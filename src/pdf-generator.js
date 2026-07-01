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
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, getHolyHolyHolyText } = require('./assets/text/mass-texts');
const { getDefaultCopyrightFull } = require('./assets/text/copyright');
const { formatMusicSlot, renderMusicLineText } = require('./music-formatter');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');
const { getImageDimensions } = require('./image-utils');

// QR encoding for the classic design's Give/Join/Bulletin codes. Loaded
// lazily so a stripped install (or a missing optional dep) simply omits the
// codes instead of crashing the whole generator.
let _qrcode = null;
function getQRCode() {
  if (_qrcode === null) {
    try { _qrcode = require('qrcode'); }
    catch (e) { _qrcode = false; }
  }
  return _qrcode || null;
}

// 72pt = 1 inch
const PT = 72;

// Default printed width for uploaded music images, in inches on the
// 8.5in-wide (tabloid) page. The director of liturgy's spec: ALL music
// notation prints 5"–5.5" wide, centered (service music was previously 6"
// — "rendered too large"). Other trims scale proportionally to their page
// width and clamp to the content area.
const NOTATION_WIDTH_IN = 5.5;
const NOTATION_WIDTHS_IN = {
  processional: NOTATION_WIDTH_IN, communion: NOTATION_WIDTH_IN,
  thanksgiving: NOTATION_WIDTH_IN, psalmRefrain: NOTATION_WIDTH_IN,
  kyrie: NOTATION_WIDTH_IN, gloria: NOTATION_WIDTH_IN, sanctus: NOTATION_WIDTH_IN,
  mysteryOfFaith: NOTATION_WIDTH_IN, lambOfGod: NOTATION_WIDTH_IN,
  gospelAcclamation: NOTATION_WIDTH_IN
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

// Serif family for the "classic" design — a faithful, freely-licensed
// emulation of the parish's in-house worship aid:
//   * Serif*   — TeX Gyre Pagella (URW P052), metric-compatible with
//                Palatino / Book Antiqua: the body text and bold/italic
//                sub-heading labels.
//   * Display* — EB Garamond: the centered small-caps section headers and
//                the cover title.
//   * Script-Italic — URW Bookman (light italic): the cover's "If you are
//                new to St. Theresa…" greeting.
// All are SIL OFL and vendored under assets/fonts/classic. When the font
// directory can't be found (a stripped bundle) the classic roles fall back
// to PDFKit's built-in Times family so the design still renders.
const FONT_FILES_CLASSIC = {
  'Serif':            path.join('classic', 'Classic-Serif-Regular.otf'),
  'Serif-Bold':       path.join('classic', 'Classic-Serif-Bold.otf'),
  'Serif-Italic':     path.join('classic', 'Classic-Serif-Italic.otf'),
  'Serif-BoldItalic': path.join('classic', 'Classic-Serif-BoldItalic.otf'),
  'Display':          path.join('classic', 'Classic-Display-Regular.ttf'),
  'Display-SemiBold': path.join('classic', 'Classic-Display-SemiBold.ttf'),
  'Display-Italic':   path.join('classic', 'Classic-Display-Italic.ttf'),
  'Script-Italic':    path.join('classic', 'Classic-Script-Italic.otf')
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

// Physical font files for the classic serif roles, or PDFKit built-in
// Times fallbacks when the vendored files aren't reachable.
function resolveClassicFontPaths() {
  const dir = resolveFontDir();
  const builtin = {
    'Serif': 'Times-Roman', 'Serif-Bold': 'Times-Bold',
    'Serif-Italic': 'Times-Italic', 'Serif-BoldItalic': 'Times-BoldItalic',
    'Display': 'Times-Roman', 'Display-SemiBold': 'Times-Bold',
    'Display-Italic': 'Times-Italic', 'Script-Italic': 'Times-Italic'
  };
  if (!dir) return builtin;
  const out = {};
  for (const [name, file] of Object.entries(FONT_FILES_CLASSIC)) {
    const p = path.join(dir, file);
    out[name] = fs.existsSync(p) ? p : builtin[name];
  }
  return out;
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

// Two output designs share the same flow engine, readings handling, and
// notation pipeline; they differ only in typography, color, section naming,
// and a few layout choices. The theme object below is consulted by the
// shared drawing primitives so "reimagined" (the app's original look) stays
// byte-for-byte identical while "classic" reproduces the parish's in-house
// Book-Antiqua/Garamond worship aid.
const THEMES = {
  reimagined: {
    design: 'reimagined',
    // Logical role -> registered font name.
    fonts: {
      body: 'Sans', bold: 'Sans-Bold', italic: 'Sans-Italic', boldItalic: 'Sans-BoldItalic',
      section: 'Sans-Bold', sectionAside: 'Sans-Bold', script: 'Sans-Italic'
    },
    colors: {
      section: COLORS.navy, subLabel: COLORS.burgundy, subInline: COLORS.text,
      rubric: '#8B0000', body: COLORS.text, muted: COLORS.muted, rule: COLORS.gold,
      coverName: COLORS.gold, feast: COLORS.navy
    },
    smallCaps: false,      // section headers are letter-spaced ALL CAPS + a gold rule
    sectionRule: true,
    sectionSize: 11,
    subUpper: true,        // sub-headings render uppercase
    subDash: false,        // ...with the inline text after a space, not an em-dash
    subSize: 8,
    twoColumn: false       // psalm verses & creed stack full-width
  },
  classic: {
    design: 'classic',
    fonts: {
      body: 'Serif', bold: 'Serif-Bold', italic: 'Serif-Italic', boldItalic: 'Serif-BoldItalic',
      section: 'Display', sectionAside: 'Display-Italic', script: 'Script-Italic'
    },
    colors: {
      section: '#111111', subLabel: '#111111', subInline: '#222222',
      rubric: '#222222', body: '#1A1A1A', muted: '#333333', rule: '#000000',
      coverName: '#111111', feast: '#111111'
    },
    smallCaps: true,       // centered EB Garamond small-caps headers, no rule
    sectionRule: false,
    sectionSize: 15,
    subUpper: false,       // title-case bold labels
    subDash: true,         // "Processional Hymn — Title" with an em-dash
    subSize: 9,
    twoColumn: true        // psalm verses & creed in two columns
  }
};

function resolveTheme(design) {
  return THEMES[design] || THEMES.reimagined;
}

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

    // Output design: caller option > per-aid field > reimagined (original).
    this.design = options.design || data.design || 'reimagined';
    this.theme = resolveTheme(this.design);

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
    // True when the current page carries licensed music — an embedded
    // notation image OR a reserved hymn paste area — so the short license
    // line prints in that page's footer.
    this._pageHasNotation = false;

    // 8-page guarantee state: global shrink factor for body text AND
    // notation images, and the dry-run flag used while measuring blocks.
    this.textScale = 1;
    this._dryRun = false;
    this._clipWarnedPage = 0;
  }

  // Scale a base font/spacing value by the layout's scale factor.
  s(n) { return n * this.scale; }

  // Theme lookups — logical font role -> registered font name, and semantic
  // color role -> hex. Reimagined maps these back to the original Sans fonts
  // and navy/burgundy/gold, so its output is unchanged.
  _font(role) { return this.theme.fonts[role] || this.theme.fonts.body; }
  _color(role) { return this.theme.colors[role] || this.theme.colors.body; }

  // Ascent (top-of-text to baseline) of the current font at a given size,
  // used to align mixed-size runs on a shared baseline.
  _ascentAt(size) {
    const f = this.doc._font;
    const ascender = (f && f.ascender) ? f.ascender : 750;
    return (ascender / 1000) * size;
  }

  // Draw a centered faux-small-caps section title in the classic Display
  // face: significant words get an enlarged initial cap followed by smaller
  // capitals; connective words ("of the", "in") stay italic lowercase. All
  // runs share one baseline. Returns the height consumed.
  _smallCapsTitle(text, baseSize) {
    const CONNECTORS = new Set(['of', 'the', 'in', 'and', 'to', 'for', 'a', 'of the']);
    const capSize = baseSize;
    const restSize = baseSize * 0.78;
    const connSize = baseSize * 0.72;
    const words = String(text).trim().split(/\s+/);
    // Build the run list: each run is {str, size, font, italic}.
    const runs = [];
    words.forEach((w, i) => {
      if (i > 0) runs.push({ str: ' ', size: restSize, font: this._font('section') });
      // The leading word is always a full small-cap ("THE Liturgy…"); only
      // interior connectives drop to italic lowercase.
      if (i > 0 && CONNECTORS.has(w.toLowerCase())) {
        runs.push({ str: w.toLowerCase(), size: connSize, font: this._font('sectionAside'), italic: true });
      } else {
        const up = w.toUpperCase();
        runs.push({ str: up[0], size: capSize, font: this._font('section') });
        if (up.length > 1) runs.push({ str: up.slice(1), size: restSize, font: this._font('section') });
      }
    });
    // Measure total width and the tallest ascent (for the shared baseline).
    let totalW = 0, maxAscent = 0, maxSize = 0;
    for (const r of runs) {
      this.doc.font(r.font).fontSize(r.size);
      r.w = this.doc.widthOfString(r.str, { characterSpacing: r.italic ? 0 : this.s(0.5) });
      totalW += r.w;
      maxAscent = Math.max(maxAscent, this._ascentAt(r.size));
      maxSize = Math.max(maxSize, r.size);
    }
    const blockH = maxSize * 1.18;
    if (this._dryRun) { this.y += blockH; return blockH; }
    const baseline = this.y + maxAscent;
    let x = this.MARGIN_SIDE + Math.max(0, (this.CONTENT_WIDTH - totalW) / 2);
    for (const r of runs) {
      this.doc.font(r.font).fontSize(r.size).fillColor(this._color('section'));
      const yTop = baseline - this._ascentAt(r.size);
      this.doc.text(r.str, x, yTop, { lineBreak: false, characterSpacing: r.italic ? 0 : this.s(0.5) });
      x += r.w;
    }
    this.y += blockH;
    this._trackY();
    return blockH;
  }

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
      // The classic design needs its serif roles registered too.
      if (this.design === 'classic') {
        for (const [name, filePath] of Object.entries(resolveClassicFontPaths())) {
          doc.registerFont(name, filePath);
        }
      }
      doc.font(this.design === 'classic' ? 'Serif' : 'Sans');

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);
      this.doc = doc;
      this.y = this.MARGIN_TOP;

      try {
        if (this.design === 'classic') this.renderPage1CoverClassic();
        else this.renderPage1Cover();
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
    // Classic: a large centered small-caps Garamond title, no rule.
    if (this.theme.smallCaps) {
      this.y += this.s(2);
      this._smallCapsTitle(text, this.s(this.theme.sectionSize));
      this.y += this.s(6);
      this.doc.font(this._font('body'));
      return;
    }
    // Reimagined: letter-spaced ALL-CAPS with a gold rule underneath.
    this.doc.fontSize(this.s(this.theme.sectionSize)).fillColor(this._color('section')).font(this._font('section'));
    const ruleY = this.y + this.doc.heightOfString(text.toUpperCase(), { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 }) + this.s(2);
    this._textBlock(text.toUpperCase(), this.MARGIN_SIDE,
      { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 }, this.s(8));
    if (this.theme.sectionRule && !this._dryRun) {
      this.doc.save()
        .moveTo(this.MARGIN_SIDE + this.s(40), ruleY)
        .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE - this.s(40), ruleY)
        .lineWidth(0.5).strokeColor(this._color('rule')).stroke().restore();
    }
    this.doc.font(this._font('body'));
  }

  // A sub-heading line. Per the director of liturgy, a piece's title/composer
  // and a reading's scripture citation belong ON the heading line (not on a
  // separate line below), and a posture direction ("Please stand") sits
  // right-justified on that same line. opts:
  //   inline      — text placed immediately after the heading (music
  //                 title/composer, or a scripture citation)
  //   inlineFont  — font for the inline text (default 'Sans-Italic' for
  //                 music; pass 'Sans-Bold' for citations)
  //   inlineColor — color for the inline text
  //   right       — posture direction, right-justified on the heading line
  // All parts share the heading's font size so their baselines align.
  subHeading(text, opts = {}) {
    const SIZE = this.s(this.theme.subSize);
    const boldFont = this._font('bold');
    const labelCS = this.theme.subUpper ? 0.8 : 0;   // reimagined letter-spaces its caps
    // Classic joins the label to its inline title with an em-dash ("Hymn—Title").
    const label = (this.theme.subUpper ? String(text).toUpperCase() : String(text))
      + (this.theme.subDash && opts.inline ? '—' : '');
    // Classic renders every inline (titles AND scripture citations) in italic
    // serif; reimagined honors the caller's inlineFont (bold for citations).
    const inlineFontName = this.theme.design === 'classic'
      ? this._font('italic')
      : (opts.inlineFont || this._font('italic'));
    const inlineColor = this.theme.design === 'classic'
      ? this._color('subInline')
      : (opts.inlineColor || this._color('subInline'));
    const startY = this.y;

    // Measure each part up front (same font size → shared baseline).
    this.doc.fontSize(SIZE).font(boldFont);
    const headingW = this.doc.widthOfString(label, { characterSpacing: labelCS });
    let rightW = 0;
    if (opts.right) {
      this.doc.fontSize(SIZE).font(this._font('italic'));
      rightW = this.doc.widthOfString(opts.right);
    }
    const gap = this.theme.subDash ? this.s(1.5) : this.s(6);
    const inlineX = this.MARGIN_SIDE + headingW + (opts.inline ? gap : 0);
    // Inline text may wrap; it gets the room between the heading and the
    // right-justified posture direction (or the right margin).
    const rightEdge = this.PAGE_WIDTH - this.MARGIN_SIDE - (rightW ? rightW + gap : 0);
    const inlineW = Math.max(this.s(40), rightEdge - inlineX);

    // Height of the line = tallest part (inline text can wrap to 2+ lines).
    let blockH = this.doc.fontSize(SIZE).font(boldFont).currentLineHeight(true);
    if (opts.inline) {
      this.doc.fontSize(SIZE).font(inlineFontName);
      blockH = Math.max(blockH, this.doc.heightOfString(String(opts.inline), { width: inlineW }));
    }

    if (this._dryRun) {
      this.y = startY + blockH + this.s(2);
      this.doc.font(this._font('body'));
      return;
    }
    if (this._bottom() - startY < this.doc.fontSize(SIZE).font(boldFont).currentLineHeight(true)) {
      this._warnClipped();
      this.doc.font(this._font('body'));
      return;
    }

    // Heading label.
    this.doc.fontSize(SIZE).fillColor(this._color('subLabel')).font(boldFont)
      .text(label, this.MARGIN_SIDE, startY, { characterSpacing: labelCS, lineBreak: false });
    // Right-justified posture direction.
    if (opts.right) {
      this.doc.fontSize(SIZE).fillColor(this._color('rubric')).font(this._font('italic'))
        .text(opts.right, rightEdge, startY, { width: rightW, align: 'right', lineBreak: false });
    }
    // Inline title/composer or scripture citation.
    if (opts.inline) {
      this.doc.fontSize(SIZE).fillColor(inlineColor).font(inlineFontName)
        .text(String(opts.inline), inlineX, startY, { width: inlineW });
    }

    this.y = startY + blockH + this.s(2);
    this.doc.font(this._font('body'));
    this._trackY();
  }

  // Sub-heading for a music slot: the piece's title + composer go inline on
  // the heading line with the redundant slot label dropped (director: "don't
  // restate what it is; only provide the title and composer"). When a slot
  // carries different pieces per Mass time, the heading stands alone and each
  // piece is listed on its own line below (still label-free).
  musicHeading(heading, titleField, composerField, opts = {}) {
    const items = formatMusicSlot(this.data, titleField, composerField);
    if (items.length <= 1) {
      this.subHeading(heading, { inline: items[0] ? renderMusicLineText(items[0]) : undefined, right: opts.right });
    } else {
      this.subHeading(heading, { right: opts.right });
      for (const item of items) {
        this.bodyText(renderMusicLineText(item), { italic: true, size: 8.5, gap: 1 });
      }
    }
  }

  rubric(text, align) {
    // Standalone posture directions ("Please stand/kneel/be seated" on their
    // own line) are centered by default per the director of liturgy. Callers
    // may override, and a parish rubricAlignment setting still wins.
    const a = align || this.ss.rubricAlignment || 'center';
    this.doc.fontSize(this.s(this.design === 'classic' ? 8.5 : 7.5)).fillColor(this._color('rubric')).font(this._font('italic'));
    this._textBlock(text, this.MARGIN_SIDE, { width: this.CONTENT_WIDTH, align: a }, this.s(2));
    this.doc.font(this._font('body'));
  }

  bodyText(text, opts = {}) {
    if (!text) return;
    // Default body size 9; callers may pass opts.size for secondary text
    // (dialogues, announcements, notes). textScale is the flow engine's
    // global shrink factor.
    const baseSize = opts.size || 9;
    this.doc.fontSize(this.s(baseSize) * this.textScale)
      .fillColor(opts.color || this._color('body'))
      .font(opts.bold ? this._font('bold') : opts.italic ? this._font('italic') : this._font('body'));
    const x = opts.x !== undefined ? opts.x : this.MARGIN_SIDE;
    const width = opts.width !== undefined ? opts.width : this.CONTENT_WIDTH;
    this._textBlock(text, x, {
      width,
      align: opts.align || 'left',
      lineGap: this.s(1) * this.textScale
    }, this.s(opts.gap !== undefined ? opts.gap : 3));
    this.doc.font(this._font('body'));
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
      // Same fit tolerance as the render loop, or a block within 1pt of
      // exactly fitting would trigger a needless global shrink.
      if (h > this._bottom() - y + 1 && y > this.MARGIN_TOP + 1) {
        pages++;
        y = this.MARGIN_TOP;
      }
      y += h;
    }
    return pages;
  }

  // Folio only. The OneLicense permission line is NOT repeated on every page
  // that carries notation — per the director of liturgy it appears once, in
  // the full copyright block at the end of the document. The per-page flag
  // is still cleared so it can't leak across pages.
  _finishContentPage(pageNo) {
    this._pageHasNotation = false;
    this.pageNumber(pageNo);
  }

  renderContentFlow() {
    const blocks = this.design === 'classic' ? this._buildContentBlocksClassic() : this._buildContentBlocks();

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
    const inches = NOTATION_WIDTHS_IN[slot] || NOTATION_WIDTH_IN;
    return Math.min(inches * PT * (this.PAGE_WIDTH / (8.5 * PT)), this.CONTENT_WIDTH);
  }

  _notationImage(slot, maxHBase, opts = {}) {
    const buf = this.notationImages[slot];
    if (!buf) return false;
    const available = this._bottom() - this.y;
    const dims = getImageDimensions(buf);

    // The director of liturgy's spec: all music notation prints 5"–5.5"
    // wide. Width is fixed at the slot's spec; height follows the image's
    // natural aspect ratio. textScale: when the flow engine shrinks the
    // booklet to fit 8 pages, images shrink with the text so the layout
    // compresses evenly instead of starving the last slot.
    let drawW = this._notationTargetWidth(slot) * this.textScale;
    let drawH = dims ? (dims.height / dims.width) * drawW : this.s(maxHBase);

    // Height is capped ONLY at a full content page — never at the scrap left
    // below the current block. A notation image that doesn't fit the room
    // remaining is pushed whole to the next page by the flow paginator (the
    // Gloria that was shrunk too small should instead have bumped the
    // Liturgy of the Word to the following page). We do NOT reduce the width
    // to squeeze the image into leftover space, which is what made notation
    // render below the 5" minimum.
    const fullPageH = this._bottom() - this.MARGIN_TOP;
    if (drawH > fullPageH) {
      // Taller than a whole page even at spec width: shrink proportionally
      // so the image stays complete (rare — a very tall single score).
      drawW = drawW * (fullPageH / drawH);
      drawH = fullPageH;
    }
    if (!this._dryRun && drawH > available + 1) {
      // The paginator should have started a fresh page for this block; if a
      // late slot still overruns, clamp to the page and warn rather than
      // silently run past the bottom margin.
      if (available < this.s(20)) {
        this.warnings.push(`Page is too full to place the ${slot} notation image.`);
        return true; // the slot HAS music; we just couldn't fit it
      }
      this.warnings.push(`Page was too full to print the ${slot} notation at full size — it was reduced to fit.`);
      drawW = drawW * (available / drawH);
      drawH = available;
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
    this.doc.fontSize(this.s(6.5)).fillColor('#B5B5B5').font(this._font('italic'))
      .text('Reserved for hymn music — paste licensed notation here',
        this.MARGIN_SIDE, this.y + h / 2 - this.s(4),
        { width: this.CONTENT_WIDTH, align: 'center' });
    this.doc.font(this._font('body'));
    // This page will carry licensed music once the parish pastes it in —
    // it needs the license line just like a page with embedded notation.
    this._pageHasNotation = true;
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
    this.doc.fontSize(this.s(9) * this.textScale).fillColor(this._color('body')).font(this._font('body'));
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
    this.doc.fontSize(this.s(6)).fillColor('#C8C8C8').font(this._font('italic'))
      .text(label || 'Music notation', this.MARGIN_SIDE,
        this.y + drawH / 2 - this.s(3),
        { width: this.CONTENT_WIDTH, align: 'center' });
    this.doc.font(this._font('body'));
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

  _drawDefaultCross(cx, y, opts = {}) {
    const armLen = opts.arm || this.s(25);
    const k = armLen / this.s(25);
    this.doc.save().lineWidth(this.s(4) * k).strokeColor(opts.color || COLORS.navy);
    this.doc.moveTo(cx, y - armLen).lineTo(cx, y + armLen).stroke();
    this.doc.moveTo(cx - armLen, y).lineTo(cx + armLen, y).stroke();
    this.doc.lineWidth(this.s(1.5) * k);
    const corner = this.s(15) * k, tick = this.s(5) * k;
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
  // Classic cover: an elegant Garamond title, the parish cross, and a
  // single-column "If you are new…" welcome with bold-labeled info blocks —
  // a faithful reproduction of the parish's in-house worship aid cover.
  renderPage1CoverClassic() {
    const cx = this.PAGE_WIDTH / 2;
    this.y = this.MARGIN_TOP + this.s(16);

    // Feast title — large small-caps Garamond, wraps across lines as needed.
    this._coverTitleClassic(this.data.feastName, this.s(25));
    this.y += this.s(4);
    // Date — centered italic.
    this.doc.fontSize(this.s(13)).fillColor(this._color('feast')).font('Display-Italic')
      .text(formatDate(this.data.liturgicalDate), this.MARGIN_SIDE, this.y,
        { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(14);

    // Cross / parish logo, centered in the upper-middle of the page.
    const logoPath = this._resolveLogoPath();
    const logoH = this.s(112);
    if (logoPath) {
      try {
        this.doc.image(logoPath, cx - this.s(75), this.y, { fit: [this.s(150), logoH], align: 'center', valign: 'top' });
      } catch (e) {
        this._drawDefaultCross(cx, this.y + logoH / 2, { arm: this.s(48), color: this._color("feast") });
        this.warnings.push(`Cover logo could not be loaded: ${e.message}`);
      }
    } else {
      this._drawDefaultCross(cx, this.y + logoH / 2, { arm: this.s(48), color: this._color("feast") });
    }
    this.y += logoH + this.s(20);

    // "If you are new to <Parish>…" greeting in the script italic face.
    const ps = this.parishSettings;
    const shortName = ps.parishShortName || this._shortParishName(ps.parishName) || 'our parish';
    const greeting = ps.newcomerHeading || `If you are new to ${shortName}…`;
    this.doc.fontSize(this.s(17)).fillColor(this._color('feast')).font('Script-Italic')
      .text(greeting, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'left', lineBreak: false });
    this.y = this.doc.y + this.s(7);

    // Single-column info blocks: bold small-caps label, indented body.
    const infos = [
      ['CONNECT', ps.connectBlurb || 'If you are new or want to learn more about our community, please fill out a newcomer card at the Welcome Desk in the Narthex. Give completed forms to an usher or place them in the collection basket.'],
      ['NURSERY', ps.nurseryBlurb || 'Children are always welcome at Mass. A staffed nursery is available in the Family Center for children ages 6 months to 3 years during the 9:00 and 11:00 AM Sunday Masses.'],
      ['RESTROOMS', ps.restroomsBlurb || 'Public restrooms are located at the rear of the church on the west side of the Narthex.'],
      ['REQUEST PRAYER', ps.prayerBlurb || 'We lift up the parish prayer list during Sunday Mass and in our weekly newsletter. Share your prayer intentions with us any time.']
    ];
    for (const [label, body] of infos) {
      if (this.y > this._bottom() - this.s(14)) { this._warnClipped(); break; }
      this.doc.fontSize(this.s(8.5)).fillColor(this._color('subLabel')).font('Serif-Bold')
        .text(label, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, characterSpacing: 0.5, lineBreak: false });
      this.y = this.doc.y + this.s(1.5);
      const room = this._bottom() - this.y;
      if (room < this.s(9)) { this._warnClipped(); break; }
      this.doc.fontSize(this.s(9)).fillColor(this._color('body')).font('Serif')
        .text(body, this.MARGIN_SIDE + this.s(14), this.y,
          { width: this.CONTENT_WIDTH - this.s(14), align: 'justify', lineGap: this.s(0.5), height: room, ellipsis: true });
      this.y = this.doc.y + this.s(6.5);
    }
    this._trackY();
  }

  // Render a feast title as centered small-caps Garamond, wrapping words
  // across lines that fit the content width at the cap size.
  _coverTitleClassic(text, size) {
    const words = String(text).trim().split(/\s+/);
    this.doc.font(this._font('section')).fontSize(size);
    const spaceW = this.doc.widthOfString(' ');
    const lines = [];
    let line = [], lineW = 0;
    for (const w of words) {
      const wW = this.doc.widthOfString(w.toUpperCase());
      if (line.length && lineW + spaceW + wW > this.CONTENT_WIDTH) {
        lines.push(line); line = [w]; lineW = wW;
      } else {
        lineW += (line.length ? spaceW : 0) + wW; line.push(w);
      }
    }
    if (line.length) lines.push(line);
    for (const ln of lines) this._smallCapsTitle(ln.join(' '), size);
  }

  _shortParishName(name) {
    if (!name) return null;
    return String(name).replace(/\b(Catholic|Church|Parish|Roman)\b/gi, '').replace(/\s+/g, ' ').trim() || null;
  }

  // Draw a QR code as crisp vector modules for a URL, with a caption label
  // beneath. Silently no-ops (returning 0 width) when qrcode isn't available
  // or no URL is configured.
  _drawQR(url, label, x, yTop, boxSize) {
    const QR = getQRCode();
    if (!QR || !url) return;
    let qr;
    try { qr = QR.create(String(url), { errorCorrectionLevel: 'M' }); }
    catch (e) { return; }
    const n = qr.modules.size;
    const data = qr.modules.data;
    const cell = boxSize / n;
    if (!this._dryRun) {
      this.doc.save().fillColor('#000000');
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (data[r * n + c]) this.doc.rect(x + c * cell, yTop + r * cell, cell + 0.2, cell + 0.2).fill();
        }
      }
      this.doc.restore();
      this.doc.fontSize(this.s(8)).fillColor(this._color('body')).font('Display')
        .text(String(label).toUpperCase(), x - this.s(6), yTop + boxSize + this.s(3),
          { width: boxSize + this.s(12), align: 'center', characterSpacing: 0.5, lineBreak: false });
    }
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

    // Heading (with the scripture citation inline on the same line) + first
    // paragraph stay together; the remaining paragraphs flow as their own
    // blocks. opts.right places a posture direction on the heading line.
    const reading = (heading, citation, text, opts = {}) => {
      const paras = String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      b(() => {
        this.subHeading(heading, { inline: citation || undefined, inlineFont: 'Sans-Bold', inlineColor: '#333333', right: opts.right });
        if (paras[0]) this.bodyText(paras[0], opts);
      });
      for (const p of paras.slice(1)) b(() => this.bodyText(p, opts));
    };

    // --- The Introductory Rites ---
    b(() => {
      this.sectionHeader('The Introductory Rites');
      this.musicHeading('Organ Prelude', 'organPrelude', 'organPreludeComposer');
    });

    const entranceType = this.ss.entranceType || 'processional';
    b(() => {
      // "Please stand" rides on the entrance heading line, right-justified
      // (director: same line as the heading and the hymn title).
      this.musicHeading(
        entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon',
        'processionalOrEntrance', 'processionalOrEntranceComposer',
        { right: RUBRICS.stand });
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
      this.musicHeading('Lord, Have Mercy', 'kyrieSetting', 'kyrieComposer');
      this.ordinaryMusicSpace('kyrie', 'Kyrie — music notation');
    });

    const showGloria = this.ss.gloria !== undefined ? this.ss.gloria :
      (this.data.liturgicalSeason !== 'lent' && this.data.liturgicalSeason !== 'advent');
    if (showGloria) {
      b(() => {
        this.subHeading('Gloria', { inline: this.ss.gloriaSetting || undefined });
        if (this._slotHasMusic('gloria')) {
          this.ordinaryMusicSpace('gloria', 'Gloria — music notation');
        } else {
          this.bodyText('Glory to God in the highest, and on earth peace to people of good will.');
        }
      });
    }

    // --- The Collect + The Liturgy of the Word ---
    // The Collect (opening prayer) closes the Introductory Rites; its heading
    // follows the Gloria, then "Please be seated" sits between it and the
    // "The Liturgy of the Word" title (director). The Collect heading must not
    // strand at the foot of a page away from that transition, so — except when
    // a Children's Liturgy dismissal has to come between them — the Collect
    // heading, the "Please be seated" direction and the section title all
    // render as one block that moves to a fresh page together.
    {
      const paras = String(this.r.firstReadingText || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      const wordOpening = () => {
        this.rubric(RUBRICS.sit);
        this.sectionHeader('The Liturgy of the Word');
        this.subHeading('First Reading', { inline: this.r.firstReadingCitation || undefined, inlineFont: 'Sans-Bold', inlineColor: '#333333' });
        if (paras[0]) this.bodyText(paras[0], { size: 9 });
      };
      if (this.data.childrenLiturgyEnabled) {
        // Children leave after the Opening Prayer and return at the Offertory,
        // so the dismissal box separates the Collect from the readings.
        b(() => this.subHeading('Collect'));
        b(() => this._childrenLiturgyBox());
        b(wordOpening);
      } else {
        b(() => { this.subHeading('Collect'); wordOpening(); });
      }
      for (const p of paras.slice(1)) b(() => this.bodyText(p, { size: 9 }));
    }

    b(() => {
      // Responsorial Psalm has no piece "title" — only the scripture
      // reference goes on the heading line (director). The setting/composer
      // line is dropped; the notation itself carries the music.
      this.subHeading('Responsorial Psalm', { inline: this.r.psalmCitation || undefined, inlineFont: 'Sans-Bold', inlineColor: '#333333' });
      // Music (uploaded refrain notation or a paste area) replaces the
      // text refrain — the notation carries the words.
      if (this._slotHasMusic('psalmRefrain')) {
        this.ordinaryMusicSpace('psalmRefrain', 'Responsorial Psalm refrain — music notation');
      } else if (this.r.psalmRefrain) {
        this.bodyText(`R. ${this.r.psalmRefrain}`, { bold: true, size: 9 });
      }
    });
    if (this.r.psalmVerses) {
      // Each verse ends with "R." to cue the people back to the response,
      // and a blank space separates the verses (director). The trailing "R."
      // is only added when the verse doesn't already carry one.
      for (const v of String(this.r.psalmVerses).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
        const verse = /(?:^|\s)R\.?\s*$/.test(v) ? v : `${v} R.`;
        b(() => this.bodyText(verse, { size: 8.5, x: this.MARGIN_SIDE + this.s(10), width: this.CONTENT_WIDTH - this.s(10), gap: 7 }));
      }
    }

    if (!this.r.noSecondReading && this.r.secondReadingCitation) {
      reading('Second Reading', this.r.secondReadingCitation, this.r.secondReadingText, { size: 9 });
    }

    b(() => {
      // Stand for the Gospel Acclamation — direction right-justified on the
      // heading line, with the acclamation's reference inline (director).
      this.subHeading('Gospel Acclamation', { inline: this.r.gospelAcclamationReference || undefined, inlineFont: 'Sans-Bold', inlineColor: '#333333', right: RUBRICS.stand });
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
      if (this.r.gospelAcclamationVerse) this.bodyText(this.r.gospelAcclamationVerse, { italic: true, size: 8.5 });
    });

    // --- Gospel, Homily, Creed --- (already standing for the Gospel)
    reading('Gospel', this.r.gospelCitation, this.r.gospelText, { size: 9.5 });

    // Homily: "Please be seated" right-justified on the heading line. The
    // congregation then stands for the Creed (direction on the Creed line).
    b(() => this.subHeading('Homily', { right: RUBRICS.sit }));

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
        this.subHeading(creedHeading, { right: RUBRICS.stand });
        if (this.ss.twoColumnCreed && creedType !== 'baptismal_vows') {
          this._renderCreedTwoColumn(creedText);
        } else {
          this.bodyText(creedText);
        }
      });
    }

    // Prayer of the Faithful — heading only (the "The intentions are read…"
    // line was dropped as unnecessary per the director).
    b(() => this.subHeading('Prayer of the Faithful'));

    // --- The Liturgy of the Eucharist ---
    b(() => {
      // "Please be seated" sits before this section title (director).
      this.rubric(RUBRICS.sit);
      this.sectionHeader('The Liturgy of the Eucharist');
      this.musicHeading('Offertory', 'offertoryAnthem', 'offertoryAnthemComposer');
      if (this.data.childrenLiturgyEnabled) {
        const _clTimes = (Array.isArray(this.data.childrenLiturgyMassTimes) && this.data.childrenLiturgyMassTimes.length)
          ? this.data.childrenLiturgyMassTimes
          : (this.data.childrenLiturgyMassTime ? [this.data.childrenLiturgyMassTime] : ['Sun 9:00 AM']);
        this.rubric(`Children return from Children's Liturgy of the Word (${_clTimes.join(' & ')})`);
      }
    });

    b(() => {
      // Stand for the Invitation to Prayer — direction right-justified on the
      // heading line (director).
      this.subHeading('Invitation to Prayer', { right: RUBRICS.stand });
      this.bodyText(`Priest: ${INVITATION_TO_PRAYER.priest}`);
      this.bodyText(`All: ${INVITATION_TO_PRAYER.all}`, { bold: true });
    });

    b(() => {
      // Sanctus language: per-aid override > parish default > English. The
      // setting name rides inline on the heading.
      const holyHolyLanguage = this.ss.holyHolyLanguage || this.parishSettings.defaultSanctusLanguage || 'english';
      this.subHeading(holyHolyLanguage === 'latin' ? 'Sanctus' : 'Holy, Holy, Holy',
        { inline: this.ss.holyHolySetting || 'Mass of St. Theresa' });
      if (this._slotHasMusic('sanctus')) {
        this.ordinaryMusicSpace('sanctus', 'Holy, Holy, Holy — music notation');
      } else {
        this.bodyText(getHolyHolyHolyText(holyHolyLanguage));
      }
    });

    b(() => {
      this.rubric(RUBRICS.kneel);
      this.subHeading('Mystery of Faith', { inline: this.ss.mysteryOfFaithSetting || 'Mass of St. Theresa' });
      this.ordinaryMusicSpace('mysteryOfFaith', 'Mystery of Faith — music notation');
    });

    // Great Amen, then "Please stand" between it and the Communion Rite title.
    b(() => this.subHeading('Great Amen'));

    // --- The Communion Rite ---
    b(() => {
      // "Please stand" appears below "Great Amen" and above this section
      // title (director). The Lord's Prayer text is dropped (unnecessary).
      this.rubric(RUBRICS.stand);
      this.sectionHeader('The Communion Rite');
      this.subHeading("The Lord's Prayer");
    });

    b(() => this.subHeading('Sign of Peace'));

    b(() => {
      this.subHeading('Lamb of God', { inline: this.ss.lambOfGodSetting || 'Mass of St. Theresa' });
      this.ordinaryMusicSpace('lambOfGod', 'Lamb of God — music notation');
      // "Please kneel" belongs with the Lamb of God (the congregation kneels
      // after the Agnus Dei); it stays in this block so it can't strand alone
      // at the top of the next page, and it is centered (director).
      this.rubric(RUBRICS.kneel);
    });

    b(() => {
      this.musicHeading('Communion Hymn', 'communionHymn', 'communionHymnComposer');
      this.hymnMusicSpace({ slot: 'communion' });
    });

    b(() => {
      this.musicHeading('Choral Anthem', 'choralAnthemConcluding', 'choralAnthemConcludingComposer');
    });

    // Prayer after Communion — the congregation stands for the priest's
    // closing prayer of the Communion Rite. "Please stand" sits below the
    // Choral Anthem and above this heading (director); it is NOT repeated at
    // the Blessing, where the people are already standing.
    b(() => {
      this.rubric(RUBRICS.stand);
      this.subHeading('Prayer after Communion');
    });

    // --- The Concluding Rites ---
    b(() => {
      this.sectionHeader('The Concluding Rites');
      this.musicHeading('Hymn of Thanksgiving', 'hymnOfThanksgiving', 'hymnOfThanksgivingComposer');
      this.hymnMusicSpace({ slot: 'thanksgiving' });
    });

    // Blessing & Dismissal — heading only (the Priest/Deacon dialogue was
    // dropped as unnecessary per the director). No "Please stand" here: the
    // people already stood for the Prayer after Communion.
    b(() => {
      this.subHeading('Blessing & Dismissal');
    });

    if (this.includePostlude) {
      b(() => {
        this.musicHeading('Organ Postlude', 'organPostlude', 'organPostludeComposer');
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

  // A bold hanging label ("Verse:", "R.") followed by wrapped body text —
  // used by the classic design where the reimagined layout uses inline runs.
  _hangingLabel(label, text, opts = {}) {
    const size = opts.size || 9;
    const startY = this.y;
    this.doc.fontSize(this.s(size) * this.textScale).font(this._font('bold'));
    const labelW = this.doc.widthOfString(label);
    const indent = Math.max(labelW + this.s(8), this.s(46));
    if (!this._dryRun) {
      this.doc.fillColor(this._color('subLabel'))
        .text(label, this.MARGIN_SIDE, startY, { lineBreak: false });
    }
    const x = this.MARGIN_SIDE + indent;
    this.bodyText(text, { x, width: this.CONTENT_WIDTH - indent, size, gap: opts.gap });
    this.y = Math.max(this.y, startY + this.doc.currentLineHeight(true));
  }

  // Balanced two-column body text (psalm strophes, creed) in the classic
  // serif — lines split down the middle into left/right columns.
  _twoColumnText(text, opts = {}) {
    const size = opts.size || 9;
    const lines = String(text).split('\n');
    const half = Math.ceil(lines.length / 2);
    const leftText = lines.slice(0, half).join('\n');
    const rightText = lines.slice(half).join('\n');
    const gap = this.s(14);
    const colW = (this.CONTENT_WIDTH - gap) / 2;
    const x2 = this.MARGIN_SIDE + colW + gap;
    const lineOpts = { lineGap: this.s(0.8) * this.textScale };
    this.doc.fontSize(this.s(size) * this.textScale).fillColor(this._color('body')).font(this._font('body'));
    if (this._dryRun) {
      const lh = this.doc.heightOfString(leftText, { ...lineOpts, width: colW });
      const rh = this.doc.heightOfString(rightText, { ...lineOpts, width: colW });
      this.y += Math.max(lh, rh) + this.s(3);
      return;
    }
    const startY = this.y;
    const lh = this.doc.heightOfString(leftText, { ...lineOpts, width: colW });
    const rh = this.doc.heightOfString(rightText, { ...lineOpts, width: colW });
    const maxH = Math.min(Math.max(lh, rh), this._bottom() - startY);
    if (leftText.trim()) this.doc.text(leftText, this.MARGIN_SIDE, startY, { ...lineOpts, width: colW, height: maxH, ellipsis: true });
    if (rightText.trim()) this.doc.text(rightText, x2, startY, { ...lineOpts, width: colW, height: maxH, ellipsis: true });
    this.y = startY + maxH + this.s(3);
    this._trackY();
  }

  // The Give / Join / Bulletin QR row plus social handles and the licensing
  // block that close the classic booklet's last page.
  _classicFooterBlock() {
    const ps = this.parishSettings;
    const qrItems = [
      ['GIVE', ps.giveUrl], ['JOIN', ps.joinUrl], ['BULLETIN', ps.bulletinUrl]
    ].filter(([, url]) => url && getQRCode());
    const socials = String(ps.socialHandles || '').split('\n').map(s => s.trim()).filter(Boolean);

    if (qrItems.length) {
      this.y += this.s(16);
      const box = this.s(64);
      const cellGap = this.s(28);
      const rowW = qrItems.length * box + (qrItems.length - 1) * cellGap;
      // Center the QR row, leaving room on the right for social handles.
      const socialW = socials.length ? this.s(90) : 0;
      let x = this.MARGIN_SIDE + Math.max(0, (this.CONTENT_WIDTH - socialW - rowW) / 2);
      const yTop = this.y;
      for (const [label, url] of qrItems) {
        this._drawQR(url, label, x, yTop, box);
        x += box + cellGap;
      }
      if (socials.length && !this._dryRun) {
        this.doc.fontSize(this.s(9)).fillColor(this._color('body')).font(this._font('body'))
          .text(socials.join('\n'), x + this.s(6), yTop + box * 0.2,
            { width: this.PAGE_WIDTH - this.MARGIN_SIDE - x - this.s(6), lineGap: this.s(3) });
      }
      this.y = yTop + box + this.s(20);
    }

    const copyrightFull = ps.copyrightFull || getDefaultCopyrightFull(ps.onelicenseNumber);
    this.y += this.s(6);
    this.doc.fontSize(this.s(6) * this.textScale).fillColor(this._color('muted')).font(this._font('italic'));
    this._textBlock(copyrightFull, this.MARGIN_SIDE, {
      width: this.CONTENT_WIDTH, align: 'justify', lineGap: this.s(1) * this.textScale
    }, 0);
  }

  // Classic design: the same liturgy as the reimagined flow, but with the
  // parish's in-house section names, an Invocation / Prayer over the
  // Offerings / Communion Antiphon, two-column psalm & creed, and a QR
  // footer — all drawn through the shared theme-aware primitives.
  _buildContentBlocksClassic() {
    const blocks = [];
    const b = (fn) => blocks.push({ render: fn });
    // The in-house classic aid uses shorter posture wording than the
    // director-revised reimagined design.
    const RUB = { stand: 'Please stand', sit: 'Please sit', kneel: 'Please kneel' };

    const reading = (heading, citation, text, opts = {}) => {
      const paras = String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      b(() => {
        this.subHeading(heading, { inline: citation || undefined, right: opts.right });
        if (paras[0]) this.bodyText(paras[0], opts);
      });
      for (const p of paras.slice(1)) b(() => this.bodyText(p, opts));
    };

    // --- The Introductory Rites ---
    b(() => {
      this.musicHeading('Organ Prelude', 'organPrelude', 'organPreludeComposer');
      this.y += this.s(2);
      this.sectionHeader('The Introductory Rites');
    });

    const entranceType = this.ss.entranceType || 'processional';
    b(() => {
      this.musicHeading(
        entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon',
        'processionalOrEntrance', 'processionalOrEntranceComposer', { right: RUB.stand });
      if (entranceType === 'processional') this.hymnMusicSpace({ slot: 'processional' });
    });

    b(() => this.subHeading('Invocation'));

    if ((this.ss.penitentialAct || 'confiteor') === 'confiteor') {
      b(() => {
        this.subHeading('Penitential Act');
        this.bodyText(CONFITEOR, { size: 9, gap: 3 });
      });
    }

    b(() => {
      this.musicHeading('Lord Have Mercy', 'kyrieSetting', 'kyrieComposer');
      this.ordinaryMusicSpace('kyrie', 'Kyrie — music notation');
    });

    const showGloria = this.ss.gloria !== undefined ? this.ss.gloria :
      (this.data.liturgicalSeason !== 'lent' && this.data.liturgicalSeason !== 'advent');
    if (showGloria) {
      b(() => {
        this.subHeading('Glory to God', { inline: this.ss.gloriaSetting || undefined });
        if (this._slotHasMusic('gloria')) this.ordinaryMusicSpace('gloria', 'Gloria — music notation');
        else this.bodyText('Glory to God in the highest, and on earth peace to people of good will.');
      });
    }

    // Collect + "Please sit" + The Liturgy of the Word (kept together).
    {
      const paras = String(this.r.firstReadingText || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      const wordOpening = () => {
        this.rubric(RUB.sit);
        this.sectionHeader('The Liturgy of the Word');
        this.subHeading('First Reading', { inline: this.r.firstReadingCitation || undefined });
        if (paras[0]) this.bodyText(paras[0], { size: 9 });
      };
      if (this.data.childrenLiturgyEnabled) {
        b(() => this.subHeading('Collect'));
        b(() => this._childrenLiturgyBox());
        b(wordOpening);
      } else {
        b(() => { this.subHeading('Collect'); wordOpening(); });
      }
      for (const p of paras.slice(1)) b(() => this.bodyText(p, { size: 9 }));
    }

    // Responsorial Psalm — refrain (notation) + two-column strophes, each R.-capped.
    b(() => {
      this.subHeading('Responsorial Psalm', { inline: this.r.psalmCitation || undefined });
      if (this._slotHasMusic('psalmRefrain')) {
        this.ordinaryMusicSpace('psalmRefrain', 'Responsorial Psalm refrain — music notation');
      } else if (this.r.psalmRefrain) {
        this.bodyText(`R. ${this.r.psalmRefrain}`, { bold: true, size: 9 });
      }
      if (this.r.psalmVerses) {
        const strophes = String(this.r.psalmVerses).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
          .map(v => (/(?:^|\s)R\.?\s*$/.test(v) ? v : `${v} R.`));
        this._twoColumnText(strophes.join('\n'), { size: 8.5 });
      }
    });

    if (!this.r.noSecondReading && this.r.secondReadingCitation) {
      reading('Second Reading', this.r.secondReadingCitation, this.r.secondReadingText, { size: 9 });
    }

    // Gospel Alleluia — citation on the heading, then a "Verse:" line.
    b(() => {
      this.subHeading('Gospel Alleluia', { inline: this.r.gospelAcclamationReference || undefined, right: RUB.stand });
      if (this._slotHasMusic('gospelAcclamation')) {
        this.ordinaryMusicSpace('gospelAcclamation', 'Gospel Acclamation — music notation');
      }
      if (this.r.gospelAcclamationVerse) this._hangingLabel('Verse:', this.r.gospelAcclamationVerse, { size: 9 });
    });

    reading('Gospel', this.r.gospelCitation, this.r.gospelText, { size: 9 });

    b(() => this.subHeading('Homily', { right: RUB.sit }));

    {
      const creedType = this.ss.creedType || 'nicene';
      const creedHeading = { apostles: "The Apostles' Creed", baptismal_vows: 'Renewal of Baptismal Vows', nicene: 'The Nicene Creed' }[creedType] || 'The Nicene Creed';
      const creedText = { apostles: APOSTLES_CREED, baptismal_vows: RENEWAL_OF_BAPTISMAL_VOWS, nicene: NICENE_CREED }[creedType] || NICENE_CREED;
      b(() => {
        this.subHeading(creedHeading, { right: RUB.stand });
        if (creedType !== 'baptismal_vows') this._renderCreedTwoColumn(creedText);
        else this.bodyText(creedText);
      });
    }

    b(() => this.subHeading('Prayer of the Faithful'));

    if (this.data.announcements) {
      b(() => {
        this.subHeading('Announcements', { right: RUB.sit });
        this.bodyText(this.data.announcements, { size: 8.5 });
      });
    }

    // --- The Liturgy of the Eucharist ---
    b(() => {
      this.rubric(RUB.sit);
      this.sectionHeader('The Liturgy of the Eucharist');
      this.musicHeading('Offertory Hymn', 'offertoryAnthem', 'offertoryAnthemComposer');
      if (this.data.childrenLiturgyEnabled) {
        const _clTimes = (Array.isArray(this.data.childrenLiturgyMassTimes) && this.data.childrenLiturgyMassTimes.length)
          ? this.data.childrenLiturgyMassTimes
          : (this.data.childrenLiturgyMassTime ? [this.data.childrenLiturgyMassTime] : ['Sun 9:00 AM']);
        this.rubric(`Children return from Children's Liturgy of the Word (${_clTimes.join(' & ')})`);
      }
    });

    b(() => this.subHeading('Invitation to Prayer', { right: RUB.stand }));
    b(() => this.subHeading('Prayer over the Offerings'));

    b(() => {
      const holyHolyLanguage = this.ss.holyHolyLanguage || this.parishSettings.defaultSanctusLanguage || 'english';
      this.subHeading(holyHolyLanguage === 'latin' ? 'Sanctus' : 'Holy, Holy, Holy',
        { inline: this.ss.holyHolySetting || 'Mass of St. Theresa' });
      if (this._slotHasMusic('sanctus')) this.ordinaryMusicSpace('sanctus', 'Holy, Holy, Holy — music notation');
      else this.bodyText(getHolyHolyHolyText(holyHolyLanguage));
      this.rubric('Please kneel or be seated');
    });

    b(() => {
      this.subHeading('Mystery of Faith', { inline: this.ss.mysteryOfFaithSetting || 'Mass of St. Theresa' });
      this.ordinaryMusicSpace('mysteryOfFaith', 'Mystery of Faith — music notation');
    });

    b(() => this.subHeading('Great Amen', { inline: 'chant' }));

    // --- The Communion Rite ---
    b(() => {
      this.rubric(RUB.stand);
      this.sectionHeader('The Communion Rite');
      this.subHeading("The Lord's Prayer");
    });

    b(() => this.subHeading('Sign of Peace'));

    b(() => {
      this.subHeading('Lamb of God', { inline: this.ss.lambOfGodSetting || 'Mass of St. Theresa' });
      this.ordinaryMusicSpace('lambOfGod', 'Lamb of God — music notation');
      this.rubric(RUB.kneel);
    });

    if (this._slotHasMusic('communionAntiphon') || this.data.communionAntiphon) {
      b(() => {
        this.subHeading('Communion Antiphon', { inline: this.data.communionAntiphonComposer || undefined });
        if (this._slotHasMusic('communionAntiphon')) this.ordinaryMusicSpace('communionAntiphon', 'Communion Antiphon — music notation');
      });
    }

    b(() => {
      this.musicHeading('Communion Hymn', 'communionHymn', 'communionHymnComposer');
      this.hymnMusicSpace({ slot: 'communion' });
    });

    // Choral Anthem only prints when a piece is actually scheduled — the
    // classic aid omits the empty heading.
    if (formatMusicSlot(this.data, 'choralAnthemConcluding', 'choralAnthemConcludingComposer').length) {
      b(() => this.musicHeading('Choral Anthem', 'choralAnthemConcluding', 'choralAnthemConcludingComposer'));
    }

    b(() => {
      this.rubric(RUB.stand);
      this.subHeading('Prayer after Communion');
    });

    // --- The Concluding Rites ---
    b(() => {
      this.sectionHeader('The Concluding Rites');
      this.musicHeading('Hymn of Thanksgiving', 'hymnOfThanksgiving', 'hymnOfThanksgivingComposer');
      this.hymnMusicSpace({ slot: 'thanksgiving' });
    });

    b(() => this.subHeading('Blessing and Dismissal'));

    if (this.includePostlude) {
      b(() => this.musicHeading('Organ Postlude', 'organPostlude', 'organPostludeComposer'));
    }

    if (this.data.specialNotes) {
      b(() => { this.y += this.s(4); this.bodyText(this.data.specialNotes, { italic: true, size: 8.5, align: 'center', color: this._color('muted') }); });
    }
    if (this.parishSettings.closingMessage) {
      b(() => { this.y += this.s(2); this.bodyText(this.parishSettings.closingMessage, { size: 8, align: 'center', color: this._color('muted') }); });
    }

    b(() => this._classicFooterBlock());

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
      [`Children's Liturgy of the Word — ${_clTimes.join(' & ')}`, this._font('bold'), 8]
    ];
    if (this.data.childrenLiturgyLeader)
      clLines.push([`Led by ${this.data.childrenLiturgyLeader}`, this._font('body'), 7.5]);
    if (this.data.childrenLiturgyMusic) {
      clLines.push([`${this.data.childrenLiturgyMusic}${this.data.childrenLiturgyMusicComposer ? ', ' + this.data.childrenLiturgyMusicComposer : ''}`, this._font('italic'), 7.5]);
    }
    const notes = this.data.childrenLiturgyNotes ||
      'Children are dismissed after the Opening Prayer and will rejoin during the Offertory.';
    clLines.push([notes, this._font('italic'), 7]);
    let contentH = 0;
    for (const [text, font, size] of clLines) {
      this.doc.font(font).fontSize(this.s(size) * this.textScale);
      contentH += this.doc.heightOfString(text, { width: innerW });
    }
    if (this._dryRun) {
      this.y += contentH + this.s(12);
      this.doc.font(this._font('body'));
      return;
    }
    const boxH = Math.min(contentH + this.s(8), Math.max(0, this._bottom() - this.y));
    if (boxH > this.s(10)) {
      this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, boxH)
        .fillColor('#f5f0e6').fill().restore();
      const boxBottom = this.y + boxH;
      let cursorY = this.y + this.s(4);
      for (const [text, font, size] of clLines) {
        this.doc.font(font).fontSize(this.s(size) * this.textScale).fillColor(this._color('body'));
        const remaining = boxBottom - cursorY;
        if (remaining < this.doc.currentLineHeight(true)) { this._warnClipped(); break; }
        this.doc.text(text, innerX, cursorY, { width: innerW, height: remaining, ellipsis: true });
        cursorY = this.doc.y;
      }
      this.y += boxH + this.s(4);
    } else {
      this._warnClipped();
    }
    this.doc.font(this._font('body'));
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
