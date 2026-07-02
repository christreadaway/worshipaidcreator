// Tests for the "classic" output design — a faithful emulation of the
// parish's in-house Book Antiqua / Garamond worship aid, selectable
// alongside the original "reimagined" design. The reimagined design must be
// unaffected (locked in by the other suites); here we verify the classic
// path renders, the design threads through both renderers, and the vendored
// fonts are present.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { generatePdf } = require('../pdf-generator');
const { renderBookletHtml } = require('../template-renderer');

const baseData = {
  feastName: '13th Sunday in Ordinary Time',
  liturgicalDate: '2026-06-28',
  liturgicalSeason: 'ordinary',
  reserveHymnSpace: false,
  seasonalSettings: {
    gloria: true, gloriaSetting: 'Mass of St. Theresa', creedType: 'apostles',
    entranceType: 'processional', holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa', lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor'
  },
  readings: {
    firstReadingCitation: '2 Kings 4:8-11, 14-16a', firstReadingText: 'One day Elisha came to Shunem...',
    psalmCitation: 'Psalm 89:2-3, 16-17, 18-19', psalmRefrain: 'Forever I will sing the goodness of the Lord.',
    psalmVerses: 'The promises of the LORD I will sing forever.\n\nBlessed the people who know the joyful shout.\n\nYou are the splendor of their strength.',
    secondReadingCitation: 'Romans 6:3-4, 8-11', secondReadingText: 'Brothers and sisters: Are you unaware...',
    gospelAcclamationReference: '1 Peter 2:9', gospelAcclamationVerse: 'You are a chosen race...',
    gospelCitation: 'Matthew 10:37-42', gospelText: 'Jesus said to his apostles...'
  },
  musicSat5pm: {}, musicSun9am: {}, musicSun11am: {}
};

const parishSettings = {
  parishName: 'St. Theresa Catholic Church', onelicenseNumber: 'A-702171',
  giveUrl: 'https://st-theresa.org/give', joinUrl: 'https://st-theresa.org/join',
  bulletinUrl: 'https://st-theresa.org/bulletin', socialHandles: '@stccaustin\n@sttaustin'
};

describe('Classic design — PDF', () => {
  it('renders an 8-page classic booklet with no layout warnings (design option)', async () => {
    const out = path.join(os.tmpdir(), `classic-opt-${process.pid}.pdf`);
    const res = await generatePdf(baseData, out, { bookletSize: 'tabloid', design: 'classic', parishSettings });
    assert.equal(res.pageCount, 8);
    assert.deepEqual(res.warnings, []);
    fs.unlinkSync(out);
  });

  it('accepts the design on the aid data itself (data.design)', async () => {
    const out = path.join(os.tmpdir(), `classic-data-${process.pid}.pdf`);
    const res = await generatePdf({ ...baseData, design: 'classic' }, out, { bookletSize: 'tabloid', parishSettings });
    assert.equal(res.pageCount, 8);
    assert.deepEqual(res.warnings, []);
    fs.unlinkSync(out);
  });

  it('still renders the reimagined design by default (no design option)', async () => {
    const out = path.join(os.tmpdir(), `reimagined-default-${process.pid}.pdf`);
    const res = await generatePdf(baseData, out, { bookletSize: 'tabloid', parishSettings });
    assert.equal(res.pageCount, 8);
    assert.deepEqual(res.warnings, []);
    fs.unlinkSync(out);
  });

  it('renders on the half-letter trim too', async () => {
    const out = path.join(os.tmpdir(), `classic-half-${process.pid}.pdf`);
    const res = await generatePdf({ ...baseData, design: 'classic' }, out, { bookletSize: 'half-letter', parishSettings });
    assert.equal(res.pageCount, 8);
    fs.unlinkSync(out);
  });
});

