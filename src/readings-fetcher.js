// Fetches Mass readings from USCCB and (optionally) re-fetches the same
// citations in alternative Bible translations.
//
// USCCB publishes the U.S. Lectionary text (NABRE-based) at
//   https://bible.usccb.org/bible/readings/MMDDYY.cfm
// We scrape that page for citations + text. For non-NABRE translations,
// we keep the citations from USCCB and re-fetch the passage from
// bible-api.com using a translation id.
'use strict';

const https = require('https');

const TRANSLATIONS = [
  { id: 'NABRE',  label: 'NABRE (Lectionary, USCCB)', source: 'usccb' },
  { id: 'DRA',    label: 'Douay-Rheims (Catholic)',   source: 'bible-api', code: 'dra'  },
  { id: 'KJV',    label: 'King James Version',         source: 'bible-api', code: 'kjv'  },
  { id: 'WEB',    label: 'World English Bible',        source: 'bible-api', code: 'web'  },
  { id: 'BBE',    label: 'Bible in Basic English',     source: 'bible-api', code: 'bbe'  },
  { id: 'ASV',    label: 'American Standard Version',  source: 'bible-api', code: 'asv'  }
];

function getTranslation(id) {
  return TRANSLATIONS.find(t => t.id === (id || 'NABRE').toUpperCase()) || TRANSLATIONS[0];
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (WorshipAidGenerator)',
        'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
  });
}

function toUsccbDate(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd || '');
  if (!m) throw new Error('Invalid date — expected YYYY-MM-DD');
  return `${m[2]}${m[3]}${m[1].slice(2)}`;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function htmlToLines(html) {
  // Convert <br> to newlines, strip remaining tags, decode entities, trim.
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks)
    .split('\n')
    .map(l => l.replace(/\s+$/, '').replace(/^\s+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// USCCB renders the Lectionary text with each clause/phrase on its own line
// (sense-line layout used by lectors).  Worship aids want a normal flowing
// paragraph instead.  Collapse single line breaks within a paragraph into
// spaces, but keep paragraph breaks (blank lines).  Used for first/second/
// gospel readings + the gospel-acclamation verse.  Psalm verses are NOT
// reflowed — those are stanzas with intentional line structure.
function reflowAsParagraphs(text) {
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function parseUsccbHtml(html) {
  const sections = {};
  // Each reading lives in a `<div class="wr-block b-verse ...">` block.
  const blockRe = /<div class="wr-block b-verse[\s\S]*?<h3 class="name">([\s\S]*?)<\/h3>[\s\S]*?<div class="address">([\s\S]*?)<\/div>[\s\S]*?<div class="content-body">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const name = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
    const citation = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    const body = htmlToLines(m[3]);
    sections[name.toLowerCase()] = { name, citation, body };
  }
  return sections;
}

function splitPsalm(body) {
  // Refrain lines start with "R."; everything else is verses.
  // Multiple "or:" alternative refrains may appear — we keep only the first.
  const lines = body.split('\n');
  let refrain = '';
  const verseLines = [];
  let inAltRefrain = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (verseLines.length && verseLines[verseLines.length - 1] !== '') verseLines.push(''); continue; }
    if (/^or\s*:?$/i.test(line)) { inAltRefrain = true; continue; }
    const refMatch = /^R\.\s*(?:\([^)]*\)\s*)?(.*)$/.exec(line);
    if (refMatch) {
      if (!refrain && !inAltRefrain) refrain = refMatch[1].trim();
      inAltRefrain = false;
      continue;
    }
    inAltRefrain = false;
    verseLines.push(line);
  }
  // Collapse consecutive blank lines and trim.
  const verses = verseLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { refrain, verses };
}

function splitGospelAcclamation(body) {
  // Body looks like: "R. Alleluia, alleluia.\n<verse line>\n...\nR. Alleluia, alleluia."
  // We want just the verse text.
  const lines = body.split('\n');
  const verseLines = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^R\.\s*/.test(line)) continue;
    if (/^or\s*:?$/i.test(line)) continue;
    verseLines.push(line);
  }
  return verseLines.join('\n').trim();
}

