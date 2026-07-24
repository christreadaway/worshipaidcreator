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
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, RUBRICS_CLASSIC, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, getHolyHolyHolyText } = require('./assets/text/mass-texts');
const { getDefaultCopyrightFull } = require('./assets/text/copyright');
const { formatMusicSlot, renderMusicLineRuns } = require('./music-formatter');
const { buildLiturgyOutline } = require('./liturgy-outline');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');
const { getImageDimensions } = require('./image-utils');
const { getQRCode, SMALLCAPS_CONNECTORS, classicGreeting, classicCoverBlocks, resolveChildrenLiturgyTimes } = require('./render-shared');

// 72pt = 1 inch
const PT = 72;

// Default printed width for uploaded music images, in inches on the
// 8.5in-wide (tabloid) page. The director of liturgy's spec (17th Sunday
// OT proof, July 2026): the default width for ALL music notation images
// is 5", centered. (Earlier passes tried 6" — "too large" — then 5.5".)
// Other trims scale proportionally to their page width and clamp to the
// content area.
const NOTATION_WIDTH_IN = 5;
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

// The deploy layout never changes at runtime, so directory/file probes run
// once per process, not once per export.
let _cachedFontDir;
function resolveFontDir() {
  if (_cachedFontDir !== undefined) return _cachedFontDir;
  const candidates = [
    path.join(__dirname, 'assets', 'fonts'),                    // src/ locally
    path.join(process.cwd(), 'src', 'assets', 'fonts'),         // /var/task on Lambda
    path.join(__dirname, '..', 'src', 'assets', 'fonts'),       // bundle one level deep
    path.join(__dirname, '..', '..', 'src', 'assets', 'fonts'), // netlify/functions bundle
    '/usr/share/fonts/truetype/liberation'                       // system install
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, FONT_FILES.Sans))) { _cachedFontDir = dir; return dir; }
    } catch (e) { /* keep looking */ }
  }
  _cachedFontDir = null;
  return null;
}

