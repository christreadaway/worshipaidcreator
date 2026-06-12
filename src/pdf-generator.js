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
    // Spread bridging: 1-based page number of the page being rendered, and
    // the pending remainder of a music image that continues onto the
    // facing page (set on even pages, consumed at the top of 3/7).
    this._pageNo = 1;
    this._carryNotation = null;

    // 8-page guarantee state: shrink-to-fit factor for body text and the
    // dry-run flag used while measuring a page before rendering it.
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
        this.renderPage2IntroductoryRites();
        this.renderPage3LiturgyOfWord();
        this.renderPage4GospelCreed();
        this.renderPage5LiturgyEucharist();
        this.renderPage6CommunionRite();
        this.renderPage7ConcludingRites();
        this.renderPage8BackCover();
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

  // Shrink-to-fit, in order of preference:
  //   1. Normal margins, normal type.
  //   2. Relax the side and bottom margins to 0.5" (wider + taller text
  //      area; a no-op on half-letter, which is already at 0.5").
  //   3. Relax the top margin to 0.5" as well — top last so the page
  //      keeps its visual anchor as long as possible.
  //   4. Only then reduce the body-text scale, never below 0.75 of normal
  //      so the type stays legible.
  // Anything that still doesn't fit at minimum scale gets truncated by
  // _textBlock with a warning, so the booklet is always exactly 8 pages.
  _fitPageText(renderFn, opts = {}) {
    const MIN_MARGIN = 0.5 * PT;
    // Content already drawn at the top of this page (a carried notation
    // remainder) — every margin stage must start below it.
    const carriedY = this.y > this.MARGIN_TOP ? this.y : null;
    const orig = {
      side: this.MARGIN_SIDE, top: this.MARGIN_TOP, bottom: this.MARGIN,
      width: this.CONTENT_WIDTH, y: this.y
    };
    // Pages with furniture anchored inside the bottom margin band (the
    // page-7 copyright line) keep their bottom margin so content can't
    // collide with it.
    const minBottom = opts.keepBottom ? orig.bottom : Math.min(orig.bottom, MIN_MARGIN);
    const stages = [
      [orig.side, orig.top, orig.bottom],
      [Math.min(orig.side, MIN_MARGIN), orig.top, minBottom],
      [Math.min(orig.side, MIN_MARGIN), Math.min(orig.top, MIN_MARGIN), minBottom]
    ];
    const applyMargins = ([side, top, bottom]) => {
      this.MARGIN_SIDE = side;
      this.MARGIN_TOP = top;
      this.MARGIN = bottom;
      this.CONTENT_WIDTH = this.PAGE_WIDTH - 2 * side;
      // PDFKit auto-page-breaks any text that crosses its own bottom
      // margin, so the document margins must follow the relaxed values or
      // text written into the reclaimed band would spawn a ninth page.
      this.doc.page.margins.left = side;
      this.doc.page.margins.right = side;
      this.doc.page.margins.top = top;
      this.doc.page.margins.bottom = bottom;
      // _fitPageText normally runs right after newPage() so content starts
      // at the (possibly relaxed) top margin — but when a bridged music
      // image was carried onto this page, content must start below it.
      this.y = carriedY !== null ? carriedY : top;
    };
    const measure = () => {
      this._dryRun = true;
      const y0 = this.y;
      renderFn();
      const needed = this.y - y0;
      this._dryRun = false;
      this.y = y0;
      return needed;
    };

    this.textScale = 1;
    let needed = 0;
    let fits = false;
    for (const stage of stages) {
      applyMargins(stage);
      needed = measure();
      if (needed <= this._bottom() - this.y) { fits = true; break; }
    }
    if (!fits) {
      // Fully relaxed margins weren't enough — shrink type, floor 0.75.
      const available = this._bottom() - this.y;
      for (let i = 0; i < 2 && needed > available && this.textScale > 0.75; i++) {
        this.textScale = Math.max(0.75, this.textScale * Math.max(0.75, available / needed));
        needed = measure();
      }
    }
    renderFn();
    this.textScale = 1;
    // Restore layout margins so footers (folio, copyright) sit at the same
    // place on every page. The doc-level bottom margin stays relaxed for
    // the rest of this page — restoring it mid-page would re-trigger
    // PDFKit's page break for content already placed in the relaxed band.
    this.MARGIN_SIDE = orig.side;
    this.MARGIN_TOP = orig.top;
    this.MARGIN = orig.bottom;
    this.CONTENT_WIDTH = orig.width;
  }

  // True when this slot will render music (an uploaded image or a reserved
  // paste box) instead of spoken text. Mirrors the HTML renderer.
  _slotHasMusic(slot) {
    return !!this.notationImages[slot] || this.data.reserveHymnSpace !== false;
  }

  // Draw an uploaded notation image scaled to the full content width keeping
  // its proportions. Music can NEVER be cut off or lost:
  //   * On an EVEN page (2/4/6), an image too tall for the space left may
  //     BRIDGE onto the facing odd page — the open spread (2-3, 6-7) is
  //     visible all at once, so the assembly keeps singing. The image is
  //     drawn lossless in two clipped parts; never across a page turn
  //     (odd -> even).
  //   * On an ODD page (or when bridging is off) the image shrinks
  //     proportionally to fit — smaller, but complete.
  // When a height cap or shrink narrows the image, it is centered.
  // Returns true when the slot had an image (drawn or dry-run-measured).
  // Spec width for a slot's music image: inches on the tabloid page,
  // proportional on other trims, never wider than the content area.
  _notationTargetWidth(slot) {
    const inches = NOTATION_WIDTHS_IN[slot] || 6;
    return Math.min(inches * PT * (this.PAGE_WIDTH / (8.5 * PT)), this.CONTENT_WIDTH);
  }

  _notationImage(slot, maxHBase, reserveBelowBase = 0, opts = {}) {
    const buf = this.notationImages[slot];
    if (!buf) return false;
    const reserveBelow = this.s(reserveBelowBase);
    const available = this.PAGE_HEIGHT - this.MARGIN - reserveBelow - this.y;
    const dims = getImageDimensions(buf);

    // Natural size at the slot's spec width (6in service music / 5in hymns
    // and psalm refrain on tabloid), centered by the drawX math below.
    let drawW = this._notationTargetWidth(slot);
    let drawH = dims ? (dims.height / dims.width) * drawW : this.s(maxHBase);

    const canBridge = !!opts.bridge && !this._dryRun &&
      this._pageNo % 2 === 0 && this._pageNo < 8;

    if (canBridge && drawH > available) {
      // Budget: what's left here plus most of the facing page. An image
      // even taller than that shrinks to the budget (still complete).
      const facingBudget = (this.PAGE_HEIGHT - this.MARGIN_TOP - this.MARGIN) * 0.6;
      const totalBudget = Math.max(available, 0) + facingBudget;
      if (drawH > totalBudget) {
        drawW = drawW * (totalBudget / drawH);
        drawH = totalBudget;
      }
      const part1H = Math.max(0, available);
      const drawX = this.MARGIN_SIDE + (this.CONTENT_WIDTH - drawW) / 2;
      if (part1H > this.s(12)) {
        this.doc.save().rect(drawX, this.y, drawW, part1H).clip();
        let failed = null;
        try {
          this.doc.image(buf, drawX, this.y, { width: drawW, height: drawH });
        } catch (e) { failed = e; }
        this.doc.restore();
        if (failed) {
          this.warnings.push(`Could not embed ${slot} notation image: ${failed.message}`);
          return false; // fall back to the paste box
        }
      }
      this._carryNotation = { buf, drawW, drawH, shownH: part1H, slot };
      this.warnings.push(`${slot} music continues onto the facing page (pages ${this._pageNo}–${this._pageNo + 1}) — the open spread reads as one piece.`);
      this.y += part1H;
      this._trackY();
      return true;
    }

    // Single-page path: bridgeable slots use their natural height up to the
    // space available; others honor the height cap. Shrink keeps the image
    // complete.
    const maxH = opts.bridge ? Infinity : this.s(maxHBase);
    const capH = Math.min(maxH, available);
    if (capH < this.s(20)) {
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
      this.y += drawH + this.s(4);
      this._trackY();
    } catch (e) {
      this.warnings.push(`Could not embed ${slot} notation image: ${e.message}`);
      return false; // fall back to the paste box
    }
    return true;
  }

  // Draw the continuation of a music image that bridged from the previous
  // (even) page. Runs at the very top of the facing page, before any other
  // content. The full image is drawn shifted up with a clip window over the
  // unseen remainder — pixels line up exactly with part 1, nothing is lost.
  _drawCarriedNotation() {
    const c = this._carryNotation;
    if (!c) return;
    this._carryNotation = null;
    const remH = c.drawH - c.shownH;
    if (remH <= 0) return;
    const drawX = this.MARGIN_SIDE + (this.CONTENT_WIDTH - c.drawW) / 2;
    this.doc.save().rect(drawX, this.y, c.drawW, remH).clip();
    try {
      this.doc.image(c.buf, drawX, this.y - c.shownH, { width: c.drawW, height: c.drawH });
    } catch (e) {
      this.warnings.push(`Could not finish the ${c.slot} notation on the facing page: ${e.message}`);
    }
    this.doc.restore();
    this.doc.fontSize(this.s(6)).fillColor('#B5B5B5').font('Sans-Italic')
      .text('(continued)', this.MARGIN_SIDE, this.y + remH + this.s(1),
        { width: this.CONTENT_WIDTH, align: 'right', lineBreak: false });
    this.doc.font('Sans');
    this.y += remH + this.s(10);
    this._trackY();
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
      if (this._notationImage(opts.slot, opts.height !== undefined ? opts.height : 160, opts.reserveBelow || 0, { bridge: true })) return;
    }
    if (this.data.reserveHymnSpace === false) return;
    const desired = this.s(opts.height !== undefined ? opts.height : 160);
    const reserveBelow = this.s(opts.reserveBelow || 0);
    const available = this.PAGE_HEIGHT - this.MARGIN - reserveBelow - this.y;
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
  ordinaryMusicSpace(slot, label, opts = {}) {
    if (slot && this.notationImages[slot]) {
      // Image cap is far more generous than the 55-unit paste guide: real
      // ordinary-part music runs 2-3 staves at full content width. Mirrors
      // the HTML renderer's ordinaryImageMax (2.4in / 3in).
      if (this._notationImage(slot, 170, opts.reserveBelow || 0, { bridge: !!opts.bridge })) return;
    }
    if (this.data.reserveHymnSpace === false) return;
    const h = this.s(55);
    const available = this._bottom() - this.y;
    if (available < this.s(30)) return;
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

  renderPage2IntroductoryRites() {
    this.newPage();
    this.sectionHeader('The Introductory Rites');

    this.subHeading('Organ Prelude');
    this.musicLine('organPrelude', 'organPreludeComposer', 'Prelude');

    this.rubric(RUBRICS.stand);

    const entranceType = this.ss.entranceType || 'processional';
    this.subHeading(entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon');
    this.musicLine('processionalOrEntrance', 'processionalOrEntranceComposer',
      entranceType === 'processional' ? 'Processional' : 'Antiphon');
    // Hymn paste area only when a processional hymn is sung (not antiphon).
    // Reserve space for penitential act, Kyrie, Gloria, optional Advent wreath,
    // and optional Children's Liturgy dismissal box.
    if (entranceType === 'processional') {
      const clReserve = this.data.childrenLiturgyEnabled ? 75 : 0;
      this.hymnMusicSpace({ slot: 'processional', reserveBelow: 150 + clReserve });
    }

    if (this.showAdventWreath) {
      this.y += this.s(3);
      this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, this.s(18))
        .fillColor('#f0eaf5').fill().restore();
      this.doc.fontSize(this.s(9)).fillColor(COLORS.purple).font('Sans-Bold')
        .text('Lighting of the Advent Wreath', this.MARGIN_SIDE, this.y + this.s(4), { width: this.CONTENT_WIDTH, align: 'center' });
      this.doc.font('Sans');
      this.y = this.doc.y + this.s(8);
    }

    if ((this.ss.penitentialAct || 'confiteor') === 'confiteor') {
      this.subHeading('Penitential Act');
      this.bodyText(CONFITEOR, { size: 8, gap: 3 });
    }

    this.subHeading('Lord, Have Mercy');
    this.musicLine('kyrieSetting', 'kyrieComposer', 'Kyrie');
    this.ordinaryMusicSpace('kyrie', 'Kyrie — music notation');

    const showGloria = this.ss.gloria !== undefined ? this.ss.gloria :
      (this.data.liturgicalSeason !== 'lent' && this.data.liturgicalSeason !== 'advent');
    if (showGloria) {
      this.subHeading('Gloria');
      // Which setting the Gloria is sung from (e.g. "Mass of Creation").
      if (this.ss.gloriaSetting) this.bodyText(this.ss.gloriaSetting, { italic: true, gap: 1 });
      if (this._slotHasMusic('gloria')) {
        this.ordinaryMusicSpace('gloria', 'Gloria — music notation', { bridge: true, reserveBelow: this.data.childrenLiturgyEnabled ? 85 : 0 });
      } else {
        this.bodyText('Glory to God in the highest, and on earth peace to people of good will.');
      }
    }

    // Children's Liturgy dismissal — placed here because children are
    // dismissed AFTER the Opening Prayer (end of Introductory Rites),
    // BEFORE the First Reading. They return at the Offertory (page 5).
    if (this.data.childrenLiturgyEnabled) {
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
        this.doc.font(font).fontSize(this.s(size));
        contentH += this.doc.heightOfString(text, { width: innerW });
      }
      const boxH = Math.min(contentH + this.s(8), Math.max(0, this._bottom() - this.y));
      if (boxH > this.s(10)) {
        if (!this._dryRun) {
          this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, boxH)
            .fillColor('#f5f0e6').fill().restore();
          const boxBottom = this.y + boxH;
          let cursorY = this.y + this.s(4);
          for (const [text, font, size] of clLines) {
            this.doc.font(font).fontSize(this.s(size)).fillColor(COLORS.text);
            const remaining = boxBottom - cursorY;
            if (remaining < this.doc.currentLineHeight(true)) { this._warnClipped(); break; }
            this.doc.text(text, innerX, cursorY, { width: innerW, height: remaining, ellipsis: true });
            cursorY = this.doc.y;
          }
        }
        this.y += boxH + this.s(4);
      }
      if (this._dryRun) this.y += contentH + this.s(12);
      this.doc.font('Sans');
      this._trackY();
    }

    this.pageNumber(2);
  }

  renderPage3LiturgyOfWord() {
    this.newPage();
    // A music image bridging from page 2 finishes here, above everything.
    this._drawCarriedNotation();
    this._fitPageText(() => {
      this.sectionHeader('The Liturgy of the Word');
      this.rubric(RUBRICS.sit);

      this.subHeading('First Reading');
      this.citation(this.r.firstReadingCitation);
      this.bodyText(this.r.firstReadingText, { size: 9 });

      this.subHeading('Responsorial Psalm');
      this.citation(this.r.psalmCitation);
      this.musicLine('responsorialPsalmSetting', 'responsorialPsalmSettingComposer', 'Setting');
      // Music (uploaded refrain notation or a paste area) replaces the
      // text refrain — the notation carries the words.
      if (this._slotHasMusic('psalmRefrain')) {
        this.ordinaryMusicSpace('psalmRefrain', 'Responsorial Psalm refrain — music notation');
      } else if (this.r.psalmRefrain) {
        this.bodyText(`R. ${this.r.psalmRefrain}`, { bold: true, size: 9 });
      }
      if (this.r.psalmVerses) this.bodyText(this.r.psalmVerses, { size: 8.5, x: this.MARGIN_SIDE + this.s(10), width: this.CONTENT_WIDTH - this.s(10) });

      if (!this.r.noSecondReading && this.r.secondReadingCitation) {
        this.subHeading('Second Reading');
        this.citation(this.r.secondReadingCitation);
        this.bodyText(this.r.secondReadingText, { size: 9 });
      }

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
      // Order mirrors the HTML renderer: acclamation, reference, verse.
      if (this.r.gospelAcclamationReference) {
        this.citation(this.r.gospelAcclamationReference);
      }
      if (this.r.gospelAcclamationVerse) {
        this.bodyText(this.r.gospelAcclamationVerse, { italic: true, size: 8.5 });
      }
    });

    this.pageNumber(3);
  }

  renderPage4GospelCreed() {
    this.newPage();
    this._fitPageText(() => {
      this.subHeading('Gospel');
      this.citation(this.r.gospelCitation);
      this.bodyText(this.r.gospelText, { size: 9.5 });

      this.subHeading('Homily');
      this.rubric(RUBRICS.sit);
      this.y += this.s(4);
      this.rubric(RUBRICS.stand);

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
      this.subHeading(creedHeading);
      if (this.ss.twoColumnCreed && creedType !== 'baptismal_vows') {
        this._renderCreedTwoColumn(creedText);
      } else {
        this.bodyText(creedText);
      }

      this.subHeading('Prayer of the Faithful');
      this.bodyText('The intentions are read; the assembly responds.', { italic: true, size: 8 });
    });

    this.pageNumber(4);
  }

  renderPage5LiturgyEucharist() {
    this.newPage();
    this.sectionHeader('The Liturgy of the Eucharist');
    this.rubric(RUBRICS.sit);

    this.subHeading('Offertory');
    this.musicLine('offertoryAnthem', 'offertoryAnthemComposer', 'Offertory Anthem');

    // Children return from Children's Liturgy of the Word at the Offertory.
    if (this.data.childrenLiturgyEnabled) {
      const _clTimes = (Array.isArray(this.data.childrenLiturgyMassTimes) && this.data.childrenLiturgyMassTimes.length)
        ? this.data.childrenLiturgyMassTimes
        : (this.data.childrenLiturgyMassTime ? [this.data.childrenLiturgyMassTime] : ['Sun 9:00 AM']);
      this.rubric(`† Children return from Children's Liturgy of the Word (${_clTimes.join(' & ')}).`);
    }

    this.rubric(RUBRICS.stand);

    this.subHeading('Invitation to Prayer');
    this.bodyText(`Priest: ${INVITATION_TO_PRAYER.priest}`);
    this.bodyText(`All: ${INVITATION_TO_PRAYER.all}`, { bold: true });

    // Sanctus language: per-aid override > parish default > English
    const holyHolyLanguage = this.ss.holyHolyLanguage || this.parishSettings.defaultSanctusLanguage || 'english';
    this.subHeading(holyHolyLanguage === 'latin' ? 'Sanctus' : 'Holy, Holy, Holy');
    this.bodyText(this.ss.holyHolySetting || 'Mass of St. Theresa', { italic: true });
    if (this._slotHasMusic('sanctus')) {
      this.ordinaryMusicSpace('sanctus', 'Holy, Holy, Holy — music notation');
    } else {
      this.bodyText(getHolyHolyHolyText(holyHolyLanguage));
    }

    this.rubric(RUBRICS.kneel);

    this.subHeading('Mystery of Faith');
    this.bodyText(this.ss.mysteryOfFaithSetting || 'Mass of St. Theresa', { italic: true });
    this.ordinaryMusicSpace('mysteryOfFaith', 'Mystery of Faith — music notation');

    this.subHeading('Great Amen');

    this.pageNumber(5);
  }

  renderPage6CommunionRite() {
    this.newPage();
    this.sectionHeader('The Communion Rite');

    this.subHeading("The Lord's Prayer");
    this.rubric(RUBRICS.stand);
    this.bodyText(LORDS_PRAYER);

    this.subHeading('Sign of Peace');

    this.subHeading('Lamb of God');
    this.bodyText(this.ss.lambOfGodSetting || 'Mass of St. Theresa', { italic: true });
    this.ordinaryMusicSpace('lambOfGod', 'Lamb of God — music notation');

    this.rubric(RUBRICS.kneel);

    this.subHeading('Communion Hymn');
    this.musicLine('communionHymn', 'communionHymnComposer', 'Communion');
    this.hymnMusicSpace({ slot: 'communion', reserveBelow: 50 });

    this.subHeading('Choral Anthem');
    this.musicLine('choralAnthemConcluding', 'choralAnthemConcludingComposer', 'Anthem');

    this.pageNumber(6);
  }

  renderPage7ConcludingRites() {
    this.newPage();
    // A music image bridging from page 6 finishes here, above everything.
    this._drawCarriedNotation();
    // keepBottom: the copyright line is anchored inside the bottom margin
    // band on this page, so the content area must not grow down into it.
    this._fitPageText(() => {
      this.sectionHeader('The Concluding Rites');

      this.subHeading('Hymn of Thanksgiving');
      this.musicLine('hymnOfThanksgiving', 'hymnOfThanksgivingComposer', 'Thanksgiving');
      // Leave room below for the blessing & dismissal, postlude, announcements
      // (estimated from text length), and the copyright line.
      const announcementReserve = this.data.announcements
        ? Math.min(120, Math.ceil(String(this.data.announcements).length / 80) * 10 + 25)
        : 0;
      this.hymnMusicSpace({ slot: 'thanksgiving', reserveBelow: 130 + announcementReserve });

      this.rubric(RUBRICS.stand);

      this.subHeading('Blessing & Dismissal');
      this.bodyText('Priest: The Lord be with you. All: And with your spirit.', { size: 8 });
      this.bodyText('Priest: May almighty God bless you, the Father, and the Son, ✠ and the Holy Spirit. All: Amen.', { size: 8 });
      this.bodyText('Deacon: Go forth, the Mass is ended. All: Thanks be to God.', { size: 8 });

      if (this.includePostlude) {
        this.subHeading('Organ Postlude');
        this.musicLine('organPostlude', 'organPostludeComposer', 'Postlude');
      }

      if (this.data.announcements) {
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
      }
    }, { keepBottom: true });

    // Single line only — a wrapped copyright line would overlap the folio.
    // Manually truncate with an ellipsis if it can't fit the content width.
    let copyrightShort = String(this.parishSettings.copyrightShort ||
      getDefaultCopyrightShort(this.parishSettings.onelicenseNumber)).replace(/\s+/g, ' ').trim();
    this.doc.font('Sans').fontSize(this.s(7));
    if (this.doc.widthOfString(copyrightShort) > this.CONTENT_WIDTH) {
      while (copyrightShort.length > 1 && this.doc.widthOfString(copyrightShort + '…') > this.CONTENT_WIDTH) {
        copyrightShort = copyrightShort.slice(0, -1);
      }
      copyrightShort = copyrightShort.trimEnd() + '…';
    }
    this._footerText(copyrightShort, this.PAGE_HEIGHT - this.MARGIN * 0.85, { lineBreak: false });

    this.pageNumber(7);
  }

  renderPage8BackCover() {
    this.newPage();
    const cx = this.PAGE_WIDTH / 2;

    this.y = this.MARGIN_TOP + this.s(80);
    const armLen = this.s(18);
    this.doc.save().lineWidth(this.s(3)).strokeColor(COLORS.navy);
    this.doc.moveTo(cx, this.y - armLen).lineTo(cx, this.y + armLen).stroke();
    this.doc.moveTo(cx - armLen, this.y).lineTo(cx + armLen, this.y).stroke();
    this.doc.lineWidth(this.s(1));
    const corner = this.s(11), tick = this.s(4);
    for (const [ox, oy] of [[-corner, -corner], [corner, -corner], [-corner, corner], [corner, corner]]) {
      this.doc.moveTo(cx + ox, this.y + oy - tick).lineTo(cx + ox, this.y + oy + tick).stroke();
      this.doc.moveTo(cx + ox - tick, this.y + oy).lineTo(cx + ox + tick, this.y + oy).stroke();
    }
    this.doc.restore();

    this.y = this.MARGIN_TOP + this.s(120);
    this.doc.fontSize(this.s(13)).fillColor(COLORS.navy).font('Sans-Bold')
      .text(this.data.feastName, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(3);
    this.doc.fontSize(this.s(10)).fillColor(COLORS.muted).font('Sans')
      .text(formatDate(this.data.liturgicalDate), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });

    // Anchor copyright above the bottom margin so it never crosses it.
    const copyrightBlockHeight = this.s(90);
    const copyrightY = this.PAGE_HEIGHT - this.MARGIN - copyrightBlockHeight;

    this.y = this.doc.y + this.s(14);
    if (this.data.specialNotes) {
      // Clamp to the top of the copyright block so long notes can't push
      // the back cover onto a ninth page.
      const notesRoom = copyrightY - this.s(6) - this.y;
      if (notesRoom > this.s(12)) {
        this.doc.fontSize(this.s(9)).fillColor(COLORS.muted).font('Sans-Italic')
          .text(this.data.specialNotes, this.MARGIN_SIDE + this.s(20), this.y,
            { width: this.CONTENT_WIDTH - this.s(40), align: 'center', height: notesRoom, ellipsis: true });
        this.y = Math.min(this.doc.y, copyrightY - this.s(6)) + this.s(8);
      } else {
        this._warnClipped();
      }
      this.doc.font('Sans');
    }

    // Standing closing message (like the HTML back cover), above the
    // copyright block and clamped to it.
    if (this.parishSettings.closingMessage) {
      const closingRoom = copyrightY - this.s(6) - this.y;
      if (closingRoom > this.s(12)) {
        this.doc.fontSize(this.s(8)).fillColor(COLORS.muted).font('Sans')
          .text(this.parishSettings.closingMessage, this.MARGIN_SIDE + this.s(20), this.y,
            { width: this.CONTENT_WIDTH - this.s(40), align: 'center', height: closingRoom, ellipsis: true });
      } else {
        this._warnClipped();
      }
    }

    // Default wording shared with the HTML renderer (single source:
    // DEFAULT_PARISH_SETTINGS in config/defaults.js).
    const copyrightFull = this.parishSettings.copyrightFull ||
      getDefaultCopyrightFull(this.parishSettings.onelicenseNumber);
    // Footer-style write: a custom copyright block longer than the reserved
    // space is clipped at the page edge instead of spilling to a new page.
    const prevBottom = this.doc.page.margins.bottom;
    this.doc.page.margins.bottom = 0;
    this.doc.fontSize(this.s(6.5)).fillColor(COLORS.light)
      .text(copyrightFull, this.MARGIN_SIDE + this.s(10), copyrightY, {
        width: this.CONTENT_WIDTH - this.s(20), align: 'center', lineGap: this.s(1.5),
        height: this.PAGE_HEIGHT - copyrightY, ellipsis: true
      });
    this.doc.page.margins.bottom = prevBottom;
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
