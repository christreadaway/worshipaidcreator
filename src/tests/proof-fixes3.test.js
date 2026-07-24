// Tests for the director-of-liturgy proof pass #3 (17th Sunday in Ordinary
// Time, July 2026 proof). Each assertion locks in one item the director
// marked up so the layout can't silently regress:
//   - the default width for ALL music notation images is 5 inches
//   - a composer's name is NEVER italicized (title stays italic)
//   - at least an 8pt space above every heading
//   - the Penitential Act shares the page with the entrance hymn: full text
//     -> two columns -> heading only (text omitted, with a warning)
//   - Lord Have Mercy + Glory to God + Collect are one atomic group on a
//     single page
//   - notation title headers are stripped at RENDER time too, so scans
//     stored before the upload-time cropper existed/improved print clean
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { renderBookletHtml } = require('../template-renderer');
const { generatePdf, WorshipAidPdfGenerator } = require('../pdf-generator');
const { renderMusicLineRuns } = require('../music-formatter');
const { stripTitlesFromImages, stripTitleFromBuffer } = require('../notation-resolver');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof3-'));

const musicBlock = {
  organPrelude: 'Adagio from Sonata No. 1', organPreludeComposer: 'Felix Mendelssohn',
  processionalOrEntrance: 'God, We Praise You!',
  kyrieSetting: 'Kyrie', kyrieComposer: 'Palestrina/Covington',
  offertoryAnthem: 'God Be in My Head, Sarum Missal', offertoryAnthemComposer: 'arr. Hopson',
  communionHymn: 'All Who Hunger',
  hymnOfThanksgiving: 'Joyful, Joyful, We Adore You',
  organPostlude: 'Choral Prelude on a tune from Vulpius', organPostludeComposer: 'Healey Willan'
};

const data = {
  feastName: '17th Sunday in Ordinary Time',
  liturgicalDate: '2026-07-26',
  liturgicalSeason: 'ordinary',
  reserveHymnSpace: false,
  seasonalSettings: {
    gloria: true, creedType: 'apostles', entranceType: 'processional',
    holyHolySetting: 'Mass of St. Theresa', mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa', penitentialAct: 'confiteor'
  },
  readings: {
    firstReadingCitation: '1 Kings 3:5, 7-12',
    firstReadingText: 'The LORD appeared to Solomon in a dream at night...',
    psalmCitation: 'Psalm 119:57, 72, 76-77, 127-128, 129-130',
    psalmRefrain: 'Lord, I love your commands.',
    psalmVerses: 'I have said, O LORD, that my part is to keep your words.\n\nFor I love your commands more than gold, however fine.',
    secondReadingCitation: 'Romans 8:28-30',
    secondReadingText: 'Brothers and sisters: We know that all things work for good...',
    gospelAcclamationReference: 'Cf. Matthew 11:25',
    gospelAcclamationVerse: 'Blessed are you, Father, Lord of heaven and earth...',
    gospelCitation: 'Matthew 13:44-52',
    gospelText: 'Jesus said to his disciples: "The kingdom of heaven is like a treasure buried in a field..."'
  },
  musicSat5pm: { ...musicBlock },
  musicSun9am: { ...musicBlock },
  musicSun11am: { ...musicBlock, choralAnthemConcluding: 'Bless the Lord', choralAnthemConcludingComposer: 'Brian Luckner' }
};

// A solid dark PNG of the given pixel size (prints at the 5in spec width).
async function solidPng(width, height) {
  const sharp = require('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#222' } }).png().toBuffer();
}

// Pull every image-draw transform out of each page's deflated content
// stream. Returns one array of {w, h, x} per stream, in file order.
function imageDrawsByStream(pdfPath) {
  const bytes = fs.readFileSync(pdfPath).toString('latin1');
  const streams = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(bytes)) !== null) {
    let txt;
    try { txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
    catch (e) { continue; }
    const draws = [];
    const drawRe = /([\d.]+) 0 0 (-?[\d.]+) ([\d.]+) ([\d.]+) cm\s*\n\/I\d+ Do/g;
    let d;
    while ((d = drawRe.exec(txt)) !== null) {
      draws.push({ w: parseFloat(d[1]), h: Math.abs(parseFloat(d[2])), x: parseFloat(d[3]) });
    }
    streams.push(draws);
  }
  return streams;
}

