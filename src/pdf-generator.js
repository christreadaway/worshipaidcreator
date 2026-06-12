// PDF generation using PDFKit
// Supports two finished booklet sizes:
//   - half-letter:  5.5" x 8.5"  (printed 8.5x11 folded saddle-stitch)
//   - tabloid:      8.5" x 11"   (printed 11x17 folded saddle-stitch)
// Both use 1" margins and scale fonts/spacing proportionally so layouts
// stay visually consistent. Imposition for saddle-stitch is left to the
// printer driver (Acrobat / PDF reader booklet print mode).
'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { APOSTLES_CREED, NICENE_CREED, RENEWAL_OF_BAPTISMAL_VOWS } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, LORDS_PRAYER, getHolyHolyHolyText } = require('./assets/text/mass-texts');
const { getDefaultCopyrightFull, getDefaultCopyrightShort } = require('./assets/text/copyright');
const { formatMusicSlot, renderMusicLineText } = require('./music-formatter');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');
const { getImageDimensions } = require('./image-utils');

// 72pt = 1 inch
const PT = 72;

// Default printed widths for uploaded music images, in inches on the
// 8.5in-wide (tabloid) page — the parish's spec: service music 6in,
// hymns + responsorial psalm refrain 5in, all centered. Other trims scale
// proportionally to their page width.
const NOTATION_WIDTHS_IN = {
  processional: 5, communion: 5, thanksgiving: 5, psalmRefrain: 5,
  kyrie: 6, gloria: 6, sanctus: 6, mysteryOfFaith: 6, lambOfGod: 6,
  gospelAcclamation: 6
};

// Embedded TrueType fonts — Liberation Sans covers the full Latin Unicode
// range (curly quotes, em/en dashes, accented chars, currency symbols)
// that Helvetica's WinAnsi encoding silently drops.
//
// The fonts are vendored in src/assets/fonts (SIL OFL) so they ship with
// the code everywhere — including Netlify Lambda, where neither the system
// font directory nor pdfkit's bundled .afm metric files exist (the v1.5
// "ENOENT .../data/Helvetica.afm" export crash). Candidate paths cover the
// local checkout, the Lambda bundle layout (cwd = /var/task), and the
// system install as a last resort.
const FONT_FILES = {
  'Sans':            'LiberationSans-Regular.ttf',
  'Sans-Bold':       'LiberationSans-Bold.ttf',
  'Sans-Italic':     'LiberationSans-Italic.ttf',
  'Sans-BoldItalic': 'LiberationSans-BoldItalic.ttf'
};

function resolveFontDir() {
  const candidates = [
    path.join(__dirname, 'assets', 'fonts'),                    // src/ locally
    path.join(process.cwd(), 'src', 'assets', 'fonts'),         // /var/task on Lambda
    path.join(__dirname, '..', 'src', 'assets', 'fonts'),       // bundle one level deep
    path.join(__dirname, '..', '..', 'src', 'assets', 'fonts'), // netlify/functions bundle
    '/usr/share/fonts/truetype/liberation'                       // system install
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, FONT_FILES.Sans))) return dir;
    } catch (e) { /* keep looking */ }
  }
  return null;
}

let _fontDirWarned = false;
function resolveFontPaths() {
  const dir = resolveFontDir();
  if (!dir) {
    if (!_fontDirWarned) {
      _fontDirWarned = true;
      console.warn('[pdf] Liberation Sans fonts not found in any candidate dir — falling back to built-in Helvetica (reduced character coverage).');
    }
    // Built-in PDF fonts; only works where pdfkit's .afm data files exist.
    return { 'Sans': 'Helvetica', 'Sans-Bold': 'Helvetica-Bold', 'Sans-Italic': 'Helvetica-Oblique', 'Sans-BoldItalic': 'Helvetica-BoldOblique' };
  }
  const out = {};
  for (const [name, file] of Object.entries(FONT_FILES)) out[name] = path.join(dir, file);
  return out;
}

// Layouts. All values in PDF points (72 = 1 inch).
// Tabloid uses 1" margins (page is large enough that this still leaves a
// comfortable 6.5"×9" content rectangle). Half-letter would be too tight at
// 1" (3.5"×6.5"), so we use 0.5" there to keep the standard 8-page Mass
// booklet from overflowing onto extra pages.
const LAYOUTS = {
  'half-letter': {
    pageWidth:  5.5 * PT,
    pageHeight: 8.5 * PT,
    margin:     0.5 * PT,
    scale:      1.0
  },
  tabloid: {
    pageWidth:  8.5 * PT,
    pageHeight: 11.0 * PT,
    margin:     1.0 * PT,
    // Scale fonts and spacing proportionally to page height so larger
    // booklets feel similar in density. 8.5*11 / 5.5*8.5 in linear height.
    scale:      11.0 / 8.5  // ≈ 1.294
  }
};

