// Tests for the director-of-liturgy proof fixes (13th Sunday in Ordinary
// Time, June 2026 proof). Each assertion locks in one item the director
// marked up so the layout can't silently regress:
//   - posture directions carry no cross symbol or trailing punctuation
//   - a piece's title/composer rides on the heading line (no "Prelude —"
//     style label) and posture directions are right-justified on the heading
//   - scripture citations ride on the reading heading line
//   - a Collect heading follows the Gloria; "Please be seated" sits before
//     "The Liturgy of the Word"; "Please stand" sits before the section
//     titles where the director placed it
//   - the unnecessary texts (intentions line, Our Father, blessing dialogue)
//     are gone and the responsorial-psalm setting line is gone
//   - psalm verses end with "R."
//   - the OneLicense permission appears only in the end-of-document block
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { renderBookletHtml } = require('../template-renderer');
const { generatePdf } = require('../pdf-generator');
const { RUBRICS } = require('../assets/text/mass-texts');

// An Ordinary-Time aid that exercises every changed slot: processional
// entrance, Gloria, all readings, psalm verses, and music in every slot.
const data = {
  feastName: '13th Sunday in Ordinary Time',
  liturgicalDate: '2026-06-28',
  liturgicalSeason: 'ordinary',
  reserveHymnSpace: false, // text path (no paste boxes) so strings are visible
  seasonalSettings: {
    gloria: true, creedType: 'apostles', entranceType: 'processional',
    holyHolySetting: 'Healey Willan', mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Healey Willan', penitentialAct: 'confiteor'
  },
  readings: {
    firstReadingCitation: '2 Kings 4:8-11, 14-16a',
    firstReadingText: 'One day Elisha came to Shunem...',
    psalmCitation: 'Psalm 89:2-3, 16-17, 18-19',
    psalmRefrain: 'Forever I will sing the goodness of the Lord.',
    psalmVerses: 'The promises of the LORD I will sing forever.\n\nBlessed the people who know the joyful shout.',
    secondReadingCitation: 'Romans 6:3-4, 8-11',
    secondReadingText: 'Brothers and sisters: Are you unaware...',
    gospelAcclamationReference: '1 Peter 2:9',
    gospelAcclamationVerse: 'You are a chosen race...',
    gospelCitation: 'Matthew 10:37-42',
    gospelText: 'Jesus said to his apostles...'
  },
  musicSat5pm:  { organPrelude: 'Adagio', organPreludeComposer: 'Crawford', processionalOrEntrance: 'I Know That My Redeemer Lives', kyrieSetting: 'Kyrie', kyrieComposer: 'Palestrina', communionHymn: 'I Receive the Living God', hymnOfThanksgiving: 'Lord, Help Us', organPostlude: 'Fanfare', organPostludeComposer: 'Willan' },
  musicSun9am:  { organPrelude: 'Adagio', organPreludeComposer: 'Crawford', processionalOrEntrance: 'I Know That My Redeemer Lives', kyrieSetting: 'Kyrie', kyrieComposer: 'Palestrina', communionHymn: 'I Receive the Living God', hymnOfThanksgiving: 'Lord, Help Us', organPostlude: 'Fanfare', organPostludeComposer: 'Willan' },
  musicSun11am: { organPrelude: 'Adagio', organPreludeComposer: 'Crawford', processionalOrEntrance: 'I Know That My Redeemer Lives', kyrieSetting: 'Kyrie', kyrieComposer: 'Palestrina', communionHymn: 'I Receive the Living God', hymnOfThanksgiving: 'Lord, Help Us', organPostlude: 'Fanfare', organPostludeComposer: 'Willan' }
};

describe('Proof fixes — posture directions', () => {
  it('carry no cross symbol and no trailing punctuation', () => {
    assert.equal(RUBRICS.stand, 'Please stand');
    assert.equal(RUBRICS.sit, 'Please be seated');
    assert.equal(RUBRICS.kneel, 'Please kneel');
    for (const v of Object.values(RUBRICS)) {
      assert.ok(!/[☩✝✠†]/.test(v), `no cross symbol in "${v}"`);
      assert.ok(!/[.]$/.test(v), `no trailing period in "${v}"`);
    }
  });

  it('render right-justified on the Processional Hymn heading line', () => {
    const { html } = renderBookletHtml(data);
    // The entrance heading row carries a right-justified posture direction.
    assert.match(html, /Processional Hymn<\/span>[^]*?<span class="rubric-inline">Please stand<\/span>/);
  });
});

describe('Proof fixes — music labels dropped, info inline', () => {
  it('drops the redundant "Prelude —" / "Kyrie —" style labels', () => {
    const { html } = renderBookletHtml(data);
    assert.ok(!html.includes('music-label'), 'no music-label spans remain');
    assert.doesNotMatch(html, /Prelude\s*&mdash;/);
    assert.doesNotMatch(html, /Kyrie\s*&mdash;/);
    assert.doesNotMatch(html, /Communion\s*&mdash;/);
  });

  it('puts the prelude title + composer on the Organ Prelude heading line', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Organ Prelude<\/span><span class="sub-inline"><em>Adagio<\/em>, Crawford/);
  });

  it('puts ordinary-setting names inline on Holy/Mystery/Lamb headings', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Holy, Holy, Holy<\/span><span class="sub-inline">Healey Willan/);
    assert.match(html, /Mystery of Faith<\/span><span class="sub-inline">Mass of St\. Theresa/);
    assert.match(html, /Lamb of God<\/span><span class="sub-inline">Healey Willan/);
  });
});