describe('Classic design — HTML preview theme', () => {
  it('tags the body with the selected design class', () => {
    const classic = renderBookletHtml(baseData, { design: 'classic', parishSettings });
    const reimagined = renderBookletHtml(baseData, { design: 'reimagined', parishSettings });
    assert.match(classic.html, /<body class="design-classic">/);
    assert.match(reimagined.html, /<body class="design-reimagined">/);
    assert.ok(!/design-classic">/.test(reimagined.html), 'reimagined never carries the classic body class');
  });

  it('renders the classic body structure: small-caps headers, classic names, two-column psalm, Verse:, QR footer', () => {
    const { html } = renderBookletHtml(baseData, { design: 'classic', parishSettings });
    // Classic section headers and the parish's in-house section names.
    assert.match(html, /class="c-section"/);
    assert.match(html, /Glory to God/);
    assert.match(html, /Lord Have Mercy/);
    assert.match(html, /Gospel Alleluia/);
    assert.match(html, /Prayer over the Offerings/);
    assert.match(html, /Please kneel or be seated/);
    assert.match(html, /Blessing and Dismissal/);
    // Two-column psalm, the "Verse:" label, and the QR/social footer.
    assert.match(html, /class="c-twocol"/);
    assert.match(html, /class="c-verse-label">Verse:/);
    assert.match(html, /class="c-qr"/);
    assert.match(html, /@font-face/);
    // The reimagined body never uses the classic markup.
    const re = renderBookletHtml(baseData, { design: 'reimagined', parishSettings });
    assert.ok(!/class="c-section"/.test(re.html), 'reimagined body has no classic section headers');
    assert.ok(!/class="c-qr"/.test(re.html), 'reimagined body has no QR footer');
    assert.match(re.html, /GLORIA|Gloria/);
  });

  it('defaults to reimagined when no design is given', () => {
    const { html } = renderBookletHtml(baseData, { parishSettings });
    assert.match(html, /<body class="design-reimagined">/);
  });
});

// Review fixes (comprehensive code review): season handling, parity with
// reimagined content, resilience to missing fields, and the preview/export
// contract (both classic renderers must show the same thing).
describe('Classic design — review fixes', () => {
  it('suppresses "Alleluia" in Lent and prints the Lenten acclamation text when no music slot', () => {
    const lent = {
      ...baseData,
      liturgicalSeason: 'lent',
      seasonalSettings: { ...baseData.seasonalSettings, gloria: false }
    };
    const { html } = renderBookletHtml(lent, { design: 'classic', parishSettings });
    assert.ok(!/Gospel Alleluia/.test(html), 'no "Alleluia" heading during Lent');
    assert.match(html, /Gospel Acclamation/);
    assert.match(html, /Praise to you, Lord Jesus Christ, King of endless glory!/);
  });

  it('prints the standard acclamation text outside Lent when no music slot carries it', () => {
    const { html } = renderBookletHtml(baseData, { design: 'classic', parishSettings });
    assert.match(html, /Alleluia, alleluia!/);
  });

  it('renders the Advent wreath block in Advent', () => {
    const advent = { ...baseData, liturgicalSeason: 'advent', seasonalSettings: { ...baseData.seasonalSettings, gloria: false, adventWreath: true } };
    const { html } = renderBookletHtml(advent, { design: 'classic', parishSettings });
    assert.match(html, /Lighting of the Advent Wreath/);
  });

  it('renders the parish welcomeMessage on the classic cover', () => {
    const { html } = renderBookletHtml(baseData, { design: 'classic', parishSettings: { ...parishSettings, welcomeMessage: 'Welcome, Bishop Vásquez!' } });
    assert.match(html, /class="c-welcome">Welcome, Bishop Vásquez!/);
  });

  it('renders the children\'s liturgy box and return line like the reimagined design', () => {
    const cl = { ...baseData, childrenLiturgyEnabled: true, childrenLiturgyMassTimes: ['Sun 9:00 AM'] };
    const { html } = renderBookletHtml(cl, { design: 'classic', parishSettings });
    assert.match(html, /Children's Liturgy of the Word/);
    assert.match(html, /Children return from Children's Liturgy of the Word \(Sun 9:00 AM\)/);
  });

  it('never prints a Communion Antiphon section (no schema field / no UI exists for it)', () => {
    const withBoxes = { ...baseData, reserveHymnSpace: true };
    const { html } = renderBookletHtml(withBoxes, { design: 'classic', parishSettings });
    assert.ok(!/Communion Antiphon/.test(html));
  });

  it('survives an empty feast name in both renderers (no crash, no "undefined")', async () => {
    const noFeast = { ...baseData, feastName: '' };
    const { html } = renderBookletHtml(noFeast, { design: 'classic', parishSettings });
    assert.ok(!/c-cover-title">undefined/.test(html));
    const out = path.join(os.tmpdir(), `classic-nofeast-${process.pid}.pdf`);
    const res = await generatePdf(noFeast, out, { bookletSize: 'tabloid', design: 'classic', parishSettings });
    assert.equal(res.pageCount, 8);
    fs.unlinkSync(out);
  });

  it('classic preview and classic PDF share cover fallback copy (render-shared)', () => {
    const { classicCoverBlocks, classicGreeting } = require('../render-shared');
    const blocks = classicCoverBlocks({});
    assert.equal(blocks.length, 4);
    const { html } = renderBookletHtml(baseData, { design: 'classic', parishSettings: {} });
    for (const [, body] of blocks) {
      assert.ok(html.includes(body.slice(0, 40)), `preview carries the shared default: ${body.slice(0, 30)}…`);
    }
    assert.match(classicGreeting({ parishName: 'St. Theresa Catholic Church' }), /^If you are new to St\. Theresa…$/);
  });

  it('flags overflowing pages with a banner in the classic preview too', () => {
    const long = { ...baseData, readings: { ...baseData.readings, gospelText: 'Jesus said to his apostles: "Whoever loves father or mother more than me is not worthy of me." '.repeat(80) } };
    const { html, warnings } = renderBookletHtml(long, { design: 'classic', parishSettings });
    assert.ok(warnings.length > 0, 'overflow detected');
    assert.match(html, /overflow-banner/);
  });

  it('emits the classic CSS only for the classic design', () => {
    const cl = renderBookletHtml(baseData, { design: 'classic', parishSettings });
    const re = renderBookletHtml(baseData, { design: 'reimagined', parishSettings });
    assert.match(cl.html, /@font-face/);
    assert.ok(!/@font-face/.test(re.html), 'reimagined carries no classic font rules');
  });
});

describe('Centered rubrics reach real exports (UI defaults)', () => {
  it('the editor SPA defaults rubric alignment to center at all three layers', () => {
    const { getAppHtml } = require('../server');
    const spa = getAppHtml();
    assert.match(spa, /<option value="center" selected>/, 'select defaults to center');
    assert.match(spa, /v\('rubricAlignment'\) \|\| 'center'/, 'buildData falls back to center');
    assert.match(spa, /ss\.rubricAlignment \|\| 'center'/, 'populateForm falls back to center');
  });
});

describe('Classic design — vendored fonts', () => {
  const dir = path.join(__dirname, '..', 'assets', 'fonts', 'classic');
  const files = [
    'Classic-Serif-Regular.otf', 'Classic-Serif-Bold.otf', 'Classic-Serif-Italic.otf',
    'Classic-Serif-BoldItalic.otf', 'Classic-Display-Regular.ttf', 'Classic-Display-SemiBold.ttf',
    'Classic-Display-Italic.ttf', 'Classic-Script-Italic.otf'
  ];
  for (const f of files) {
    it(`ships the vendored font ${f}`, () => {
      const p = path.join(dir, f);
      assert.ok(fs.existsSync(p), `${f} must be present`);
      assert.ok(fs.statSync(p).size > 10000, `${f} looks like a real font file`);
    });
  }
});
