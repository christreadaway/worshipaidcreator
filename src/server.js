// Express web server for Worship Aid Generator
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { validateInput } = require('./validator');
const { generatePdf } = require('./pdf-generator');
const { renderBookletHtml } = require('./template-renderer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/output', express.static(path.join(__dirname, '..', 'output')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// File upload for images
const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

// Serve the main web UI
app.get('/', (req, res) => {
  res.send(getMainPageHtml());
});

// API: Validate input JSON
app.post('/api/validate', (req, res) => {
  const result = validateInput(req.body);
  res.json(result);
});

// API: Generate HTML preview
app.post('/api/preview', (req, res) => {
  const validation = validateInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
  }
  const { html, warnings } = renderBookletHtml(req.body);
  res.json({ html, warnings });
});

// API: Generate PDF and return download link
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const validation = validateInput(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }

    const outputDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const dateSlug = req.body.occasionDate || 'undated';
    const pdfPath = path.join(outputDir, `worship-aid-${dateSlug}.pdf`);
    const result = await generatePdf(req.body, pdfPath, { compact: req.body.compact });

    res.json({
      success: true,
      downloadUrl: `/output/worship-aid-${dateSlug}.pdf`,
      warnings: result.warnings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Download PDF directly
app.post('/api/download-pdf', async (req, res) => {
  try {
    const validation = validateInput(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }

    const outputDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const dateSlug = req.body.occasionDate || 'undated';
    const pdfPath = path.join(outputDir, `worship-aid-${dateSlug}.pdf`);
    await generatePdf(req.body, pdfPath, { compact: req.body.compact });

    res.download(pdfPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Load sample data
app.get('/api/sample', (req, res) => {
  const samplePath = path.join(__dirname, '..', 'sample', 'second-sunday-lent.json');
  const data = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  res.json(data);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Worship Aid Generator`);
  console.log(`  Web UI running at: http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});

function getMainPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Worship Aid Generator</title>
<style>
  :root {
    --primary: #8B0000;
    --primary-light: #a52a2a;
    --bg: #f5f5f0;
    --card-bg: #ffffff;
    --text: #1a1a1a;
    --muted: #666;
    --border: #ddd;
    --success: #2d7d46;
    --error: #c0392b;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  header {
    background: var(--primary);
    color: white;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  header h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
  header .actions { display: flex; gap: 8px; }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
  .btn-primary { background: white; color: var(--primary); }
  .btn-success { background: var(--success); color: white; }
  .btn-outline { background: transparent; color: white; border: 1px solid rgba(255,255,255,0.5); }
  .btn-outline:hover { background: rgba(255,255,255,0.1); }
  .btn-secondary { background: #e0e0e0; color: var(--text); }
  .btn-danger { background: var(--error); color: white; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .layout {
    display: grid;
    grid-template-columns: 420px 1fr;
    height: calc(100vh - 56px);
    overflow: hidden;
  }

  .editor-panel {
    background: var(--card-bg);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 16px;
  }
  .preview-panel {
    overflow-y: auto;
    padding: 20px;
    background: #e8e8e0;
  }

  .form-section {
    margin-bottom: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .form-section-header {
    background: var(--primary);
    color: white;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
  }
  .form-section-header:hover { background: var(--primary-light); }
  .form-section-body { padding: 12px; }
  .form-section-body.collapsed { display: none; }

  .form-group { margin-bottom: 10px; }
  .form-group label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .form-group input, .form-group textarea, .form-group select {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
    transition: border-color 0.15s;
  }
  .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px rgba(139,0,0,0.1);
  }
  .form-group textarea { min-height: 60px; resize: vertical; }

  .per-mass-group {
    background: #f9f9f6;
    border: 1px solid #eee;
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 6px;
  }
  .per-mass-group .form-group { margin-bottom: 6px; }
  .per-mass-group .form-group:last-child { margin-bottom: 0; }

  .add-btn {
    font-size: 12px;
    color: var(--primary);
    background: none;
    border: 1px dashed var(--primary);
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    width: 100%;
  }
  .add-btn:hover { background: rgba(139,0,0,0.05); }
  .remove-btn {
    float: right;
    font-size: 11px;
    color: var(--error);
    background: none;
    border: none;
    cursor: pointer;
  }

  .preview-page {
    background: white;
    width: 8.5in;
    min-height: 11in;
    margin: 0 auto 20px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.12);
    border-radius: 2px;
  }
  .preview-page iframe {
    width: 100%;
    border: none;
    min-height: 88in;
  }

  .status-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--card-bg);
    border-top: 1px solid var(--border);
    padding: 8px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    z-index: 100;
  }
  .status-bar .warnings { color: #e67e22; }
  .status-bar .errors { color: var(--error); }

  .toast {
    position: fixed;
    top: 70px;
    right: 20px;
    padding: 12px 20px;
    border-radius: 8px;
    color: white;
    font-size: 13px;
    z-index: 200;
    animation: slideIn 0.3s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  }
  .toast.success { background: var(--success); }
  .toast.error { background: var(--error); }
  @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .json-mode {
    width: 100%;
    min-height: 400px;
    font-family: 'Menlo', 'Consolas', monospace;
    font-size: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    resize: vertical;
  }
  .tabs { display: flex; border-bottom: 2px solid var(--border); margin-bottom: 12px; }
  .tab {
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    background: none;
    color: var(--muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
  }
  .tab.active { color: var(--primary); border-bottom-color: var(--primary); }
  .checkbox-group { display: flex; align-items: center; gap: 6px; }
  .checkbox-group input { width: auto; }
</style>
</head>
<body>

<header>
  <h1>&#x271E; Worship Aid Generator</h1>
  <div class="actions">
    <button class="btn btn-outline" onclick="loadSample()">Load Sample</button>
    <button class="btn btn-outline" onclick="importJson()">Import JSON</button>
    <button class="btn btn-outline" onclick="exportJson()">Export JSON</button>
    <button class="btn btn-primary" onclick="generatePreview()">Preview</button>
    <button class="btn btn-success" onclick="generatePdf()">Generate PDF</button>
  </div>
</header>

<div class="layout">
  <!-- EDITOR PANEL -->
  <div class="editor-panel" id="editor-panel">
    <div class="tabs">
      <button class="tab active" onclick="switchTab('form')">Form Editor</button>
      <button class="tab" onclick="switchTab('json')">JSON Editor</button>
    </div>

    <div id="form-view">
      <!-- Metadata -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Metadata & Schedule <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div class="form-group">
            <label>Occasion Name</label>
            <input type="text" id="occasionName" placeholder="e.g., Second Sunday of Lent">
          </div>
          <div class="form-group">
            <label>Date</label>
            <input type="date" id="occasionDate">
          </div>
          <div class="form-group">
            <label>Mass Times (comma-separated)</label>
            <input type="text" id="massTimes" placeholder="Sat 5:00 PM, Sun 9:00 AM, Sun 11:00 AM">
          </div>
          <div class="form-group checkbox-group">
            <input type="checkbox" id="compact">
            <label style="margin:0;text-transform:none;font-size:13px;">Compact mode (9pt font)</label>
          </div>
          <div class="form-group checkbox-group">
            <input type="checkbox" id="gloriaCheck" checked>
            <label style="margin:0;text-transform:none;font-size:13px;">Include Gloria</label>
          </div>
        </div>
      </div>

      <!-- Introductory Rites -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Introductory Rites <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div class="form-group">
            <label>Organ Prelude — Title</label>
            <input type="text" id="preludeTitle" placeholder="e.g., O Sacred Head, Now Wounded">
          </div>
          <div class="form-group">
            <label>Organ Prelude — Composer</label>
            <input type="text" id="preludeComposer" placeholder="e.g., J.S. Bach">
          </div>
          <div class="form-group">
            <label>Entrance Antiphon — Citation</label>
            <input type="text" id="entranceCitation" placeholder="e.g., Cf. Ps 27 (26):8-9">
          </div>
          <div class="form-group">
            <label>Entrance Antiphon — Composer Credit</label>
            <input type="text" id="entranceCredit" placeholder="e.g., Setting by Richard Rice">
          </div>
          <div class="form-group">
            <label>Penitential Act</label>
            <select id="penitentialAct">
              <option value="default">Default Confiteor</option>
              <option value="custom">Custom Text</option>
            </select>
          </div>
          <div class="form-group">
            <label>Collect</label>
            <textarea id="collect" rows="3" placeholder="Opening prayer text..."></textarea>
          </div>
          <div id="kyrieContainer">
            <label style="font-size:12px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Kyrie Settings (per Mass)</label>
            <div id="kyrieList"></div>
            <button class="add-btn" onclick="addKyrie()">+ Add Kyrie Setting</button>
          </div>
        </div>
      </div>

      <!-- Liturgy of the Word -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Liturgy of the Word <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div class="form-group">
            <label>First Reading — Citation</label>
            <input type="text" id="firstReadingCitation" placeholder="e.g., Genesis 15:5-12, 17-18">
          </div>
          <div class="form-group">
            <label>First Reading — Text</label>
            <textarea id="firstReadingText" rows="6" placeholder="Full reading text..."></textarea>
          </div>
          <div class="form-group">
            <label>Responsorial Psalm — Citation</label>
            <input type="text" id="psalmCitation" placeholder="e.g., Psalm 27:1, 7-8, 8-9, 13-14">
          </div>
          <div class="form-group">
            <label>Responsorial Psalm — Response</label>
            <input type="text" id="psalmResponse" placeholder="e.g., The Lord is my light and my salvation.">
          </div>
          <div class="form-group">
            <label>Second Reading — Citation</label>
            <input type="text" id="secondReadingCitation" placeholder="e.g., Philippians 3:17—4:1">
          </div>
          <div class="form-group">
            <label>Second Reading — Text</label>
            <textarea id="secondReadingText" rows="6" placeholder="Full reading text..."></textarea>
          </div>
          <div class="form-group checkbox-group">
            <input type="checkbox" id="lentenCheck">
            <label style="margin:0;text-transform:none;font-size:13px;">Lenten Gospel Acclamation (suppress Alleluia)</label>
          </div>
          <div class="form-group">
            <label>Gospel Acclamation — Citation</label>
            <input type="text" id="acclamationCitation" placeholder="e.g., Cf. Mt 17:5">
          </div>
          <div class="form-group">
            <label>Gospel Acclamation — Verse</label>
            <input type="text" id="acclamationVerse">
          </div>
          <div class="form-group">
            <label>Gospel — Citation</label>
            <input type="text" id="gospelCitation" placeholder="e.g., Luke 9:28b-36">
          </div>
          <div class="form-group">
            <label>Gospel — Text</label>
            <textarea id="gospelText" rows="6" placeholder="Full Gospel text..."></textarea>
          </div>
          <div class="form-group">
            <label>Creed Type</label>
            <select id="creedType">
              <option value="nicene">Nicene Creed</option>
              <option value="apostles">Apostles' Creed</option>
            </select>
          </div>
          <div class="form-group">
            <label>Announcements</label>
            <textarea id="announcements" rows="3" placeholder="Parish announcements..."></textarea>
          </div>
        </div>
      </div>

      <!-- Liturgy of the Eucharist -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Liturgy of the Eucharist <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div id="offertoryContainer">
            <label style="font-size:12px;font-weight:600;color:#666;text-transform:uppercase;">Offertory Anthems</label>
            <div id="offertoryList"></div>
            <button class="add-btn" onclick="addPerMassItem('offertory')">+ Add Offertory Anthem</button>
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>Holy, Holy, Holy — Setting Name</label>
            <input type="text" id="sanctusName" placeholder="e.g., Mass of Creation (Haugen)">
          </div>
          <div class="form-group">
            <label>Mystery of Faith — Setting Name</label>
            <input type="text" id="mysteryName" placeholder="e.g., Mass of Creation (Haugen)">
          </div>
          <div class="form-group">
            <label>Mystery of Faith — Option</label>
            <select id="mysteryOption">
              <option value="A">A — We proclaim your Death...</option>
              <option value="B">B — When we eat this Bread...</option>
              <option value="C">C — Save us, Savior of the world...</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Communion Rite -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Communion Rite <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div class="form-group">
            <label>Agnus Dei — Setting Name</label>
            <input type="text" id="agnusName" placeholder="e.g., Mass of Creation (Haugen)">
          </div>
          <div id="communionContainer">
            <label style="font-size:12px;font-weight:600;color:#666;text-transform:uppercase;">Communion Hymns</label>
            <div id="communionList"></div>
            <button class="add-btn" onclick="addPerMassItem('communion')">+ Add Communion Hymn</button>
          </div>
        </div>
      </div>

      <!-- Concluding Rites -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Concluding Rites <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div class="form-group">
            <label>Hymn of Thanksgiving — Title</label>
            <input type="text" id="thanksgivingTitle">
          </div>
          <div class="form-group">
            <label>Year A Stanza (optional)</label>
            <textarea id="yearAStanza" rows="2"></textarea>
          </div>
          <div id="choralContainer">
            <label style="font-size:12px;font-weight:600;color:#666;text-transform:uppercase;">Choral Anthems</label>
            <div id="choralList"></div>
            <button class="add-btn" onclick="addPerMassItem('choral')">+ Add Choral Anthem</button>
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>Prayer after Communion</label>
            <textarea id="prayerAfterCommunion" rows="3"></textarea>
          </div>
        </div>
      </div>

      <!-- Back Cover -->
      <div class="form-section">
        <div class="form-section-header" onclick="toggleSection(this)">
          Back Cover & Branding <span>&#9660;</span>
        </div>
        <div class="form-section-body">
          <div class="form-group">
            <label>Instagram Handle</label>
            <input type="text" id="instagram" placeholder="@yourparish">
          </div>
          <div class="form-group">
            <label>Facebook</label>
            <input type="text" id="facebook">
          </div>
          <div class="form-group">
            <label>YouTube</label>
            <input type="text" id="youtube">
          </div>
          <div class="form-group">
            <label>QR Code — Give URL</label>
            <input type="text" id="qrGive" placeholder="https://...">
          </div>
          <div class="form-group">
            <label>QR Code — Join URL</label>
            <input type="text" id="qrJoin" placeholder="https://...">
          </div>
          <div class="form-group">
            <label>QR Code — Bulletin URL</label>
            <input type="text" id="qrBulletin" placeholder="https://...">
          </div>
          <div class="form-group">
            <label>Copyright Block (optional override)</label>
            <textarea id="copyrightBlock" rows="3" placeholder="Leave blank for default..."></textarea>
          </div>
        </div>
      </div>
    </div>

    <div id="json-view" style="display:none;">
      <textarea class="json-mode" id="jsonEditor" spellcheck="false"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="btn btn-secondary" onclick="syncJsonToForm()">Apply JSON to Form</button>
        <button class="btn btn-secondary" onclick="syncFormToJson()">Refresh from Form</button>
      </div>
    </div>

    <div style="height:60px;"></div>
  </div>

  <!-- PREVIEW PANEL -->
  <div class="preview-panel" id="preview-panel">
    <div id="preview-placeholder" style="text-align:center;padding:80px 20px;color:#999;">
      <div style="font-size:48px;margin-bottom:16px;">&#x271E;</div>
      <h2 style="color:#666;margin-bottom:8px;">Worship Aid Preview</h2>
      <p>Fill in the form on the left, then click <strong>Preview</strong> to see the booklet.</p>
      <p style="margin-top:12px;">Or click <strong>Load Sample</strong> to start with example data.</p>
    </div>
    <div id="preview-content" style="display:none;">
      <div class="preview-page">
        <iframe id="preview-iframe" sandbox="allow-same-origin"></iframe>
      </div>
    </div>
  </div>
</div>

<div class="status-bar" id="status-bar">
  <span id="status-text">Ready</span>
  <span id="status-warnings"></span>
</div>

<script>
// Per-mass item management
const perMassItems = { offertory: [], communion: [], choral: [] };
let kyrieItems = [];

function toggleSection(header) {
  const body = header.nextElementSibling;
  const arrow = header.querySelector('span');
  body.classList.toggle('collapsed');
  arrow.textContent = body.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  if (tab === 'json') {
    document.getElementById('form-view').style.display = 'none';
    document.getElementById('json-view').style.display = 'block';
    document.querySelectorAll('.tab')[1].classList.add('active');
    syncFormToJson();
  } else {
    document.getElementById('form-view').style.display = 'block';
    document.getElementById('json-view').style.display = 'none';
    document.querySelectorAll('.tab')[0].classList.add('active');
  }
}

function val(id) { return document.getElementById(id)?.value?.trim() || ''; }
function checked(id) { return document.getElementById(id)?.checked || false; }

function buildData() {
  const data = {
    occasionName: val('occasionName'),
    occasionDate: val('occasionDate'),
    massTimes: val('massTimes').split(',').map(s => s.trim()).filter(Boolean),
    compact: checked('compact'),
    gloria: checked('gloriaCheck'),
    creedType: val('creedType'),
  };

  if (val('preludeTitle')) data.organPrelude = { title: val('preludeTitle'), composer: val('preludeComposer') };
  if (val('entranceCitation') || val('entranceCredit')) {
    data.entranceAntiphon = { citation: val('entranceCitation'), composerCredit: val('entranceCredit') };
  }
  data.penitentialAct = val('penitentialAct');
  if (val('collect')) data.collect = val('collect');

  if (kyrieItems.length > 0) data.kyrieSettings = [...kyrieItems];

  data.firstReading = { citation: val('firstReadingCitation'), text: val('firstReadingText') };
  data.responsorialPsalm = { citation: val('psalmCitation'), response: val('psalmResponse') };

  if (val('secondReadingCitation') || val('secondReadingText')) {
    data.secondReading = { citation: val('secondReadingCitation'), text: val('secondReadingText') };
  }

  data.gospelAcclamation = {
    citation: val('acclamationCitation'),
    verse: val('acclamationVerse'),
    lenten: checked('lentenCheck')
  };

  data.gospel = { citation: val('gospelCitation'), text: val('gospelText') };
  if (val('announcements')) data.announcements = val('announcements');

  if (perMassItems.offertory.length) data.offertoryAnthems = [...perMassItems.offertory];
  if (val('sanctusName')) data.holySanctus = { settingName: val('sanctusName') };
  if (val('mysteryName')) data.mysteryOfFaith = { settingName: val('mysteryName'), option: val('mysteryOption') };
  if (val('agnusName')) data.agnus = { settingName: val('agnusName') };
  if (perMassItems.communion.length) data.communionHymns = [...perMassItems.communion];

  if (val('thanksgivingTitle')) {
    data.hymnThanksgiving = { title: val('thanksgivingTitle') };
    if (val('yearAStanza')) data.hymnThanksgiving.yearAStanza = val('yearAStanza');
  }
  if (perMassItems.choral.length) data.choralAnthems = [...perMassItems.choral];
  if (val('prayerAfterCommunion')) data.prayerAfterCommunion = val('prayerAfterCommunion');

  const social = {};
  if (val('instagram')) social.instagram = val('instagram');
  if (val('facebook')) social.facebook = val('facebook');
  if (val('youtube')) social.youtube = val('youtube');
  if (Object.keys(social).length) data.socialHandles = social;

  const qr = {};
  if (val('qrGive')) qr.give = val('qrGive');
  if (val('qrJoin')) qr.join = val('qrJoin');
  if (val('qrBulletin')) qr.bulletin = val('qrBulletin');
  if (Object.keys(qr).length) data.qrCodes = qr;

  if (val('copyrightBlock')) data.copyrightBlock = val('copyrightBlock');

  return data;
}

function populateForm(data) {
  document.getElementById('occasionName').value = data.occasionName || '';
  document.getElementById('occasionDate').value = data.occasionDate || '';
  document.getElementById('massTimes').value = (data.massTimes || []).join(', ');
  document.getElementById('compact').checked = data.compact || false;
  document.getElementById('gloriaCheck').checked = data.gloria !== false;
  document.getElementById('creedType').value = data.creedType || 'nicene';

  document.getElementById('preludeTitle').value = data.organPrelude?.title || '';
  document.getElementById('preludeComposer').value = data.organPrelude?.composer || '';
  document.getElementById('entranceCitation').value = data.entranceAntiphon?.citation || '';
  document.getElementById('entranceCredit').value = data.entranceAntiphon?.composerCredit || '';
  document.getElementById('penitentialAct').value = data.penitentialAct || 'default';
  document.getElementById('collect').value = data.collect || '';

  kyrieItems = data.kyrieSettings || [];
  renderKyrieList();

  document.getElementById('firstReadingCitation').value = data.firstReading?.citation || '';
  document.getElementById('firstReadingText').value = data.firstReading?.text || '';
  document.getElementById('psalmCitation').value = data.responsorialPsalm?.citation || '';
  document.getElementById('psalmResponse').value = data.responsorialPsalm?.response || '';
  document.getElementById('secondReadingCitation').value = data.secondReading?.citation || '';
  document.getElementById('secondReadingText').value = data.secondReading?.text || '';
  document.getElementById('lentenCheck').checked = data.gospelAcclamation?.lenten || false;
  document.getElementById('acclamationCitation').value = data.gospelAcclamation?.citation || '';
  document.getElementById('acclamationVerse').value = data.gospelAcclamation?.verse || '';
  document.getElementById('gospelCitation').value = data.gospel?.citation || '';
  document.getElementById('gospelText').value = data.gospel?.text || '';
  document.getElementById('announcements').value = data.announcements || '';

  perMassItems.offertory = data.offertoryAnthems || [];
  perMassItems.communion = data.communionHymns || [];
  perMassItems.choral = data.choralAnthems || [];
  renderPerMassList('offertory');
  renderPerMassList('communion');
  renderPerMassList('choral');

  document.getElementById('sanctusName').value = data.holySanctus?.settingName || '';
  document.getElementById('mysteryName').value = data.mysteryOfFaith?.settingName || '';
  document.getElementById('mysteryOption').value = data.mysteryOfFaith?.option || 'A';
  document.getElementById('agnusName').value = data.agnus?.settingName || '';

  document.getElementById('thanksgivingTitle').value = data.hymnThanksgiving?.title || '';
  document.getElementById('yearAStanza').value = data.hymnThanksgiving?.yearAStanza || '';
  document.getElementById('prayerAfterCommunion').value = data.prayerAfterCommunion || '';

  document.getElementById('instagram').value = data.socialHandles?.instagram || '';
  document.getElementById('facebook').value = data.socialHandles?.facebook || '';
  document.getElementById('youtube').value = data.socialHandles?.youtube || '';
  document.getElementById('qrGive').value = data.qrCodes?.give || '';
  document.getElementById('qrJoin').value = data.qrCodes?.join || '';
  document.getElementById('qrBulletin').value = data.qrCodes?.bulletin || '';
  document.getElementById('copyrightBlock').value = data.copyrightBlock || '';
}

function addKyrie() {
  kyrieItems.push({ massTime: '', settingName: '' });
  renderKyrieList();
}
function removeKyrie(i) {
  kyrieItems.splice(i, 1);
  renderKyrieList();
}
function renderKyrieList() {
  const container = document.getElementById('kyrieList');
  container.innerHTML = kyrieItems.map((k, i) => \`
    <div class="per-mass-group">
      <button class="remove-btn" onclick="removeKyrie(\${i})">Remove</button>
      <div class="form-group">
        <label>Mass Time</label>
        <input type="text" value="\${k.massTime || ''}" onchange="kyrieItems[\${i}].massTime=this.value">
      </div>
      <div class="form-group">
        <label>Setting Name</label>
        <input type="text" value="\${k.settingName || ''}" onchange="kyrieItems[\${i}].settingName=this.value">
      </div>
    </div>
  \`).join('');
}

function addPerMassItem(type) {
  perMassItems[type].push({ massTime: '', title: '', composer: '' });
  renderPerMassList(type);
}
function removePerMassItem(type, i) {
  perMassItems[type].splice(i, 1);
  renderPerMassList(type);
}
function renderPerMassList(type) {
  const container = document.getElementById(type + 'List');
  container.innerHTML = perMassItems[type].map((item, i) => \`
    <div class="per-mass-group">
      <button class="remove-btn" onclick="removePerMassItem('\${type}',\${i})">Remove</button>
      <div class="form-group">
        <label>Mass Time</label>
        <input type="text" value="\${item.massTime || ''}" onchange="perMassItems['\${type}'][\${i}].massTime=this.value">
      </div>
      <div class="form-group">
        <label>Title</label>
        <input type="text" value="\${item.title || ''}" onchange="perMassItems['\${type}'][\${i}].title=this.value">
      </div>
      <div class="form-group">
        <label>Composer</label>
        <input type="text" value="\${item.composer || ''}" onchange="perMassItems['\${type}'][\${i}].composer=this.value">
      </div>
    </div>
  \`).join('');
}

function syncFormToJson() {
  document.getElementById('jsonEditor').value = JSON.stringify(buildData(), null, 2);
}
function syncJsonToForm() {
  try {
    const data = JSON.parse(document.getElementById('jsonEditor').value);
    populateForm(data);
    showToast('JSON applied to form', 'success');
  } catch (e) {
    showToast('Invalid JSON: ' + e.message, 'error');
  }
}

async function loadSample() {
  try {
    const res = await fetch('/api/sample');
    const data = await res.json();
    populateForm(data);
    showToast('Sample data loaded', 'success');
    setStatus('Sample data loaded — click Preview to see the booklet');
  } catch (e) {
    showToast('Failed to load sample: ' + e.message, 'error');
  }
}

function importJson() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      populateForm(data);
      showToast('JSON imported', 'success');
    } catch (err) {
      showToast('Invalid JSON file: ' + err.message, 'error');
    }
  };
  input.click();
}

function exportJson() {
  const data = buildData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = \`worship-aid-\${data.occasionDate || 'draft'}.json\`;
  a.click();
  URL.revokeObjectURL(url);
}

async function generatePreview() {
  setStatus('Generating preview...');
  const data = buildData();
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    if (!res.ok) {
      showToast('Validation error: ' + (result.errors || []).join(', '), 'error');
      setStatus('Preview failed — check validation errors');
      return;
    }
    document.getElementById('preview-placeholder').style.display = 'none';
    document.getElementById('preview-content').style.display = 'block';
    const iframe = document.getElementById('preview-iframe');
    iframe.srcdoc = result.html;
    iframe.onload = () => {
      iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px';
    };
    const warnText = result.warnings.length > 0 ? result.warnings.length + ' warning(s)' : '';
    setStatus('Preview generated', warnText);
    if (result.warnings.length) {
      showToast(result.warnings.length + ' warning(s) — check status bar', 'error');
    }
  } catch (e) {
    showToast('Preview error: ' + e.message, 'error');
    setStatus('Preview failed');
  }
}

async function generatePdf() {
  setStatus('Generating PDF...');
  const data = buildData();
  try {
    const res = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    if (!res.ok) {
      showToast('Error: ' + (result.error || result.errors?.join(', ')), 'error');
      setStatus('PDF generation failed');
      return;
    }
    // Trigger download
    const a = document.createElement('a');
    a.href = result.downloadUrl;
    a.download = '';
    a.click();
    const warnText = result.warnings.length > 0 ? result.warnings.length + ' warning(s)' : '';
    setStatus('PDF generated — downloading', warnText);
    showToast('PDF generated successfully!', 'success');
  } catch (e) {
    showToast('PDF error: ' + e.message, 'error');
    setStatus('PDF generation failed');
  }
}

function setStatus(text, warnings) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-warnings').innerHTML = warnings ? '<span class="warnings">' + warnings + '</span>' : '';
}

function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
</script>

</body>
</html>`;
}

module.exports = app;
