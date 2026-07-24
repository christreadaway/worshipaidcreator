// Renders worship aid data into an 8-page HTML booklet
// PRD: 5.5" x 8.5" half-letter booklet pages
// Updated with worksheet workflow: Advent wreath, Lenten postlude suppression,
// alternate Lenten acclamation, Apostles' Creed for Advent/Easter
'use strict';

const path = require('path');
const fs = require('fs');
const { APOSTLES_CREED, NICENE_CREED, RENEWAL_OF_BAPTISMAL_VOWS } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, RUBRICS_CLASSIC, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, getHolyHolyHolyText } = require('./assets/text/mass-texts');
const { getQRCode, SMALLCAPS_CONNECTORS, classicGreeting, classicCoverBlocks, resolveChildrenLiturgyTimes } = require('./render-shared');
const { formatMusicSlot, renderMusicLineHtml } = require('./music-formatter');
const { buildLiturgyOutline } = require('./liturgy-outline');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');
const { getDefaultCopyrightFull } = require('./assets/text/copyright');

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nl2br(str) {
  if (!str) return '';
  return escapeHtml(str).replace(/\n/g, '<br>');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function getLogoSvg() {
  const logoPath = path.join(__dirname, 'assets', 'logo', 'jerusalem-cross.svg');
  if (fs.existsSync(logoPath)) return fs.readFileSync(logoPath, 'utf8');
  return '';
}

// Parish-uploaded logo when configured (so the preview matches the PDF),
// otherwise the bundled Jerusalem cross.
function getLogoHtml(settings) {
  if (settings && settings.logoPath) {
    return `<img src="${escapeHtml(settings.logoPath)}" alt="Parish logo" style="width:60px;height:60px;object-fit:contain;">`;
  }
  return getLogoSvg();
}

// A sub-heading line. Per the director of liturgy, a piece's title/composer
// or a reading's scripture citation sits ON the heading line, and a posture
// direction ("Please stand") is right-justified on that same line. opts:
//   inline      — plain text after the heading (escaped); for citations
//   inlineHtml  — pre-built HTML after the heading (music lines)
//   citation    — style the inline text as a scripture citation
//   right       — posture direction, right-justified on the heading line
function subHeadingHtml(label, opts = {}) {
  // Music lines get the .music class: the container stays roman so only the
  // <em>-wrapped piece title is italic — a composer's name is NEVER
  // italicized (director of liturgy).
  const inline = opts.inlineHtml
    ? `<span class="sub-inline music">${opts.inlineHtml}</span>`
    : (opts.inline ? `<span class="sub-inline${opts.citation ? ' cite' : ''}">${escapeHtml(opts.inline)}</span>` : '');
  const right = opts.right ? `<span class="rubric-inline">${escapeHtml(opts.right)}</span>` : '';
  return `<div class="sub-heading-row"><div class="sub-heading-left"><span class="sub-heading">${escapeHtml(label)}</span>${inline}</div>${right}</div>`;
}

// Sub-heading for a music slot: title + composer inline, redundant slot label
// dropped (director). Different pieces per Mass time fall back to a bare
// heading with each piece listed below.
function musicSubHeadingHtml(data, label, titleField, composerField, opts = {}) {
  const items = formatMusicSlot(data, titleField, composerField);
  if (items.length <= 1) {
    const inlineHtml = items[0] ? renderMusicLineHtml(items[0]) : '';
    return subHeadingHtml(label, { inlineHtml, right: opts.right });
  }
  let html = subHeadingHtml(label, { right: opts.right });
  html += items.map(i => `<p class="music-entry">${renderMusicLineHtml(i)}</p>`).join('');
  return html;
}

// Inline SVG QR for a URL — crisp and self-contained (mirrors the PDF's
// vector QR). Returns '' when qrcode isn't available or no URL is given.
function qrSvgHtml(url) {
  const QR = getQRCode();
  if (!QR || !url) return '';
  let qr;
  try { qr = QR.create(String(url), { errorCorrectionLevel: 'M' }); } catch (e) { return ''; }
  const n = qr.modules.size, data = qr.modules.data;
  let rects = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (data[r * n + c]) rects += `<rect x="${c}" y="${r}" width="1.02" height="1.02"/>`;
  }
  return `<svg viewBox="0 0 ${n} ${n}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" fill="#000">${rects}</svg>`;
}

// Small-caps title inner markup with italic-lowercase connectives
// ("THE LITURGY of the WORD"), shared by the classic section headers and the
// cover title. The connective set is the same one the PDF generator uses,
// so the preview and the export always agree on the word treatment.
function classicTitleInner(text) {
  if (!text || !String(text).trim()) return '';
  return String(text).trim().split(/\s+/).map((w, i) =>
    (i > 0 && SMALLCAPS_CONNECTORS.has(w.toLowerCase())) ? `<span class="c-conn">${escapeHtml(w)}</span>` : escapeHtml(w)
  ).join(' ');
}
function classicSectionHtml(text) {
  return `<div class="c-section">${classicTitleInner(text)}</div>`;
}