async function fetchUsccbReadings(yyyyMmDd) {
  const url = `https://bible.usccb.org/bible/readings/${toUsccbDate(yyyyMmDd)}.cfm`;
  const html = await httpsGet(url);
  const sections = parseUsccbHtml(html);

  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(sections).find(name => name === k || name.startsWith(k));
      if (found) return sections[found];
    }
    return null;
  };

  const reading1 = get('reading 1', 'reading i', 'first reading');
  const reading2 = get('reading 2', 'reading ii', 'second reading');
  const psalm    = get('responsorial psalm');
  const accl     = get('alleluia', 'gospel acclamation', 'verse before the gospel');
  const gospel   = get('gospel');

  const psalmParts = psalm ? splitPsalm(psalm.body) : { refrain: '', verses: '' };

  return {
    sourceUrl: url,
    firstReadingCitation: reading1 ? reading1.citation : '',
    firstReadingText:     reading1 ? reflowAsParagraphs(reading1.body) : '',
    psalmCitation:        psalm ? psalm.citation : '',
    psalmRefrain:         psalmParts.refrain,
    psalmVerses:          psalmParts.verses,
    secondReadingCitation: reading2 ? reading2.citation : '',
    secondReadingText:     reading2 ? reflowAsParagraphs(reading2.body) : '',
    noSecondReading:       !reading2,
    gospelAcclamationReference: accl ? accl.citation : '',
    gospelAcclamationVerse:     accl ? reflowAsParagraphs(splitGospelAcclamation(accl.body)) : '',
    gospelCitation: gospel ? gospel.citation : '',
    gospelText:     gospel ? reflowAsParagraphs(gospel.body) : ''
  };
}

async function fetchPassageFromBibleApi(citation, code) {
  if (!citation) return '';
  const url = `https://bible-api.com/${encodeURIComponent(citation)}?translation=${encodeURIComponent(code)}`;
  const body = await httpsGet(url);
  let json;
  try { json = JSON.parse(body); } catch { return ''; }
  if (!json || !json.text) return '';
  const cleaned = String(json.text).replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return reflowAsParagraphs(cleaned);
}

// Replace USCCB Lectionary text with a different translation, keeping the
// citations and Lectionary-only items (psalm refrain, acclamation verse) as-is.
async function applyTranslation(readings, translationId) {
  const t = getTranslation(translationId);
  if (t.source === 'usccb') return readings;

  const out = { ...readings, translation: t.id };
  const tasks = [
    ['firstReadingText',  readings.firstReadingCitation],
    ['secondReadingText', readings.secondReadingCitation],
    ['psalmVerses',       readings.psalmCitation],
    ['gospelText',        readings.gospelCitation]
  ];
  await Promise.all(tasks.map(async ([field, citation]) => {
    if (!citation) return;
    try {
      const text = await fetchPassageFromBibleApi(citation, t.code);
      if (text) {
        // psalmVerses keeps its original stanza line structure; everything
        // else is reflowed to flowing paragraphs (already done in
        // fetchPassageFromBibleApi for the others, but also here for safety).
        out[field] = field === 'psalmVerses' ? text : reflowAsParagraphs(text);
      }
    } catch (e) {
      // Leave the USCCB text in place if the alternate translation fails.
      console.warn(`[readings] ${t.id} fetch failed for ${citation}: ${e.message}`);
    }
  }));
  return out;
}

async function fetchReadings(yyyyMmDd, translationId) {
  const base = await fetchUsccbReadings(yyyyMmDd);
  base.translation = 'NABRE';
  return applyTranslation(base, translationId);
}

module.exports = {
  TRANSLATIONS,
  getTranslation,
  fetchReadings,
  fetchUsccbReadings,
  applyTranslation,
  reflowAsParagraphs,
  // exported for testing
  _internal: { parseUsccbHtml, splitPsalm, splitGospelAcclamation, toUsccbDate, reflowAsParagraphs }
};
