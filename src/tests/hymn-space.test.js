// Reserved hymn-music paste areas.
// Processional paste area is conditional: only shown when entranceType is
// 'processional' (not 'antiphon').  Communion and thanksgiving always show
// when reserveHymnSpace is true.  Ordinary-music paste areas (Kyrie,
// Holy Holy Holy, Lamb of God) are smaller and also gated by reserveHymnSpace.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderBookletHtml } = require('../template-renderer');
const { generatePdf, LAYOUTS } = require('../pdf-generator');

const outputDir = path.join(__dirname, '..', '..', 'output', 'hymn-space-tests');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'sample', 'second-sunday-lent.json'), 'utf8'));
// sample uses entranceType: 'antiphon' so the processional paste area is suppressed.
const processionalSample = {
  ...sample,
  seasonalSettings: { ...(sample.seasonalSettings || {}), entranceType: 'processional' }
};

before(() => { fs.mkdirSync(outputDir, { recursive: true }); });
after(() => {
  for (const f of fs.readdirSync(outputDir)) fs.unlinkSync(path.join(outputDir, f));
  fs.rmdirSync(outputDir);
});

describe('HTML renderer — hymn music paste areas', () => {
  it('processional mode renders three paste areas (processional, communion, thanksgiving)', () => {
    const { html } = renderBookletHtml(processionalSample);
    const matches = html.match(/class="hymn-music-space"/g) || [];
    assert.equal(matches.length, 3);
    assert.match(html, /paste licensed notation here/);
  });

  it('antiphon mode renders two paste areas (communion, thanksgiving — no processional)', () => {
    const { html } = renderBookletHtml(sample); // sample uses antiphon
    const matches = html.match(/class="hymn-music-space"/g) || [];
    assert.equal(matches.length, 2);
  });

  it('places paste areas on pages 6 and 7 (always)', () => {
    const { html } = renderBookletHtml(sample);
    for (const page of [6, 7]) {
      const start = html.indexOf(`id="page-${page}"`);
      const end = html.indexOf(`id="page-${page + 1}"`);
      const section = html.slice(start, end === -1 ? undefined : end);
      assert.match(section, /hymn-music-space/, `page ${page} should contain a paste area`);
    }
  });

  it('places processional paste area on page 2 only when entranceType is processional', () => {
    const { html: procHtml } = renderBookletHtml(processionalSample);
    const start = procHtml.indexOf('id="page-2"');
    const end = procHtml.indexOf('id="page-3"');
    const page2 = procHtml.slice(start, end);
    assert.match(page2, /hymn-music-space/, 'page 2 should have paste area in processional mode');

    const { html: antHtml } = renderBookletHtml(sample);
    const start2 = antHtml.indexOf('id="page-2"');
    const end2 = antHtml.indexOf('id="page-3"');
    const page2ant = antHtml.slice(start2, end2);
    assert.doesNotMatch(page2ant, /hymn-music-space/, 'page 2 should have no paste area in antiphon mode');
  });

  it('omits all hymn paste areas when reserveHymnSpace is false', () => {
    const { html } = renderBookletHtml({ ...sample, reserveHymnSpace: false });
    assert.doesNotMatch(html, /class="hymn-music-space"/);
  });

  it('ordinary music paste areas appear for Kyrie, Holy Holy Holy, Lamb of God', () => {
    const { html } = renderBookletHtml(sample);
    assert.match(html, /class="ordinary-music-space"/);
    assert.match(html, /Kyrie.*music notation/);
    assert.match(html, /Holy.*Holy.*music notation/);
    assert.match(html, /Lamb of God.*music notation/);
  });

  it('ordinary music paste areas hidden when reserveHymnSpace is false', () => {
    const { html } = renderBookletHtml({ ...sample, reserveHymnSpace: false });
    assert.doesNotMatch(html, /class="ordinary-music-space"/);
  });

  it('sizes the hymn paste area per booklet geometry', () => {
    const half = renderBookletHtml(sample, { bookletSize: 'half-letter' }).html;
    const tab = renderBookletHtml(sample, { bookletSize: 'tabloid' }).html;
    assert.match(half, /\.hymn-music-space\s*{[^}]*height:\s*2\.2in/);
    assert.match(tab, /\.hymn-music-space\s*{[^}]*height:\s*2\.9in/);
  });

  it('two-column creed adds two-column class when twoColumnCreed is set', () => {
    const data = { ...processionalSample, seasonalSettings: { ...(processionalSample.seasonalSettings || {}), twoColumnCreed: true, creedType: 'nicene' } };
    const { html } = renderBookletHtml(data);
    assert.match(html, /class="creed-text two-column"/);
  });

  it('creed stays single-column without twoColumnCreed', () => {
    const { html } = renderBookletHtml(processionalSample);
    assert.doesNotMatch(html, /class="creed-text two-column"/);
  });

  it('rubric alignment style applied when rubricAlignment is set', () => {
    const data = { ...sample, seasonalSettings: { ...(sample.seasonalSettings || {}), rubricAlignment: 'center' } };
    const { html } = renderBookletHtml(data);
    assert.match(html, /text-align:center/);
  });
});

describe('PDF generator — hymn music paste areas', () => {
  async function gen(label, data, opts) {
    const out = path.join(outputDir, label + '.pdf');
    const result = await generatePdf(data, out, opts || {});
    return { result, size: fs.statSync(out).size };
  }

  it('generates successfully with paste areas on (default) for both sizes', async () => {
    for (const size of ['half-letter', 'tabloid']) {
      const { result } = await gen('on-' + size, sample, { bookletSize: size });
      assert.equal(result.pageMaxY.length, 8);
      const L = LAYOUTS[size];
      const bottomEdge = L.pageHeight - L.margin;
      for (let i = 0; i < result.pageMaxY.length; i++) {
        assert.ok(result.pageMaxY[i] <= bottomEdge + 70,
          `${size} page ${i + 1} maxY=${result.pageMaxY[i]} exceeded ${bottomEdge}+70`);
      }
    }
  });

  it('processional sample renders with paste area on page 2', async () => {
    const { result } = await gen('proc-hymn', processionalSample);
    assert.equal(result.pageMaxY.length, 8);
    assert.equal(result.pageCount, 8);
  });

  it('paste areas consume more total vertical space than without', async () => {
    // The flow paginator redistributes blocks across pages, so compare the
    // booklet's TOTAL used height rather than fixed per-page positions.
    const on = (await gen('cmp-on', sample)).result;
    const off = (await gen('cmp-off', { ...sample, reserveHymnSpace: false })).result;
    const total = r => r.pageMaxY.reduce((a, v) => a + v, 0);
    assert.ok(total(on) > total(off),
      `expected total maxY with space (${total(on)}) > without (${total(off)})`);
  });

  it('still fits within page bounds when announcements are long', async () => {
    const announcements = 'Parish picnic next Sunday after the 11 AM Mass. '.repeat(8);
    const { result } = await gen('long-ann', { ...sample, announcements }, { bookletSize: 'half-letter' });
    const L = LAYOUTS['half-letter'];
    const bottomEdge = L.pageHeight - L.margin;
    for (let i = 0; i < result.pageMaxY.length; i++) {
      assert.ok(result.pageMaxY[i] <= bottomEdge + 70,
        `page ${i + 1} maxY=${result.pageMaxY[i]} ran past the margin`);
    }
  });
});
