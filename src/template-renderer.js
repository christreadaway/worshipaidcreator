// Renders worship aid data into an 8-page HTML booklet
'use strict';

const path = require('path');
const fs = require('fs');
const { APOSTLES_CREED, NICENE_CREED } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_STANDARD, LORDS_PRAYER, AGNUS_DEI_TEXT } = require('./assets/text/mass-texts');
const { DEFAULT_COPYRIGHT } = require('./assets/text/copyright');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(str) {
  if (!str) return '';
  return escapeHtml(str).replace(/\n/g, '<br>');
}

function renderImage(imgPath, alt, warnings) {
  if (!imgPath) {
    warnings.push(`Missing image for: ${alt}`);
    return `<div class="notation-placeholder">[NOTATION: ${escapeHtml(alt)}]</div>`;
  }
  // For web frontend, images may be base64 or relative paths
  if (imgPath.startsWith('data:') || imgPath.startsWith('http')) {
    return `<img class="notation-img" src="${imgPath}" alt="${escapeHtml(alt)}">`;
  }
  const absPath = path.resolve(imgPath);
  if (fs.existsSync(absPath)) {
    const ext = path.extname(absPath).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg';
    const data = fs.readFileSync(absPath);
    const b64 = data.toString('base64');
    return `<img class="notation-img" src="data:${mime};base64,${b64}" alt="${escapeHtml(alt)}">`;
  }
  warnings.push(`Image file not found: ${imgPath} (for ${alt})`);
  return `<div class="notation-placeholder">[NOTATION: ${escapeHtml(alt)}]</div>`;
}

function renderPerMassItems(items, massTimes, label) {
  if (!items || items.length === 0) return '';
  // Check if all same
  const allSame = items.length === 1 || items.every(i => i.title === items[0].title);
  if (allSame) {
    const item = items[0];
    return `<p class="music-item"><em>${escapeHtml(item.title)}</em>${item.composer ? ' — ' + escapeHtml(item.composer) : ''}</p>`;
  }
  // Group by title
  let html = '';
  for (const item of items) {
    const timeLabel = item.massTime || '';
    html += `<p class="music-item"><strong>(${escapeHtml(timeLabel)})</strong> <em>${escapeHtml(item.title)}</em>${item.composer ? ' — ' + escapeHtml(item.composer) : ''}</p>`;
  }
  return html;
}

function getLogoSvg() {
  const logoPath = path.join(__dirname, 'assets', 'logo', 'jerusalem-cross.svg');
  if (fs.existsSync(logoPath)) {
    return fs.readFileSync(logoPath, 'utf8');
  }
  return '<div class="logo-placeholder">[LOGO]</div>';
}

