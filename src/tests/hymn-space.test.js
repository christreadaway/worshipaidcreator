// Reserved hymn-music paste areas.
// OneLicense has no public API, so the booklet intentionally leaves a blank
// area under each congregational hymn slot (processional, communion,
// thanksgiving) for the parish to paste licensed notation by hand.
// These tests cover both renderers and the default-on/opt-out behavior.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderBookletHtml } = require('../template-renderer');
const { generatePdf, LAYOUTS } = require('../pdf-generator');

const outputDir = path.join(__dirname, '..', '..', 'output', 'hymn-space-tests');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'sample', 'second-sunday-lent.json'), 'utf8'));

before(() => { fs.mkdirSync(outputDir, { recursive: true }); });
after(() => {
  for (const f of fs.readdirSync(outputDir)) fs.unlinkSync(path.join(outputDir, f));
  fs.rmdirSync(outputDir);
});

describe('HTML renderer — hymn music paste areas', () => {
  it('renders three paste areas by default (processional, communion, thanksgiving)', () => {
    const { html } = renderBookletHtml(sample);
    const matches = html.match(/class="hymn-music-space"/g) || [];
    assert.equal(matches.length, 3);
    assert.match(html, /paste licensed notation here/);
  });

  it('places paste areas on pages 2, 6, and 7', () => {
    const { html } = renderBookletHtml(sample);
    for (const page of [2, 6, 7]) {
      const start = html.indexOf(`id="page-${page}"`);
      const end = html.indexOf(`id="page-${page + 1}"`);
      const section = html.slice(start, end === -1 ? undefined : end);
      assert.match(section, /hymn-music-space/, `page ${page} should contain a paste area`);
    }
  });

  it('omits paste areas when reserveHymnSpace is false', () => {
    const { html } = renderBookletHtml({ ...sample, reserveHymnSpace: false });
    assert.doesNotMatch(html, /class="hymn-music-space"/);
  });

  it('sizes the paste area per booklet geometry', () => {
    const half = renderBookletHtml(sample, { bookletSize: 'half-letter' }).html;
    const tab = renderBookletHtml(sample, { bookletSize: 'tabloid' }).html;
    assert.match(half, /\.hymn-music-space\s*{[^}]*height:\s*2\.2in/);
    assert.match(tab, /\.hymn-music-space\s*{[^}]*height:\s*2\.9in/);
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
      // Same slack the layout suite allows for page numbers / copyright
      // lines intentionally placed inside the bottom margin band.
      for (let i = 0; i < result.pageMaxY.length; i++) {
        assert.ok(result.pageMaxY[i] <= bottomEdge + 70,
          `${size} page ${i + 1} maxY=${result.pageMaxY[i]} exceeded ${bottomEdge}+70`);
      }
    }
  });

  it('pushes content lower on pages 2, 6, 7 than with paste areas off', async () => {
    const on = (await gen('cmp-on', sample)).result;
    const off = (await gen('cmp-off', { ...sample, reserveHymnSpace: false })).result;
    // pageMaxY is 0-indexed: pages 2, 6, 7 are indices 1, 5, 6.
    for (const idx of [1, 5, 6]) {
      assert.ok(on.pageMaxY[idx] > off.pageMaxY[idx],
        `page ${idx + 1}: expected maxY with space (${on.pageMaxY[idx]}) > without (${off.pageMaxY[idx]})`);
    }
  });

  it('still fits within page bounds when announcements are long', async () => {
    const announcements = 'Parish picnic next Sunday after the 11 AM Mass. '.repeat(8);
    const { result } = await gen('long-ann', { ...sample, announcements });
    const L = LAYOUTS['half-letter'];
    assert.ok(result.pageMaxY[6] <= L.pageHeight - L.margin + 70,
      `page 7 maxY=${result.pageMaxY[6]} ran past the margin`);
  });
});