// Page geometry for the preview/print HTML, mirrored from the PDF generator.
// half-letter: 5.5"x8.5" (booklet folded from 8.5x11 sheets)
// tabloid:     8.5"x11"  (booklet folded from 11x17 sheets)
const PAGE_GEOMETRY = {
  // ordinaryImageMax: height cap for notation images on Mass ordinary parts
  // and sung responses — sized for real music (2-3 staves at full content
  // width), unlike the small 0.6in paste-guide boxes. Mirrors the PDF
  // generator's 170 base-unit cap.
  'half-letter': { width: '5.5in', height: '8.5in', padding: '0.4in 0.4in', fontSize: '9.5pt', headerSize: '12pt', hymnSpace: '2.2in', ordinaryImageMax: '2.4in' },
  tabloid:       { width: '8.5in', height: '11in',  padding: '0.6in 0.6in', fontSize: '12pt', headerSize: '14pt', hymnSpace: '2.9in', ordinaryImageMax: '3in' }
};

function resolvePageGeometry(bookletSize) {
  return PAGE_GEOMETRY[bookletSize] || PAGE_GEOMETRY['half-letter'];
}

// CSS for the classic design — emitted only when the classic body is
// selected, so reimagined previews carry no dead rules or font requests.
// Monochrome Book-Antiqua/Garamond serif mirroring the classic PDF: the
// exact vendored typefaces (served from /assets/fonts/classic), small-caps
// section headers, em-dash sub-labels, two-column psalm & creed, QR footer.
function classicCssFor(geom) {
  return `
  @font-face { font-family:'ClassicSerif'; src:url('/assets/fonts/classic/Classic-Serif-Regular.otf') format('opentype'); font-weight:400; font-style:normal; font-display:swap; }
  @font-face { font-family:'ClassicSerif'; src:url('/assets/fonts/classic/Classic-Serif-Bold.otf') format('opentype'); font-weight:700; font-style:normal; font-display:swap; }
  @font-face { font-family:'ClassicSerif'; src:url('/assets/fonts/classic/Classic-Serif-Italic.otf') format('opentype'); font-weight:400; font-style:italic; font-display:swap; }
  @font-face { font-family:'ClassicSerif'; src:url('/assets/fonts/classic/Classic-Serif-BoldItalic.otf') format('opentype'); font-weight:700; font-style:italic; font-display:swap; }
  @font-face { font-family:'ClassicDisplay'; src:url('/assets/fonts/classic/Classic-Display-SemiBold.ttf') format('truetype'); font-weight:600; font-style:normal; font-display:swap; }
  @font-face { font-family:'ClassicDisplay'; src:url('/assets/fonts/classic/Classic-Display-Regular.ttf') format('truetype'); font-weight:400; font-style:normal; font-display:swap; }
  @font-face { font-family:'ClassicDisplay'; src:url('/assets/fonts/classic/Classic-Display-Italic.ttf') format('truetype'); font-weight:400; font-style:italic; font-display:swap; }
  @font-face { font-family:'ClassicScript'; src:url('/assets/fonts/classic/Classic-Script-Italic.otf') format('opentype'); font-weight:400; font-style:italic; font-display:swap; }

  body.design-classic {
    font-family: 'ClassicSerif', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif;
    color: #1a1a1a;
  }
  .c-section {
    font-family: 'ClassicDisplay', 'EB Garamond', Garamond, Georgia, serif;
    font-weight: 600; color: #111; text-align: center;
    font-variant: small-caps; text-transform: lowercase;
    letter-spacing: 0.5pt;
    font-size: calc(${geom.headerSize} * 1.55);
    margin: 8pt 0 5pt; line-height: 1.1;
  }
  .c-section .c-conn { font-variant: normal; font-style: italic; font-size: 0.72em; }
  body.design-classic .sub-heading {
    font-family: 'ClassicSerif', 'Book Antiqua', Palatino, Georgia, serif;
    color: #111; text-transform: none; letter-spacing: 0; font-weight: 700;
    font-size: 10pt;
  }
  body.design-classic .sub-inline { color: #222; margin-left: 2pt; font-style: italic; }
  /* Only the <em> piece title is italic on music lines — the composer's
     name is never italicized (director of liturgy). */
  body.design-classic .sub-inline.music { font-style: normal; }
  body.design-classic .sub-heading-left .sub-inline::before {
    content: '\\2014'; font-style: normal; font-weight: 700; color: #111; margin: 0 2pt 0 0;
  }
  body.design-classic .sub-inline.cite { font-style: italic; font-weight: 400; color: #222; }
  body.design-classic .rubric, body.design-classic .rubric-inline { color: #222; font-style: italic; }
  body.design-classic .reading-text, body.design-classic .prayer-text { text-align: justify; }
  body.design-classic .reading-text { margin-left: 10pt; }
  /* Two-column psalm strophes & creed */
  .c-twocol { column-count: 2; column-gap: 18pt; margin: 3pt 0; font-size: 0.94em; }
  .c-twocol .c-strophe { break-inside: avoid; margin-bottom: 5pt; white-space: pre-line; }
  .c-verse-label { font-weight: 700; }
  /* Classic cover */
  .c-cover { text-align: center; padding-top: 6pt; }
  .c-cover-title {
    font-family: 'ClassicDisplay', 'EB Garamond', Garamond, Georgia, serif;
    font-variant: small-caps; text-transform: lowercase; color: #111;
    font-size: calc(${geom.headerSize} * 2.1); line-height: 1.06; letter-spacing: 0.5pt; margin-bottom: 4pt;
  }
  .c-cover-title .c-conn { font-variant: normal; font-style: italic; font-size: 0.7em; }
  .c-cover-date { font-family:'ClassicDisplay',Georgia,serif; font-style: italic; font-size: calc(${geom.headerSize} * 0.95); color:#111; margin-bottom: 12pt; }
  .c-cover-cross { margin: 6pt auto 14pt; }
  .c-cover-cross svg { width: 96px; height: 96px; }
  .c-cover-cross svg, .c-cover-cross svg * { fill: #111 !important; }
  .c-greeting {
    font-family: 'ClassicScript', 'Book Antiqua', cursive, serif; font-style: italic;
    font-size: calc(${geom.headerSize} * 1.25); text-align: left; margin: 6pt 0 6pt; color:#111;
  }
  .c-info { text-align: left; }
  .c-info-block { margin-bottom: 7pt; }
  .c-info-label { font-family:'ClassicSerif',Georgia,serif; font-weight: 700; font-variant: small-caps; letter-spacing: 0.5pt; font-size: 0.95em; }
  .c-info-body { margin-left: 14pt; text-align: justify; }
  .c-welcome { font-style: italic; text-align: center; margin-top: 6pt; font-size: 0.95em; }
  /* QR footer */
  .c-footer { text-align: center; margin-top: 14pt; }
  .c-qr-row { display: flex; justify-content: center; align-items: flex-start; gap: 26pt; margin-bottom: 8pt; }
  .c-qr { text-align: center; }
  .c-qr svg { width: 74px; height: 74px; display: block; margin: 0 auto 3pt; }
  .c-qr-label { font-family:'ClassicDisplay',Georgia,serif; font-variant: small-caps; letter-spacing: 0.5pt; font-size: 9pt; }
  .c-social { text-align: left; font-size: 9pt; line-height: 1.5; align-self: center; }
  .c-copyright { font-style: italic; font-size: 6.5pt; color:#333; text-align: justify; line-height: 1.35; margin-top: 8pt; }
`;
}

