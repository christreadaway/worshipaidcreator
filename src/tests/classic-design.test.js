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

  it('includes the classic re-skin CSS only structurally (always defined, applied by body class)', () => {
    const { html } = renderBookletHtml(baseData, { design: 'classic', parishSettings });
    assert.match(html, /body\.design-classic \.section-header/);
    assert.match(html, /body\.design-classic \.sub-heading-left \.sub-inline::before/);
  });

  it('defaults to reimagined when no design is given', () => {
    const { html } = renderBookletHtml(baseData, { parishSettings });
    assert.match(html, /<body class="design-reimagined">/);
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
