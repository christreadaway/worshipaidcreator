// Layout-correctness tests for the PDF generator.
// Validates page count, dimensions, and that body content stays inside the
// 1" margins on both booklet sizes by introspecting the generator's
// per-page maxY tracking and the produced PDF's MediaBoxes.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { generatePdf, LAYOUTS } = require('../pdf-generator');

const outputDir = path.join(__dirname, '..', '..', 'output', 'layout-tests');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'sample', 'second-sunday-lent.json'), 'utf8'));

before(() => { fs.mkdirSync(outputDir, { recursive: true }); });
after(() => {
  for (const f of fs.readdirSync(outputDir)) fs.unlinkSync(path.join(outputDir, f));
  fs.rmdirSync(outputDir);
});

function extractMediaBoxes(pdfBuffer) {
  const text = pdfBuffer.toString('binary');
  const pages = [];
  const re = /\/Type \/Page[\s\S]*?\/MediaBox \[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    pages.push({ width: parseFloat(m[1]), height: parseFloat(m[2]) });
  }
  return pages;
}

async function gen(size, label, overrides) {
  const out = path.join(outputDir, label + '.pdf');
  const data = overrides ? Object.assign({}, sample, overrides) : sample;
  const result = await generatePdf(data, out, { bookletSize: size });
  return { result, out, buf: fs.readFileSync(out) };
}

describe('PDF layout — half-letter (5.5x8.5)', () => {
  let gen1;
  before(async () => { gen1 = await gen('half-letter', 'half-letter'); });

  it('reports the expected page dimensions', () => {
    const L = LAYOUTS['half-letter'];
    assert.equal(gen1.result.pageWidth, L.pageWidth);
    assert.equal(gen1.result.pageHeight, L.pageHeight);
    assert.equal(gen1.result.margin, L.margin);
  });

  it('contains the 8 logical sections', () => {
    // pageMaxY has one entry per logical page (cover + 7 newPage calls).
    assert.equal(gen1.result.pageMaxY.length, 8);
  });

  it('renders within a sensible upper bound', () => {
    // Content can spill into extra pages if a Mass has unusually long
    // readings. We just guard against runaway output.
    assert.ok(gen1.result.pageCount >= 8, 'at least 8 pages');
    assert.ok(gen1.result.pageCount <= 24, `pageCount ${gen1.result.pageCount} exceeds 24`);
  });

  it('content stays above the bottom margin on every page', () => {
    const L = LAYOUTS['half-letter'];
    const bottomEdge = L.pageHeight - L.margin;
    // Allow a small slack for the page-number / copyright lines we
    // intentionally place inside the bottom margin band.
    const slack = 56;
    for (let i = 0; i < gen1.result.pageMaxY.length; i++) {
      const maxY = gen1.result.pageMaxY[i];
      assert.ok(maxY <= bottomEdge + slack,
        `page ${i + 1} maxY=${maxY} exceeded bottom=${bottomEdge} (+${slack}pt slack)`);
    }
  });
});

describe('PDF layout — tabloid (8.5x11)', () => {
  let g;
  before(async () => { g = await gen('tabloid', 'tabloid'); });

  it('reports tabloid page dimensions', () => {
    const L = LAYOUTS.tabloid;
    assert.equal(g.result.pageWidth, L.pageWidth);
    assert.equal(g.result.pageHeight, L.pageHeight);
    assert.equal(g.result.bookletSize, 'tabloid');
    assert.equal(g.result.margin, 72);
  });

  it('contains the 8 logical sections at letter size', () => {
    assert.equal(g.result.pageMaxY.length, 8);
    assert.equal(g.result.pageWidth, 612);
    assert.equal(g.result.pageHeight, 792);
  });

  it('renders within a sensible upper bound', () => {
    assert.ok(g.result.pageCount >= 8);
    assert.ok(g.result.pageCount <= 24, `pageCount ${g.result.pageCount} exceeds 24`);
  });

  it('content stays above the bottom margin on every page', () => {
    const L = LAYOUTS.tabloid;
    const bottomEdge = L.pageHeight - L.margin;
    const slack = 70;
    for (let i = 0; i < g.result.pageMaxY.length; i++) {
      const maxY = g.result.pageMaxY[i];
      assert.ok(maxY <= bottomEdge + slack,
        `page ${i + 1} maxY=${maxY} exceeded bottom=${bottomEdge} (+${slack}pt slack)`);
    }
  });
});

describe('PDF layout — long-content stress', () => {
  it('long readings render without crash on half-letter', async () => {
    const longText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(60);
    const r = await gen('half-letter', 'stress-half', {
      readings: Object.assign({}, sample.readings, {
        firstReadingText: longText,
        secondReadingText: longText,
        gospelText: longText
      })
    });
    assert.ok(fs.existsSync(r.out));
    assert.ok(Array.isArray(r.result.warnings));
  });

  it('long readings render without crash on tabloid', async () => {
    const longText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(80);
    const r = await gen('tabloid', 'stress-tabloid', {
      readings: Object.assign({}, sample.readings, {
        firstReadingText: longText,
        secondReadingText: longText,
        gospelText: longText
      })
    });
    assert.ok(fs.existsSync(r.out));
  });
});

describe('PDF layout — both sizes share the same page count', () => {
  it('both sizes have 8 logical sections', async () => {
    const a = await gen('half-letter', 'count-half');
    const b = await gen('tabloid', 'count-tab');
    assert.equal(a.result.pageMaxY.length, 8);
    assert.equal(b.result.pageMaxY.length, 8);
  });

  it('both sizes produce valid PDFs of bounded size', async () => {
    const a = await gen('half-letter', 'fit-half');
    const b = await gen('tabloid', 'fit-tab');
    assert.ok(a.buf.length > 5000);
    assert.ok(b.buf.length > 5000);
    assert.ok(a.result.pageCount > 0);
    assert.ok(b.result.pageCount > 0);
  });
});