describe('Proof fixes — scripture citations inline', () => {
  it('puts each reading citation on its heading line', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /First Reading<\/span><span class="sub-inline cite">2 Kings 4:8-11, 14-16a/);
    assert.match(html, /Second Reading<\/span><span class="sub-inline cite">Romans 6:3-4, 8-11/);
    assert.match(html, /Gospel<\/span><span class="sub-inline cite">Matthew 10:37-42/);
  });

  it('responsorial psalm shows only the scripture reference (no setting line)', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Responsorial Psalm<\/span><span class="sub-inline cite">Psalm 89/);
  });

  it('puts "Please stand" on the Gospel Acclamation heading with its reference', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Gospel Acclamation<\/span><span class="sub-inline cite">1 Peter 2:9[^]*?rubric-inline">Please stand/);
  });
});

describe('Proof fixes — Collect, section transitions, omissions', () => {
  it('adds a Collect heading', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /<span class="sub-heading">Collect<\/span>/);
  });

  it('places "Please be seated" before "The Liturgy of the Word"', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Please be seated<\/p>\s*<div class="section-header">The Liturgy of the Word/);
  });

  it('places "Please be seated" before "The Liturgy of the Eucharist"', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Please be seated<\/p>\s*<div class="section-header">The Liturgy of the Eucharist/);
  });

  it('places "Please stand" before "The Communion Rite"', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Please stand<\/p>\s*<div class="section-header">The Communion Rite/);
  });

  it('drops the intentions line, the Our Father text, and the blessing dialogue', () => {
    const { html } = renderBookletHtml(data);
    assert.ok(!html.includes('The intentions are read'));
    assert.ok(!html.includes('Our Father'));
    assert.ok(!html.includes('Go forth, the Mass is ended'));
    assert.ok(!html.includes('The Lord be with you'));
  });
});

describe('Proof fixes — psalm verses and licensing', () => {
  it('ends each psalm verse with R.', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /The promises of the LORD I will sing forever\. R\./);
    assert.match(html, /Blessed the people who know the joyful shout\. R\./);
  });

  it('prints the OneLicense permission only once, in the end block', () => {
    const { html } = renderBookletHtml(data);
    const occurrences = (html.match(/Music reprinted under OneLicense/g) || []).length;
    assert.equal(occurrences, 1, 'permission appears exactly once');
    assert.ok(!html.includes('copyright-short'), 'no per-page short license element');
  });
});

describe('Proof fixes — PDF still renders cleanly', () => {
  it('produces an 8-page PDF with no layout warnings', async () => {
    const out = path.join(os.tmpdir(), `proof-fixes-${process.pid}.pdf`);
    const res = await generatePdf(data, out, {
      bookletSize: 'tabloid',
      parishSettings: { parishName: 'St. Theresa Catholic Church', onelicenseNumber: 'A-702171' }
    });
    assert.equal(res.pageCount, 8);
    assert.deepEqual(res.warnings, []);
    fs.unlinkSync(out);
  });
});

// Second proof pass (June 28, 2026 re-proof): posture directions centered,
// the Collect heading no longer strands away from the readings, the psalm
// prints one strophe per block (each ending "R."), and a Prayer after
// Communion heading is added while the redundant Blessing "Please stand" is
// dropped.
describe('Proof fixes v2 — posture centering', () => {
  it('centers standalone posture directions by default', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /class="rubric" style="text-align:center"/);
    // No standalone posture line falls back to left alignment.
    assert.ok(!/class="rubric" style="text-align:left"/.test(html));
  });

  it('honors an explicit parish rubricAlignment override', () => {
    const { html } = renderBookletHtml({ ...data, seasonalSettings: { ...data.seasonalSettings, rubricAlignment: 'left' } });
    assert.match(html, /class="rubric" style="text-align:left"/);
  });
});

describe('Proof fixes v2 — Prayer after Communion and posture flow', () => {
  it('adds a Prayer after Communion heading below the Choral Anthem', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Choral Anthem<\/span>[^]*?Please stand<\/p>\s*<div class="sub-heading-row"><div class="sub-heading-left"><span class="sub-heading">Prayer after Communion/);
  });

  it('drops the redundant "Please stand" before Blessing & Dismissal', () => {
    const { html } = renderBookletHtml(data);
    assert.ok(!/Please stand<\/p>\s*<div class="sub-heading">Blessing/.test(html));
    // The stand that remains is the one above Prayer after Communion.
    assert.match(html, /Please stand<\/p>\s*<div class="sub-heading-row"><div class="sub-heading-left"><span class="sub-heading">Prayer after Communion/);
  });

  it('keeps "Please kneel" with the Lamb of God', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /Lamb of God<\/span>[^]*?Please kneel<\/p>/);
  });
});

describe('Proof fixes v2 — psalm strophes', () => {
  const multi = {
    ...data,
    readings: {
      ...data.readings,
      psalmVerses: 'Strophe one line A,\nstrophe one line B.\n\nStrophe two line A,\nstrophe two line B.\n\nStrophe three line A,\nstrophe three line B.'
    }
  };

  it('prints one paragraph per strophe, each ending with R.', () => {
    const { html } = renderBookletHtml(multi);
    const verses = html.match(/<p class="psalm-verse">[^]*?<\/p>/g) || [];
    assert.equal(verses.length, 3, 'three strophe paragraphs');
    for (const v of verses) assert.match(v, /R\.<\/p>$/);
  });

  it('renders the multi-strophe psalm into a clean 8-page PDF', async () => {
    const out = path.join(os.tmpdir(), `proof-fixes-v2-${process.pid}.pdf`);
    const res = await generatePdf(multi, out, {
      bookletSize: 'tabloid',
      parishSettings: { parishName: 'St. Theresa Catholic Church', onelicenseNumber: 'A-702171' }
    });
    assert.equal(res.pageCount, 8);
    assert.deepEqual(res.warnings, []);
    fs.unlinkSync(out);
  });
});