const COLORS = {
  navy: '#1A2E4A',
  burgundy: '#6B1A1A',
  gold: '#B8922A',
  text: '#1C1C1C',
  muted: '#555555',
  light: '#888888',
  rule: '#C8A84B',
  purple: '#5b3d8f'
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function resolveLayout(bookletSize) {
  return LAYOUTS[bookletSize] || LAYOUTS['half-letter'];
}

class WorshipAidPdfGenerator {
  constructor(data, options = {}) {
    this.data = applySeasonDefaults(data);
    this.options = options;
    this.warnings = [];
    this.ss = this.data.seasonalSettings || {};
    this.r = this.data.readings || {};
    this.parishSettings = options.parishSettings || {};
    // Per-slot notation images, pre-resolved to PNG/JPEG buffers by the
    // caller (the server loads them from disk or Netlify Blobs). Keys match
    // data.notationImages slots: processional, communion, thanksgiving,
    // kyrie, gloria, sanctus, mysteryOfFaith, lambOfGod, psalmRefrain,
    // gospelAcclamation.
    this.notationImages = options.notationImages || {};

    // Match the HTML renderer: caller option > per-aid field > tabloid.
    this.bookletSize = options.bookletSize || data.bookletSize || 'tabloid';
    const L = resolveLayout(this.bookletSize);
    this.PAGE_WIDTH    = L.pageWidth;
    this.PAGE_HEIGHT   = L.pageHeight;
    this.MARGIN        = L.margin;
    this.MARGIN_TOP    = L.margin;
    this.MARGIN_SIDE   = L.margin;
    this.CONTENT_WIDTH = this.PAGE_WIDTH - 2 * this.MARGIN;
    this.scale         = L.scale;

    const overflows = detectOverflows(this.data);
    overflows.forEach(o => this.warnings.push(o.message));

    const isLenten = this.data.liturgicalSeason === 'lent';
    const isAdvent = this.data.liturgicalSeason === 'advent';
    this.includePostlude = this.ss.includePostlude !== undefined ? this.ss.includePostlude : !isLenten;
    this.showAdventWreath = this.ss.adventWreath !== undefined ? this.ss.adventWreath : isAdvent;

    // Page-level state used by tests and bounds tracking
    this._maxYReached = 0;
    this.pageEvents = [];
    this._pageNo = 1;
    // True when the current page carries an embedded notation image — the
    // short license line prints in that page's footer.
    this._pageHasNotation = false;

    // 8-page guarantee state: global shrink factor for body text AND
    // notation images, and the dry-run flag used while measuring blocks.
    this.textScale = 1;
    this._dryRun = false;
    this._clipWarnedPage = 0;
  }

  // Scale a base font/spacing value by the layout's scale factor.
  s(n) { return n * this.scale; }

  generate(outputPath) {
    return new Promise((resolve, reject) => {
      const fontPaths = resolveFontPaths();
      const doc = new PDFDocument({
        size: [this.PAGE_WIDTH, this.PAGE_HEIGHT],
        margins: { top: this.MARGIN_TOP, bottom: this.MARGIN_TOP, left: this.MARGIN_SIDE, right: this.MARGIN_SIDE },
        bufferPages: true,
        // Never load the default Helvetica at construction: its .afm metric
        // files don't exist in serverless bundles. We register and select
        // our embedded fonts explicitly before any text is written.
        font: null,
        info: {
          Title: `Worship Aid — ${this.data.feastName}`,
          Author: 'Worship Aid Generator',
          Subject: this.data.feastName,
          CreationDate: new Date()
        }
      });

      for (const [name, filePath] of Object.entries(fontPaths)) {
        doc.registerFont(name, filePath);
      }
      doc.font('Sans');

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);
      this.doc = doc;
      this.y = this.MARGIN_TOP;

      try {
        this.renderPage1Cover();
        this.renderContentFlow();
        // Capture the final page's maxY for layout introspection.
        this.pageEvents.push({ maxY: this._maxYReached });
        const bufferedPageCount = doc.bufferedPageRange().count;
        doc.end();
        const pageMaxY = this.pageEvents.map(p => p.maxY);
        stream.on('finish', () => resolve({
          outputPath,
          warnings: this.warnings,
          bookletSize: this.bookletSize,
          pageWidth: this.PAGE_WIDTH,
          pageHeight: this.PAGE_HEIGHT,
          margin: this.MARGIN,
          pageMaxY,
          pageCount: bufferedPageCount
        }));
        stream.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Track the lowest Y coordinate written on the current page so tests can
  // verify no content has run past the bottom margin.
  _trackY() {
    // Dry-run measurement must never pollute the real bounds tracking.
    if (this._dryRun) return;
    if (this.doc.y > this._maxYReached) this._maxYReached = this.doc.y;
    if (this.y > this._maxYReached)     this._maxYReached = this.y;
  }

  newPage() {
    this.pageEvents.push({ maxY: this._maxYReached });
    this._maxYReached = 0;
    this.doc.addPage();
    this.y = this.MARGIN_TOP;
    this._pageNo++;
  }

  // Write text inside the bottom margin band (folios, copyright lines)
  // without letting PDFKit auto-add a page — it page-breaks any text whose
  // baseline crosses the bottom margin, which used to inject a near-blank
  // page after every section.
  _footerText(str, y, opts = {}) {
    const prevBottom = this.doc.page.margins.bottom;
    this.doc.page.margins.bottom = 0;
    this.doc.fontSize(opts.size || this.s(7)).fillColor(opts.color || COLORS.light)
      .text(str, opts.x !== undefined ? opts.x : this.MARGIN_SIDE, y,
        { width: opts.width !== undefined ? opts.width : this.CONTENT_WIDTH, align: 'center',
          lineBreak: opts.lineBreak !== false });
    this.doc.page.margins.bottom = prevBottom;
  }

  pageNumber(num) {
    this._footerText(String(num), this.PAGE_HEIGHT - this.MARGIN * 0.6, { x: 0, width: this.PAGE_WIDTH });
  }

  // Bottom edge of the writable area on the current page.
  _bottom() { return this.PAGE_HEIGHT - this.MARGIN; }

  // Warn (once per logical page) that content had to be truncated to keep
  // the booklet at exactly 8 pages.
  _warnClipped() {
    if (this._dryRun) return;
    const page = this.pageEvents.length + 1;
    if (this._clipWarnedPage === page) return;
    this._clipWarnedPage = page;
    this.warnings.push(`Page ${page}: content was truncated to keep the booklet at 8 pages — shorten the text on this page.`);
  }

  // Normalize text for the embedded Liberation Sans font.  The only common
  // characters outside its coverage are decorative liturgical crosses.
  _normalizeText(str) {
    if (!str) return str;
    return String(str)
      .replace(/☩/g, '†')   // Cross of Jerusalem → dagger (†)
      .replace(/✝/g, '†')  // Latin cross → dagger
      .replace(/✠/g, '†'); // Maltese cross → dagger
  }

  // Write a text block at this.y, clamped to the current page. Never lets
  // PDFKit auto-add a page: if the block doesn't fully fit it is truncated
  // with an ellipsis and a warning is recorded. In dry-run mode nothing is
  // drawn — this.y just advances by the measured height (used by
  // _fitPageText to shrink-to-fit a page before really rendering it).
  // Returns the measured height of the full (unclamped) block.
  _textBlock(text, x, textOpts, advanceAfter) {
    text = this._normalizeText(text);
    const h = this.doc.heightOfString(text, textOpts);
    if (this._dryRun) {
      this.y += h + advanceAfter;
      return h;
    }
    const remaining = this._bottom() - this.y;
    if (remaining < this.doc.currentLineHeight(true)) {
      this._warnClipped();
      return h;
    }
    const opts = { ...textOpts };
    if (h > remaining) {
      opts.height = remaining;
      opts.ellipsis = true;
      this._warnClipped();
    }
    this.doc.text(text, x, this.y, opts);
    this.y = Math.min(this.doc.y, this._bottom()) + advanceAfter;
    this._trackY();
    return h;
  }

  sectionHeader(text) {
    this.doc.fontSize(this.s(11)).fillColor(COLORS.navy).font('Sans-Bold');
    const ruleY = this.y + this.doc.heightOfString(text.toUpperCase(), { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 }) + this.s(2);
    this._textBlock(text.toUpperCase(), this.MARGIN_SIDE,
      { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 }, this.s(8));
    if (!this._dryRun) {
      this.doc.save()
        .moveTo(this.MARGIN_SIDE + this.s(40), ruleY)
        .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE - this.s(40), ruleY)
        .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
    }
    this.doc.font('Sans');
  }

  subHeading(text) {
    this.doc.fontSize(this.s(8)).fillColor(COLORS.burgundy).font('Sans-Bold');
    this._textBlock(text.toUpperCase(), this.MARGIN_SIDE,
      { width: this.CONTENT_WIDTH, characterSpacing: 0.8 }, this.s(2));
    this.doc.font('Sans');
  }

  rubric(text, align) {
    const a = align || this.ss.rubricAlignment || 'left';
    this.doc.fontSize(this.s(7.5)).fillColor('#8B0000').font('Sans-Italic');
    this._textBlock(text, this.MARGIN_SIDE, { width: this.CONTENT_WIDTH, align: a }, this.s(2));
    this.doc.font('Sans');
  }

  bodyText(text, opts = {}) {
    if (!text) return;
    // Single consistent body-text size throughout — textScale shrinks it
    // only when _fitPageText needs to fit a page.
    const baseSize = 9;
    this.doc.fontSize(this.s(baseSize) * this.textScale)
      .fillColor(opts.color || COLORS.text)
      .font(opts.bold ? 'Sans-Bold' : opts.italic ? 'Sans-Italic' : 'Sans');
    const x = opts.x !== undefined ? opts.x : this.MARGIN_SIDE;
    const width = opts.width !== undefined ? opts.width : this.CONTENT_WIDTH;
    this._textBlock(text, x, {
      width,
      align: opts.align || 'left',
      lineGap: this.s(1) * this.textScale
    }, this.s(opts.gap !== undefined ? opts.gap : 3));
    this.doc.font('Sans');
  }

  citation(text) {
    this.bodyText(text, { bold: true, size: 8.5, color: '#333333', gap: 1 });
  }

  musicLine(titleField, composerField, label) {
    const items = formatMusicSlot(this.data, titleField, composerField);
    if (items.length === 0) return;
    for (const item of items) {
      const text = `${label} — ${renderMusicLineText(item)}`;
      this.doc.fontSize(this.s(9) * this.textScale).fillColor(COLORS.text).font('Sans-Italic');
      this._textBlock(text, this.MARGIN_SIDE, { width: this.CONTENT_WIDTH }, this.s(2));
    }
    this.doc.font('Sans');
  }

  // FLOW LAYOUT ============================================
  // The liturgy is a sequence of atomic blocks (a heading plus its prayer
  // text, a hymn line plus its notation image, one paragraph of a reading,
  // ...). Pages 2-8 are NOT fixed section slots: blocks are measured and
  // packed in order, breaking to a new page whenever the next block's real
  // height doesn't fit — so the layout is conditional on the vertical
  // height of the actual hymns, prayers, and readings. Hard rules:
  //   * a block is never split (music and its heading stay together);
  //   * nothing is ever dropped silently — if the content can't fit the
  //     7 content pages even at 75% scale, the overflow is truncated on
  //     page 8 WITH a warning the editor surfaces at export.

  // Height of a block as if rendered from the top of a fresh page.
  _measureBlock(block) {
    this._dryRun = true;
    const y0 = this.y;
    this.y = this.MARGIN_TOP;
    block.render();
    const h = this.y - this.MARGIN_TOP;
    this._dryRun = false;
    this.y = y0;
    return h;
  }

  _countPagesNeeded(blocks) {
    const pageH = this._bottom() - this.MARGIN_TOP;
    let pages = 1;
    let y = this.MARGIN_TOP;
    for (const block of blocks) {
      const h = Math.min(this._measureBlock(block), pageH);
      if (h > this._bottom() - y && y > this.MARGIN_TOP + 1) {
        pages++;
        y = this.MARGIN_TOP;
      }
      y += h;
    }
    return pages;
  }

  // Folio + (when the page carries licensed notation) the short license
  // line, then reset the per-page notation flag.
  _finishContentPage(pageNo) {
    if (this._pageHasNotation) {
      let line = String(this.parishSettings.copyrightShort ||
        getDefaultCopyrightShort(this.parishSettings.onelicenseNumber)).replace(/\s+/g, ' ').trim();
      this.doc.font('Sans').fontSize(this.s(7));
      if (this.doc.widthOfString(line) > this.CONTENT_WIDTH) {
        while (line.length > 1 && this.doc.widthOfString(line + '…') > this.CONTENT_WIDTH) {
          line = line.slice(0, -1);
        }
        line = line.trimEnd() + '…';
      }
      this._footerText(line, this.PAGE_HEIGHT - this.MARGIN * 0.85, { lineBreak: false });
      this._pageHasNotation = false;
    }
    this.pageNumber(pageNo);
  }

  renderContentFlow() {
    const blocks = this._buildContentBlocks();

    // Global shrink: text and notation images scale together (floor 0.75)
    // until the whole liturgy packs into the 7 content pages.
    let scale = 1;
    for (;;) {
      this.textScale = scale;
      if (this._countPagesNeeded(blocks) <= 7 || scale <= 0.751) break;
      scale = Math.max(0.75, scale - 0.05);
    }
    this.textScale = scale;
    if (scale < 1) {
      this.warnings.push(`Content was scaled to ${Math.round(scale * 100)}% to fit the 8-page booklet.`);
    }

    this.newPage();
    let pageNo = 2;
    for (const block of blocks) {
      const h = this._measureBlock(block);
      const remaining = this._bottom() - this.y;
      if (h > remaining + 1 && pageNo < 8 && this.y > this.MARGIN_TOP + 1) {
        this._finishContentPage(pageNo);
        this.newPage();
        pageNo++;
      }
      // On page 8 with no room left, the block's own clamps truncate it
      // with a loud warning — never a ninth page, never a silent drop.
      block.render();
    }
    this._finishContentPage(pageNo);

    // Saddle-stitch booklets print in multiples of 4 — pad to 8 pages.
    while (pageNo < 8) {
      this.newPage();
      pageNo++;
      this.pageNumber(pageNo);
    }
    this.textScale = 1;
  }

  // True when this slot will render music (an uploaded image or a reserved
  // paste box) instead of spoken text. Mirrors the HTML renderer.
  _slotHasMusic(slot) {
    return !!this.notationImages[slot] || this.data.reserveHymnSpace !== false;
  }

  // Draw an uploaded notation image at its slot's spec width, centered,
  // keeping proportions. Music is NEVER split across pages and NEVER cut
  // off: the flow paginator gives the image a fresh page when it doesn't
  // fit the current one, and an image taller than a full page shrinks
  // proportionally — smaller, but complete.
  // Returns true when the slot had an image (drawn or dry-run-measured).
  // Spec width for a slot's music image: inches on the tabloid page,
  // proportional on other trims, never wider than the content area.
  _notationTargetWidth(slot) {
    const inches = NOTATION_WIDTHS_IN[slot] || 6;
    return Math.min(inches * PT * (this.PAGE_WIDTH / (8.5 * PT)), this.CONTENT_WIDTH);
  }

  _notationImage(slot, maxHBase, opts = {}) {
    const buf = this.notationImages[slot];
    if (!buf) return false;
    const available = this._bottom() - this.y;
    const dims = getImageDimensions(buf);

    // Natural size at the slot's spec width (6in service music / 5in hymns
    // and psalm refrain on tabloid). textScale: when the flow engine
    // shrinks the booklet to fit 8 pages, images shrink with the text so
    // the layout compresses evenly instead of starving the last slot.
    let drawW = this._notationTargetWidth(slot) * this.textScale;
    let drawH = dims ? (dims.height / dims.width) * drawW : this.s(maxHBase);

    // Hymn slots are uncapped (a full-page hymn owns its page); ordinary
    // parts keep a height cap. Shrink keeps the image complete.
    const maxH = opts.uncapped ? Infinity : this.s(maxHBase) * this.textScale;
    const capH = Math.min(maxH, available);
    if (capH < this.s(20)) {
      // NEVER silent: the flow paginator should have prevented this; if a
      // page still can't take the image, say so.
      if (!this._dryRun) this.warnings.push(`Page is too full to place the ${slot} notation image.`);
      return true; // the slot HAS music; we just couldn't fit it
    }
    if (drawH > capH) {
      drawW = drawW * (capH / drawH);
      drawH = capH;
    }
    if (this._dryRun) {
      this.y += drawH + this.s(4);
      return true;
    }
    const drawX = this.MARGIN_SIDE + (this.CONTENT_WIDTH - drawW) / 2;
    try {
      this.doc.image(buf, drawX, this.y, { width: drawW, height: drawH });
      this._pageHasNotation = true;
      this.y += drawH + this.s(4);
      this._trackY();
    } catch (e) {
      this.warnings.push(`Could not embed ${slot} notation image: ${e.message}`);
      return false; // fall back to the paste box
    }
    return true;
  }

  // Reserved blank area under a congregational hymn slot. OneLicense has no
  // public API, so the booklet deliberately leaves room for the parish to
  // paste licensed notation in by hand after export (Acrobat, print + paste,
  // etc.). The dashed guide and label disappear once an image is pasted over
  // them. Height is clamped to the space left on the page so the box never
  // crosses the bottom margin; below a usable minimum it is skipped entirely.
  //
  // When the slot has an uploaded notation image (opts.slot), the image is
  // embedded in place of the dashed box.
  hymnMusicSpace(opts = {}) {
    if (opts.slot && this.notationImages[opts.slot]) {
      if (this._notationImage(opts.slot, opts.height !== undefined ? opts.height : 160, { uncapped: true })) return;
    }
    if (this.data.reserveHymnSpace === false) return;
    const desired = this.s(opts.height !== undefined ? opts.height : 160) * this.textScale;
    const available = this._bottom() - this.y;
    const h = Math.min(desired, available);
    if (h < this.s(50)) {
      if (!this._dryRun) this.warnings.push('Page is too full to reserve space for pasted hymn music.');
      return;
    }
    if (this._dryRun) {
      this.y += h + this.s(6);
      return;
    }
    this.doc.save()
      .rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, h)
      .dash(3, { space: 3 }).lineWidth(0.5).strokeColor('#C9C9C9').stroke()
      .undash().restore();
    this.doc.fontSize(this.s(6.5)).fillColor('#B5B5B5').font('Sans-Italic')
      .text('Reserved for hymn music — paste licensed notation here',
        this.MARGIN_SIDE, this.y + h / 2 - this.s(4),
        { width: this.CONTENT_WIDTH, align: 'center' });
    this.doc.font('Sans');
    this.y += h + this.s(6);
    this._trackY();
  }

  // Two-column layout for the Nicene/Apostles' Creed. Splits the text at the
  // midpoint and renders left/right columns side by side to conserve vertical
  // space on page 4 when the creed + gospel are both present.
  _renderCreedTwoColumn(text) {
    const lines = text.split('\n');
    const half = Math.ceil(lines.length / 2);
    const leftText  = lines.slice(0, half).join('\n');
    const rightText = lines.slice(half).join('\n');
    const gap  = this.s(10);
    const colW = (this.CONTENT_WIDTH - gap) / 2;
    const x1   = this.MARGIN_SIDE;
    const x2   = this.MARGIN_SIDE + colW + gap;
    const lineOpts = { lineGap: this.s(0.8) * this.textScale };
    this.doc.fontSize(this.s(9) * this.textScale).fillColor(COLORS.text).font('Sans');
    if (this._dryRun) {
      const lh = this.doc.heightOfString(leftText,  { ...lineOpts, width: colW });
      const rh = this.doc.heightOfString(rightText, { ...lineOpts, width: colW });
      this.y += Math.max(lh, rh) + this.s(3);
      return;
    }
    const startY = this.y;
    const lh = this.doc.heightOfString(leftText,  { ...lineOpts, width: colW });
    const rh = this.doc.heightOfString(rightText, { ...lineOpts, width: colW });
    const maxH = Math.min(Math.max(lh, rh), this._bottom() - startY);
    if (lh > 0) this.doc.text(leftText,  x1, startY, { ...lineOpts, width: colW, height: maxH, ellipsis: true });
    if (rh > 0) this.doc.text(rightText, x2, startY, { ...lineOpts, width: colW, height: maxH, ellipsis: true });
    this.y = startY + maxH + this.s(3);
    this._trackY();
  }

  // Small reserved area under a Mass ordinary part (Kyrie, Gloria, Holy Holy
  // Holy, Mystery of Faith, Lamb of God) or sung response (psalm refrain,
  // gospel acclamation) so the parish can paste the week's musical setting in
  // by hand after export — smaller than hymn spaces since ordinary settings
  // are the same every week and already identified by name above. When the
  // slot carries an uploaded notation image, the image renders instead.
  ordinaryMusicSpace(slot, label) {
    if (slot && this.notationImages[slot]) {
      // Image cap is far more generous than the 55-unit paste guide: real
      // ordinary-part music runs 2-3 staves at full content width. Mirrors
      // the HTML renderer's ordinaryImageMax (2.4in / 3in).
      if (this._notationImage(slot, 170)) return;
    }
    if (this.data.reserveHymnSpace === false) return;
    const h = this.s(55) * this.textScale;
    const available = this._bottom() - this.y;
    if (available < this.s(30)) {
      // NEVER skip silently — a missing Kyrie/Gloria box must be reported.
      if (!this._dryRun) this.warnings.push(`Page is too full to fit the ${label || slot || 'music'} area — shorten the content above it.`);
      return;
    }
    const drawH = Math.min(h, available);
    if (this._dryRun) { this.y += drawH + this.s(4); return; }
    this.doc.save()
      .rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, drawH)
      .dash(2, { space: 3 }).lineWidth(0.4).strokeColor('#DEDEDE').stroke()
      .undash().restore();
    this.doc.fontSize(this.s(6)).fillColor('#C8C8C8').font('Sans-Italic')
      .text(label || 'Music notation', this.MARGIN_SIDE,
        this.y + drawH / 2 - this.s(3),
        { width: this.CONTENT_WIDTH, align: 'center' });
    this.doc.font('Sans');
    this.y += drawH + this.s(4);
    this._trackY();
  }

  // Resolve a parish-supplied logo path to a filesystem path PDFKit can read.
  // Accepts a /uploads/... URL relative to the data dir, an absolute path,
  // or returns null if no logo is configured / the file is missing.
  _resolveLogoPath() {
    const raw = this.parishSettings.logoPath;
    if (!raw) return null;
    if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
    const stripped = raw.replace(/^\/+/, '');
    const candidates = [
      path.join(__dirname, '..', 'data', stripped),
      path.join(__dirname, '..', stripped),
      path.join(process.cwd(), stripped),
      path.join(process.cwd(), 'data', stripped)
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  _drawDefaultCross(cx, y) {
    const armLen = this.s(25);
    this.doc.save().lineWidth(this.s(4)).strokeColor(COLORS.navy);
    this.doc.moveTo(cx, y - armLen).lineTo(cx, y + armLen).stroke();
    this.doc.moveTo(cx - armLen, y).lineTo(cx + armLen, y).stroke();
    this.doc.lineWidth(this.s(1.5));
    const corner = this.s(15), tick = this.s(5);
    for (const [ox, oy] of [[-corner, -corner], [corner, -corner], [-corner, corner], [corner, corner]]) {
      this.doc.moveTo(cx + ox, y + oy - tick).lineTo(cx + ox, y + oy + tick).stroke();
      this.doc.moveTo(cx + ox - tick, y + oy).lineTo(cx + ox + tick, y + oy).stroke();
    }
    this.doc.restore();
  }

  // PAGE RENDERERS ============================================

  renderPage1Cover() {
    const cx = this.PAGE_WIDTH / 2;
    const usableTop = this.MARGIN_TOP;

    // Logo: parish-uploaded image when present, otherwise the default cross.
    this.y = usableTop + this.s(40);
    const logoPath = this._resolveLogoPath();
    if (logoPath) {
      const targetH = this.s(60);
      try {
        this.doc.image(logoPath, cx - this.s(60), usableTop + this.s(10), {
          fit: [this.s(120), targetH], align: 'center', valign: 'top'
        });
      } catch (e) {
        // Fall back to the default cross if the image can't be loaded.
        this._drawDefaultCross(cx, this.y);
        this.warnings.push(`Cover logo could not be loaded: ${e.message}`);
      }
    } else {
      this._drawDefaultCross(cx, this.y);
    }

    // Parish name (if persistent branding is configured)
    let nameY = usableTop + this.s(95);
    if (this.parishSettings.parishName) {
      this.doc.fontSize(this.s(11)).fillColor(COLORS.gold).font('Sans-Bold')
        .text(this.parishSettings.parishName.toUpperCase(), this.MARGIN_SIDE, nameY,
          { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 });
      nameY = this.doc.y + this.s(2);
      if (this.parishSettings.coverTagline) {
        this.doc.fontSize(this.s(8)).fillColor(COLORS.muted).font('Sans-Italic')
          .text(this.parishSettings.coverTagline, this.MARGIN_SIDE, nameY,
            { width: this.CONTENT_WIDTH, align: 'center' });
        nameY = this.doc.y + this.s(4);
      }
      nameY += this.s(4);
    }

    // Feast name
    this.y = nameY;
    this.doc.fontSize(this.s(20)).fillColor(COLORS.navy).font('Sans-Bold')
      .text(this.data.feastName, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(6);

    this.doc.fontSize(this.s(11)).fillColor(COLORS.muted).font('Sans')
      .text(formatDate(this.data.liturgicalDate), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(3);

    // Mass times: parish setting (newline-separated), like the HTML cover.
    const massTimesLines = String(this.parishSettings.massTimes || 'Sat 5:00 PM\nSun 9:00 AM\nSun 11:00 AM')
      .split('\n').map(t => t.trim()).filter(Boolean);
    this.doc.fontSize(this.s(9)).fillColor(COLORS.light)
      .text(massTimesLines.join(' • '), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(4);

    // Clergy lines under the times, mirroring the HTML cover.
    const clergyLines = [];
    if (this.parishSettings.pastor) clergyLines.push(`${this.parishSettings.pastor}, ${this.parishSettings.pastorTitle || 'Pastor'}`);
    if (this.parishSettings.associates) String(this.parishSettings.associates).split('\n').forEach(l => { if (l.trim()) clergyLines.push(l.trim()); });
    if (this.parishSettings.deacons) String(this.parishSettings.deacons).split('\n').forEach(l => { if (l.trim()) clergyLines.push(l.trim()); });
    if (this.parishSettings.musicDirector) clergyLines.push(this.parishSettings.musicDirector + ', Music Director');
    if (clergyLines.length) {
      const clergyRoom = this._bottom() - this.y;
      if (clergyRoom > this.s(10)) {
        this.doc.fontSize(this.s(8)).fillColor(COLORS.muted).font('Sans')
          .text(clergyLines.join('\n'), this.MARGIN_SIDE, this.y,
            { width: this.CONTENT_WIDTH, align: 'center', lineGap: this.s(1), height: clergyRoom, ellipsis: true });
        this.y = Math.min(this.doc.y, this._bottom());
      } else {
        this._warnClipped();
      }
    }
    this.y += this.s(6);

    this.doc.save()
      .moveTo(this.MARGIN_SIDE + this.s(60), this.y)
      .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE - this.s(60), this.y)
      .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
    this.y += this.s(14);

    // Parish info blocks (2x2 grid)
    const ps = this.parishSettings;
    const infos = [
      ['CONNECT', ps.connectBlurb || 'New to the parish? Visit the Welcome Desk after Mass.'],
      ['NURSERY', ps.nurseryBlurb || 'A nursery is available during the 9:00 AM and 11:00 AM Masses.'],
      ['RESTROOMS', ps.restroomsBlurb || 'Restrooms are located in the narthex and lower level.'],
      ['PRAYER', ps.prayerBlurb || 'For prayer requests, contact the parish office.']
    ];

    const gridGap = this.s(12);
    const colW = (this.CONTENT_WIDTH - gridGap) / 2;
    let rowY = this.y;
    // Track the max bottom across BOTH columns of the row — advancing off
    // column 1 alone lets a taller column-0 blurb get overprinted by the
    // next row.
    let rowBottom = rowY;
    for (let i = 0; i < infos.length; i++) {
      const col = i % 2;
      const x = this.MARGIN_SIDE + col * (colW + gridGap);

      // Clamp each cell to the bottom margin so a long parish blurb can
      // never push the cover onto a second page.
      if (rowY > this._bottom() - this.s(14)) { this._warnClipped(); break; }
      this.doc.fontSize(this.s(7)).fillColor(COLORS.gold).font('Sans-Bold')
        .text(infos[i][0], x, rowY, { width: colW, characterSpacing: 1, lineBreak: false });
      const labelBottom = this.doc.y + this.s(1);
      const cellRemaining = this._bottom() - labelBottom;
      if (cellRemaining > this.s(8)) {
        this.doc.fontSize(this.s(8)).fillColor('#444444').font('Sans')
          .text(infos[i][1], x, labelBottom, { width: colW, lineGap: this.s(1), height: cellRemaining, ellipsis: true });
        rowBottom = Math.max(rowBottom, this.doc.y);
      } else {
        this._warnClipped();
        rowBottom = Math.max(rowBottom, labelBottom);
      }
      if (col === 1) {
        rowY = rowBottom + this.s(6);
        rowBottom = rowY;
      }
    }
    this.y = Math.min(rowY, this._bottom());

    // Welcome message block under the info grid (like the HTML cover),
    // clamped to the bottom margin.
    if (ps.welcomeMessage) {
      this.y += this.s(2);
      const welcomeRoom = this._bottom() - this.y;
      if (welcomeRoom > this.s(10)) {
        this.doc.fontSize(this.s(8)).fillColor(COLORS.text).font('Sans-Italic')
          .text(ps.welcomeMessage, this.MARGIN_SIDE, this.y,
            { width: this.CONTENT_WIDTH, align: 'center', lineGap: this.s(1), height: welcomeRoom, ellipsis: true });
        this.doc.font('Sans');
        this.y = Math.min(this.doc.y, this._bottom());
      } else {
        this._warnClipped();
      }
    }
    this._trackY();
  }
  // The ordered liturgy as atomic blocks for the flow paginator. Each
  // block renders at this.y with the shared helpers (all dry-run aware).
  // Granularity rules:
  //   * a heading travels with the first piece of its content;
  //   * a hymn line and its notation image/paste box are ONE block;
  //   * long prose (readings, gospel) splits into per-paragraph blocks so
  //     it can flow across pages without orphaning its heading.
  _buildContentBlocks() {
    const blocks = [];
    const b = (fn) => blocks.push({ render: fn });

    // Heading + citation + first paragraph stay together; the remaining
    // paragraphs flow as their own blocks.
    const reading = (heading, citation, text, opts = {}) => {
      const paras = String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      b(() => {
        this.subHeading(heading);
        if (citation) this.citation(citation);
        if (paras[0]) this.bodyText(paras[0], opts);
      });
      for (const p of paras.slice(1)) b(() => this.bodyText(p, opts));
    };

    // --- The Introductory Rites ---
    b(() => {
      this.sectionHeader('The Introductory Rites');
      this.subHeading('Organ Prelude');
      this.musicLine('organPrelude', 'organPreludeComposer', 'Prelude');
      this.rubric(RUBRICS.stand);
    });

    const entranceType = this.ss.entranceType || 'processional';
    b(() => {
      this.subHeading(entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon');
      this.musicLine('processionalOrEntrance', 'processionalOrEntranceComposer',
        entranceType === 'processional' ? 'Processional' : 'Antiphon');
      if (entranceType === 'processional') {
        this.hymnMusicSpace({ slot: 'processional' });
      }
    });

    if (this.showAdventWreath) {
      b(() => {
        this.y += this.s(3);
        const boxH = this.s(18);
        if (!this._dryRun) {
          this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, boxH)
            .fillColor('#f0eaf5').fill().restore();
          this.doc.fontSize(this.s(9)).fillColor(COLORS.purple).font('Sans-Bold')
            .text('Lighting of the Advent Wreath', this.MARGIN_SIDE, this.y + this.s(4),
              { width: this.CONTENT_WIDTH, align: 'center', lineBreak: false });
          this.doc.font('Sans');
        }
        this.y += boxH + this.s(4);
        this._trackY();
      });
    }

    if ((this.ss.penitentialAct || 'confiteor') === 'confiteor') {
      b(() => {
        this.subHeading('Penitential Act');
        this.bodyText(CONFITEOR, { size: 8, gap: 3 });
      });
    }

    b(() => {
      this.subHeading('Lord, Have Mercy');
      this.musicLine('kyrieSetting', 'kyrieComposer', 'Kyrie');
      this.ordinaryMusicSpace('kyrie', 'Kyrie — music notation');
    });

    const showGloria = this.ss.gloria !== undefined ? this.ss.gloria :
      (this.data.liturgicalSeason !== 'lent' && this.data.liturgicalSeason !== 'advent');
    if (showGloria) {
      b(() => {
        this.subHeading('Gloria');
        if (this.ss.gloriaSetting) this.bodyText(this.ss.gloriaSetting, { italic: true, gap: 1 });
        if (this._slotHasMusic('gloria')) {
          this.ordinaryMusicSpace('gloria', 'Gloria — music notation');
        } else {
          this.bodyText('Glory to God in the highest, and on earth peace to people of good will.');
        }
      });
    }

    // Children's Liturgy dismissal — children leave after the Opening
    // Prayer (end of Introductory Rites) and return at the Offertory.
    if (this.data.childrenLiturgyEnabled) {
      b(() => this._childrenLiturgyBox());
    }

    // --- The Liturgy of the Word ---
    {
      const paras = String(this.r.firstReadingText || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      b(() => {
        this.sectionHeader('The Liturgy of the Word');
        this.rubric(RUBRICS.sit);
        this.subHeading('First Reading');
        if (this.r.firstReadingCitation) this.citation(this.r.firstReadingCitation);
        if (paras[0]) this.bodyText(paras[0], { size: 9 });
      });
      for (const p of paras.slice(1)) b(() => this.bodyText(p, { size: 9 }));
    }

    b(() => {
      this.subHeading('Responsorial Psalm');
      if (this.r.psalmCitation) this.citation(this.r.psalmCitation);
      this.musicLine('responsorialPsalmSetting', 'responsorialPsalmSettingComposer', 'Setting');
      // Music (uploaded refrain notation or a paste area) replaces the
      // text refrain — the notation carries the words.
      if (this._slotHasMusic('psalmRefrain')) {
        this.ordinaryMusicSpace('psalmRefrain', 'Responsorial Psalm refrain — music notation');
      } else if (this.r.psalmRefrain) {
        this.bodyText(`R. ${this.r.psalmRefrain}`, { bold: true, size: 9 });
      }
    });
    if (this.r.psalmVerses) {
      for (const v of String(this.r.psalmVerses).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
        b(() => this.bodyText(v, { size: 8.5, x: this.MARGIN_SIDE + this.s(10), width: this.CONTENT_WIDTH - this.s(10) }));
      }
    }

    if (!this.r.noSecondReading && this.r.secondReadingCitation) {
      reading('Second Reading', this.r.secondReadingCitation, this.r.secondReadingText, { size: 9 });
    }

    b(() => {
      this.rubric(RUBRICS.stand);
      this.subHeading('Gospel Acclamation');
      const isLenten = this.data.liturgicalSeason === 'lent';
      let acclamationText;
      if (isLenten) {
        acclamationText = (this.ss.lentenAcclamation === 'alternate') ? GOSPEL_ACCLAMATION_LENTEN_ALT : GOSPEL_ACCLAMATION_LENTEN;
      } else {
        acclamationText = GOSPEL_ACCLAMATION_STANDARD;
      }
      // Music (uploaded notation or a paste area) replaces the sung
      // acclamation text; the cantor's verse keeps printing below.
      if (this._slotHasMusic('gospelAcclamation')) {
        this.ordinaryMusicSpace('gospelAcclamation', 'Gospel Acclamation — music notation');
      } else {
        this.bodyText(acclamationText, { bold: true, size: 9 });
      }
      if (this.r.gospelAcclamationReference) this.citation(this.r.gospelAcclamationReference);
      if (this.r.gospelAcclamationVerse) this.bodyText(this.r.gospelAcclamationVerse, { italic: true, size: 8.5 });
    });

    // --- Gospel, Homily, Creed ---
    reading('Gospel', this.r.gospelCitation, this.r.gospelText, { size: 9.5 });

    b(() => {
      this.subHeading('Homily');
      this.rubric(RUBRICS.sit);
      this.y += this.s(4);
      this.rubric(RUBRICS.stand);
    });

    {
      const creedType = this.ss.creedType || 'nicene';
      const creedHeading = {
        apostles:       "The Apostles' Creed",
        baptismal_vows: 'Renewal of Baptismal Vows',
        nicene:         'The Nicene Creed'
      }[creedType] || 'The Nicene Creed';
      const creedText = {
        apostles:       APOSTLES_CREED,
        baptismal_vows: RENEWAL_OF_BAPTISMAL_VOWS,
        nicene:         NICENE_CREED
      }[creedType] || NICENE_CREED;
      b(() => {
        this.subHeading(creedHeading);
        if (this.ss.twoColumnCreed && creedType !== 'baptismal_vows') {
          this._renderCreedTwoColumn(creedText);
        } else {
          this.bodyText(creedText);
        }
      });
    }

    b(() => {
      this.subHeading('Prayer of the Faithful');
      this.bodyText('The intentions are read; the assembly responds.', { italic: true, size: 8 });
    });

    // --- The Liturgy of the Eucharist ---
    b(() => {
      this.sectionHeader('The Liturgy of the Eucharist');
      this.rubric(RUBRICS.sit);
      this.subHeading('Offertory');
      this.musicLine('offertoryAnthem', 'offertoryAnthemComposer', 'Offertory Anthem');
      if (this.data.childrenLiturgyEnabled) {
        const _clTimes = (Array.isArray(this.data.childrenLiturgyMassTimes) && this.data.childrenLiturgyMassTimes.length)
          ? this.data.childrenLiturgyMassTimes
          : (this.data.childrenLiturgyMassTime ? [this.data.childrenLiturgyMassTime] : ['Sun 9:00 AM']);
        this.rubric(`† Children return from Children's Liturgy of the Word (${_clTimes.join(' & ')}).`);
      }
    });

    b(() => {
      this.rubric(RUBRICS.stand);
      this.subHeading('Invitation to Prayer');
      this.bodyText(`Priest: ${INVITATION_TO_PRAYER.priest}`);
      this.bodyText(`All: ${INVITATION_TO_PRAYER.all}`, { bold: true });
    });

    b(() => {
      // Sanctus language: per-aid override > parish default > English
      const holyHolyLanguage = this.ss.holyHolyLanguage || this.parishSettings.defaultSanctusLanguage || 'english';
      this.subHeading(holyHolyLanguage === 'latin' ? 'Sanctus' : 'Holy, Holy, Holy');
      this.bodyText(this.ss.holyHolySetting || 'Mass of St. Theresa', { italic: true });
      if (this._slotHasMusic('sanctus')) {
        this.ordinaryMusicSpace('sanctus', 'Holy, Holy, Holy — music notation');
      } else {
        this.bodyText(getHolyHolyHolyText(holyHolyLanguage));
      }
    });

    b(() => {
      this.rubric(RUBRICS.kneel);
      this.subHeading('Mystery of Faith');
      this.bodyText(this.ss.mysteryOfFaithSetting || 'Mass of St. Theresa', { italic: true });
      this.ordinaryMusicSpace('mysteryOfFaith', 'Mystery of Faith — music notation');
    });

    b(() => this.subHeading('Great Amen'));

    // --- The Communion Rite ---
    b(() => {
      this.sectionHeader('The Communion Rite');
      this.subHeading("The Lord's Prayer");
      this.rubric(RUBRICS.stand);
      this.bodyText(LORDS_PRAYER);
    });

    b(() => this.subHeading('Sign of Peace'));

    b(() => {
      this.subHeading('Lamb of God');
      this.bodyText(this.ss.lambOfGodSetting || 'Mass of St. Theresa', { italic: true });
      this.ordinaryMusicSpace('lambOfGod', 'Lamb of God — music notation');
    });

    b(() => {
      this.rubric(RUBRICS.kneel);
      this.subHeading('Communion Hymn');
      this.musicLine('communionHymn', 'communionHymnComposer', 'Communion');
      this.hymnMusicSpace({ slot: 'communion' });
    });

    b(() => {
      this.subHeading('Choral Anthem');
      this.musicLine('choralAnthemConcluding', 'choralAnthemConcludingComposer', 'Anthem');
    });

    // --- The Concluding Rites ---
    b(() => {
      this.sectionHeader('The Concluding Rites');
      this.subHeading('Hymn of Thanksgiving');
      this.musicLine('hymnOfThanksgiving', 'hymnOfThanksgivingComposer', 'Thanksgiving');
      this.hymnMusicSpace({ slot: 'thanksgiving' });
    });

    b(() => {
      this.rubric(RUBRICS.stand);
      this.subHeading('Blessing & Dismissal');
      this.bodyText('Priest: The Lord be with you. All: And with your spirit.', { size: 8 });
      this.bodyText('Priest: May almighty God bless you, the Father, and the Son, ✠ and the Holy Spirit. All: Amen.', { size: 8 });
      this.bodyText('Deacon: Go forth, the Mass is ended. All: Thanks be to God.', { size: 8 });
    });

    if (this.includePostlude) {
      b(() => {
        this.subHeading('Organ Postlude');
        this.musicLine('organPostlude', 'organPostludeComposer', 'Postlude');
      });
    }

    if (this.data.announcements) {
      b(() => {
        this.y += this.s(4);
        if (!this._dryRun) {
          this.doc.save()
            .moveTo(this.MARGIN_SIDE, this.y)
            .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE, this.y)
            .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
        }
        this.y += this.s(4);
        this.subHeading('Announcements');
        this.bodyText(this.data.announcements, { size: 7.5 });
      });
    }

    // Special notes and the parish's standing closing message (formerly
    // the back cover), then the full copyright block.
    if (this.data.specialNotes) {
      b(() => {
        this.y += this.s(4);
        this.bodyText(this.data.specialNotes, { italic: true, size: 8.5, align: 'center', color: COLORS.muted });
      });
    }
    if (this.parishSettings.closingMessage) {
      b(() => {
        this.y += this.s(2);
        this.bodyText(this.parishSettings.closingMessage, { size: 8, align: 'center', color: COLORS.muted });
      });
    }

    b(() => {
      const copyrightFull = this.parishSettings.copyrightFull ||
        getDefaultCopyrightFull(this.parishSettings.onelicenseNumber);
      this.y += this.s(8);
      this.doc.fontSize(this.s(6.5) * this.textScale).fillColor(COLORS.light).font('Sans');
      this._textBlock(copyrightFull, this.MARGIN_SIDE + this.s(10), {
        width: this.CONTENT_WIDTH - this.s(20), align: 'center', lineGap: this.s(1.5) * this.textScale
      }, 0);
    });

    return blocks;
  }

  // Tinted info box for the Children's Liturgy dismissal. Dry-run aware.
  _childrenLiturgyBox() {
    this.y += this.s(4);
    const _clTimes = (Array.isArray(this.data.childrenLiturgyMassTimes) && this.data.childrenLiturgyMassTimes.length)
      ? this.data.childrenLiturgyMassTimes
      : (this.data.childrenLiturgyMassTime ? [this.data.childrenLiturgyMassTime] : ['Sun 9:00 AM']);
    const innerX = this.MARGIN_SIDE + this.s(4);
    const innerW = this.CONTENT_WIDTH - this.s(8);
    const clLines = [
      [`Children's Liturgy of the Word — ${_clTimes.join(' & ')}`, 'Sans-Bold', 8]
    ];
    if (this.data.childrenLiturgyLeader)
      clLines.push([`Led by ${this.data.childrenLiturgyLeader}`, 'Sans', 7.5]);
    if (this.data.childrenLiturgyMusic) {
      clLines.push([`${this.data.childrenLiturgyMusic}${this.data.childrenLiturgyMusicComposer ? ', ' + this.data.childrenLiturgyMusicComposer : ''}`, 'Sans-Italic', 7.5]);
    }
    const notes = this.data.childrenLiturgyNotes ||
      'Children are dismissed after the Opening Prayer and will rejoin during the Offertory.';
    clLines.push([notes, 'Sans-Italic', 7]);
    let contentH = 0;
    for (const [text, font, size] of clLines) {
      this.doc.font(font).fontSize(this.s(size) * this.textScale);
      contentH += this.doc.heightOfString(text, { width: innerW });
    }
    if (this._dryRun) {
      this.y += contentH + this.s(12);
      this.doc.font('Sans');
      return;
    }
    const boxH = Math.min(contentH + this.s(8), Math.max(0, this._bottom() - this.y));
    if (boxH > this.s(10)) {
      this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, boxH)
        .fillColor('#f5f0e6').fill().restore();
      const boxBottom = this.y + boxH;
      let cursorY = this.y + this.s(4);
      for (const [text, font, size] of clLines) {
        this.doc.font(font).fontSize(this.s(size) * this.textScale).fillColor(COLORS.text);
        const remaining = boxBottom - cursorY;
        if (remaining < this.doc.currentLineHeight(true)) { this._warnClipped(); break; }
        this.doc.text(text, innerX, cursorY, { width: innerW, height: remaining, ellipsis: true });
        cursorY = this.doc.y;
      }
      this.y += boxH + this.s(4);
    } else {
      this._warnClipped();
    }
    this.doc.font('Sans');
    this._trackY();
  }
}

async function generatePdf(data, outputPath, options = {}) {
  const generator = new WorshipAidPdfGenerator(data, options);
  return generator.generate(outputPath);
}

// Backwards-compat alias.
async function generateImposedPdf(data, outputPath, options = {}) {
  return generatePdf(data, outputPath, options);
}

function buildFilename(data) {
  const date = (data.liturgicalDate || '').replace(/-/g, '_');
  const name = (data.feastName || 'Untitled').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  return `${date}__${name}.pdf`;
}

module.exports = {
  generatePdf,
  generateImposedPdf,
  buildFilename,
  WorshipAidPdfGenerator,
  LAYOUTS
};
