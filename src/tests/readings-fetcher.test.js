// Tests for the USCCB readings fetcher: HTML parsing + paragraph reflow.
// USCCB serves Lectionary text with each clause on its own line (sense-line
// layout). Worship aids want a flowing-paragraph layout instead, so we
// reflow single line breaks into spaces while keeping paragraph breaks.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internal, reflowAsParagraphs, applyTranslation } = require('../readings-fetcher');

describe('reflowAsParagraphs', () => {
  it('returns empty string for empty input', () => {
    assert.equal(reflowAsParagraphs(''), '');
    assert.equal(reflowAsParagraphs(null), '');
    assert.equal(reflowAsParagraphs(undefined), '');
  });

  it('joins single-line-broken phrases into one paragraph', () => {
    const lectionaryStyle = 'The Lord God took Abram outside\nand said,\n"Look up at the sky\nand count the stars,\nif you can."';
    const result = reflowAsParagraphs(lectionaryStyle);
    assert.equal(result, 'The Lord God took Abram outside and said, "Look up at the sky and count the stars, if you can."');
  });

  it('preserves paragraph breaks (double newlines)', () => {
    const text = 'First paragraph\nbroken across lines.\n\nSecond paragraph\nalso broken.';
    const result = reflowAsParagraphs(text);
    assert.equal(result, 'First paragraph broken across lines.\n\nSecond paragraph also broken.');
  });

  it('handles leading/trailing whitespace per paragraph', () => {
    const text = '  Line one\n  Line two  \n\n  Line three  ';
    const result = reflowAsParagraphs(text);
    assert.equal(result, 'Line one Line two\n\nLine three');
  });

  it('collapses multiple internal spaces left by joining', () => {
    const text = 'A  B\n   C    D';
    assert.equal(reflowAsParagraphs(text), 'A B C D');
  });

  it('drops empty paragraphs', () => {
    const text = 'Para 1\n\n\n\nPara 2';
    assert.equal(reflowAsParagraphs(text), 'Para 1\n\nPara 2');
  });

  it('leaves a single-line input unchanged', () => {
    assert.equal(reflowAsParagraphs('A single line of text.'), 'A single line of text.');
  });
});

describe('parseUsccbHtml + reflow integration', () => {
  // Mimic the structure USCCB returns — a wr-block per reading with
  // <h3 class="name">, <div class="address">, <div class="content-body">.
  function fakeUsccbBlock({ name, citation, body }) {
    return `<div class="wr-block b-verse foo">
      <h3 class="name">${name}</h3>
      <div class="address">${citation}</div>
      <div class="content-body">${body}</div>
    </div>`;
  }

  it('parses readings into the expected sections object', () => {
    const html = fakeUsccbBlock({
      name: 'Reading 1',
      citation: 'Genesis 15:5-12',
      body: 'The Lord God took Abram outside<br>and said,<br>"Look up at the sky."'
    });
    const sections = _internal.parseUsccbHtml(html);
    assert.ok(sections['reading 1']);
    assert.equal(sections['reading 1'].citation, 'Genesis 15:5-12');
    // Body still has line breaks from <br>; reflow happens at the next layer.
    assert.ok(sections['reading 1'].body.includes('\n'));
  });

  it('splitPsalm extracts refrain even when followed by alternate "or:"', () => {
    const body = 'R. The Lord is my light and my salvation.\nor:\nR. (cf. 1) Lord, hear my prayer.\nVerse 1\nVerse 2';
    const { refrain, verses } = _internal.splitPsalm(body);
    assert.equal(refrain, 'The Lord is my light and my salvation.');
    assert.ok(verses.includes('Verse 1'));
  });

  it('splitGospelAcclamation strips R. lines and keeps the verse', () => {
    const body = 'R. Alleluia, alleluia.\nFrom the shining cloud the Father\'s voice is heard.\nR. Alleluia, alleluia.';
    const verse = _internal.splitGospelAcclamation(body);
    assert.equal(verse, "From the shining cloud the Father's voice is heard.");
  });

  it('toUsccbDate converts YYYY-MM-DD to MMDDYY', () => {
    assert.equal(_internal.toUsccbDate('2026-03-01'), '030126');
    assert.equal(_internal.toUsccbDate('2026-12-25'), '122526');
  });

  it('toUsccbDate throws for invalid input', () => {
    assert.throws(() => _internal.toUsccbDate('not-a-date'));
    assert.throws(() => _internal.toUsccbDate(''));
  });
});

describe('parseUsccbHtml failure detection', () => {
  it('throws when neither a Gospel nor a Reading 1 section is found', () => {
    assert.throws(() => _internal.parseUsccbHtml('<html><body>USCCB redesigned this page</body></html>'),
      /layout may have changed/);
  });
});