describe('Proof fixes v3 — composer names are never italicized', () => {
  it('renderMusicLineRuns keeps the title italic and everything else roman', () => {
    const runs = renderMusicLineRuns({
      title: 'Bless the Lord', composer: 'Brian Luckner',
      hymnal: 'Worship IV', hymnNumber: '612', timeLabel: 'Sun, 11 AM'
    });
    assert.deepEqual(runs, [
      { text: 'Bless the Lord', italic: true },
      { text: ' [Worship IV #612]', italic: false },
      { text: ', Brian Luckner', italic: false },
      { text: ' (Sun, 11 AM)', italic: false }
    ]);
  });

  it('classic HTML music lines: roman container, italic <em> title, roman .composer span', () => {
    const { html } = renderBookletHtml({ ...data, design: 'classic' });
    // The prelude line: title in <em>, composer in a .composer span.
    assert.match(html, /<em>Adagio from Sonata No\. 1<\/em><span class="composer">, Felix Mendelssohn<\/span>/);
    // Classic CSS keeps plain inlines (setting names) italic but forces the
    // music container roman so the composer can never inherit italics.
    assert.match(html, /body\.design-classic \.sub-inline\.music\s*{\s*font-style:\s*normal/);
    // The multi-Mass choral list also carries the roman composer span.
    assert.match(html, /<em>Bless the Lord<\/em><span class="composer">, Brian Luckner<\/span>/);
  });

  it('reimagined HTML music lines carry the same roman-composer structure', () => {
    const { html } = renderBookletHtml(data);
    assert.match(html, /<span class="sub-inline music"><em>Adagio from Sonata No\. 1<\/em><span class="composer">, Felix Mendelssohn<\/span>/);
    assert.match(html, /\.sub-inline\.music\s*{\s*font-style:\s*normal/);
  });

  it('PDF renders mixed-style music lines cleanly in both designs', async () => {
    for (const design of ['classic', 'reimagined']) {
      const out = path.join(outputDir, `runs-${design}.pdf`);
      const result = await generatePdf(data, out, { design, bookletSize: 'tabloid' });
      assert.equal(result.pageCount, 8, `${design}: 8 pages`);
      assert.ok(fs.statSync(out).size > 1000, `${design}: non-trivial PDF`);
    }
  });
});

describe('Proof fixes v3 — at least 8pt above every heading', () => {
  it('_padBeforeHeading tops up the gap to 8pt mid-page', () => {
    const gen = new WorshipAidPdfGenerator(data, { bookletSize: 'tabloid' });
    gen.y = 300; gen._lastGapAfter = 3;
    gen._padBeforeHeading();
    assert.equal(gen.y, 305, 'gap of 3 is topped up by 5');
    gen.y = 300; gen._lastGapAfter = 12;
    gen._padBeforeHeading();
    assert.equal(gen.y, 300, 'a gap already >= 8pt gets no extra pad');
  });

  it('_padBeforeHeading skips the pad at the top of a page, but not in dry-run', () => {
    const gen = new WorshipAidPdfGenerator(data, { bookletSize: 'tabloid' });
    gen.y = gen.MARGIN_TOP; gen._lastGapAfter = 0;
    gen._padBeforeHeading();
    assert.equal(gen.y, gen.MARGIN_TOP, 'no pad at the top of a fresh page');
    // Dry-run measurement must assume the worst case (mid-page placement)
    // so a block can never measure shorter than it renders.
    gen._dryRun = true;
    gen.y = gen.MARGIN_TOP; gen._lastGapAfter = 0;
    gen._padBeforeHeading();
    assert.equal(gen.y, gen.MARGIN_TOP + 8, 'dry-run applies the full worst-case pad');
  });

  it('HTML: heading rows and bare headings carry the 8pt minimum, both designs', () => {
    const html = renderBookletHtml(data).html;
    assert.match(html, /\.sub-heading-row\s*{[^}]*margin:\s*8pt 0 2pt/);
    assert.match(html, /div\.sub-heading\s*{\s*margin-top:\s*8pt/);
    const classic = renderBookletHtml({ ...data, design: 'classic' }).html;
    assert.match(classic, /\.c-section\s*{[^}]*margin:\s*8pt 0 5pt/);
  });
});

describe('Proof fixes v3 — Penitential Act shares the entrance-hymn page', () => {
  // The Penitential Act is a "fit block": it adapts to the room left on the
  // page instead of flowing to the next one. Drive the picker through all
  // four outcomes with synthetic fixed-height blocks so the assertions
  // don't depend on font metrics.
  async function runFitScenario(fillerH) {
    const gen = new WorshipAidPdfGenerator(data, { design: 'classic', bookletSize: 'tabloid' });
    const rendered = [];
    const rec = (name, h) => () => { gen.y += h; if (!gen._dryRun) rendered.push(name); };
    gen._buildContentBlocksClassic = () => [
      { render: rec('filler', fillerH) },
      {
        fit: [rec('full', 100), rec('twocol', 45), rec('heading', 10)],
        fitWarnings: [null, null, 'W-heading-only'],
        fitNoneWarning: 'W-omitted'
      }
    ];
    const result = await gen.generate(path.join(outputDir, `fit-${fillerH}.pdf`));
    return { rendered, warnings: result.warnings };
  }

  it('uses the full text when it fits', async () => {
    const { rendered, warnings } = await runFitScenario(300); // 348pt left
    assert.ok(rendered.includes('full'));
    assert.ok(!warnings.some(w => /^W-/.test(w)));
  });

  it('falls back to two columns when the full text does not fit', async () => {
    const { rendered, warnings } = await runFitScenario(590); // 58pt left
    assert.ok(rendered.includes('twocol'));
    assert.ok(!rendered.includes('full'));
    assert.ok(!warnings.some(w => /^W-/.test(w)));
  });

  it('falls back to the heading alone (text omitted) with a warning', async () => {
    const { rendered, warnings } = await runFitScenario(620); // 28pt left
    assert.ok(rendered.includes('heading'));
    assert.ok(!rendered.includes('twocol'));
    assert.ok(warnings.includes('W-heading-only'));
  });

  it('omits the block entirely, loudly, when nothing fits', async () => {
    const { rendered, warnings } = await runFitScenario(645); // 3pt left
    assert.ok(!rendered.includes('full') && !rendered.includes('twocol') && !rendered.includes('heading'));
    assert.ok(warnings.includes('W-omitted'));
  });

  it('both designs expose the Penitential Act as a 3-variant fit block', () => {
    for (const [design, builder] of [['classic', '_buildContentBlocksClassic'], ['reimagined', '_buildContentBlocks']]) {
      const gen = new WorshipAidPdfGenerator(data, { design });
      // Stub every drawing helper so the block builders can run without a doc.
      for (const m of ['musicHeading', 'subHeading', 'ordinaryMusicSpace', 'sectionHeader', 'rubric',
        'bodyText', 'hymnMusicSpace', '_childrenLiturgyBox', '_twoColumnText', '_hangingLabel',
        '_runsLine', '_renderCreedTwoColumn', '_classicFooterBlock', '_textBlock']) {
        gen[m] = () => {};
      }
      const fitBlocks = gen[builder]().filter(bl => Array.isArray(bl.fit));
      assert.equal(fitBlocks.length, 1, `${design}: exactly one fit block (the Penitential Act)`);
      assert.equal(fitBlocks[0].fit.length, 3, `${design}: full text / two columns / heading only`);
      assert.match(fitBlocks[0].fitWarnings[2], /Penitential Act/);
      assert.match(fitBlocks[0].fitNoneWarning, /Penitential Act/);
    }
  });

  it('an ordinary aid still prints the full Penitential Act with no warnings', async () => {
    const out = path.join(outputDir, 'penact-normal.pdf');
    const result = await generatePdf(data, out, { design: 'classic', bookletSize: 'tabloid' });
    assert.ok(!result.warnings.some(w => /Penitential Act/.test(w)),
      `no Penitential Act warnings, got: ${result.warnings.join(' | ')}`);
  });
});

describe('Proof fixes v3 — Lord Have Mercy + Gloria + Collect on one page', () => {
  it('the three render as ONE atomic block in both designs', () => {
    for (const [design, builder, kyrieHeading] of [
      ['classic', '_buildContentBlocksClassic', 'Lord Have Mercy'],
      ['reimagined', '_buildContentBlocks', 'Lord, Have Mercy']
    ]) {
      const gen = new WorshipAidPdfGenerator(data, { design });
      const calls = [];
      gen.musicHeading = (h) => calls.push(h);
      gen.subHeading = (h) => calls.push(h);
      gen.sectionHeader = (t) => calls.push(t);
      for (const m of ['ordinaryMusicSpace', 'rubric', 'bodyText', 'hymnMusicSpace', '_childrenLiturgyBox',
        '_twoColumnText', '_hangingLabel', '_runsLine', '_renderCreedTwoColumn', '_classicFooterBlock', '_textBlock']) {
        gen[m] = () => {};
      }
      const blocks = gen[builder]();
      let group = null;
      for (const bl of blocks) {
        if (!bl.render) continue;
        calls.length = 0;
        bl.render();
        if (calls.includes(kyrieHeading)) { group = { block: bl, calls: [...calls] }; break; }
      }
      assert.ok(group, `${design}: found the Lord Have Mercy block`);
      assert.ok(group.calls.some(c => /Gloria|Glory to God/.test(c)),
        `${design}: Gloria is in the same block (${group.calls.join(', ')})`);
      assert.ok(group.calls.includes('Collect'), `${design}: Collect is in the same block`);
      assert.equal(group.block.keepNext, true,
        `${design}: the group keeps the Liturgy of the Word opening with it`);
    }
  });

  it('kyrie + gloria notation images print on the same page (same content stream)', async () => {
    const kyrie = await solidPng(800, 300);   // ~135pt tall at the 5in width
    const gloria = await solidPng(800, 800);  // ~360pt tall at the 5in width
    const out = path.join(outputDir, 'same-page.pdf');
    const result = await generatePdf({ ...data, reserveHymnSpace: true }, out, {
      design: 'classic', bookletSize: 'tabloid',
      notationImages: { kyrie, gloria }
    });
    assert.equal(result.pageCount, 8);
    assert.ok(!result.warnings.some(w => /reduced to fit|too full to place/.test(w)),
      `no shrink warnings, got: ${result.warnings.join(' | ')}`);
    const streams = imageDrawsByStream(out);
    const together = streams.find(draws =>
      draws.some(d => Math.abs(d.h - 135) < 10) && draws.some(d => Math.abs(d.h - 360) < 10));
    assert.ok(together, 'one page carries BOTH the kyrie and gloria draws');
    // And both print at the 5in spec width (360pt), centered.
    for (const d of together) {
      assert.ok(Math.abs(d.w - 360) < 1.5, `5in spec width (got ${d.w})`);
      assert.ok(Math.abs(d.x - (72 + (468 - d.w) / 2)) < 1, `centered (x=${d.x})`);
    }
  });
});

describe('Proof fixes v3 — notation titles stripped at render time', () => {
  const sharp = require('sharp');

  // Synthetic notation scan built from raw pixels (no fonts needed): an
  // optional title band, a white gap, then staff systems of thin
  // full-width lines. 480px wide = the detector's analysis width, so rows
  // map 1:1 and the fixture is fully deterministic.
  function buildScan({ withTitle, height = 700, staves = [260, 470] }) {
    const W = 480, H = height;
    const img = Buffer.alloc(W * H, 255);
    const band = (x0, x1, y0, y1) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img[y * W + x] = 20;
    };
    if (withTitle) band(150, 300, 20, 48); // "GOSPEL ACCLAMATION"-ish: ~31% ink per row
    for (const top of staves) {
      // 5 thin lines (2 rows) with 10-row gaps — a staff system.
      for (const sy of [top, top + 12, top + 24, top + 36, top + 48]) band(20, 460, sy, sy + 2);
    }
    return sharp(img, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  }

  it('stripTitleFromBuffer crops a title band above the first staff', async () => {
    const titled = await buildScan({ withTitle: true });
    const { buffer, cropped } = await stripTitleFromBuffer(titled);
    assert.equal(cropped, true);
    const meta = await sharp(buffer).metadata();
    // The crop lands in the 48..260 white gap (minus breathing room).
    assert.ok(meta.height < 700 - 48 && meta.height > 700 - 260,
      `title band removed (height now ${meta.height})`);
  });

  it('handles the wide-short single-staff shape (a Gospel Acclamation refrain)', async () => {
    const refrain = await buildScan({ withTitle: true, height: 300, staves: [180] });
    const { cropped, buffer } = await stripTitleFromBuffer(refrain);
    assert.equal(cropped, true);
    const meta = await sharp(buffer).metadata();
    assert.ok(meta.height < 300 - 48, `title removed from the refrain scan (height now ${meta.height})`);
  });

  it('stripTitlesFromImages crops only slots that carry a title and reports them', async () => {
    const titled = await buildScan({ withTitle: true });
    const clean = await buildScan({ withTitle: false });
    const { images, cropped } = await stripTitlesFromImages({ gospelAcclamation: titled, kyrie: clean });
    assert.deepEqual(cropped, ['gospelAcclamation']);
    assert.ok(images.gospelAcclamation.length !== titled.length || !images.gospelAcclamation.equals(titled),
      'titled image was re-encoded smaller');
    assert.ok(images.kyrie.equals(clean), 'clean image passes through byte-identical');
  });

  it('is idempotent and cache-stable across repeated calls', async () => {
    const titled = await buildScan({ withTitle: true });
    const first = await stripTitleFromBuffer(titled);
    const second = await stripTitleFromBuffer(titled); // cache path
    assert.ok(first.buffer.equals(second.buffer));
    const again = await stripTitleFromBuffer(first.buffer); // already cropped
    assert.equal(again.cropped, false);
  });
});
