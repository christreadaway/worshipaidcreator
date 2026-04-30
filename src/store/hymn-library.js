// Parish-managed local hymn library. Stores hymn entries with the fields
// most useful when picking music for a worship aid: title, tune name,
// composer, key (for arrangement decisions), meter, hymnal/source, and
// licensing notes. English-only for v1.
'use strict';

const kv = require('./kv');

const KEY_NS = 'hymn-library';
const PARISH_KEY = 'parish-default';

const STARTER_LIBRARY = [
  { title: 'Holy God, We Praise Thy Name', tune: 'GROSSER GOTT', composer: 'Katholisches Gesangbuch (1774)', key: 'F major', meter: '78.78.77', source: 'Public domain', language: 'en' },
  { title: 'O God, Our Help in Ages Past', tune: 'ST. ANNE', composer: 'William Croft', key: 'C major', meter: 'CM', source: 'Public domain', language: 'en' },
  { title: 'Lift High the Cross', tune: 'CRUCIFER', composer: 'Sydney H. Nicholson', key: 'E♭ major', meter: '10.10 with refrain', source: 'Hope Publishing', language: 'en' },
  { title: 'For All the Saints', tune: 'SINE NOMINE', composer: 'Ralph Vaughan Williams', key: 'G major', meter: '10.10.10.4', source: 'Public domain', language: 'en' },
  { title: 'Be Thou My Vision', tune: 'SLANE', composer: 'Irish traditional', key: 'D major', meter: '10.10.9.10', source: 'Public domain', language: 'en' },
  { title: 'Christ, Be Our Light', tune: 'CHRIST BE OUR LIGHT', composer: 'Bernadette Farrell', key: 'D major', meter: 'Irregular', source: 'OCP', language: 'en' },
  { title: 'Gather Us In', tune: 'GATHER US IN', composer: 'Marty Haugen', key: 'D minor', meter: 'Irregular', source: 'GIA', language: 'en' },
  { title: 'On Eagle’s Wings', tune: 'ON EAGLE’S WINGS', composer: 'Michael Joncas', key: 'E♭ major', meter: 'Irregular', source: 'OCP', language: 'en' },
  { title: 'Here I Am, Lord', tune: 'HERE I AM', composer: 'Daniel L. Schutte', key: 'D major', meter: 'Irregular', source: 'OCP', language: 'en' },
  { title: 'How Great Thou Art', tune: 'O STORE GUD', composer: 'Stuart K. Hine', key: 'B♭ major', meter: '11.10.11.10 with refrain', source: 'Manna Music', language: 'en' },
  { title: 'Amazing Grace', tune: 'NEW BRITAIN', composer: 'American melody', key: 'G major', meter: 'CM', source: 'Public domain', language: 'en' },
  { title: 'Praise to the Lord, the Almighty', tune: 'LOBE DEN HERREN', composer: 'Stralsund Gesangbuch (1665)', key: 'G major', meter: '14.14.4.7.8', source: 'Public domain', language: 'en' },
  { title: 'Sing of Mary', tune: 'PLEADING SAVIOR', composer: 'Joshua Leavitt', key: 'D major', meter: '87.87 D', source: 'Public domain', language: 'en' },
  { title: 'Lord, Who Throughout These Forty Days', tune: 'ST. FLAVIAN', composer: 'John Day Psalter (1562)', key: 'D major', meter: 'CM', source: 'Public domain', language: 'en' },
  { title: '’Tis Good, Lord, to Be Here', tune: 'POTSDAM', composer: 'arr. from J.S. Bach', key: 'F major', meter: 'SM', source: 'Public domain', language: 'en' },
  { title: 'Transfigure Us, O Lord', tune: 'TRANSFIGURE US', composer: 'Bob Hurd', key: 'A minor', meter: 'Irregular', source: 'OCP', language: 'en' },
  { title: 'Jesus Christ Is Risen Today', tune: 'EASTER HYMN', composer: 'Lyra Davidica (1708)', key: 'C major', meter: '77.77 with alleluias', source: 'Public domain', language: 'en' },
  { title: 'O Sacred Head, Now Wounded', tune: 'PASSION CHORALE', composer: 'Hans Leo Hassler', key: 'D minor', meter: '76.76 D', source: 'Public domain', language: 'en' },
  { title: 'Crown Him with Many Crowns', tune: 'DIADEMATA', composer: 'George J. Elvey', key: 'D major', meter: 'SMD', source: 'Public domain', language: 'en' },
  { title: 'Ave Maria', tune: 'AVE MARIA (Schubert)', composer: 'Franz Schubert', key: 'B♭ major', meter: 'Irregular', source: 'Public domain', language: 'en' }
];

