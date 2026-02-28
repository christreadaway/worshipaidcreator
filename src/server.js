// Express web server — Worship Aid Generator
// Multi-user workflow with role-based access per St. Theresa worksheet
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { validateInput, detectOverflows } = require('./validator');
const { generatePdf, buildFilename } = require('./pdf-generator');
const { renderBookletHtml } = require('./template-renderer');
const { getSeasonDefaults, SEASONS, LENTEN_ACCLAMATION_OPTIONS } = require('./config/seasons');
const store = require('./store/file-store');
const userStore = require('./store/user-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directories exist
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const NOTATION_DIR = path.join(UPLOADS_DIR, 'notation');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
[NOTATION_DIR, COVERS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// Multer config for image uploads
const notationUpload = multer({
  storage: multer.diskStorage({
    destination: NOTATION_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const coverUpload = multer({
  storage: multer.diskStorage({
    destination: COVERS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `cover-${Date.now()}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/exports', express.static(store.getExportsDir()));
app.use('/uploads', express.static(UPLOADS_DIR));

// Seed default users on first run
userStore.seedDefaultUsers();

// --- AUTH MIDDLEWARE ---
function getSessionToken(req) {
  return req.headers['x-session-token'] || req.query.token || null;
}

function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  const user = userStore.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!userStore.hasPermission(req.user, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// --- AUTH ROUTES ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = userStore.authenticateUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const token = userStore.createSession(user.id);
  res.json({ token, user });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) userStore.destroySession(token);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = getSessionToken(req);
  const user = userStore.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(user);
});

// --- USER MANAGEMENT (admin only) ---
app.get('/api/users', requireAuth, requirePermission('manage_users'), (req, res) => {
  res.json(userStore.listUsers());
});

app.post('/api/users', requireAuth, requirePermission('manage_users'), (req, res) => {
  try {
    const user = userStore.createUser(req.body);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:id', requireAuth, requirePermission('manage_users'), (req, res) => {
  const user = userStore.updateUser(req.params.id, req.body);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.delete('/api/users/:id', requireAuth, requirePermission('manage_users'), (req, res) => {
  userStore.deleteUser(req.params.id);
  res.json({ success: true });
});

// --- API ROUTES ---

// Season defaults
app.get('/api/season-defaults/:season', (req, res) => {
  const defaults = getSeasonDefaults(req.params.season);
  res.json(defaults);
});

// Lenten acclamation options
app.get('/api/lenten-acclamations', (req, res) => {
  res.json(LENTEN_ACCLAMATION_OPTIONS);
});

// Validate
app.post('/api/validate', (req, res) => {
  const result = validateInput(req.body);
  const overflows = detectOverflows(req.body);
  res.json({ ...result, overflows });
});

// Preview HTML
app.post('/api/preview', (req, res) => {
  const settings = store.loadSettings();
  const { html, warnings } = renderBookletHtml(req.body, { parishSettings: settings });
  const overflows = detectOverflows(req.body);
  res.json({ html, warnings, overflows });
});

// Generate PDF
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const settings = store.loadSettings();

    // Enforce pastor approval if enabled in settings
    if (settings.requirePastorApproval && req.body.id) {
      const draft = store.loadDraft(req.body.id);
      if (draft && draft.status !== 'approved') {
        return res.status(403).json({ error: 'Pastor approval required before export. Current status: ' + (draft.status || 'draft') });
      }
    }

    const filename = buildFilename(req.body);
    const outputPath = path.join(store.getExportsDir(), filename);
    const result = await generatePdf(req.body, outputPath, { parishSettings: settings });

    // Mark draft as exported if it has an id
    if (req.body.id) {
      const draft = store.loadDraft(req.body.id);
      if (draft) {
        draft.status = 'exported';
        draft.exportedAt = new Date().toISOString();
        store.saveDraft(draft);
      }
    }

    res.json({
      success: true,
      filename,
      downloadUrl: `/exports/${filename}`,
      warnings: result.warnings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- IMAGE UPLOADS ---
app.post('/api/upload/notation', requireAuth, requirePermission('upload_images'), notationUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    filename: req.file.filename,
    url: `/uploads/notation/${req.file.filename}`,
    originalName: req.file.originalname
  });
});

app.post('/api/upload/cover', requireAuth, requirePermission('edit_cover'), coverUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    filename: req.file.filename,
    url: `/uploads/covers/${req.file.filename}`,
    originalName: req.file.originalname
  });
});

app.get('/api/uploads/notation', (req, res) => {
  const files = fs.readdirSync(NOTATION_DIR).filter(f => !f.startsWith('.')).map(f => ({
    filename: f,
    url: `/uploads/notation/${f}`
  }));
  res.json(files);
});

app.get('/api/uploads/covers', (req, res) => {
  const files = fs.readdirSync(COVERS_DIR).filter(f => !f.startsWith('.')).map(f => ({
    filename: f,
    url: `/uploads/covers/${f}`
  }));
  res.json(files);
});

// --- DRAFTS ---
app.post('/api/drafts', (req, res) => {
  const draft = store.saveDraft(req.body);
  res.json(draft);
});

app.get('/api/drafts', (req, res) => {
  res.json(store.listDrafts());
});

app.get('/api/drafts/:id', (req, res) => {
  const draft = store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

app.delete('/api/drafts/:id', (req, res) => {
  store.deleteDraft(req.params.id);
  res.json({ success: true });
});

app.post('/api/drafts/:id/duplicate', (req, res) => {
  const copy = store.duplicateDraft(req.params.id);
  if (!copy) return res.status(404).json({ error: 'Draft not found' });
  res.json(copy);
});

// --- APPROVAL WORKFLOW ---
app.post('/api/drafts/:id/submit-for-review', requireAuth, (req, res) => {
  const draft = store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  draft.status = 'review';
  draft.submittedBy = req.user.displayName;
  draft.submittedAt = new Date().toISOString();
  store.saveDraft(draft);
  res.json(draft);
});

app.post('/api/drafts/:id/approve', requireAuth, requirePermission('approve'), (req, res) => {
  const draft = store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  draft.status = 'approved';
  draft.approvedBy = req.user.displayName;
  draft.approvedAt = new Date().toISOString();
  store.saveDraft(draft);
  res.json(draft);
});

app.post('/api/drafts/:id/request-changes', requireAuth, requirePermission('approve'), (req, res) => {
  const draft = store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  draft.status = 'draft';
  draft.changeRequestedBy = req.user.displayName;
  draft.changeRequestedAt = new Date().toISOString();
  draft.changeNote = (req.body && req.body.note) || '';
  delete draft.approvedBy;
  delete draft.approvedAt;
  store.saveDraft(draft);
  res.json(draft);
});

// --- SETTINGS ---
app.get('/api/settings', (req, res) => {
  res.json(store.loadSettings());
});

app.put('/api/settings', (req, res) => {
  const settings = store.saveSettings(req.body);
  res.json(settings);
});

// --- SAMPLE ---
app.get('/api/sample', (req, res) => {
  const samplePath = path.join(__dirname, '..', 'sample', 'second-sunday-lent.json');
  if (fs.existsSync(samplePath)) {
    const data = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    return res.json(data);
  }
  res.status(404).json({ error: 'Sample not found' });
});

// --- MAIN UI ---
app.get('/', (req, res) => res.send(getAppHtml()));
app.get('/login', (req, res) => res.send(getAppHtml()));
app.get('/admin', (req, res) => res.send(getAppHtml()));
app.get('/history', (req, res) => res.send(getAppHtml()));
app.get('/users', (req, res) => res.send(getAppHtml()));

// Only start listening when run directly (not when imported for testing)
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Worship Aid Generator`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop.\n`);
    console.log(`  Default users: jd/worship2026, morris/music2026, vincent/music2026, frlarry/pastor2026, kari/staff2026, donna/staff2026\n`);
  });
}

// =====================================================================
// FULL SPA HTML — Login + Role-based Editor + Live Preview + History + Admin + User Management
// =====================================================================
function getAppHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Worship Aid Generator</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=Cinzel:wght@400;600&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --navy: #1A2E4A; --burgundy: #6B1A1A; --gold: #B8922A; --gold-light: #D4AF5A;
  --cream: #FAF7F2; --parchment: #F2EBD9; --dark: #1C1C1C; --gray: #5A5A5A;
  --border: #E0D5C0; --success: #2d7d46; --error: #c0392b; --white: #fff;
  --purple: #5b3d8f;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, sans-serif; background: var(--cream); color: var(--dark); font-size: 13px; }

/* NAV */
nav { background: var(--navy); padding: 0 20px; display: flex; align-items: center; height: 50px; gap: 24px; }
nav .brand { font-family: 'Cinzel', serif; font-size: 15px; color: var(--gold-light); letter-spacing: 1px; font-weight: 600; }
nav a { color: rgba(255,255,255,0.7); text-decoration: none; font-size: 12px; font-weight: 500; letter-spacing: 0.5px; padding: 4px 0; border-bottom: 2px solid transparent; transition: all 0.15s; }
nav a:hover, nav a.active { color: #fff; border-bottom-color: var(--gold); }
nav .spacer { flex: 1; }
nav .user-info { color: rgba(255,255,255,0.6); font-size: 11px; }
nav .user-info strong { color: var(--gold-light); }
.btn { padding: 6px 14px; border: none; border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 5px; }
.btn:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
.btn-gold { background: var(--gold); color: var(--white); }
.btn-navy { background: var(--navy); color: var(--white); }
.btn-outline { background: transparent; border: 1px solid var(--border); color: var(--gray); }
.btn-sm { padding: 4px 10px; font-size: 11px; }
.btn-danger { background: var(--error); color: var(--white); }

/* LOGIN */
.login-view { max-width: 360px; margin: 80px auto; padding: 30px; background: white; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center; }
.login-view h2 { font-family: 'Cinzel', serif; color: var(--navy); margin-bottom: 4px; }
.login-view .subtitle { font-size: 11px; color: var(--gray); margin-bottom: 20px; }
.login-view .fg { margin-bottom: 12px; text-align: left; }
.login-view .fg label { display: block; font-size: 10px; font-weight: 600; color: var(--gray); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
.login-view .fg input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; }
.login-error { color: var(--error); font-size: 12px; margin-bottom: 8px; display: none; }

/* LAYOUT */
.app { display: grid; grid-template-columns: 380px 1fr; height: calc(100vh - 50px); }
.editor { background: var(--white); border-right: 1px solid var(--border); overflow-y: auto; padding: 14px; }
.preview-area { overflow-y: auto; padding: 16px; background: #e8e4da; }

/* Role indicator */
.role-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.role-badge.admin { background: #e8d5f5; color: var(--purple); }
.role-badge.music_director { background: #d5e8f5; color: #2a5e8a; }
.role-badge.pastor { background: #f5e8d5; color: #8a5e2a; }
.role-badge.staff { background: #d5f5e8; color: #2a8a5e; }

/* Section permissions indicator */
.section-lock { color: var(--gray); font-size: 9px; font-style: italic; margin-bottom: 6px; }

/* FORM */
.form-section { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px; overflow: hidden; }
.form-section-hdr { background: var(--navy); color: var(--gold-light); padding: 7px 10px; font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.form-section-hdr:hover { background: #243a5a; }
.form-section-body { padding: 10px; }
.form-section-body.collapsed { display: none; }
.form-section.disabled { opacity: 0.5; pointer-events: none; }
.fg { margin-bottom: 8px; }
.fg label { display: block; font-size: 10px; font-weight: 600; color: var(--gray); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
.fg input, .fg textarea, .fg select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 3px; font-size: 12px; font-family: inherit; }
.fg input:focus, .fg textarea:focus, .fg select:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 2px rgba(184,146,42,0.15); }
.fg textarea { min-height: 50px; resize: vertical; }
.fg-check { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.fg-check input { width: auto; }
.fg-check label { margin: 0; text-transform: none; font-size: 12px; }
.fg-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

/* Music block per mass time */
.mass-time-block { background: var(--parchment); border: 1px solid var(--border); border-radius: 4px; padding: 8px; margin-bottom: 8px; }
.mass-time-block h4 { font-family: 'Cinzel', serif; font-size: 9px; color: var(--burgundy); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }

/* Preview */
.preview-frame { background: white; width: 5.5in; margin: 0 auto 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); border-radius: 2px; }
.preview-frame iframe { width: 100%; border: none; min-height: 68in; }

/* Status */
.status { position: fixed; bottom: 0; left: 0; right: 0; background: var(--white); border-top: 1px solid var(--border); padding: 6px 16px; display: flex; justify-content: space-between; font-size: 11px; color: var(--gray); z-index: 100; }
.status .warn { color: #e67e22; } .status .err { color: var(--error); }

/* Toast */
.toast { position: fixed; top: 60px; right: 16px; padding: 10px 18px; border-radius: 6px; color: white; font-size: 12px; z-index: 200; animation: slideIn 0.25s ease; box-shadow: 0 3px 10px rgba(0,0,0,0.2); }
.toast.success { background: var(--success); } .toast.error { background: var(--error); }
@keyframes slideIn { from { transform: translateX(80px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* History page */
.history-view { max-width: 800px; margin: 30px auto; padding: 0 20px; }
.history-view h2 { font-family: 'Cinzel', serif; color: var(--navy); margin-bottom: 16px; }
.draft-card { background: white; border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
.draft-card .info { flex: 1; }
.draft-card .info h3 { font-size: 14px; margin-bottom: 2px; } .draft-card .info p { font-size: 11px; color: var(--gray); }
.draft-card .actions { display: flex; gap: 6px; }
.status-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 500; }
.status-badge.draft { background: #fef3cd; color: #856404; }
.status-badge.review { background: #cce5ff; color: #004085; }
.status-badge.approved { background: #d1ecf1; color: #0c5460; }
.status-badge.exported { background: #d4edda; color: #155724; }

/* Admin page */
.admin-view { max-width: 600px; margin: 30px auto; padding: 0 20px; }
.admin-view h2 { font-family: 'Cinzel', serif; color: var(--navy); margin-bottom: 16px; }

/* Users page */
.users-view { max-width: 700px; margin: 30px auto; padding: 0 20px; }
.users-view h2 { font-family: 'Cinzel', serif; color: var(--navy); margin-bottom: 16px; }
.user-card { background: white; border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
.user-card .info { flex: 1; }
.user-card .info h3 { font-size: 14px; margin-bottom: 2px; }
.user-card .info p { font-size: 11px; color: var(--gray); }

/* Overflow indicator */
.overflow-indicator { background: #fdeaea; border: 1px solid var(--error); border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; font-size: 11px; color: var(--error); }
.page-placeholder { text-align: center; padding: 60px 20px; color: var(--gray); }
.page-placeholder h2 { color: var(--navy); font-family: 'Cinzel', serif; margin-bottom: 8px; }

/* Image upload */
.upload-area { border: 2px dashed var(--border); border-radius: 6px; padding: 12px; text-align: center; cursor: pointer; transition: all 0.15s; margin-bottom: 8px; }
.upload-area:hover { border-color: var(--gold); background: #faf8f0; }
.upload-area input[type="file"] { display: none; }
.image-preview { max-width: 100%; max-height: 80px; margin-top: 6px; border: 1px solid var(--border); border-radius: 3px; }
</style>
</head>
<body>

<!-- LOGIN PAGE -->
<div id="page-login" style="display:none;">
  <div style="text-align:center;padding-top:40px;">
    <span style="font-size:36px;">&#x271E;</span>
  </div>
  <div class="login-view">
    <h2>Worship Aid Generator</h2>
    <p class="subtitle">Sign in to contribute</p>
    <div id="login-error" class="login-error"></div>
    <div class="fg"><label>Username</label><input type="text" id="login-username" placeholder="e.g., jd, morris, frlarry"></div>
    <div class="fg"><label>Password</label><input type="password" id="login-password" placeholder="Password"></div>
    <button class="btn btn-gold" style="width:100%;justify-content:center;margin-top:8px;" onclick="doLogin()">Sign In</button>
  </div>
</div>

<nav id="main-nav" style="display:none;">
  <span class="brand">&#x271E; Worship Aid Generator</span>
  <a href="/" class="nav-link active" data-page="editor">Editor</a>
  <a href="/history" class="nav-link" data-page="history">History</a>
  <a href="/admin" class="nav-link" data-page="admin" id="nav-admin">Settings</a>
  <a href="/users" class="nav-link" data-page="users" id="nav-users" style="display:none;">Users</a>
  <span class="spacer"></span>
  <span class="user-info" id="user-display"></span>
  <button class="btn btn-outline btn-sm" onclick="loadSample()">Load Sample</button>
  <button class="btn btn-outline btn-sm" onclick="saveDraft()">Save Draft</button>
  <button class="btn btn-gold btn-sm" onclick="generatePreview()">Preview</button>
  <button class="btn btn-navy btn-sm" id="btn-export" onclick="generatePdfExport()">Export PDF</button>
  <button class="btn btn-outline btn-sm" onclick="doLogout()" style="color:rgba(255,255,255,0.5);">Logout</button>
</nav>

<!-- EDITOR PAGE -->
<div class="app" id="page-editor" style="display:none;">
  <div class="editor" id="editor">

    <!-- LITURGICAL DATE -->
    <div class="form-section">
      <div class="form-section-hdr" onclick="toggle(this)">Liturgical Date &amp; Season <span>&#9660;</span></div>
      <div class="form-section-body">
        <div class="fg"><label>Feast / Sunday Name</label><input type="text" id="feastName" placeholder="e.g., Second Sunday of Lent"></div>
        <div class="fg-row">
          <div class="fg"><label>Date</label><input type="date" id="liturgicalDate"></div>
          <div class="fg"><label>Liturgical Season</label>
            <select id="liturgicalSeason" onchange="onSeasonChange()">
              <option value="ordinary">Ordinary Time</option>
              <option value="advent">Advent</option>
              <option value="christmas">Christmas</option>
              <option value="lent">Lent</option>
              <option value="easter">Easter</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- SEASONAL OVERRIDES -->
    <div class="form-section" id="section-seasonal">
      <div class="form-section-hdr" onclick="toggle(this)">Seasonal Settings <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock" id="seasonal-lock-note">These are seasonally static and usually locked for several weeks.</p>
        <div class="fg-check"><input type="checkbox" id="gloria"><label for="gloria">Include Gloria</label></div>
        <div class="fg-row">
          <div class="fg"><label>Creed</label><select id="creedType"><option value="nicene">Nicene Creed</option><option value="apostles">Apostles' Creed</option></select></div>
          <div class="fg"><label>Entrance Type</label><select id="entranceType"><option value="processional">Processional Hymn</option><option value="antiphon">Entrance Antiphon</option></select></div>
        </div>
        <div class="fg"><label>Holy Holy Setting</label><input type="text" id="holyHolySetting" placeholder="e.g., Mass of St. Theresa"></div>
        <div class="fg"><label>Mystery of Faith Setting</label><input type="text" id="mysteryOfFaithSetting"></div>
        <div class="fg"><label>Lamb of God Setting</label><input type="text" id="lambOfGodSetting"></div>
        <div class="fg"><label>Penitential Act</label><select id="penitentialAct"><option value="confiteor">Confiteor (I confess)</option><option value="kyrie_only">Kyrie Only</option></select></div>
        <div class="fg-check"><input type="checkbox" id="includePostlude"><label for="includePostlude">Include Organ Postlude</label></div>
        <div class="fg-check"><input type="checkbox" id="adventWreath"><label for="adventWreath">Lighting of the Advent Wreath</label></div>
        <div class="fg" id="lentenAcclamationGroup" style="display:none;">
          <label>Lenten Gospel Acclamation</label>
          <select id="lentenAcclamation">
            <option value="standard">Praise to you, Lord Jesus Christ, King of endless glory!</option>
            <option value="alternate">Glory and praise to you, Lord Jesus Christ!</option>
          </select>
        </div>
      </div>
    </div>

    <!-- READINGS -->
    <div class="form-section" id="section-readings">
      <div class="form-section-hdr" onclick="toggle(this)">Readings <span>&#9660;</span></div>
      <div class="form-section-body">
        <div class="fg"><label>First Reading — Citation</label><input type="text" id="firstReadingCitation" placeholder="e.g., Genesis 15:5-12, 17-18"></div>
        <div class="fg"><label>First Reading — Text</label><textarea id="firstReadingText" rows="5"></textarea></div>
        <div class="fg"><label>Responsorial Psalm — Citation</label><input type="text" id="psalmCitation"></div>
        <div class="fg"><label>Psalm Refrain</label><input type="text" id="psalmRefrain" placeholder="e.g., The Lord is my light and my salvation."></div>
        <div class="fg"><label>Psalm Verses (separate stanzas with blank lines)</label><textarea id="psalmVerses" rows="4"></textarea></div>
        <div class="fg-check"><input type="checkbox" id="noSecondReading"><label for="noSecondReading">No Second Reading (some feasts)</label></div>
        <div class="fg"><label>Second Reading — Citation</label><input type="text" id="secondReadingCitation"></div>
        <div class="fg"><label>Second Reading — Text</label><textarea id="secondReadingText" rows="5"></textarea></div>
        <div class="fg"><label>Gospel Acclamation — Reference</label><input type="text" id="gospelAcclamationReference" placeholder="e.g., Cf. Mt 17:5"></div>
        <div class="fg"><label>Gospel Acclamation — Verse</label><input type="text" id="gospelAcclamationVerse"></div>
        <div class="fg"><label>Gospel — Citation</label><input type="text" id="gospelCitation" placeholder="e.g., Luke 9:28b-36"></div>
        <div class="fg"><label>Gospel — Text</label><textarea id="gospelText" rows="6"></textarea></div>
      </div>
    </div>

    <!-- MUSIC: SAT 5PM -->
    <div class="form-section" id="section-music-sat5pm">
      <div class="form-section-hdr" onclick="toggle(this)">Music — Sat 5:00 PM <span>&#9660;</span></div>
      <div class="form-section-body" id="music-sat5pm-body">
        ${musicBlockFields('sat5pm')}
      </div>
    </div>

    <!-- MUSIC: SUN 9AM -->
    <div class="form-section" id="section-music-sun9am">
      <div class="form-section-hdr" onclick="toggle(this)">Music — Sun 9:00 AM <span>&#9660;</span></div>
      <div class="form-section-body" id="music-sun9am-body">
        ${musicBlockFields('sun9am')}
      </div>
    </div>

    <!-- MUSIC: SUN 11AM -->
    <div class="form-section" id="section-music-sun11am">
      <div class="form-section-hdr" onclick="toggle(this)">Music — Sun 11:00 AM <span>&#9660;</span></div>
      <div class="form-section-body" id="music-sun11am-body">
        ${musicBlockFields('sun11am')}
      </div>
    </div>

    <!-- NOTATION IMAGES -->
    <div class="form-section" id="section-notation">
      <div class="form-section-hdr" onclick="toggle(this)">Notation Images <span>&#9660;</span></div>
      <div class="form-section-body">
        <p style="font-size:11px;color:var(--gray);margin-bottom:8px;">Upload MuseScore exports, score screenshots, or OneLicense notation PNGs.</p>
        <div class="upload-area" onclick="document.getElementById('notationFileInput').click()">
          <input type="file" id="notationFileInput" accept="image/*" onchange="uploadNotation(this)">
          <p style="font-size:11px;color:var(--gray);">Click to upload notation image (PNG, JPG, SVG)</p>
        </div>
        <div id="notation-list"></div>
      </div>
    </div>

    <!-- CHILDREN'S LITURGY -->
    <div class="form-section">
      <div class="form-section-hdr" onclick="toggle(this)">Children's Liturgy <span>&#9660;</span></div>
      <div class="form-section-body">
        <div class="fg-check"><input type="checkbox" id="childrenLiturgyEnabled"><label for="childrenLiturgyEnabled">Enable Children's Liturgy of the Word</label></div>
        <div class="fg"><label>Mass Time</label><input type="text" id="childrenLiturgyMassTime" placeholder="Sun 9:00 AM" value="Sun 9:00 AM"></div>
        <div class="fg-row">
          <div class="fg"><label>Music Title</label><input type="text" id="childrenLiturgyMusic"></div>
          <div class="fg"><label>Composer</label><input type="text" id="childrenLiturgyMusicComposer"></div>
        </div>
      </div>
    </div>

    <!-- ANNOUNCEMENTS & NOTES -->
    <div class="form-section" id="section-announcements">
      <div class="form-section-hdr" onclick="toggle(this)">Announcements &amp; Notes <span>&#9660;</span></div>
      <div class="form-section-body">
        <div class="fg"><label>Announcements</label><textarea id="announcements" rows="3"></textarea></div>
        <div class="fg"><label>Special Notes (optional)</label><textarea id="specialNotes" rows="2" placeholder="Any one-off variations..."></textarea></div>
      </div>
    </div>

    <!-- COVER IMAGE -->
    <div class="form-section" id="section-cover">
      <div class="form-section-hdr" onclick="toggle(this)">Cover Image <span>&#9660;</span></div>
      <div class="form-section-body">
        <p style="font-size:11px;color:var(--gray);margin-bottom:8px;">Optional color cover for special seasons (Christmas, Holy Week, Easter).</p>
        <div class="upload-area" onclick="document.getElementById('coverFileInput').click()">
          <input type="file" id="coverFileInput" accept="image/*" onchange="uploadCover(this)">
          <p style="font-size:11px;color:var(--gray);">Click to upload cover image</p>
        </div>
        <div id="cover-preview"></div>
      </div>
    </div>

    <div style="height:50px;"></div>
  </div>

  <div class="preview-area" id="preview-area">
    <div id="overflow-warnings"></div>
    <div id="preview-placeholder" class="page-placeholder">
      <div style="font-size:36px;margin-bottom:12px;">&#x271E;</div>
      <h2>Worship Aid Preview</h2>
      <p>Fill in the form, then click <strong>Preview</strong>.</p>
      <p style="margin-top:8px;">Or <strong>Load Sample</strong> to start with example data.</p>
    </div>
    <div id="preview-content" style="display:none;">
      <div class="preview-frame"><iframe id="preview-iframe" sandbox="allow-same-origin"></iframe></div>
    </div>
  </div>
</div>

<!-- HISTORY PAGE -->
<div id="page-history" style="display:none;">
  <div class="history-view">
    <h2>Worship Aid History</h2>
    <div id="history-list"></div>
  </div>
</div>

<!-- ADMIN/SETTINGS PAGE -->
<div id="page-admin" style="display:none;">
  <div class="admin-view">
    <h2>Parish Settings</h2>
    <div class="form-section"><div class="form-section-hdr">Parish Information</div>
      <div class="form-section-body">
        <div class="fg"><label>Parish Name</label><input type="text" id="s_parishName"></div>
        <div class="fg"><label>Address</label><input type="text" id="s_parishAddress"></div>
        <div class="fg-row">
          <div class="fg"><label>Phone</label><input type="text" id="s_parishPhone"></div>
          <div class="fg"><label>Website URL</label><input type="text" id="s_parishUrl"></div>
        </div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Cover Page Info Blocks</div>
      <div class="form-section-body">
        <div class="fg"><label>Connect Blurb</label><textarea id="s_connectBlurb" rows="2"></textarea></div>
        <div class="fg"><label>Nursery Blurb</label><textarea id="s_nurseryBlurb" rows="2"></textarea></div>
        <div class="fg"><label>Restrooms Blurb</label><textarea id="s_restroomsBlurb" rows="2"></textarea></div>
        <div class="fg"><label>Prayer Blurb</label><textarea id="s_prayerBlurb" rows="2"></textarea></div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Copyright &amp; Licensing</div>
      <div class="form-section-body">
        <div class="fg"><label>OneLicense Number</label><input type="text" id="s_onelicenseNumber"></div>
        <div class="fg"><label>Short Copyright (Page 7)</label><textarea id="s_copyrightShort" rows="2"></textarea></div>
        <div class="fg"><label>Full Copyright (Page 8)</label><textarea id="s_copyrightFull" rows="4"></textarea></div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Workflow</div>
      <div class="form-section-body">
        <div class="fg-check"><input type="checkbox" id="s_requirePastorApproval"><label for="s_requirePastorApproval">Require pastor approval before PDF export</label></div>
        <p style="font-size:11px;color:var(--gray);margin-top:4px;">When enabled, drafts must be submitted for review and approved by the pastor before they can be exported as PDF.</p>
      </div>
    </div>
    <button class="btn btn-gold" onclick="saveAdminSettings()" style="margin-top:12px;">Save Settings</button>
  </div>
</div>

<!-- USERS PAGE (admin only) -->
<div id="page-users" style="display:none;">
  <div class="users-view">
    <h2>User Management</h2>
    <div id="user-list"></div>
    <div class="form-section" style="margin-top:16px;">
      <div class="form-section-hdr">Add New User</div>
      <div class="form-section-body">
        <div class="fg-row">
          <div class="fg"><label>Username</label><input type="text" id="new_username"></div>
          <div class="fg"><label>Display Name</label><input type="text" id="new_displayName"></div>
        </div>
        <div class="fg-row">
          <div class="fg"><label>Role</label>
            <select id="new_role">
              <option value="admin">Director of Liturgy (Admin)</option>
              <option value="music_director">Music Director</option>
              <option value="pastor">Pastor</option>
              <option value="staff">Staff</option>
            </select>
          </div>
          <div class="fg"><label>Password</label><input type="password" id="new_password"></div>
        </div>
        <button class="btn btn-gold btn-sm" onclick="addUser()">Add User</button>
      </div>
    </div>
  </div>
</div>

<div class="status"><span id="status-text">Ready</span><span id="status-extra"></span></div>

<script>
// --- Session State ---
let _sessionToken = localStorage.getItem('wa_token');
let _currentUser = null;

// --- Auth ---
async function checkAuth() {
  if (!_sessionToken) { showLogin(); return; }
  try {
    const res = await fetch('/api/auth/me', { headers: { 'x-session-token': _sessionToken } });
    if (!res.ok) { showLogin(); return; }
    _currentUser = await res.json();
    showApp();
  } catch(e) { showLogin(); }
}

function showLogin() {
  _currentUser = null;
  document.getElementById('page-login').style.display = '';
  document.getElementById('main-nav').style.display = 'none';
  ['editor','history','admin','users'].forEach(p => document.getElementById('page-' + p).style.display = 'none');
}

async function showApp() {
  document.getElementById('page-login').style.display = 'none';
  document.getElementById('main-nav').style.display = '';

  // Show user info
  const roleLabels = { admin: 'Director of Liturgy', music_director: 'Music Director', pastor: 'Pastor', staff: 'Staff' };
  document.getElementById('user-display').innerHTML =
    '<strong>' + esc(_currentUser.displayName) + '</strong> <span class="role-badge ' + _currentUser.role + '">' + (roleLabels[_currentUser.role] || _currentUser.role) + '</span>';

  // Show/hide nav items based on role
  document.getElementById('nav-users').style.display = _currentUser.role === 'admin' ? '' : 'none';
  document.getElementById('btn-export').style.display = hasRole('export_pdf') ? '' : 'none';

  // Load parish settings for approval workflow awareness
  try {
    const sr = await fetch('/api/settings');
    window._parishSettings = await sr.json();
  } catch(e) { window._parishSettings = {}; }

  applyRolePermissions();
  showPage('editor');
}

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; errEl.style.display = ''; return; }
    _sessionToken = data.token;
    _currentUser = data.user;
    localStorage.setItem('wa_token', _sessionToken);
    showApp();
  } catch(e) { errEl.textContent = 'Connection error'; errEl.style.display = ''; }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-session-token': _sessionToken } });
  _sessionToken = null;
  _currentUser = null;
  localStorage.removeItem('wa_token');
  showLogin();
}

// Enter key on login
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-password').focus(); });

// --- Role-Based Permissions ---
const rolePerms = {
  admin: ['edit_all', 'manage_users', 'manage_settings', 'edit_readings', 'edit_music', 'edit_seasonal', 'approve', 'export_pdf', 'edit_announcements', 'upload_images', 'edit_cover'],
  music_director: ['edit_music', 'edit_seasonal', 'upload_images', 'export_pdf'],
  pastor: ['edit_readings', 'approve', 'edit_announcements'],
  staff: ['edit_readings', 'edit_music', 'edit_announcements', 'edit_seasonal', 'export_pdf']
};

function hasRole(perm) {
  if (!_currentUser) return false;
  const perms = rolePerms[_currentUser.role] || [];
  return perms.includes(perm) || perms.includes('edit_all');
}

function applyRolePermissions() {
  // Music sections: only music_director, admin, staff
  const musicSections = ['section-music-sat5pm', 'section-music-sun9am', 'section-music-sun11am', 'section-notation'];
  musicSections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('disabled', !hasRole('edit_music'));
  });

  // Readings: only pastor, admin, staff
  const readingsSection = document.getElementById('section-readings');
  if (readingsSection) readingsSection.classList.toggle('disabled', !hasRole('edit_readings'));

  // Seasonal: music_director, admin, staff
  const seasonalSection = document.getElementById('section-seasonal');
  if (seasonalSection) seasonalSection.classList.toggle('disabled', !hasRole('edit_seasonal'));

  // Announcements: pastor, admin, staff
  const announcementsSection = document.getElementById('section-announcements');
  if (announcementsSection) announcementsSection.classList.toggle('disabled', !hasRole('edit_announcements'));

  // Cover: admin only
  const coverSection = document.getElementById('section-cover');
  if (coverSection) coverSection.classList.toggle('disabled', !hasRole('edit_cover'));

  // Settings nav: admin only
  document.getElementById('nav-admin').style.display = hasRole('manage_settings') ? '' : 'none';
}

// --- Navigation ---
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const page = link.dataset.page;
    showPage(page);
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
  });
});
function showPage(page) {
  ['editor','history','admin','users'].forEach(p => {
    document.getElementById('page-' + p).style.display = (p === page) ? '' : 'none';
  });
  if (page === 'history') loadHistory();
  if (page === 'admin') loadAdminSettings();
  if (page === 'users') loadUsers();
}

// --- Form helpers ---
function toggle(hdr) {
  const body = hdr.nextElementSibling;
  const arrow = hdr.querySelector('span');
  body.classList.toggle('collapsed');
  arrow.textContent = body.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function ch(id) { const el = document.getElementById(id); return el ? el.checked : false; }
function sv(id, val) { const el = document.getElementById(id); if (el) el.value = val || ''; }
function sc(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; }

function buildMusicBlock(prefix) {
  return {
    organPrelude: v(prefix + '_organPrelude'),
    organPreludeComposer: v(prefix + '_organPreludeComposer'),
    processionalOrEntrance: v(prefix + '_processional'),
    processionalOrEntranceComposer: v(prefix + '_processionalComposer'),
    kyrieSetting: v(prefix + '_kyrie'),
    kyrieComposer: v(prefix + '_kyrieComposer'),
    offertoryAnthem: v(prefix + '_offertory'),
    offertoryAnthemComposer: v(prefix + '_offertoryComposer'),
    communionHymn: v(prefix + '_communion'),
    communionHymnComposer: v(prefix + '_communionComposer'),
    hymnOfThanksgiving: v(prefix + '_thanksgiving'),
    hymnOfThanksgivingComposer: v(prefix + '_thanksgivingComposer'),
    organPostlude: v(prefix + '_postlude'),
    organPostludeComposer: v(prefix + '_postludeComposer'),
    choralAnthemConcluding: v(prefix + '_choral'),
    choralAnthemConcludingComposer: v(prefix + '_choralComposer')
  };
}

function populateMusicBlock(prefix, block) {
  if (!block) return;
  sv(prefix + '_organPrelude', block.organPrelude);
  sv(prefix + '_organPreludeComposer', block.organPreludeComposer);
  sv(prefix + '_processional', block.processionalOrEntrance);
  sv(prefix + '_processionalComposer', block.processionalOrEntranceComposer);
  sv(prefix + '_kyrie', block.kyrieSetting);
  sv(prefix + '_kyrieComposer', block.kyrieComposer);
  sv(prefix + '_offertory', block.offertoryAnthem);
  sv(prefix + '_offertoryComposer', block.offertoryAnthemComposer);
  sv(prefix + '_communion', block.communionHymn);
  sv(prefix + '_communionComposer', block.communionHymnComposer);
  sv(prefix + '_thanksgiving', block.hymnOfThanksgiving);
  sv(prefix + '_thanksgivingComposer', block.hymnOfThanksgivingComposer);
  sv(prefix + '_postlude', block.organPostlude);
  sv(prefix + '_postludeComposer', block.organPostludeComposer);
  sv(prefix + '_choral', block.choralAnthemConcluding);
  sv(prefix + '_choralComposer', block.choralAnthemConcludingComposer);
}

function buildData() {
  return {
    id: window._currentDraftId || undefined,
    feastName: v('feastName'),
    liturgicalDate: v('liturgicalDate'),
    liturgicalSeason: v('liturgicalSeason'),
    lastEditedBy: _currentUser ? _currentUser.displayName : undefined,
    seasonalSettings: {
      gloria: ch('gloria'),
      creedType: v('creedType'),
      entranceType: v('entranceType'),
      holyHolySetting: v('holyHolySetting'),
      mysteryOfFaithSetting: v('mysteryOfFaithSetting'),
      lambOfGodSetting: v('lambOfGodSetting'),
      penitentialAct: v('penitentialAct'),
      includePostlude: ch('includePostlude'),
      adventWreath: ch('adventWreath'),
      lentenAcclamation: v('lentenAcclamation')
    },
    readings: {
      firstReadingCitation: v('firstReadingCitation'),
      firstReadingText: v('firstReadingText'),
      psalmCitation: v('psalmCitation'),
      psalmRefrain: v('psalmRefrain'),
      psalmVerses: v('psalmVerses'),
      noSecondReading: ch('noSecondReading'),
      secondReadingCitation: v('secondReadingCitation'),
      secondReadingText: v('secondReadingText'),
      gospelAcclamationReference: v('gospelAcclamationReference'),
      gospelAcclamationVerse: v('gospelAcclamationVerse'),
      gospelCitation: v('gospelCitation'),
      gospelText: v('gospelText')
    },
    musicSat5pm: buildMusicBlock('sat5pm'),
    musicSun9am: buildMusicBlock('sun9am'),
    musicSun11am: buildMusicBlock('sun11am'),
    childrenLiturgyEnabled: ch('childrenLiturgyEnabled'),
    childrenLiturgyMassTime: v('childrenLiturgyMassTime'),
    childrenLiturgyMusic: v('childrenLiturgyMusic'),
    childrenLiturgyMusicComposer: v('childrenLiturgyMusicComposer'),
    announcements: v('announcements'),
    specialNotes: v('specialNotes'),
    coverImagePath: window._coverImagePath || undefined
  };
}

function populateForm(data) {
  window._currentDraftId = data.id || undefined;
  sv('feastName', data.feastName);
  sv('liturgicalDate', data.liturgicalDate);
  sv('liturgicalSeason', data.liturgicalSeason);
  const ss = data.seasonalSettings || {};
  sc('gloria', ss.gloria);
  sv('creedType', ss.creedType);
  sv('entranceType', ss.entranceType);
  sv('holyHolySetting', ss.holyHolySetting);
  sv('mysteryOfFaithSetting', ss.mysteryOfFaithSetting);
  sv('lambOfGodSetting', ss.lambOfGodSetting);
  sv('penitentialAct', ss.penitentialAct);
  sc('includePostlude', ss.includePostlude !== false);
  sc('adventWreath', !!ss.adventWreath);
  sv('lentenAcclamation', ss.lentenAcclamation || 'standard');
  const r = data.readings || {};
  sv('firstReadingCitation', r.firstReadingCitation);
  sv('firstReadingText', r.firstReadingText);
  sv('psalmCitation', r.psalmCitation);
  sv('psalmRefrain', r.psalmRefrain);
  sv('psalmVerses', r.psalmVerses);
  sc('noSecondReading', r.noSecondReading);
  sv('secondReadingCitation', r.secondReadingCitation);
  sv('secondReadingText', r.secondReadingText);
  sv('gospelAcclamationReference', r.gospelAcclamationReference);
  sv('gospelAcclamationVerse', r.gospelAcclamationVerse);
  sv('gospelCitation', r.gospelCitation);
  sv('gospelText', r.gospelText);
  populateMusicBlock('sat5pm', data.musicSat5pm);
  populateMusicBlock('sun9am', data.musicSun9am);
  populateMusicBlock('sun11am', data.musicSun11am);
  sc('childrenLiturgyEnabled', data.childrenLiturgyEnabled);
  sv('childrenLiturgyMassTime', data.childrenLiturgyMassTime);
  sv('childrenLiturgyMusic', data.childrenLiturgyMusic);
  sv('childrenLiturgyMusicComposer', data.childrenLiturgyMusicComposer);
  sv('announcements', data.announcements);
  sv('specialNotes', data.specialNotes);
  window._coverImagePath = data.coverImagePath || undefined;
  updateSeasonUI();
}

// --- Season auto-rules ---
async function onSeasonChange() {
  const season = v('liturgicalSeason');
  try {
    const res = await fetch('/api/season-defaults/' + season);
    const defaults = await res.json();
    sc('gloria', defaults.gloria);
    sv('creedType', defaults.creedType);
    sv('entranceType', defaults.entranceType);
    sv('holyHolySetting', defaults.holyHolySetting);
    sv('mysteryOfFaithSetting', defaults.mysteryOfFaithSetting);
    sv('lambOfGodSetting', defaults.lambOfGodSetting);
    sv('penitentialAct', defaults.penitentialAct);
    sc('includePostlude', defaults.includePostlude !== false);
    sc('adventWreath', !!defaults.adventWreath);
    updateSeasonUI();
    toast('Season defaults applied: ' + season, 'success');
  } catch(e) { console.error(e); }
}

function updateSeasonUI() {
  const season = v('liturgicalSeason');
  // Show Lenten acclamation choice only during Lent
  document.getElementById('lentenAcclamationGroup').style.display = (season === 'lent') ? '' : 'none';
}

// --- Image Uploads ---
async function uploadNotation(input) {
  if (!input.files || !input.files[0]) return;
  const formData = new FormData();
  formData.append('image', input.files[0]);
  try {
    const res = await fetch('/api/upload/notation', {
      method: 'POST', headers: { 'x-session-token': _sessionToken }, body: formData
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
    toast('Image uploaded: ' + data.originalName, 'success');
    loadNotationList();
  } catch(e) { toast('Upload error', 'error'); }
  input.value = '';
}

async function loadNotationList() {
  try {
    const res = await fetch('/api/uploads/notation');
    const files = await res.json();
    document.getElementById('notation-list').innerHTML = files.map(f =>
      '<div style="margin-bottom:4px;"><img src="' + f.url + '" class="image-preview" alt="notation"> <span style="font-size:10px;color:var(--gray);">' + esc(f.filename) + '</span></div>'
    ).join('');
  } catch(e) {}
}

async function uploadCover(input) {
  if (!input.files || !input.files[0]) return;
  const formData = new FormData();
  formData.append('image', input.files[0]);
  try {
    const res = await fetch('/api/upload/cover', {
      method: 'POST', headers: { 'x-session-token': _sessionToken }, body: formData
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
    window._coverImagePath = data.url;
    document.getElementById('cover-preview').innerHTML = '<img src="' + data.url + '" class="image-preview" style="max-height:120px;" alt="cover">';
    toast('Cover image uploaded', 'success');
  } catch(e) { toast('Upload error', 'error'); }
  input.value = '';
}

// --- Actions ---
async function loadSample() {
  try {
    const res = await fetch('/api/sample');
    const data = await res.json();
    populateForm(data);
    toast('Sample loaded', 'success');
    setStatus('Sample data loaded');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function saveDraft() {
  const data = buildData();
  data.status = data.status || 'draft';
  try {
    const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    window._currentDraftId = result.id;
    toast('Draft saved', 'success');
    setStatus('Draft saved at ' + new Date().toLocaleTimeString());
  } catch(e) { toast('Save error: ' + e.message, 'error'); }
}

async function generatePreview() {
  setStatus('Generating preview...');
  try {
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildData()) });
    const result = await res.json();
    document.getElementById('preview-placeholder').style.display = 'none';
    document.getElementById('preview-content').style.display = 'block';
    const iframe = document.getElementById('preview-iframe');
    iframe.srcdoc = result.html;
    iframe.onload = () => { iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px'; };

    // Show overflow warnings
    const warnEl = document.getElementById('overflow-warnings');
    warnEl.innerHTML = (result.overflows || []).map(o =>
      '<div class="overflow-indicator">' + o.message + '</div>'
    ).join('');

    setStatus('Preview generated', result.warnings.length ? result.warnings.length + ' warning(s)' : '');
  } catch(e) { toast('Preview error: ' + e.message, 'error'); }
}

async function generatePdfExport() {
  setStatus('Generating PDF...');
  try {
    const data = buildData();
    const res = await fetch('/api/generate-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken }, body: JSON.stringify(data) });
    const result = await res.json();
    if (!res.ok) { toast('Error: ' + (result.error || ''), 'error'); setStatus('Export blocked'); return; }
    const a = document.createElement('a'); a.href = result.downloadUrl; a.download = result.filename; a.click();
    toast('PDF exported: ' + result.filename, 'success');
    setStatus('PDF exported');
  } catch(e) { toast('PDF error: ' + e.message, 'error'); }
}

// --- History ---
async function loadHistory() {
  try {
    const res = await fetch('/api/drafts');
    const drafts = await res.json();
    // Load settings to check approval requirement
    let parishSettings = window._parishSettings;
    if (!parishSettings) {
      try { const sr = await fetch('/api/settings'); parishSettings = await sr.json(); window._parishSettings = parishSettings; } catch(e) { parishSettings = {}; }
    }
    const approvalRequired = parishSettings.requirePastorApproval;

    document.getElementById('history-list').innerHTML = drafts.length === 0
      ? '<p style="color:var(--gray);font-style:italic;">No saved worship aids yet.</p>'
      : drafts.map(d => {
        const status = d.status || 'draft';
        let approvalBtns = '';
        if (approvalRequired) {
          if (status === 'draft' && (hasRole('edit_readings') || hasRole('edit_music'))) {
            approvalBtns = '<button class="btn btn-outline btn-sm" onclick="submitForReview(\\'' + d.id + '\\')">Submit for Review</button>';
          }
          if (status === 'review' && hasRole('approve')) {
            approvalBtns = '<button class="btn btn-gold btn-sm" onclick="approveDraft(\\'' + d.id + '\\')">Approve</button>' +
              '<button class="btn btn-outline btn-sm" onclick="requestChanges(\\'' + d.id + '\\')">Request Changes</button>';
          }
        }
        const approvalInfo = d.approvedBy ? ' &bull; Approved by ' + esc(d.approvedBy) : '';
        return '<div class="draft-card">' +
          '<div class="info">' +
            '<h3>' + esc(d.feastName || 'Untitled') + ' <span class="status-badge ' + status + '">' + status + '</span></h3>' +
            '<p>' + esc(d.liturgicalDate || '') + ' &bull; ' + esc(d.liturgicalSeason || '') + ' &bull; Updated ' + new Date(d.updatedAt).toLocaleDateString() + (d.lastEditedBy ? ' by ' + esc(d.lastEditedBy) : '') + approvalInfo + '</p>' +
          '</div>' +
          '<div class="actions">' +
            approvalBtns +
            '<button class="btn btn-outline btn-sm" onclick="openDraft(\\'' + d.id + '\\')">Open</button>' +
            '<button class="btn btn-outline btn-sm" onclick="dupDraft(\\'' + d.id + '\\')">Duplicate</button>' +
            '<button class="btn btn-danger btn-sm" onclick="delDraft(\\'' + d.id + '\\')">Delete</button>' +
          '</div>' +
        '</div>';
      }).join('');
  } catch(e) { console.error(e); }
}

async function openDraft(id) {
  const res = await fetch('/api/drafts/' + id);
  const data = await res.json();
  populateForm(data);
  showPage('editor');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector('[data-page="editor"]').classList.add('active');
  toast('Draft loaded', 'success');
}

async function dupDraft(id) {
  await fetch('/api/drafts/' + id + '/duplicate', { method: 'POST' });
  loadHistory();
  toast('Draft duplicated', 'success');
}

async function delDraft(id) {
  if (!confirm('Delete this draft?')) return;
  await fetch('/api/drafts/' + id, { method: 'DELETE' });
  loadHistory();
}

// --- Approval Workflow ---
async function submitForReview(id) {
  await fetch('/api/drafts/' + id + '/submit-for-review', { method: 'POST', headers: { 'x-session-token': _sessionToken } });
  toast('Submitted for pastor review', 'success');
  loadHistory();
}

async function approveDraft(id) {
  await fetch('/api/drafts/' + id + '/approve', { method: 'POST', headers: { 'x-session-token': _sessionToken } });
  toast('Draft approved', 'success');
  loadHistory();
}

async function requestChanges(id) {
  const note = prompt('Note for the team (optional):') || '';
  await fetch('/api/drafts/' + id + '/request-changes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
    body: JSON.stringify({ note })
  });
  toast('Changes requested — draft returned to editing', 'success');
  loadHistory();
}

// --- Admin Settings ---
const settingsFields = ['parishName','parishAddress','parishPhone','parishUrl','connectBlurb','nurseryBlurb','restroomsBlurb','prayerBlurb','onelicenseNumber','copyrightShort','copyrightFull'];
const settingsCheckboxes = ['requirePastorApproval'];
async function loadAdminSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  settingsFields.forEach(f => sv('s_' + f, s[f]));
  settingsCheckboxes.forEach(f => sc('s_' + f, s[f]));
  window._parishSettings = s;
}
async function saveAdminSettings() {
  const s = {};
  settingsFields.forEach(f => s[f] = v('s_' + f));
  settingsCheckboxes.forEach(f => s[f] = ch('s_' + f));
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
  window._parishSettings = s;
  toast('Settings saved', 'success');
}

// --- User Management ---
async function loadUsers() {
  try {
    const res = await fetch('/api/users', { headers: { 'x-session-token': _sessionToken } });
    if (!res.ok) return;
    const users = await res.json();
    const roleLabels = { admin: 'Director of Liturgy', music_director: 'Music Director', pastor: 'Pastor', staff: 'Staff' };
    document.getElementById('user-list').innerHTML = users.map(u => \`
      <div class="user-card">
        <div class="info">
          <h3>\${esc(u.displayName)} <span class="role-badge \${u.role}">\${roleLabels[u.role] || u.role}</span></h3>
          <p>Username: \${esc(u.username)} &bull; Created \${new Date(u.createdAt).toLocaleDateString()}</p>
        </div>
        <div class="actions">
          <button class="btn btn-danger btn-sm" onclick="removeUser('\${u.id}')">Remove</button>
        </div>
      </div>
    \`).join('');
  } catch(e) { console.error(e); }
}

async function addUser() {
  const data = {
    username: v('new_username'),
    displayName: v('new_displayName'),
    role: v('new_role'),
    password: v('new_password')
  };
  try {
    const res = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify(data)
    });
    if (!res.ok) { const err = await res.json(); toast(err.error || 'Error', 'error'); return; }
    toast('User added', 'success');
    sv('new_username', ''); sv('new_displayName', ''); sv('new_password', '');
    loadUsers();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function removeUser(id) {
  if (!confirm('Remove this user?')) return;
  await fetch('/api/users/' + id, { method: 'DELETE', headers: { 'x-session-token': _sessionToken } });
  loadUsers();
}

// --- Auto-save ---
let _autoSaveTimer;
document.getElementById('editor').addEventListener('input', () => {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    if (v('feastName') || v('liturgicalDate')) saveDraft();
  }, 30000);
});

// --- Utils ---
function setStatus(text, extra) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-extra').innerHTML = extra ? '<span class="warn">' + extra + '</span>' : '';
}
function toast(msg, type) {
  const old = document.querySelector('.toast'); if (old) old.remove();
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
}

// --- Init ---
checkAuth();
</script>
</body>
</html>`;
}

// Helper: generates the per-mass-time music fields HTML
function musicBlockFields(prefix) {
  const fields = [
    ['organPrelude', 'organPreludeComposer', 'Organ Prelude'],
    ['processional', 'processionalComposer', 'Processional / Entrance'],
    ['kyrie', 'kyrieComposer', 'Lord, Have Mercy (Kyrie)'],
    ['offertory', 'offertoryComposer', 'Offertory Anthem'],
    ['communion', 'communionComposer', 'Communion Hymn'],
    ['thanksgiving', 'thanksgivingComposer', 'Hymn of Thanksgiving'],
    ['postlude', 'postludeComposer', 'Organ Postlude'],
    ['choral', 'choralComposer', 'Choral Anthem (Concluding)']
  ];
  return fields.map(([titleId, compId, label]) => `
    <div class="fg-row">
      <div class="fg"><label>${label}</label><input type="text" id="${prefix}_${titleId}" placeholder="Title"></div>
      <div class="fg"><label>&nbsp;</label><input type="text" id="${prefix}_${compId}" placeholder="Composer"></div>
    </div>
  `).join('');
}

module.exports = app;