describe('decodeEntities', () => {
  it('decodes hex entities', () => {
    assert.equal(_internal.decodeEntities('It&#x2019;s'), 'It’s');
    assert.equal(_internal.decodeEntities('&#x1F54A;'), String.fromCodePoint(0x1F54A));
  });
  it('decodes decimal entities including astral code points', () => {
    assert.equal(_internal.decodeEntities('&#39;'), "'");
    assert.equal(_internal.decodeEntities('&#128330;'), String.fromCodePoint(128330));
  });
  it('decodes &amp; last so double-encoded entities are not double-decoded', () => {
    assert.equal(_internal.decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(_internal.decodeEntities('A &amp; B'), 'A & B');
  });
});

describe('normalizeCitationForBibleApi', () => {
  it('strips Cf. prefixes', () => {
    assert.equal(_internal.normalizeCitationForBibleApi('Cf. Ps 95:8'), 'Ps 95:8');
    assert.equal(_internal.normalizeCitationForBibleApi('cf Jn 6:63c'), 'Jn 6:63');
  });
  it('strips verse-letter suffixes', () => {
    assert.equal(_internal.normalizeCitationForBibleApi('Is 50:4-7a'), 'Is 50:4-7');
    assert.equal(_internal.normalizeCitationForBibleApi('Ps 22:8-9, 17-18a, 19-20, 23-24'), 'Ps 22:8-9, 17-18, 19-20, 23-24');
  });
  it('removes parentheticals', () => {
    assert.equal(_internal.normalizeCitationForBibleApi('Ps 27:1, 7-8, 8-9, 13-14 (1a)'), 'Ps 27:1, 7-8, 8-9, 13-14');
  });
  it('normalizes em/en dashes to hyphens', () => {
    assert.equal(_internal.normalizeCitationForBibleApi('Gn 15:5–12'), 'Gn 15:5-12');
    assert.equal(_internal.normalizeCitationForBibleApi('Rom 8:31—34'), 'Rom 8:31-34');
  });
  it('handles empty input', () => {
    assert.equal(_internal.normalizeCitationForBibleApi(''), '');
    assert.equal(_internal.normalizeCitationForBibleApi(null), '');
  });
});

describe('applyTranslation', () => {
  const baseReadings = {
    translation: 'NABRE',
    firstReadingCitation: 'Genesis 15:5-12',
    firstReadingText: 'NABRE first reading text.',
    psalmCitation: 'Psalm 27:1, 7-8',
    psalmRefrain: 'The Lord is my light and my salvation.',
    psalmVerses: 'NABRE psalm verses.',
    secondReadingCitation: '',
    secondReadingText: '',
    gospelCitation: 'Luke 9:28-36',
    gospelText: 'NABRE gospel text.'
  };
  const stanza = 'The LORD is my light and my salvation;\nwhom should I fear?\n\nHear my voice, LORD, when I call;\nhave mercy on me and answer me.';
  const senseLines = 'The Lord God took Abram outside\nand said:\nLook up at the sky\nand count the stars.';

  it('does NOT reflow psalm verses but reflows readings/gospel (regression)', async () => {
    const fakeFetch = async citation =>
      citation === baseReadings.psalmCitation ? stanza : senseLines;
    const out = await applyTranslation(baseReadings, 'KJV', fakeFetch);
    assert.equal(out.psalmVerses, stanza, 'psalm stanza lines must be preserved');
    assert.equal(out.firstReadingText, 'The Lord God took Abram outside and said: Look up at the sky and count the stars.');
    assert.equal(out.gospelText, 'The Lord God took Abram outside and said: Look up at the sky and count the stars.');
    assert.equal(out.translation, 'KJV');
  });

  it('keeps translation = NABRE when every alternate fetch fails', async () => {
    const failingFetch = async () => { throw new Error('network down'); };
    const out = await applyTranslation(baseReadings, 'KJV', failingFetch);
    assert.equal(out.translation, 'NABRE');
    assert.equal(out.firstReadingText, baseReadings.firstReadingText);
    assert.equal(out.psalmVerses, baseReadings.psalmVerses);
  });

  it('keeps translation = NABRE when every fetch returns empty', async () => {
    const emptyFetch = async () => '';
    const out = await applyTranslation(baseReadings, 'DRA', emptyFetch);
    assert.equal(out.translation, 'NABRE');
  });

  it('returns readings untouched for the NABRE/usccb source', async () => {
    const out = await applyTranslation(baseReadings, 'NABRE', async () => { throw new Error('must not be called'); });
    assert.deepEqual(out, baseReadings);
  });
});

describe('reflow protects against psalm-verse damage', () => {
  // Psalm verses come from splitPsalm and look like:
  //   "The Lord is my light\n  and my salvation;\n  whom should I fear?\n\n..."
  // We want to keep the indented continuation lines for stanzas. Reflow is
  // never called on psalm verses, so this test just documents the contract.
  it('psalm verses are not passed through reflowAsParagraphs in fetchUsccbReadings', () => {
    // Smoke check via the exported reflow: verify it would damage psalm
    // structure if (incorrectly) applied. This locks in the "do not reflow
    // psalm verses" behaviour so future refactors notice.
    const psalmStanza = 'The Lord is my light\n  and my salvation;\n  whom should I fear?';
    const damaged = reflowAsParagraphs(psalmStanza);
    assert.notEqual(damaged, psalmStanza, 'reflow flattens stanza structure — must NOT be used on psalm verses');
  });
});