async function loadLibrary() {
  const stored = await kv.get(KEY_NS, PARISH_KEY);
  if (!stored || !Array.isArray(stored.entries) || stored.entries.length === 0) {
    const seeded = { entries: STARTER_LIBRARY.slice(), updatedAt: new Date().toISOString() };
    await kv.set(KEY_NS, PARISH_KEY, seeded);
    return seeded;
  }
  return stored;
}

async function saveLibrary(entries) {
  const cleaned = (Array.isArray(entries) ? entries : []).map(e => ({
    title:    String(e.title || '').trim(),
    tune:     String(e.tune || '').trim(),
    composer: String(e.composer || '').trim(),
    key:      String(e.key || '').trim(),
    meter:    String(e.meter || '').trim(),
    source:   String(e.source || '').trim(),
    // Hymnal name (e.g. "Worship IV", "Gather III") + number within it.
    // Music directors search OneLicense by hymnal + number, not title; the
    // OneLicense URL helper below uses these fields when present.
    hymnal:       String(e.hymnal || '').trim(),
    hymnNumber:   String(e.hymnNumber || '').trim(),
    language: (String(e.language || 'en').toLowerCase().slice(0, 2)) || 'en',
    notes:    String(e.notes || '').trim()
  })).filter(e => e.title);
  const record = { entries: cleaned, updatedAt: new Date().toISOString() };
  await kv.set(KEY_NS, PARISH_KEY, record);
  return record;
}

// Build a OneLicense search URL.  OneLicense's basic search accepts a free-text
// query in the `keyword` parameter.  Hymnal + number is the most specific
// query a music director can make; falls back to title + composer.
function oneLicenseSearchUrl(entry) {
  if (!entry) return '';
  const parts = [];
  if (entry.hymnal)     parts.push(entry.hymnal);
  if (entry.hymnNumber) parts.push('#' + entry.hymnNumber);
  if (!parts.length) {
    if (entry.title)    parts.push(entry.title);
    if (entry.composer) parts.push(entry.composer);
  }
  const q = parts.join(' ').trim();
  if (!q) return '';
  return 'https://www.onelicense.net/search?text=' + encodeURIComponent(q);
}

function normalize(s) {
  // Lowercase + collapse curly/straight quotes so "eagle's" matches "eagle’s"
  return String(s || '').toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"');
}

function search(library, query, opts = {}) {
  const q = normalize(query).trim();
  const englishOnly = opts.englishOnly !== false;
  const limit = opts.limit || 20;
  const entries = (library.entries || []).filter(e => englishOnly ? (e.language || 'en') === 'en' : true);
  if (!q) return entries.slice(0, limit);
  const results = [];
  for (const e of entries) {
    const title = normalize(e.title);
    const tune  = normalize(e.tune);
    const composer = normalize(e.composer);
    const hymnal = normalize(e.hymnal);
    const hymnNumber = normalize(e.hymnNumber);
    let score = 0;
    if (title.startsWith(q))       score += 100;
    else if (title.includes(q))    score += 50;
    if (tune.startsWith(q))        score += 80;
    else if (tune.includes(q))     score += 40;
    if (composer.includes(q))      score += 10;
    // Hymnal-name and -number matches are strong: a director typing
    // "Worship 612" should land on entry #612 in Worship hymnal.
    if (hymnal.includes(q))        score += 60;
    if (hymnNumber === q)          score += 90;
    else if (hymnNumber.includes(q)) score += 30;
    if (score > 0) results.push({ entry: e, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map(r => r.entry);
}

module.exports = { loadLibrary, saveLibrary, search, oneLicenseSearchUrl, STARTER_LIBRARY };