// Physical font files for the classic serif roles, or PDFKit built-in
// Times fallbacks when the vendored files aren't reachable. Resolved once.
let _cachedClassicFontPaths = null;
function resolveClassicFontPaths() {
  if (_cachedClassicFontPaths) return _cachedClassicFontPaths;
  const dir = resolveFontDir();
  const builtin = {
    'Serif': 'Times-Roman', 'Serif-Bold': 'Times-Bold',
    'Serif-Italic': 'Times-Italic', 'Serif-BoldItalic': 'Times-BoldItalic',
    'Display': 'Times-Roman', 'Display-SemiBold': 'Times-Bold',
    'Display-Italic': 'Times-Italic', 'Script-Italic': 'Times-Italic'
  };
  if (!dir) { _cachedClassicFontPaths = builtin; return builtin; }
  const out = {};
  for (const [name, file] of Object.entries(FONT_FILES_CLASSIC)) {
    const p = path.join(dir, file);
    out[name] = fs.existsSync(p) ? p : builtin[name];
  }
  _cachedClassicFontPaths = out;
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
    rubricSize: 7.5,       // standalone posture-direction lines
    twoColumn: false       // psalm verses & creed stack full-width
  },
  classic: {
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
    rubricSize: 8.5,       // standalone posture-direction lines
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

    // Trailing whitespace (points) the most recent primitive left below its
    // ink. Headings consult this to guarantee the director's minimum space
    // above every heading (see _padBeforeHeading).
    this._lastGapAfter = undefined;
  }

  // Director of liturgy (17th Sunday OT proof, July 2026): "There should be
  // at least an 8 point space between each heading and what precedes it."
  // Every heading pads itself so the whitespace above it — its own pad plus
  // whatever trailing gap the previous primitive left — is at least 8pt.
  // Dry-run measurement applies the same pad (worst case, using the gap the
  // previous block's measurement left behind), so a block can only measure
  // taller than it renders — never shorter — and pagination stays safe. At
  // the top of a fresh page there is nothing above the heading to space
  // away from, so no pad is added.
  _padBeforeHeading() {
    const MIN = 8; // absolute points on the printed page, per the director
    const prev = this._lastGapAfter !== undefined ? this._lastGapAfter : MIN;
    const deficit = Math.max(0, MIN - prev);
    if (!this._dryRun && this.y <= this.MARGIN_TOP + 0.5) return;
    this.y += deficit;
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
    if (!text || !String(text).trim()) return 0;
    const CONNECTORS = SMALLCAPS_CONNECTORS;
    const capSize = baseSize;
    const restSize = baseSize * 0.78;
    const connSize = baseSize * 0.72;
    // Dry-run height depends only on the base size (the leading word always
    // contributes a full-size cap), so skip the per-run glyph measurement
    // the shrink loop would otherwise repeat for every fit iteration.
    if (this._dryRun) {
      const blockH = baseSize * 1.18;
      this.y += blockH;
      return blockH;
    }
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
    this._lastGapAfter = advanceAfter;
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
    this._padBeforeHeading();
    // Classic: a large centered small-caps Garamond title, no rule.
    if (this.theme.smallCaps) {
      this.y += this.s(2);
      this._smallCapsTitle(text, this.s(this.theme.sectionSize));
      this.y += this.s(6);
      this._lastGapAfter = this.s(6);
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
  //   inlineRuns  — instead of `inline`, mixed-style segments
  //                 [{ text, italic }] flowed as one wrapped line — used by
  //                 music lines so the piece's title stays italic while the
  //                 composer's name is NEVER italicized (director)
  //   inlineFont  — font for the inline text (default 'Sans-Italic' for
  //                 music; pass 'Sans-Bold' for citations)
  //   inlineColor — color for the inline text
  //   right       — posture direction, right-justified on the heading line
  // All parts share the heading's font size so their baselines align.
  subHeading(text, opts = {}) {
    this._padBeforeHeading();
    const SIZE = this.s(this.theme.subSize);
    const boldFont = this._font('bold');
    const labelCS = this.theme.subUpper ? 0.8 : 0;   // reimagined letter-spaces its caps
    const runs = (opts.inlineRuns && opts.inlineRuns.length)
      ? opts.inlineRuns.map(r => ({ text: this._normalizeText(r.text), italic: !!r.italic }))
      : null;
    const hasInline = !!(opts.inline || runs);
    // Classic joins the label to its inline title with an em-dash ("Hymn—Title").
    const label = (this.theme.subUpper ? String(text).toUpperCase() : String(text))
      + (this.theme.subDash && hasInline ? '—' : '');
    // Classic callers never pass inlineFont/inlineColor (all inlines are
    // italic serif); reimagined callers pass bold for scripture citations.
    const inlineFontName = opts.inlineFont || this._font('italic');
    const inlineColor = opts.inlineColor || this._color('subInline');
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
    const inlineX = this.MARGIN_SIDE + headingW + (hasInline ? gap : 0);
    // Inline text may wrap; it gets the room between the heading and the
    // right-justified posture direction (or the right margin).
    const rightEdge = this.PAGE_WIDTH - this.MARGIN_SIDE - (rightW ? rightW + gap : 0);
    const inlineW = Math.max(this.s(40), rightEdge - inlineX);

    // Height of the line = tallest part (inline text can wrap to 2+ lines).
    let blockH = this.doc.fontSize(SIZE).font(boldFont).currentLineHeight(true);
    if (runs) {
      // Mixed italic/roman runs: measure the concatenated text in both
      // faces and keep the taller answer — their advance widths differ by
      // a hair, and the block must never measure shorter than it draws.
      const joined = runs.map(r => r.text).join('');
      this.doc.fontSize(SIZE).font(this._font('italic'));
      const hItal = this.doc.heightOfString(joined, { width: inlineW });
      this.doc.font(this._font('body'));
      const hRoman = this.doc.heightOfString(joined, { width: inlineW });
      blockH = Math.max(blockH, hItal, hRoman);
    } else if (opts.inline) {
      this.doc.fontSize(SIZE).font(inlineFontName);
      blockH = Math.max(blockH, this.doc.heightOfString(String(opts.inline), { width: inlineW }));
    }

    if (this._dryRun) {
      this.y = startY + blockH + this.s(2);
      this._lastGapAfter = this.s(2);
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
    // Inline title/composer (mixed runs) or scripture citation.
    if (runs) {
      this.doc.fontSize(SIZE).fillColor(inlineColor);
      runs.forEach((r, i) => {
        this.doc.font(r.italic ? this._font('italic') : this._font('body'));
        if (i === 0) this.doc.text(r.text, inlineX, startY, { width: inlineW, continued: runs.length > 1 });
        else this.doc.text(r.text, { width: inlineW, continued: i < runs.length - 1 });
      });
      blockH = Math.max(blockH, this.doc.y - startY);
    } else if (opts.inline) {
      this.doc.fontSize(SIZE).fillColor(inlineColor).font(inlineFontName)
        .text(String(opts.inline), inlineX, startY, { width: inlineW });
    }

    this.y = startY + blockH + this.s(2);
    this._lastGapAfter = this.s(2);
    this.doc.font(this._font('body'));
    this._trackY();
  }

  // Sub-heading for a music slot: the piece's title + composer go inline on
  // the heading line with the redundant slot label dropped (director: "don't
  // restate what it is; only provide the title and composer"). When a slot
  // carries different pieces per Mass time, the heading stands alone and each
  // piece is listed on its own line below (still label-free). The title is
  // italic; the composer's name is NEVER italicized (director, 17th Sunday
  // OT proof) — so both paths draw mixed-style runs.
  musicHeading(heading, titleField, composerField, opts = {}) {
    const items = formatMusicSlot(this.data, titleField, composerField);
    if (items.length <= 1) {
      this.subHeading(heading, { inlineRuns: items[0] ? renderMusicLineRuns(items[0]) : undefined, right: opts.right });
    } else {
      this.subHeading(heading, { right: opts.right });
      for (const item of items) {
        this._runsLine(renderMusicLineRuns(item), { size: 8.5, gap: 1 });
      }
    }
  }

  // A wrapped body-size line of mixed italic/roman runs (a multi-Mass music
  // listing: italic title, roman composer + time label). Dry-run aware.
  _runsLine(runs, opts = {}) {
    const size = this.s(opts.size || 9) * this.textScale;
    const x = this.MARGIN_SIDE;
    const width = this.CONTENT_WIDTH;
    const gapAfter = this.s(opts.gap !== undefined ? opts.gap : 3);
    const lineGap = this.s(1) * this.textScale;
    const norm = runs.map(r => ({ text: this._normalizeText(r.text), italic: !!r.italic }));
    const joined = norm.map(r => r.text).join('');
    this.doc.fontSize(size).font(this._font('italic'));
    const hItal = this.doc.heightOfString(joined, { width, lineGap });
    this.doc.font(this._font('body'));
    const hRoman = this.doc.heightOfString(joined, { width, lineGap });
    const h = Math.max(hItal, hRoman);
    this._lastGapAfter = gapAfter;
    if (this._dryRun) {
      this.y += h + gapAfter;
      return;
    }
    if (this._bottom() - this.y < this.doc.currentLineHeight(true)) {
      this._warnClipped();
      this.doc.font(this._font('body'));
      return;
    }
    this.doc.fontSize(size).fillColor(this._color('body'));
    norm.forEach((r, i) => {
      this.doc.font(r.italic ? this._font('italic') : this._font('body'));
      if (i === 0) this.doc.text(r.text, x, this.y, { width, lineGap, continued: norm.length > 1 });
      else this.doc.text(r.text, { width, lineGap, continued: i < norm.length - 1 });
    });
    this.y = Math.min(this.doc.y, this._bottom()) + gapAfter;
    this.doc.font(this._font('body'));
    this._trackY();
  }

  rubric(text, align) {
    // Standalone posture directions ("Please stand/kneel/be seated" on their
    // own line) are centered by default per the director of liturgy. Callers
    // may override, and a parish rubricAlignment setting still wins.
    const a = align || this.ss.rubricAlignment || 'center';
    this.doc.fontSize(this.s(this.theme.rubricSize)).fillColor(this._color('rubric')).font(this._font('italic'));
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

  // Height the page-break decision at block i must consider: the block's own
  // height plus every successor chained to it via keepNext (a heading or
  // transition that must not be the last thing on its page). Capped at one
  // full page — a chain too tall to honor degrades to per-block placement
  // instead of clipping.
  _chainNeed(blocks, heights, i, pageH) {
    let need = heights[i];
    let k = i;
    while (blocks[k].keepNext && k + 1 < blocks.length) {
      need += heights[k + 1];
      k++;
    }
    return Math.min(need, pageH);
  }

  // A fit block adapts to the space left on the CURRENT page instead of
  // breaking to a new one: its variants are tried in order of preference and
  // the first whose measured height fits the remaining room wins (the
  // Penitential Act: full text → two columns → heading only, per the
  // director). Measurement seeds the worst-case heading pad so a variant can
  // never measure shorter than it later renders. Returns null when no
  // variant fits (the caller omits the block with a warning).
  _pickFitVariant(block, remaining) {
    const gapBefore = this._lastGapAfter;
    let chosen = null;
    for (let i = 0; i < block.fit.length; i++) {
      this._lastGapAfter = 0; // worst-case pad above the variant's heading
      const h = this._measureBlock({ render: block.fit[i] });
      if (h <= remaining + 1) {
        chosen = { index: i, height: h, trailing: this._lastGapAfter, render: block.fit[i] };
        break;
      }
    }
    this._lastGapAfter = gapBefore;
    return chosen;
  }

  _countPagesNeeded(blocks) {
    const pageH = this._bottom() - this.MARGIN_TOP;
    // Fit blocks are placement-dependent; they are resolved inside the
    // packing loop below instead of pre-measured here.
    const heights = blocks.map(bl => bl.fit ? 0 : Math.min(this._measureBlock(bl), pageH));
    let pages = 1;
    let y = this.MARGIN_TOP;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].fit) {
        const v = this._pickFitVariant(blocks[i], this._bottom() - y);
        if (v) {
          y += v.height;
          this._lastGapAfter = v.trailing;
        }
        continue; // a fit block never forces a page break
      }
      const need = this._chainNeed(blocks, heights, i, pageH);
      // Same fit tolerance as the render loop, or a block within 1pt of
      // exactly fitting would trigger a needless global shrink.
      if (need > this._bottom() - y + 1 && y > this.MARGIN_TOP + 1) {
        pages++;
        y = this.MARGIN_TOP;
      }
      y += heights[i];
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
    const pageH = this._bottom() - this.MARGIN_TOP;
    const heights = blocks.map(bl => bl.fit ? 0 : this._measureBlock(bl));
    this._lastGapAfter = undefined;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // A fit block stays on the current page no matter what, choosing the
      // first of its variants that fits the room left (Penitential Act:
      // full text → two columns → heading only). If nothing fits at all,
      // the block is omitted with a loud warning — never silently.
      if (block.fit) {
        const v = this._pickFitVariant(block, this._bottom() - this.y);
        if (!v) {
          if (block.fitNoneWarning) this.warnings.push(block.fitNoneWarning);
          continue;
        }
        if (block.fitWarnings && block.fitWarnings[v.index]) {
          this.warnings.push(block.fitWarnings[v.index]);
        }
        v.render();
        continue;
      }

      // A bottom-anchored block (the classic QR/licensing footer) renders at
      // the foot of the FINAL page, like a back cover — padding any blank
      // pages needed to get there. If content already reached page 8 it
      // simply flows after it (the block's own clamps truncate with a
      // warning rather than spilling).
      if (block.anchorBottom) {
        while (pageNo < 8) {
          this._finishContentPage(pageNo);
          this.newPage();
          pageNo++;
        }
        // 2pt cushion: the block must start a hair above flush so
        // measure/render floating-point drift can't trip the clip guard.
        const target = this._bottom() - heights[i] - 2;
        if (target > this.y) this.y = target;
        block.render();
        continue;
      }

      // The break decision honors keepNext chains: a heading/transition
      // flagged keepNext moves to the fresh page together with the block it
      // introduces instead of stranding at the page foot.
      const need = this._chainNeed(blocks, heights, i, pageH);
      const remaining = this._bottom() - this.y;
      if (need > remaining + 1 && pageNo < 8 && this.y > this.MARGIN_TOP + 1) {
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
    this._lastGapAfter = this.s(4);
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
    this._lastGapAfter = this.s(6);
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

  // Two-column layout for the Nicene/Apostles' Creed — delegates to the
  // shared column helper so creed and psalm columns can never drift apart.
  _renderCreedTwoColumn(text) {
    this._twoColumnText(text, { size: 9, gap: 10 });
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
    this._lastGapAfter = this.s(4);
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
    // Wraps within the content width — a long parish name or custom heading
    // must never run past the trim edge.
    const ps = this.parishSettings;
    this.doc.fontSize(this.s(17)).fillColor(this._color('feast')).font('Script-Italic')
      .text(classicGreeting(ps), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'left' });
    this.y = this.doc.y + this.s(7);

    // Single-column info blocks: bold small-caps label, indented body. The
    // labels/fallback copy come from the shared helper so the classic
    // preview and export always show identical cover text.
    for (const [label, body] of classicCoverBlocks(ps)) {
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

    // Standing welcome message, like the reimagined cover — clamped to the
    // bottom margin so it can never push the cover to a second page.
    if (ps.welcomeMessage) {
      this.y += this.s(2);
      const welcomeRoom = this._bottom() - this.y;
      if (welcomeRoom > this.s(10)) {
        this.doc.fontSize(this.s(8.5)).fillColor(this._color('body')).font('Serif-Italic')
          .text(ps.welcomeMessage, this.MARGIN_SIDE, this.y,
            { width: this.CONTENT_WIDTH, align: 'center', lineGap: this.s(1), height: welcomeRoom, ellipsis: true });
        this.y = Math.min(this.doc.y, this._bottom());
      } else {
        this._warnClipped();
      }
    }
    this._trackY();
  }

  // Render a feast title as centered small-caps Garamond, wrapping words
  // across lines that fit the content width at the cap size.
  _coverTitleClassic(text, size) {
    if (!text || !String(text).trim()) return;
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

  // Draw a QR code as crisp vector modules for a URL, with a caption label
  // beneath. Draws nothing (and skips the encode entirely) in dry-run — the
  // caller owns the footer's height math — and silently no-ops when qrcode
  // isn't available or no URL is configured.
  _drawQR(url, label, x, yTop, boxSize) {
    if (this._dryRun) return;
    const QR = getQRCode();
    if (!QR || !url) return;
    let qr;
    try { qr = QR.create(String(url), { errorCorrectionLevel: 'M' }); }
    catch (e) { return; }
    const n = qr.modules.size;
    const data = qr.modules.data;
    const cell = boxSize / n;
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

  // The ordered liturgy as atomic flow blocks, built from the shared
  // liturgy outline (src/liturgy-outline.js) so the PDF and the HTML preview
  // — and the two designs — can never drift apart. Each op is drawn through
  // the theme-aware primitives; each outline block becomes one flow block,
  // except readings (split into per-paragraph blocks so prose can flow
  // without orphaning its heading) and the Penitential Act (a fit block).
  _buildContentBlocks() {
    const outline = buildLiturgyOutline(this.data, {
      design: this.design, seasonalSettings: this.ss, readings: this.r,
      parishSettings: this.parishSettings
    });
    return this._blocksFromOutline(outline.blocks);
  }

  // Classic uses the same outline (design: 'classic'); the outline resolves
  // every naming/ordering difference, so there is no separate builder.
  _buildContentBlocksClassic() { return this._buildContentBlocks(); }

  // Translate outline blocks into flow blocks for renderContentFlow.
  _blocksFromOutline(oblocks) {
    const blocks = [];
    for (const ob of oblocks) {
      const ops = ob.ops || [];
      // The Penitential Act adapts to the room left on the page instead of
      // breaking (director): full text -> two columns -> heading only, then
      // omitted with a warning if nothing fits.
      if (ob.penitential) {
        const pen = ops.find(o => o.op === 'penitential');
        const size = pen ? pen.size : 8;
        const text = pen ? pen.text : '';
        blocks.push({
          fit: [
            () => { this.subHeading('Penitential Act'); this.bodyText(text, { size, gap: 3 }); },
            () => { this.subHeading('Penitential Act'); this._twoColumnText(text, { size }); },
            () => { this.subHeading('Penitential Act'); }
          ],
          fitWarnings: [null, null,
            `The Penitential Act text did not fit on the page with the ${this.design === 'classic' ? 'Processional Hymn' : 'entrance hymn'} (even in two columns) — the heading printed without the text.`],
          fitNoneWarning: `The Penitential Act could not fit on the page with the ${this.design === 'classic' ? 'Processional Hymn' : 'entrance hymn'} and was omitted.`
        });
        continue;
      }
      // A reading is the last op in its block: heading + first paragraph stay
      // with whatever precedes them (a rubric + section opening); the rest of
      // the paragraphs flow as their own blocks.
      const last = ops[ops.length - 1];
      if (last && last.op === 'reading') {
        const head = ops.slice(0, -1);
        const paras = String(last.text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        blocks.push({
          render: () => { for (const o of head) this._renderOp(o); this._renderReadingHead(last, paras[0]); },
          keepNext: ob.keepNext, anchorBottom: ob.anchorBottom
        });
        for (const para of paras.slice(1)) blocks.push({ render: () => this.bodyText(para, { size: last.size }) });
        continue;
      }
      blocks.push({
        render: () => { for (const o of ops) this._renderOp(o); },
        keepNext: ob.keepNext, anchorBottom: ob.anchorBottom
      });
    }
    return blocks;
  }

  // Inline-style opts for a scripture citation on a heading line: bold dark
  // text in the reimagined design, plain italic in the classic serif.
  _citationInline(citation) {
    if (citation === undefined || citation === null || citation === '') return {};
    return this.design === 'classic'
      ? { inline: citation }
      : { inline: citation, inlineFont: 'Sans-Bold', inlineColor: '#333333' };
  }

  // Draw a reading's heading (with its citation inline) + its first paragraph.
  _renderReadingHead(op, firstPara) {
    this.subHeading(op.heading, { ...this._citationInline(op.citation), right: op.right });
    if (firstPara) this.bodyText(firstPara, { size: op.size });
  }

  // Draw one outline op through the theme-aware primitives.
  _renderOp(op) {
    switch (op.op) {
      case 'section':
        this.sectionHeader(op.title); break;
      case 'music':
        this.musicHeading(op.heading, op.titleField, op.composerField, { right: op.right }); break;
      case 'hymnSpace':
        this.hymnMusicSpace({ slot: op.slot }); break;
      case 'ordinarySpace':
        this.ordinaryMusicSpace(op.slot, op.label); break;
      case 'setting': {
        this.subHeading(op.heading, { inline: op.setting || undefined, right: op.right });
        if (op.mode === 'musicOnly') {
          this.ordinaryMusicSpace(op.slot, op.label);
        } else if (this._slotHasMusic(op.slot)) {
          this.ordinaryMusicSpace(op.slot, op.label);
        } else if (op.text) {
          this.bodyText(op.text);
        }
        break;
      }
      case 'subheading':
        this.subHeading(op.heading, {
          ...(op.citation ? this._citationInline(op.inline) : (op.inline ? { inline: op.inline } : {})),
          right: op.right
        });
        break;
      case 'reading':
        // Non-splitting fallback (readings are normally expanded by
        // _blocksFromOutline); render heading + full text.
        this._renderReadingHead(op, String(op.text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).join('\n\n'));
        break;
      case 'rubric':
        this.rubric(op.text); break;
      case 'psalm': {
        this.subHeading('Responsorial Psalm', this._citationInline(op.citation));
        if (this._slotHasMusic(op.slot)) {
          this.ordinaryMusicSpace(op.slot, 'Responsorial Psalm refrain — music notation');
        } else if (op.refrain) {
          this.bodyText(`R. ${op.refrain}`, { bold: true, size: 9 });
        }
        if (op.twoColumn && op.strophes && op.strophes.length) {
          this._twoColumnText(op.strophes.join('\n'), { size: 8.5 });
        }
        break;
      }
      case 'psalmVerse':
        this.bodyText(op.text, { size: 8.5, x: this.MARGIN_SIDE + this.s(10), width: this.CONTENT_WIDTH - this.s(10), gap: 7 });
        break;
      case 'creed':
        this.subHeading(op.heading, { right: op.right });
        if (op.twoColumn) this._renderCreedTwoColumn(op.text);
        else this.bodyText(op.text);
        break;
      case 'gospelAccl':
        this.subHeading(op.heading, { ...this._citationInline(op.reference), right: op.right });
        if (this._slotHasMusic(op.slot)) {
          this.ordinaryMusicSpace(op.slot, 'Gospel Acclamation — music notation');
        } else {
          this.bodyText(op.text, { bold: true, size: 9 });
        }
        if (op.verse) {
          if (op.verseStyle === 'hanging') this._hangingLabel('Verse:', op.verse, { size: 9 });
          else this.bodyText(op.verse, { italic: true, size: 8.5 });
        }
        break;
      case 'invitationText':
        this.bodyText(`Priest: ${op.priest}`);
        this.bodyText(`All: ${op.all}`, { bold: true });
        break;
      case 'childrenBox':
        this._childrenLiturgyBox(); break;
      case 'childrenReturn':
        this.rubric(op.text); break;
      case 'adventWreath':
        this._renderAdventWreath(); break;
      case 'announcements':
        this._renderAnnouncements(op); break;
      case 'notes':
        this.y += this.s(4);
        this.bodyText(op.text, { italic: true, size: 8.5, align: 'center', color: this._color('muted') });
        break;
      case 'closing':
        this.y += this.s(2);
        this.bodyText(op.text, { size: 8, align: 'center', color: this._color('muted') });
        break;
      case 'copyright':
        this._renderCopyrightBlock(); break;
      case 'classicFooter':
        this._classicFooterBlock(); break;
      default:
        break;
    }
  }

  // Advent-wreath marker: a tinted box (reimagined) or bold centered line
  // (classic), matching each design's in-house look.
  _renderAdventWreath() {
    if (this.design === 'classic') {
      this.bodyText('Lighting of the Advent Wreath', { bold: true, align: 'center', size: 9.5, gap: 4 });
      return;
    }
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
    this._lastGapAfter = this.s(4);
    this._trackY();
  }

  // Announcements. Reimagined: a gold rule + heading + small body. Classic:
  // heading (with a "Please sit" on the line) + body, no rule.
  _renderAnnouncements(op) {
    if (op.rule) {
      this.y += this.s(4);
      if (!this._dryRun) {
        this.doc.save().moveTo(this.MARGIN_SIDE, this.y)
          .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE, this.y)
          .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
      }
      this.y += this.s(4);
    }
    this.subHeading('Announcements', op.right ? { right: op.right } : {});
    this.bodyText(op.text, { size: op.size || 7.5 });
  }

  // The reimagined end-of-document copyright block.
  _renderCopyrightBlock() {
    const copyrightFull = this.parishSettings.copyrightFull ||
      getDefaultCopyrightFull(this.parishSettings.onelicenseNumber);
    this.y += this.s(8);
    this.doc.fontSize(this.s(6.5) * this.textScale).fillColor(COLORS.light).font('Sans');
    this._textBlock(copyrightFull, this.MARGIN_SIDE + this.s(10), {
      width: this.CONTENT_WIDTH - this.s(20), align: 'center', lineGap: this.s(1.5) * this.textScale
    }, 0);
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
    const gap = this.s(opts.gap !== undefined ? opts.gap : 14);
    const colW = (this.CONTENT_WIDTH - gap) / 2;
    const x2 = this.MARGIN_SIDE + colW + gap;
    const lineOpts = { lineGap: this.s(0.8) * this.textScale };
    this.doc.fontSize(this.s(size) * this.textScale).fillColor(this._color('body')).font(this._font('body'));
    this._lastGapAfter = this.s(3);
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
    const qrAvailable = !!getQRCode();
    const qrItems = [
      ['GIVE', ps.giveUrl], ['JOIN', ps.joinUrl], ['BULLETIN', ps.bulletinUrl]
    ].filter(([, url]) => url && qrAvailable);
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
      // The row is as tall as its tallest column — a long socials list must
      // push the licensing block down, not be overprinted by it. Measured
      // identically in dry-run and real render so pagination stays truthful.
      const socialsX = x + rowW + cellGap + this.s(6);
      const socialsW = Math.max(this.s(40), this.PAGE_WIDTH - this.MARGIN_SIDE - socialsX);
      let socialsH = 0;
      if (socials.length) {
        this.doc.fontSize(this.s(9)).font(this._font('body'));
        socialsH = box * 0.2 + this.doc.heightOfString(socials.join('\n'), { width: socialsW, lineGap: this.s(3) });
      }
      const rowH = Math.max(box + this.s(14), socialsH); // box + label caption
      for (const [label, url] of qrItems) {
        this._drawQR(url, label, x, yTop, box);
        x += box + cellGap;
      }
      if (socials.length && !this._dryRun) {
        this.doc.fontSize(this.s(9)).fillColor(this._color('body')).font(this._font('body'))
          .text(socials.join('\n'), socialsX, yTop + box * 0.2,
            { width: socialsW, lineGap: this.s(3), height: Math.max(0, this._bottom() - (yTop + box * 0.2)), ellipsis: true });
      }
      this.y = yTop + rowH + this.s(6);
    }

    const copyrightFull = ps.copyrightFull || getDefaultCopyrightFull(ps.onelicenseNumber);
    this.y += this.s(6);
    this.doc.fontSize(this.s(6) * this.textScale).fillColor(this._color('muted')).font(this._font('italic'));
    this._textBlock(copyrightFull, this.MARGIN_SIDE, {
      width: this.CONTENT_WIDTH, align: 'justify', lineGap: this.s(1) * this.textScale
    }, 0);
  }


  // Tinted info box for the Children's Liturgy dismissal. Dry-run aware.
  _childrenLiturgyBox() {
    this.y += this.s(4);
    const _clTimes = resolveChildrenLiturgyTimes(this.data);
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
    this._lastGapAfter = this.s(4);
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