function renderBookletHtml(data, options = {}) {
  const warnings = [];

  // Apply season defaults
  const d = applySeasonDefaults(data);
  const ss = d.seasonalSettings || {};
  const r = d.readings || {};
  const settings = options.parishSettings || {};
  // Honor the caller-selected booklet size so the preview matches the
  // exported PDF.  Default is tabloid (matches the editor's default).
  const bookletSize = options.bookletSize || data.bookletSize || 'tabloid';
  const geom = resolvePageGeometry(bookletSize);
  // Output design: 'reimagined' (the app's original look) or 'classic' (a
  // serif, monochrome emulation of the parish's in-house aid). The classic
  // preview mirrors the classic PDF — the same vendored typefaces, small-caps
  // section headers, em-dash sub-labels, two-column psalm & creed, "Verse:"
  // line, and QR footer — modulo the fixed-page-vs-flow pagination the HTML
  // preview has always used.
  const design = options.design || data.design || 'reimagined';

  const isLenten = d.liturgicalSeason === 'lent';
  const isAdvent = d.liturgicalSeason === 'advent';
  const showGloria = ss.gloria !== undefined ? ss.gloria : (d.liturgicalSeason !== 'lent' && d.liturgicalSeason !== 'advent');
  const creedType = ss.creedType || 'nicene';
  const creedText = {
    apostles:       APOSTLES_CREED,
    baptismal_vows: RENEWAL_OF_BAPTISMAL_VOWS,
    nicene:         NICENE_CREED
  }[creedType] || NICENE_CREED;
  const creedTitle = {
    apostles:       "The Apostles' Creed",
    baptismal_vows: 'Renewal of Baptismal Vows',
    nicene:         'The Nicene Creed'
  }[creedType] || 'The Nicene Creed';
  const entranceType = ss.entranceType || 'processional';
  const penitentialAct = ss.penitentialAct || 'confiteor';

  // Lenten acclamation: support alternate choice from worksheet
  let acclamationText;
  if (isLenten) {
    acclamationText = (ss.lentenAcclamation === 'alternate') ? GOSPEL_ACCLAMATION_LENTEN_ALT : GOSPEL_ACCLAMATION_LENTEN;
  } else {
    acclamationText = GOSPEL_ACCLAMATION_STANDARD;
  }

  // Postlude: suppressed during Lent per worksheet
  const includePostlude = ss.includePostlude !== undefined ? ss.includePostlude : !isLenten;

  // Advent Wreath: shown during Advent per worksheet
  const showAdventWreath = ss.adventWreath !== undefined ? ss.adventWreath : isAdvent;

  // Per-slot uploaded notation images. When a slot has an image it renders
  // INSIDE the reserved music area (no more "paste licensed notation here"
  // with no way to do it digitally — UAT June 2026). Precedence everywhere:
  // uploaded image > reserved paste box > plain text.
  const ni = d.notationImages || {};
  // ?strip=1 asks the server for the title-cropped variant of the stored
  // image — the same render-time title stripping the exported PDF applies —
  // so the preview shows exactly what will print. Off when the aid opts out.
  const stripTitles = d.stripNotationTitles !== false;
  const notationSrc = (url) =>
    stripTitles ? url + (String(url).includes('?') ? '&' : '?') + 'strip=1' : url;
  const notationImg = (slot, cls) => ni[slot]
    ? `<img class="notation-image${cls ? ' ' + cls : ''}" src="${escapeHtml(notationSrc(ni[slot]))}" alt="${escapeHtml(slot)} notation">`
    : '';

  // Hymn-sized music area for a slot: uploaded image first, then the dashed
  // paste box when reserveHymnSpace is on.
  const hymnSpace = (slot) => {
    if (ni[slot]) return notationImg(slot, 'hymn');
    return d.reserveHymnSpace !== false
      ? '<div class="hymn-music-space">Reserved for hymn music &mdash; paste licensed notation here</div>'
      : '';
  };
  // Processional hymn area — only when a processional hymn is sung,
  // not when the antiphon is chanted (antiphon has no separate music sheet).
  const processionalHymnSpaceHtml = entranceType === 'processional' ? hymnSpace('processional') : '';

  // Smaller music area for Mass ordinary parts / sung responses.
  const ordSpace = (slot, label) => {
    if (ni[slot]) return notationImg(slot, slot === 'psalmRefrain' ? 'ordinary w5' : 'ordinary');
    return d.reserveHymnSpace !== false
      ? `<div class="ordinary-music-space">${escapeHtml(label)}</div>` : '';
  };
  // Does this slot show music (image or paste box) instead of spoken text?
  const slotHasMusic = (slot) => !!ni[slot] || d.reserveHymnSpace !== false;

  // Overflow detection
  const overflows = detectOverflows(d);
  overflows.forEach(o => warnings.push(o.message));
  const overflowPages = new Set(overflows.map(o => o.page));

  // Parish info — only print a parish name when one is actually configured.
  const parishName = settings.parishName || '';
  const nurseryBlurb = settings.nurseryBlurb || 'A nursery is available during the 9:00 AM and 11:00 AM Masses.';
  const connectBlurb = settings.connectBlurb || 'New to the parish? Visit the Welcome Desk after Mass.';
  const restroomsBlurb = settings.restroomsBlurb || 'Restrooms are located in the narthex and lower level.';
  const prayerBlurb = settings.prayerBlurb || 'For prayer requests, contact the parish office.';
  // Default copyright wording is shared with the PDF generator (single
  // source: DEFAULT_PARISH_SETTINGS in config/defaults.js). The text is
  // plain — nl2br/escapeHtml escape it exactly once at render time. The
  // OneLicense permission now appears ONLY in this end-of-document block
  // (director: it should not repeat on every page with notation).
  const copyrightFull = settings.copyrightFull || getDefaultCopyrightFull(settings.onelicenseNumber);

  // Mass schedule, clergy, and standing messages (cover page).  Each section
  // is optional — a parish that doesn't fill these in still renders cleanly.
  const massTimesLines = String(settings.massTimes || 'Sat 5:00 PM\nSun 9:00 AM\nSun 11:00 AM').split('\n').map(s => s.trim()).filter(Boolean);
  const clergyLines = [];
  if (settings.pastor)        clergyLines.push(`${settings.pastor}, ${settings.pastorTitle || 'Pastor'}`);
  if (settings.associates)    String(settings.associates).split('\n').forEach(l => { if (l.trim()) clergyLines.push(l.trim()); });
  if (settings.deacons)       String(settings.deacons).split('\n').forEach(l => { if (l.trim()) clergyLines.push(l.trim()); });
  if (settings.musicDirector) clergyLines.push(settings.musicDirector + ', Music Director');
  const welcomeMessage = settings.welcomeMessage || '';
  const closingMessage = settings.closingMessage || '';
  const coverTagline = settings.coverTagline || '';

  // Rubric alignment — inline style applied to all Please sit/stand/kneel lines.
  // Centered by default per the director of liturgy; a parish setting wins.
  const rubricAlign = ss.rubricAlignment || 'center';
  const RP = `<p class="rubric" style="text-align:${escapeHtml(rubricAlign)}">`;

  // Sanctus language: per-aid override > parish default > 'english'
  const holyHolyLanguage = ss.holyHolyLanguage || settings.defaultSanctusLanguage || 'english';
  const holyHolyText = getHolyHolyHolyText(holyHolyLanguage);
  const holyHolyHeading = holyHolyLanguage === 'latin' ? 'Sanctus' : 'Holy, Holy, Holy';

  const docHead = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Worship Aid — ${escapeHtml(d.feastName)} — ${escapeHtml(d.liturgicalDate)}</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: ${geom.width} ${geom.height}; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'EB Garamond', Georgia, 'Times New Roman', serif;
    font-size: ${geom.fontSize};
    line-height: 1.35;
    color: #1C1C1C;
    background: white;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* --- Page container: ${geom.width} x ${geom.height} booklet page --- */
  .page {
    width: ${geom.width};
    height: ${geom.height};
    padding: ${geom.padding};
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  .page.overflow-warning { outline: 3px solid #c0392b; }

  /* --- Typography --- */
  .section-header {
    font-family: 'Cinzel', serif;
    font-size: ${geom.headerSize};
    font-weight: 600;
    text-align: center;
    color: #1A2E4A;
    letter-spacing: 1.5pt;
    text-transform: uppercase;
    margin: 0 0 6pt;
    padding-bottom: 4pt;
    border-bottom: 0.75pt solid #B8922A;
  }
  /* Hymnal/number citation, e.g. "[Worship IV #612]" */
  .hymnal-cite { font-style: normal; font-size: 0.85em; color: #6B1A1A; }
  .sub-heading {
    font-family: 'Cinzel', serif;
    font-size: 8.5pt;
    font-weight: 600;
    color: #6B1A1A;
    text-transform: uppercase;
    letter-spacing: 1pt;
  }
  /* Heading line: heading + inline title/citation on the left, posture
     direction right-justified. At least 8pt of space separates every
     heading from what precedes it (director of liturgy). */
  .sub-heading-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8pt;
    margin: 8pt 0 2pt;
  }
  /* Bare headings (no inline row) get the same minimum space above. */
  div.sub-heading { margin-top: 8pt; }
  .sub-heading-left { display: inline; }
  .sub-inline {
    font-style: italic;
    font-size: 9pt;
    margin-left: 5pt;
  }
  .sub-inline.cite { font-style: normal; font-weight: 600; font-size: 9pt; color: #333; }
  /* Music lines: only the <em> piece title is italic — the composer's name
     is never italicized (director of liturgy). */
  .sub-inline.music { font-style: normal; }
  .sub-inline em { font-style: italic; }
  .sub-inline .composer, .music-entry .composer { font-style: normal; }
  .rubric-inline {
    color: #8B0000;
    font-style: italic;
    font-size: 8pt;
    white-space: nowrap;
    flex: none;
  }
  .rubric {
    color: #8B0000;
    font-style: italic;
    font-size: 8pt;
    margin: 3pt 0;
  }
  .citation {
    font-weight: 600;
    font-size: 9pt;
    color: #333;
    margin: 1pt 0;
  }
  .reading-text {
    text-align: left;
    text-indent: 0;
    margin: 2pt 0 5pt;
    font-size: 9.5pt;
    line-height: 1.3;
  }
  .psalm-refrain {
    font-weight: 700;
    font-style: italic;
    margin: 3pt 0;
  }
  .psalm-verse {
    margin: 2pt 0 7pt 12pt;
    font-size: 9pt;
  }
  .prayer-text {
    margin: 2pt 0;
    line-height: 1.3;
    white-space: pre-line;
  }
  .creed-text {
    white-space: pre-line;
    font-size: 8.5pt;
    line-height: 1.25;
    margin: 2pt 0;
  }

  /* --- Music entries (multi-Mass fallback list under a heading) --- */
  .music-entry {
    margin: 2pt 0;
    font-size: 9pt;
  }
  .music-entry em { font-style: italic; }
  .mass-time-label { font-size: 8pt; color: #666; }

  /* Reserved paste area for licensed hymn notation. */
  .hymn-music-space {
    height: ${geom.hymnSpace};
    border: 0.75pt dashed #c9c9c9;
    border-radius: 2pt;
    margin: 4pt 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #b5b5b5;
    font-size: 7pt;
    font-style: italic;
  }
  /* Smaller paste area for Mass ordinary music (Kyrie, Sanctus, Agnus Dei). */
  .ordinary-music-space {
    height: 0.6in;
    border: 0.5pt dashed #dedede;
    border-radius: 2pt;
    margin: 3pt 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #c8c8c8;
    font-size: 6.5pt;
    font-style: italic;
  }
  /* Uploaded notation images — director of liturgy spec (17th Sunday OT
     proof): the default width for ALL music notation images is 5in,
     centered, at natural height. (Inches are exact on the 8.5in tabloid
     trim; smaller trims clamp to the content width.) */
  .notation-image {
    display: block;
    max-width: 100%;
    object-fit: contain;
    object-position: center top;
    margin: 3pt auto;
  }
  .notation-image.hymn     { width: 5in; max-height: ${geom.hymnSpace}; }
  .notation-image.ordinary { width: 5in; max-height: ${geom.hymnSpace}; }
  .notation-image.w5       { width: 5in; }
  /* Two-column layout for the Creed */
  .creed-text.two-column {
    columns: 2;
    column-gap: 14pt;
    column-rule: 0.5pt solid #e8e8e8;
  }

  /* --- Cover (Page 1) --- */
  .cover-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .cover-top {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-bottom: 0.75pt solid #B8922A;
    padding-bottom: 10pt;
  }
  .cover-logo svg { width: 60px; height: 60px; }
  .cover-feast {
    font-family: 'Cinzel', serif;
    font-size: 16pt;
    font-weight: 700;
    color: #1A2E4A;
    text-align: center;
    margin: 8pt 0 3pt;
    letter-spacing: 0.5pt;
  }
  .cover-date {
    font-size: 10pt;
    color: #555;
    text-align: center;
    margin-bottom: 3pt;
  }
  .cover-times {
    font-size: 8.5pt;
    color: #777;
    text-align: center;
    letter-spacing: 0.5pt;
  }

  /* Parish info block — PRD Appendix A Page 1 */
  .parish-info {
    padding-top: 8pt;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5pt 10pt;
    font-size: 7.5pt;
    line-height: 1.35;
    color: #444;
  }
  .info-block-title {
    font-family: 'Cinzel', serif;
    font-size: 6.5pt;
    font-weight: 600;
    color: #B8922A;
    text-transform: uppercase;
    letter-spacing: 1pt;
    margin-bottom: 1pt;
  }
  .info-block p { margin: 0; }

  .copyright-full {
    font-size: 6.5pt;
    color: #888;
    line-height: 1.35;
    max-width: 4in;
    text-align: center;
    margin-top: auto;
    padding-top: 12pt;
  }

  /* --- Overflow error banner --- */
  .overflow-banner {
    background: #fdeaea;
    border: 1.5pt solid #c0392b;
    color: #c0392b;
    font-size: 7.5pt;
    padding: 3pt 6pt;
    margin-bottom: 4pt;
    text-align: center;
    font-weight: 600;
  }

  /* --- Advent Wreath --- */
  .advent-wreath {
    background: #f0eaf5;
    border: 0.5pt solid #7b5ea7;
    padding: 4pt 6pt;
    margin: 4pt 0;
    font-size: 8pt;
    text-align: center;
  }
  .advent-wreath strong { color: #5b3d8f; }

  /* --- Misc --- */
  .page-number {
    position: absolute;
    bottom: 0.25in;
    left: 0; right: 0;
    text-align: center;
    font-size: 7pt;
    color: #aaa;
  }
  .divider-rule {
    border: none;
    border-top: 0.5pt solid #B8922A;
    margin: 5pt 0;
  }
  .children-liturgy {
    background: #f5f0e6;
    border: 0.5pt solid #d4c9a8;
    padding: 4pt 6pt;
    margin: 4pt 0;
    font-size: 8pt;
  }
  .announcement-block {
    background: #f7f5f0;
    border-left: 2pt solid #B8922A;
    padding: 4pt 6pt;
    margin: 4pt 0;
    font-size: 8pt;
  }

  ${design === 'classic' ? classicCssFor(geom) : ''}
</style>
</head>`;

  // ===== Shared outline drives the liturgy body (pages 2-8) =====
  // The same buildLiturgyOutline the PDF generator consumes, so the preview
  // and the export — and the two designs — can never drift apart. Each op is
  // mapped to the existing HTML helpers; the cover (page 1) stays per-design.
  const outline = buildLiturgyOutline(d, { design, seasonalSettings: ss, readings: r, parishSettings: settings });

  const rubricHtml = (text) => `<p class="rubric" style="text-align:${escapeHtml(rubricAlign)}">${escapeHtml(text)}</p>`;
  const settingTextHtml = (text) => `<div class="prayer-text">${nl2br(text)}</div>`;

  // Children's Liturgy dismissal box — identical markup in both designs.
  const childrenBoxHtml = () => {
    const times = resolveChildrenLiturgyTimes(d);
    const notes = d.childrenLiturgyNotes ||
      'Children are dismissed after the Opening Prayer and will rejoin during the Offertory.';
    return `<div class="children-liturgy">
    <strong>Children's Liturgy of the Word</strong> — ${times.map(escapeHtml).join(' &amp; ')}
    ${d.childrenLiturgyLeader ? `<br>Led by ${escapeHtml(d.childrenLiturgyLeader)}` : ''}
    ${d.childrenLiturgyMusic ? `<br><em>${escapeHtml(d.childrenLiturgyMusic)}</em>${d.childrenLiturgyMusicComposer ? ', ' + escapeHtml(d.childrenLiturgyMusicComposer) : ''}` : ''}
    <br><span style="font-size:7.5pt;font-style:italic;">${nl2br(notes)}</span>
  </div>`;
  };

  // Classic QR + licensing footer (page 8). Each QR encodes once.
  const classicFooterHtml = () => {
    const qrCells = [['Give', settings.giveUrl], ['Join', settings.joinUrl], ['Bulletin', settings.bulletinUrl]]
      .map(([label, u]) => ({ label, svg: qrSvgHtml(u) })).filter(c => c.svg);
    const socials = String(settings.socialHandles || '').split('\n').map(s => s.trim()).filter(Boolean);
    return `<div class="c-footer">
    ${qrCells.length ? `<div class="c-qr-row">
      ${qrCells.map(c => `<div class="c-qr">${c.svg}<div class="c-qr-label">${escapeHtml(c.label)}</div></div>`).join('')}
      ${socials.length ? `<div class="c-social">${socials.map(escapeHtml).join('<br>')}</div>` : ''}
    </div>` : ''}
    <div class="c-copyright">${nl2br(copyrightFull)}</div>
  </div>`;
  };

  // Map one outline op to HTML via the existing per-medium helpers.
  const renderOpHtml = (op) => {
    switch (op.op) {
      case 'section':
        return design === 'classic' ? classicSectionHtml(op.title) : `<div class="section-header">${escapeHtml(op.title)}</div>`;
      case 'music':
        return musicSubHeadingHtml(d, op.heading, op.titleField, op.composerField, { right: op.right });
      case 'hymnSpace':
        return hymnSpace(op.slot);
      case 'ordinarySpace':
        return ordSpace(op.slot, op.label);
      case 'setting': {
        let out = subHeadingHtml(op.heading, { inline: op.setting || '' });
        if (op.mode === 'musicOnly' || slotHasMusic(op.slot)) out += '\n  ' + ordSpace(op.slot, op.label);
        else if (op.text) out += '\n  ' + settingTextHtml(op.text);
        return out;
      }
      case 'penitential':
        // HTML has no page-flow constraint (the PDF turns this into a fit
        // block); the preview always shows the full text. Reimagined sets it
        // slightly smaller (8.5pt); classic uses the body size.
        return subHeadingHtml('Penitential Act') +
          `\n  <div class="prayer-text"${design === 'classic' ? '' : ' style="font-size:8.5pt;"'}>${nl2br(op.text)}</div>`;
      case 'subheading':
        return subHeadingHtml(op.heading, { inline: op.inline || '', citation: op.citation, right: op.right });
      case 'reading':
        return subHeadingHtml(op.heading, { inline: op.citation || '', citation: true }) +
          `\n  <div class="reading-text">${nl2br(op.text)}</div>`;
      case 'rubric':
        return rubricHtml(op.text);
      case 'psalm': {
        let out = subHeadingHtml('Responsorial Psalm', { inline: op.citation || '', citation: true });
        out += '\n  ' + (slotHasMusic(op.slot)
          ? ordSpace(op.slot, 'Responsorial Psalm refrain — music notation')
          : (op.refrain ? `<p class="psalm-refrain">R. ${escapeHtml(op.refrain)}</p>` : ''));
        if (op.twoColumn && op.strophes && op.strophes.length) {
          out += `\n  <div class="c-twocol">${op.strophes.map(s => `<div class="c-strophe">${nl2br(s)}</div>`).join('')}</div>`;
        }
        return out;
      }
      case 'psalmVerse':
        return `<p class="psalm-verse">${nl2br(op.text)}</p>`;
      case 'creed': {
        const head = subHeadingHtml(op.heading, { right: op.right });
        let body;
        if (design === 'classic') {
          body = op.twoColumn
            ? `<div class="c-twocol" style="white-space:pre-line">${escapeHtml(op.text)}</div>`
            : `<div class="creed-text">${nl2br(op.text)}</div>`;
        } else {
          body = `<div class="creed-text${op.twoColumn ? ' two-column' : ''}">${nl2br(op.text)}</div>`;
        }
        return head + '\n  ' + body;
      }
      case 'gospelAccl': {
        let out = subHeadingHtml(op.heading, { inline: op.reference || '', citation: true, right: op.right });
        out += '\n  ' + (slotHasMusic(op.slot)
          ? ordSpace(op.slot, 'Gospel Acclamation — music notation')
          : `<p class="psalm-refrain">${escapeHtml(op.text)}</p>`);
        if (op.verse) {
          out += '\n  ' + (op.verseStyle === 'hanging'
            ? `<p class="reading-text"><span class="c-verse-label">Verse:</span> <em>${nl2br(op.verse)}</em></p>`
            : `<p style="font-size:9pt;font-style:italic;margin:2pt 0;">${nl2br(op.verse)}</p>`);
        }
        return out;
      }
      case 'invitationText':
        return `<p class="prayer-text" style="font-size:8.5pt;"><strong>Priest:</strong> ${escapeHtml(op.priest)}</p>\n  <p class="prayer-text" style="font-size:8.5pt;"><strong>All:</strong> ${escapeHtml(op.all)}</p>`;
      case 'childrenBox':
        return childrenBoxHtml();
      case 'childrenReturn':
        return rubricHtml(op.text);
      case 'adventWreath':
        return design === 'classic'
          ? '<p class="prayer-text" style="text-align:center;font-weight:700;">Lighting of the Advent Wreath</p>'
          : '<div class="advent-wreath"><strong>Lighting of the Advent Wreath</strong></div>';
      case 'announcements':
        return design === 'classic'
          ? subHeadingHtml('Announcements', { right: op.right }) + `\n  <div class="prayer-text">${nl2br(op.text)}</div>`
          : `<hr class="divider-rule">\n  ${subHeadingHtml('Announcements')}\n  <div class="announcement-block">${nl2br(op.text)}</div>`;
      case 'notes':
        return design === 'classic'
          ? `<p class="prayer-text" style="text-align:center;font-style:italic;">${nl2br(op.text)}</p>`
          : `<div style="margin:8pt auto 0;font-size:8pt;font-style:italic;text-align:center;max-width:4in;">${nl2br(op.text)}</div>`;
      case 'closing':
        return design === 'classic'
          ? `<p class="prayer-text" style="text-align:center;">${nl2br(op.text)}</p>`
          : `<div style="margin:8pt auto 0;font-size:8pt;text-align:center;max-width:4in;">${nl2br(op.text)}</div>`;
      case 'copyright':
        return `<div class="copyright-full" style="margin:10pt auto 0;">${nl2br(copyrightFull)}</div>`;
      case 'classicFooter':
        return classicFooterHtml();
      default:
        return '';
    }
  };

  // Page 1 covers — genuinely different layouts, kept per-design.
  const reimaginedCover = () => `<!-- PAGE 1: COVER -->
<div class="page" id="page-1">
  <div class="cover-page">
    <div class="cover-top">
      <div class="cover-logo">${getLogoHtml(settings)}</div>
      ${parishName ? `<div style="font-family:'Cinzel',serif;font-size:11pt;color:#6B1A1A;text-align:center;margin-top:6pt;letter-spacing:1pt;">${escapeHtml(parishName)}</div>` : ''}
      ${coverTagline ? `<div style="font-size:8pt;color:#777;text-align:center;font-style:italic;margin-top:1pt;">${escapeHtml(coverTagline)}</div>` : ''}
      <div class="cover-feast">${escapeHtml(d.feastName)}</div>
      <div class="cover-date">${escapeHtml(formatDate(d.liturgicalDate))}</div>
      <div class="cover-times">${massTimesLines.map(escapeHtml).join(' &bull; ')}</div>
      ${clergyLines.length ? `<div style="font-size:8pt;color:#666;text-align:center;margin-top:6pt;line-height:1.4;">${clergyLines.map(escapeHtml).join('<br>')}</div>` : ''}
    </div>
    <div class="parish-info">
      <div>
        <div class="info-block-title">Connect</div>
        <p>${nl2br(connectBlurb)}</p>
      </div>
      <div>
        <div class="info-block-title">Nursery</div>
        <p>${nl2br(nurseryBlurb)}</p>
      </div>
      <div>
        <div class="info-block-title">Restrooms</div>
        <p>${nl2br(restroomsBlurb)}</p>
      </div>
      <div>
        <div class="info-block-title">Prayer</div>
        <p>${nl2br(prayerBlurb)}</p>
      </div>
    </div>
    ${welcomeMessage ? `<div style="margin-top:6pt;padding:5pt 8pt;border:0.5pt solid #B8922A;border-radius:2pt;font-size:8pt;font-style:italic;text-align:center;">${nl2br(welcomeMessage)}</div>` : ''}
  </div>
</div>`;

  const classicCover = () => {
    const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return `<!-- PAGE 1: COVER -->
<div class="page" id="page-1">
  <div class="c-cover">
    <div class="c-cover-title">${classicTitleInner(d.feastName)}</div>
    <div class="c-cover-date">${escapeHtml(formatDate(d.liturgicalDate))}</div>
    <div class="c-cover-cross">${getLogoHtml(settings)}</div>
    <div class="c-greeting">${escapeHtml(classicGreeting(settings))}</div>
    <div class="c-info">
      ${classicCoverBlocks(settings).map(([label, body]) =>
        `<div class="c-info-block"><div class="c-info-label">${escapeHtml(titleCase(label))}</div><div class="c-info-body">${nl2br(body)}</div></div>`).join('\n      ')}
    </div>
    ${welcomeMessage ? `<div class="c-welcome">${nl2br(welcomeMessage)}</div>` : ''}
  </div>
</div>`;
  };

  // Group outline ops onto their fixed HTML pages, then wrap each page shell.
  const contentByPage = {};
  for (const block of outline.blocks) {
    const rendered = block.ops.map(renderOpHtml).filter(s => s !== '' && s != null).join('\n  ');
    if (!rendered.trim()) continue;
    contentByPage[block.htmlPage] = (contentByPage[block.htmlPage] ? contentByPage[block.htmlPage] + '\n\n  ' : '') + rendered;
  }
  const banner = (n) => overflowPages.has(n)
    ? `<div class="overflow-banner">${escapeHtml((overflows.find(o => o.page === n) || {}).message || ('Page ' + n + ' content may overflow'))}</div>`
    : '';
  const pageShell = (n) => `<!-- PAGE ${n} -->
<div class="page${overflowPages.has(n) ? ' overflow-warning' : ''}" id="page-${n}">
  ${banner(n)}
  ${contentByPage[n] || ''}
  <div class="page-number">${n}</div>
</div>`;

  const coverHtml = design === 'classic' ? classicCover() : reimaginedCover();
  const bodyHtml = coverHtml + '\n\n' + [2, 3, 4, 5, 6, 7, 8].map(pageShell).join('\n\n');

  const html = `${docHead}
<body class="design-${escapeHtml(design)}">
${bodyHtml}
</body>
</html>`;

  return { html, warnings, bookletSize, pageWidth: geom.width, pageHeight: geom.height };
}

module.exports = { renderBookletHtml, escapeHtml, nl2br, formatDate, PAGE_GEOMETRY, resolvePageGeometry };