function renderBookletHtml(data, options = {}) {
  const warnings = [];
  const compact = data.compact || options.compact || false;
  const fontSize = compact ? '9pt' : '10pt';
  const creedText = data.creedType === 'apostles' ? APOSTLES_CREED : NICENE_CREED;
  const isLenten = data.gospelAcclamation?.lenten || false;
  const acclamationText = isLenten ? GOSPEL_ACCLAMATION_LENTEN : GOSPEL_ACCLAMATION_STANDARD;

  // Check text overflow
  const readingLines = (data.firstReading?.text || '').split('\n').length +
    (data.secondReading?.text || '').split('\n').length +
    (data.gospel?.text || '').split('\n').length;
  if (readingLines > 90) {
    warnings.push(`WARNING: Combined reading text is ${readingLines} lines (>90). Consider using --compact flag.`);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Worship Aid — ${escapeHtml(data.occasionName)} — ${escapeHtml(data.occasionDate)}</title>
<style>
  @page {
    size: 8.5in 11in;
    margin: 0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: ${fontSize};
    line-height: 1.4;
    color: #1a1a1a;
    background: white;
  }
  .page {
    width: 8.5in;
    height: 11in;
    padding: 0.6in 0.75in;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 22pt; text-align: center; margin-bottom: 4pt; color: #8B0000; }
  h2 { font-size: 14pt; color: #8B0000; border-bottom: 1.5pt solid #8B0000; padding-bottom: 3pt; margin: 10pt 0 6pt; }
  h3 { font-size: 11pt; color: #333; margin: 8pt 0 3pt; font-style: italic; }
  .section-title { font-size: 16pt; text-align: center; color: #8B0000; margin: 8pt 0; font-variant: small-caps; letter-spacing: 1pt; }
  .rubric { color: #8B0000; font-style: italic; font-size: 9pt; margin: 4pt 0; }
  .citation { font-weight: bold; color: #333; margin-bottom: 2pt; }
  .reading-text { margin: 4pt 0 8pt; text-align: justify; }
  .response { font-weight: bold; margin: 4pt 0; }
  .music-item { margin: 3pt 0; }
  .notation-img {
    display: block;
    max-width: 6.5in;
    height: auto;
    margin: 6pt auto;
    border: 0.5pt solid #ccc;
  }
  .notation-placeholder {
    display: block;
    max-width: 6.5in;
    min-height: 60px;
    margin: 6pt auto;
    border: 1.5pt dashed #999;
    background: #f9f9f9;
    text-align: center;
    padding: 18pt;
    color: #666;
    font-style: italic;
    font-size: 10pt;
  }
  .cover-logo { text-align: center; margin: 20pt 0 10pt; }
  .cover-logo svg { width: 100px; height: 100px; }
  .cover-occasion { text-align: center; font-size: 26pt; color: #8B0000; margin: 14pt 0 6pt; font-variant: small-caps; }
  .cover-date { text-align: center; font-size: 14pt; color: #555; margin: 4pt 0; }
  .cover-times { text-align: center; font-size: 11pt; color: #555; margin: 8pt 0; }
  .cover-welcome {
    text-align: center; font-size: 11pt; color: #333;
    margin: 24pt auto 0; max-width: 5in; line-height: 1.5;
    font-style: italic;
  }
  .cover-border {
    border: 2pt solid #8B0000;
    padding: 30pt;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .back-cover {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 100%;
  }
  .qr-section { display: flex; justify-content: center; gap: 40pt; margin: 20pt 0; }
  .qr-item { text-align: center; }
  .qr-item img { width: 80px; height: 80px; }
  .qr-placeholder { width: 80px; height: 80px; border: 1pt dashed #999; display: flex; align-items: center; justify-content: center; font-size: 8pt; color: #999; }
  .social-section { text-align: center; margin: 12pt 0; font-size: 10pt; color: #555; }
  .copyright-block { font-size: 7.5pt; color: #777; text-align: center; line-height: 1.3; margin-top: auto; padding-top: 16pt; }
  .prayer-text { margin: 4pt 0; white-space: pre-line; }
  .indent { margin-left: 20pt; }
  .bold { font-weight: bold; }
  .page-number { position: absolute; bottom: 0.4in; left: 0; right: 0; text-align: center; font-size: 8pt; color: #999; }
  .creed-text { white-space: pre-line; margin: 4pt 0; }
  .two-col { column-count: 2; column-gap: 20pt; }
  .announcements { background: #f5f5f5; padding: 8pt 10pt; margin: 6pt 0; border-left: 3pt solid #8B0000; font-size: 9pt; }
</style>
</head>
<body>

<!-- PAGE 1: COVER -->
<div class="page" id="page-1">
  <div class="cover-border">
    <div class="cover-logo">${getLogoSvg()}</div>
    <div class="cover-occasion">${escapeHtml(data.occasionName)}</div>
    <div class="cover-date">${escapeHtml(formatDate(data.occasionDate))}</div>
    <div class="cover-times">${(data.massTimes || []).map(t => escapeHtml(t)).join(' &bull; ')}</div>
    <div class="cover-welcome">
      Welcome to our parish community.<br>
      We are glad you are here to worship with us today.
    </div>
  </div>
</div>

<!-- PAGE 2: INTRODUCTORY RITES -->
<div class="page" id="page-2">
  <div class="section-title">The Introductory Rites</div>

  ${data.organPrelude ? `
  <h3>Organ Prelude</h3>
  <p class="music-item"><em>${escapeHtml(data.organPrelude.title)}</em>${data.organPrelude.composer ? ' — ' + escapeHtml(data.organPrelude.composer) : ''}</p>
  ` : ''}

  <p class="rubric">${RUBRICS.stand}</p>

  <h3>Entrance Antiphon</h3>
  ${data.entranceAntiphon?.citation ? `<p class="citation">${escapeHtml(data.entranceAntiphon.citation)}</p>` : ''}
  ${data.entranceAntiphon?.imagePath ? renderImage(data.entranceAntiphon.imagePath, 'Entrance Antiphon', warnings) : ''}
  ${data.entranceAntiphon?.composerCredit ? `<p style="font-size:8pt;color:#777;text-align:right;">${escapeHtml(data.entranceAntiphon.composerCredit)}</p>` : ''}

  <h3>Penitential Act</h3>
  <div class="prayer-text">${nl2br(data.penitentialAct === 'default' || !data.penitentialAct ? CONFITEOR : data.penitentialAct)}</div>

  <h3>Kyrie</h3>
  ${data.kyrieSettings && data.kyrieSettings.length > 0 ? data.kyrieSettings.map(k => {
    let out = '';
    if (data.kyrieSettings.length > 1 && k.massTime) {
      out += `<p class="music-item"><strong>(${escapeHtml(k.massTime)})</strong> <em>${escapeHtml(k.settingName || '')}</em></p>`;
    } else {
      out += `<p class="music-item"><em>${escapeHtml(k.settingName || '')}</em></p>`;
    }
    if (k.imagePath) out += renderImage(k.imagePath, k.settingName || 'Kyrie', warnings);
    return out;
  }).join('') : '<p class="music-item"><em>Kyrie eleison</em></p>'}

  ${!isLenten && data.gloria !== false ? `
  <h3>Gloria</h3>
  <p class="prayer-text">Glory to God in the highest,<br>and on earth peace to people of good will.</p>
  ` : ''}

  ${data.collect ? `
  <h3>Collect</h3>
  <div class="prayer-text">${nl2br(data.collect)}</div>
  ` : ''}

  <div class="page-number">2</div>
</div>

<!-- PAGE 3: LITURGY OF THE WORD -->
<div class="page" id="page-3">
  <div class="section-title">The Liturgy of the Word</div>

  <p class="rubric">${RUBRICS.sit}</p>

  <h3>First Reading</h3>
  <p class="citation">${escapeHtml(data.firstReading.citation)}</p>
  <div class="reading-text">${nl2br(data.firstReading.text)}</div>

  <h3>Responsorial Psalm</h3>
  <p class="citation">${escapeHtml(data.responsorialPsalm.citation)}</p>
  ${data.responsorialPsalm.response ? `<p class="response">R. ${escapeHtml(data.responsorialPsalm.response)}</p>` : ''}
  ${data.responsorialPsalm.imagePath ? renderImage(data.responsorialPsalm.imagePath, 'Responsorial Psalm', warnings) : ''}
  ${data.responsorialPsalm.verses ? data.responsorialPsalm.verses.map(v => `<p class="reading-text indent">${nl2br(v)}</p>`).join('') : ''}

  ${data.secondReading ? `
  <h3>Second Reading</h3>
  <p class="citation">${escapeHtml(data.secondReading.citation)}</p>
  <div class="reading-text">${nl2br(data.secondReading.text)}</div>
  ` : ''}

  <p class="rubric">${RUBRICS.stand}</p>

  <h3>Gospel Acclamation</h3>
  <p class="response">${escapeHtml(acclamationText)}</p>
  ${data.gospelAcclamation?.verse ? `<p class="reading-text">${nl2br(data.gospelAcclamation.verse)}</p>` : ''}
  ${data.gospelAcclamation?.imagePath ? renderImage(data.gospelAcclamation.imagePath, 'Gospel Acclamation', warnings) : ''}

  <div class="page-number">3</div>
</div>

<!-- PAGE 4: GOSPEL, HOMILY, CREED, INTERCESSIONS -->
<div class="page" id="page-4">
  <h3>Gospel</h3>
  <p class="citation">${escapeHtml(data.gospel.citation)}</p>
  <div class="reading-text">${nl2br(data.gospel.text)}</div>

  <h3>Homily</h3>
  <p class="rubric">${RUBRICS.sit}</p>

  <p class="rubric">${RUBRICS.stand}</p>

  <h3>${data.creedType === 'apostles' ? 'Apostles\' Creed' : 'Nicene Creed'}</h3>
  <div class="creed-text" style="font-size:${compact ? '8pt' : '9pt'}">${nl2br(creedText)}</div>

  <h3>Prayer of the Faithful</h3>
  ${data.prayerOfTheFaithful ? `<div class="reading-text">${nl2br(data.prayerOfTheFaithful)}</div>` : '<p class="rubric"><em>Intentions are read; the assembly responds.</em></p>'}

  ${data.announcements ? `
  <h3>Announcements</h3>
  <div class="announcements">${nl2br(data.announcements)}</div>
  ` : ''}

  <div class="page-number">4</div>
</div>

<!-- PAGE 5: LITURGY OF THE EUCHARIST -->
<div class="page" id="page-5">
  <div class="section-title">The Liturgy of the Eucharist</div>

  <p class="rubric">${RUBRICS.sit}</p>

  <h3>Offertory</h3>
  ${renderPerMassItems(data.offertoryAnthems, data.massTimes, 'Offertory Anthem')}

  <p class="rubric">${RUBRICS.stand}</p>

  <h3>Invitation to Prayer</h3>
  <p class="prayer-text"><strong>Priest:</strong> ${escapeHtml(INVITATION_TO_PRAYER.priest)}</p>
  <p class="prayer-text"><strong>All:</strong> ${escapeHtml(INVITATION_TO_PRAYER.all)}</p>

  <h3>Holy, Holy, Holy</h3>
  ${data.holySanctus?.settingName ? `<p class="music-item"><em>${escapeHtml(data.holySanctus.settingName)}</em></p>` : ''}
  ${data.holySanctus?.imagePath ? renderImage(data.holySanctus.imagePath, data.holySanctus?.settingName || 'Sanctus', warnings) : ''}

  <p class="rubric">${RUBRICS.kneel}</p>

  <h3>Mystery of Faith</h3>
  ${data.mysteryOfFaith?.settingName ? `<p class="music-item"><em>${escapeHtml(data.mysteryOfFaith.settingName)}</em></p>` : ''}
  ${data.mysteryOfFaith?.imagePath ? renderImage(data.mysteryOfFaith.imagePath, data.mysteryOfFaith?.settingName || 'Mystery of Faith', warnings) : ''}

  <div class="page-number">5</div>
</div>

<!-- PAGE 6: COMMUNION RITE -->
<div class="page" id="page-6">
  <div class="section-title">The Communion Rite</div>

  <h3>The Lord's Prayer</h3>
  <p class="rubric">${RUBRICS.stand}</p>
  <div class="prayer-text">${nl2br(LORDS_PRAYER)}</div>

  <h3>Lamb of God</h3>
  ${data.agnus?.settingName ? `<p class="music-item"><em>${escapeHtml(data.agnus.settingName)}</em></p>` : ''}
  ${data.agnus?.imagePath ? renderImage(data.agnus.imagePath, data.agnus?.settingName || 'Agnus Dei', warnings) : ''}

  <p class="rubric">${RUBRICS.kneel}</p>

  <h3>Communion Antiphon</h3>
  ${data.communionAntiphon?.imagePath ? renderImage(data.communionAntiphon.imagePath, 'Communion Antiphon', warnings) : ''}
  ${data.communionAntiphon?.composerCredit ? `<p style="font-size:8pt;color:#777;text-align:right;">${escapeHtml(data.communionAntiphon.composerCredit)}</p>` : ''}

  <h3>Communion Hymn</h3>
  ${renderPerMassItems(data.communionHymns, data.massTimes, 'Communion Hymn')}

  <div class="page-number">6</div>
</div>

<!-- PAGE 7: CONCLUDING RITES -->
<div class="page" id="page-7">
  <div class="section-title">The Concluding Rites</div>

  <h3>Hymn of Thanksgiving</h3>
  ${data.hymnThanksgiving?.title ? `<p class="music-item"><em>${escapeHtml(data.hymnThanksgiving.title)}</em></p>` : ''}
  ${data.hymnThanksgiving?.imagePath ? renderImage(data.hymnThanksgiving.imagePath, data.hymnThanksgiving?.title || 'Thanksgiving Hymn', warnings) : ''}
  ${data.hymnThanksgiving?.yearAStanza ? `<p class="reading-text"><strong>Year A Stanza:</strong><br>${nl2br(data.hymnThanksgiving.yearAStanza)}</p>` : ''}

  <h3>Choral Anthem</h3>
  ${renderPerMassItems(data.choralAnthems, data.massTimes, 'Choral Anthem')}

  <p class="rubric">${RUBRICS.stand}</p>

  ${data.prayerAfterCommunion ? `
  <h3>Prayer after Communion</h3>
  <div class="prayer-text">${nl2br(data.prayerAfterCommunion)}</div>
  ` : ''}

  <h3>Blessing &amp; Dismissal</h3>
  <p class="prayer-text"><strong>Priest:</strong> The Lord be with you.<br><strong>All:</strong> And with your spirit.</p>
  <p class="prayer-text"><strong>Priest:</strong> May almighty God bless you, the Father, and the Son, &#x2720; and the Holy Spirit.<br><strong>All:</strong> Amen.</p>
  <p class="prayer-text"><strong>Deacon:</strong> Go forth, the Mass is ended.<br><strong>All:</strong> Thanks be to God.</p>

  <div class="page-number">7</div>
</div>

<!-- PAGE 8: BACK COVER -->
<div class="page" id="page-8">
  <div class="back-cover">
    <div>
      <div class="cover-logo" style="margin-top:40pt">${getLogoSvg()}</div>
      <div style="text-align:center;margin-top:10pt;">
        <p style="font-size:14pt;color:#8B0000;font-variant:small-caps;">${escapeHtml(data.occasionName)}</p>
        <p style="font-size:10pt;color:#555;">${escapeHtml(formatDate(data.occasionDate))}</p>
      </div>
    </div>

    ${data.qrCodes ? `
    <div class="qr-section">
      ${data.qrCodes.give ? `<div class="qr-item"><div class="qr-placeholder">GIVE</div><p style="font-size:8pt;margin-top:4pt;">Give Online</p></div>` : ''}
      ${data.qrCodes.join ? `<div class="qr-item"><div class="qr-placeholder">JOIN</div><p style="font-size:8pt;margin-top:4pt;">Join Us</p></div>` : ''}
      ${data.qrCodes.bulletin ? `<div class="qr-item"><div class="qr-placeholder">BULLETIN</div><p style="font-size:8pt;margin-top:4pt;">Bulletin</p></div>` : ''}
    </div>
    ` : ''}

    ${data.socialHandles ? `
    <div class="social-section">
      ${data.socialHandles.instagram ? `<span>&#x1F4F7; @${escapeHtml(data.socialHandles.instagram)}</span> &nbsp; ` : ''}
      ${data.socialHandles.facebook ? `<span>&#x1F44D; ${escapeHtml(data.socialHandles.facebook)}</span> &nbsp; ` : ''}
      ${data.socialHandles.youtube ? `<span>&#x25B6; ${escapeHtml(data.socialHandles.youtube)}</span>` : ''}
    </div>
    ` : ''}

    <div class="copyright-block">${nl2br(data.copyrightBlock || DEFAULT_COPYRIGHT)}</div>
  </div>
</div>

</body>
</html>`;

  return { html, warnings };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

module.exports = { renderBookletHtml, escapeHtml, nl2br, formatDate };
