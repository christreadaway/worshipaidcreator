// Renders worship aid data into an 8-page HTML booklet
// PRD: 5.5" x 8.5" half-letter booklet pages
// Updated with worksheet workflow: Advent wreath, Lenten postlude suppression,
// alternate Lenten acclamation, Apostles' Creed for Advent/Easter
'use strict';

const path = require('path');
const fs = require('fs');
const { APOSTLES_CREED, NICENE_CREED } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, LORDS_PRAYER } = require('./assets/text/mass-texts');
const { formatMusicSlot, renderMusicLineHtml } = require('./music-formatter');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');

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

function renderMusicSection(data, titleField, composerField, label) {
  const items = formatMusicSlot(data, titleField, composerField);
  if (items.length === 0) return '';
  let html = `<div class="music-entry"><span class="music-label">${escapeHtml(label)} &mdash; </span>`;
  html += items.map(i => renderMusicLineHtml(i)).join(' <span class="music-divider">/</span> ');
  html += '</div>';
  return html;
}

function renderBookletHtml(data, options = {}) {
  const warnings = [];

  // Apply season defaults
  const d = applySeasonDefaults(data);
  const ss = d.seasonalSettings || {};
  const r = d.readings || {};
  const settings = options.parishSettings || {};

  const isLenten = d.liturgicalSeason === 'lent';
  const isAdvent = d.liturgicalSeason === 'advent';
  const showGloria = ss.gloria !== undefined ? ss.gloria : (d.liturgicalSeason !== 'lent' && d.liturgicalSeason !== 'advent');
  const creedType = ss.creedType || 'nicene';
  const creedText = creedType === 'apostles' ? APOSTLES_CREED : NICENE_CREED;
  const creedTitle = creedType === 'apostles' ? "The Apostles' Creed" : 'The Nicene Creed';
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

  // Overflow detection
  const overflows = detectOverflows(d);
  overflows.forEach(o => warnings.push(o.message));
  const overflowPages = new Set(overflows.map(o => o.page));

  // Parish info
  const parishName = settings.parishName || '[Parish Name]';
  const nurseryBlurb = settings.nurseryBlurb || 'A nursery is available during the 9:00 AM and 11:00 AM Masses.';
  const connectBlurb = settings.connectBlurb || 'New to the parish? Visit the Welcome Desk after Mass.';
  const restroomsBlurb = settings.restroomsBlurb || 'Restrooms are located in the narthex and lower level.';
  const prayerBlurb = settings.prayerBlurb || 'For prayer requests, contact the parish office.';
  const copyrightShort = settings.copyrightShort || 'Music reprinted under OneLicense #A-702171. All rights reserved.';
  const copyrightFull = settings.copyrightFull || `Excerpts from the Lectionary for Mass for Use in the Dioceses of the United States of America, second typical edition © 2001, 1998, 1997, 1986, 1970 Confraternity of Christian Doctrine, Inc., Washington, DC. Used with permission. All rights reserved.\n\nExcerpts from the English translation of The Roman Missal © 2010, International Commission on English in the Liturgy Corporation. All rights reserved.\n\nMusic reprinted under OneLicense #${escapeHtml(settings.onelicenseNumber || 'A-702171')}. All rights reserved.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Worship Aid — ${escapeHtml(d.feastName)} — ${escapeHtml(d.liturgicalDate)}</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: 5.5in 8.5in; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'EB Garamond', Georgia, 'Times New Roman', serif;
    font-size: 9.5pt;
    line-height: 1.35;
    color: #1C1C1C;
    background: white;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* --- Page container: 5.5in x 8.5in booklet page --- */
  .page {
    width: 5.5in;
    height: 8.5in;
    padding: 0.35in 0.4in;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  .page.overflow-warning { outline: 3px solid #c0392b; }

  /* --- Typography --- */
  .section-header {
    font-family: 'Cinzel', serif;
    font-size: 12pt;
    font-weight: 600;
    text-align: center;
    color: #1A2E4A;
    letter-spacing: 1.5pt;
    text-transform: uppercase;
    margin: 0 0 6pt;
    padding-bottom: 4pt;
    border-bottom: 0.75pt solid #B8922A;
  }
  .sub-heading {
    font-family: 'Cinzel', serif;
    font-size: 8.5pt;
    font-weight: 600;
    color: #6B1A1A;
    text-transform: uppercase;
    letter-spacing: 1pt;
    margin: 7pt 0 2pt;
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
    text-align: justify;
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
    margin: 2pt 0 2pt 12pt;
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

  /* --- Music entries per PRD §5.4 --- */
  .music-entry {
    margin: 2pt 0;
    font-size: 9pt;
  }
  .music-label {
    font-family: 'Cinzel', serif;
    font-size: 7.5pt;
    font-weight: 600;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.5pt;
  }
  .music-entry em { font-style: italic; }
  .mass-time-label { font-size: 8pt; color: #666; }
  .music-divider { color: #999; margin: 0 2pt; }

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

  /* --- Back Cover (Page 8) --- */
  .back-cover {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100%;
    text-align: center;
  }
  .copyright-full {
    font-size: 6.5pt;
    color: #888;
    line-height: 1.35;
    max-width: 4in;
    text-align: center;
    margin-top: auto;
    padding-top: 12pt;
  }
  .copyright-short {
    font-size: 7pt;
    color: #888;
    text-align: center;
    margin-top: 6pt;
    padding-top: 4pt;
    border-top: 0.5pt solid #ccc;
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
</style>
</head>
<body>

<!-- PAGE 1: COVER -->
<div class="page" id="page-1">
  <div class="cover-page">
    <div class="cover-top">
      <div class="cover-logo">${getLogoSvg()}</div>
      <div class="cover-feast">${escapeHtml(d.feastName)}</div>
      <div class="cover-date">${escapeHtml(formatDate(d.liturgicalDate))}</div>
      <div class="cover-times">Sat 5:00 PM &bull; Sun 9:00 AM &bull; Sun 11:00 AM</div>
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
  </div>
</div>

<!-- PAGE 2: INTRODUCTORY RITES -->
<div class="page${overflowPages.has(2) ? ' overflow-warning' : ''}" id="page-2">
  ${overflowPages.has(2) ? '<div class="overflow-banner">Page 2 content may overflow</div>' : ''}
  <div class="section-header">The Introductory Rites</div>

  <div class="sub-heading">Organ Prelude</div>
  ${renderMusicSection(d, 'organPrelude', 'organPreludeComposer', 'Prelude')}

  <p class="rubric">${RUBRICS.stand}</p>

  <div class="sub-heading">${entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon'}</div>
  ${renderMusicSection(d, 'processionalOrEntrance', 'processionalOrEntranceComposer', entranceType === 'processional' ? 'Processional' : 'Antiphon')}

  ${showAdventWreath ? `
  <div class="advent-wreath">
    <strong>Lighting of the Advent Wreath</strong>
  </div>
  ` : ''}

  ${penitentialAct === 'confiteor' ? `
  <div class="sub-heading">Penitential Act</div>
  <div class="prayer-text" style="font-size:8.5pt;">${nl2br(CONFITEOR)}</div>
  ` : ''}

  <div class="sub-heading">Lord, Have Mercy</div>
  ${renderMusicSection(d, 'kyrieSetting', 'kyrieComposer', 'Kyrie')}

  ${showGloria ? `
  <div class="sub-heading">Gloria</div>
  <p class="prayer-text" style="font-size:8.5pt;">Glory to God in the highest, and on earth peace to people of good will.</p>
  ` : ''}

  <div class="page-number">2</div>
</div>

<!-- PAGE 3: LITURGY OF THE WORD -->
<div class="page${overflowPages.has(3) ? ' overflow-warning' : ''}" id="page-3">
  ${overflowPages.has(3) ? `<div class="overflow-banner">${escapeHtml(overflows.find(o => o.page === 3)?.message || 'Page 3 overflow')}</div>` : ''}
  <div class="section-header">The Liturgy of the Word</div>

  <p class="rubric">${RUBRICS.sit}</p>

  <div class="sub-heading">First Reading</div>
  <p class="citation">${escapeHtml(r.firstReadingCitation)}</p>
  <div class="reading-text">${nl2br(r.firstReadingText)}</div>

  <div class="sub-heading">Responsorial Psalm</div>
  <p class="citation">${escapeHtml(r.psalmCitation)}</p>
  ${r.psalmRefrain ? `<p class="psalm-refrain">R. ${escapeHtml(r.psalmRefrain)}</p>` : ''}
  ${r.psalmVerses ? r.psalmVerses.split('\n\n').map(v => `<p class="psalm-verse">${nl2br(v)}</p>`).join('') : ''}

  ${!r.noSecondReading && r.secondReadingCitation ? `
  <div class="sub-heading">Second Reading</div>
  <p class="citation">${escapeHtml(r.secondReadingCitation)}</p>
  <div class="reading-text">${nl2br(r.secondReadingText)}</div>
  ` : ''}

  <p class="rubric">${RUBRICS.stand}</p>

  <div class="sub-heading">Gospel Acclamation</div>
  <p class="psalm-refrain">${escapeHtml(acclamationText)}</p>
  ${r.gospelAcclamationReference ? `<p class="citation">${escapeHtml(r.gospelAcclamationReference)}</p>` : ''}
  ${r.gospelAcclamationVerse ? `<p style="font-size:9pt;font-style:italic;margin:2pt 0;">${nl2br(r.gospelAcclamationVerse)}</p>` : ''}

  <div class="page-number">3</div>
</div>

<!-- PAGE 4: GOSPEL + CREED -->
<div class="page${overflowPages.has(4) ? ' overflow-warning' : ''}" id="page-4">
  ${overflowPages.has(4) ? `<div class="overflow-banner">${escapeHtml(overflows.find(o => o.page === 4)?.message || 'Page 4 overflow')}</div>` : ''}

  <div class="sub-heading">Gospel</div>
  <p class="citation">${escapeHtml(r.gospelCitation)}</p>
  <div class="reading-text">${nl2br(r.gospelText)}</div>

  <div class="sub-heading">Homily</div>
  <p class="rubric">${RUBRICS.sit}</p>

  <p class="rubric">${RUBRICS.stand}</p>
  <div class="sub-heading">${escapeHtml(creedTitle)}</div>
  <div class="creed-text">${nl2br(creedText)}</div>

  <div class="sub-heading">Prayer of the Faithful</div>
  <p class="rubric" style="font-style:italic;">The intentions are read; the assembly responds.</p>

  <div class="page-number">4</div>
</div>

<!-- PAGE 5: LITURGY OF THE EUCHARIST -->
<div class="page" id="page-5">
  <div class="section-header">The Liturgy of the Eucharist</div>

  <p class="rubric">${RUBRICS.sit}</p>

  <div class="sub-heading">Offertory</div>
  ${renderMusicSection(d, 'offertoryAnthem', 'offertoryAnthemComposer', 'Offertory Anthem')}

  ${d.childrenLiturgyEnabled ? `
  <div class="children-liturgy">
    <strong>Children's Liturgy of the Word</strong> — ${escapeHtml(d.childrenLiturgyMassTime || 'Sun 9:00 AM')}
    ${d.childrenLiturgyMusic ? `<br><em>${escapeHtml(d.childrenLiturgyMusic)}</em>${d.childrenLiturgyMusicComposer ? ', ' + escapeHtml(d.childrenLiturgyMusicComposer) : ''}` : ''}
  </div>
  ` : ''}

  <p class="rubric">${RUBRICS.stand}</p>

  <div class="sub-heading">Invitation to Prayer</div>
  <p class="prayer-text" style="font-size:8.5pt;"><strong>Priest:</strong> ${escapeHtml(INVITATION_TO_PRAYER.priest)}</p>
  <p class="prayer-text" style="font-size:8.5pt;"><strong>All:</strong> ${escapeHtml(INVITATION_TO_PRAYER.all)}</p>

  <div class="sub-heading">Holy, Holy, Holy</div>
  <p class="music-entry"><em>${escapeHtml(ss.holyHolySetting || 'Mass of St. Theresa')}</em></p>

  <p class="rubric">${RUBRICS.kneel}</p>

  <div class="sub-heading">Mystery of Faith</div>
  <p class="music-entry"><em>${escapeHtml(ss.mysteryOfFaithSetting || 'Mass of St. Theresa')}</em></p>

  <div class="sub-heading">Great Amen</div>

  <div class="page-number">5</div>
</div>

<!-- PAGE 6: COMMUNION RITE -->
<div class="page" id="page-6">
  <div class="section-header">The Communion Rite</div>

  <div class="sub-heading">The Lord's Prayer</div>
  <p class="rubric">${RUBRICS.stand}</p>
  <div class="prayer-text" style="font-size:8.5pt;">${nl2br(LORDS_PRAYER)}</div>

  <div class="sub-heading">Sign of Peace</div>

  <div class="sub-heading">Lamb of God</div>
  <p class="music-entry"><em>${escapeHtml(ss.lambOfGodSetting || 'Mass of St. Theresa')}</em></p>

  <p class="rubric">${RUBRICS.kneel}</p>

  <div class="sub-heading">Communion Hymn</div>
  ${renderMusicSection(d, 'communionHymn', 'communionHymnComposer', 'Communion')}

  <div class="page-number">6</div>
</div>

<!-- PAGE 7: CONCLUDING RITES -->
<div class="page" id="page-7">
  <div class="section-header">The Concluding Rites</div>

  <div class="sub-heading">Hymn of Thanksgiving</div>
  ${renderMusicSection(d, 'hymnOfThanksgiving', 'hymnOfThanksgivingComposer', 'Thanksgiving')}

  <div class="sub-heading">Choral Anthem</div>
  ${renderMusicSection(d, 'choralAnthemConcluding', 'choralAnthemConcludingComposer', 'Anthem')}

  <p class="rubric">${RUBRICS.stand}</p>

  <div class="sub-heading">Blessing &amp; Dismissal</div>
  <p class="prayer-text" style="font-size:8.5pt;"><strong>Priest:</strong> The Lord be with you. <strong>All:</strong> And with your spirit.</p>
  <p class="prayer-text" style="font-size:8.5pt;"><strong>Priest:</strong> May almighty God bless you, the Father, and the Son, &#x2720; and the Holy Spirit. <strong>All:</strong> Amen.</p>
  <p class="prayer-text" style="font-size:8.5pt;"><strong>Deacon:</strong> Go forth, the Mass is ended. <strong>All:</strong> Thanks be to God.</p>

  ${includePostlude ? `
  <div class="sub-heading">Organ Postlude</div>
  ${renderMusicSection(d, 'organPostlude', 'organPostludeComposer', 'Postlude')}
  ` : ''}

  ${d.announcements ? `
  <hr class="divider-rule">
  <div class="sub-heading">Announcements</div>
  <div class="announcement-block">${nl2br(d.announcements)}</div>
  ` : ''}

  <div class="copyright-short">${escapeHtml(copyrightShort)}</div>

  <div class="page-number">7</div>
</div>

<!-- PAGE 8: BACK COVER -->
<div class="page" id="page-8">
  <div class="back-cover">
    <div class="cover-logo" style="margin-top:30pt;">${getLogoSvg()}</div>
    <div style="margin:10pt 0;">
      <div class="cover-feast" style="font-size:13pt;">${escapeHtml(d.feastName)}</div>
      <div class="cover-date" style="font-size:9pt;">${escapeHtml(formatDate(d.liturgicalDate))}</div>
    </div>

    ${d.specialNotes ? `<div style="margin:8pt 0;font-size:8pt;font-style:italic;text-align:center;max-width:4in;">${nl2br(d.specialNotes)}</div>` : ''}

    <div class="copyright-full">${nl2br(copyrightFull)}</div>
  </div>
</div>

</body>
</html>`;

  return { html, warnings };
}

module.exports = { renderBookletHtml, escapeHtml, nl2br, formatDate };
