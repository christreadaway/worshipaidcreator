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
const { fetchReadings, TRANSLATIONS } = require('./readings-fetcher');
const { autoCropNotation } = require('./image-utils');
const hymnLibrary = require('./store/hymn-library');
const attachmentsStore = require('./store/attachments');
const { getLiturgicalInfo } = require('./liturgical-calendar');

const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Upload directories (local dev) or Blobs (Netlify)
const kv = require('./store/kv');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const NOTATION_DIR = path.join(UPLOADS_DIR, 'notation');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const ATTACHMENTS_DIR = path.join(UPLOADS_DIR, 'attachments');
if (!kv.IS_NETLIFY) {
  [NOTATION_DIR, COVERS_DIR, ATTACHMENTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

// Multer config — memory storage on Netlify, disk storage locally
function makeUploadConfig(destDir, prefixFn, allowedExts, maxSize) {
  const storage = kv.IS_NETLIFY
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: destDir,
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname);
          cb(null, prefixFn(ext));
        }
      });
  return multer({
    storage,
    fileFilter: (req, file, cb) => {
      cb(null, allowedExts.includes(path.extname(file.originalname).toLowerCase()));
    },
    limits: { fileSize: maxSize }
  });
}

const notationUpload = makeUploadConfig(
  NOTATION_DIR,
  ext => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  ['.png', '.jpg', '.jpeg', '.gif', '.svg'],
  5 * 1024 * 1024
);

const coverUpload = makeUploadConfig(
  COVERS_DIR,
  ext => `cover-${Date.now()}${ext}`,
  ['.png', '.jpg', '.jpeg'],
  10 * 1024 * 1024
);

const logoUpload = makeUploadConfig(
  COVERS_DIR,
  ext => `logo-${Date.now()}${ext}`,
  ['.png', '.jpg', '.jpeg'],
  5 * 1024 * 1024
);

// Attachments: any audio / PDF / image / score the parish wants reused.
// Keep the size cap generous so MP3 anthems and full PDF scores still fit.
const attachmentUpload = makeUploadConfig(
  ATTACHMENTS_DIR,
  ext => `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  [
    '.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac',
    '.pdf',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
    '.mid', '.midi', '.mxl', '.musicxml', '.xml',
    '.txt', '.md', '.docx', '.doc', '.rtf'
  ],
  50 * 1024 * 1024
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Log all requests on Netlify for debugging
if (kv.IS_NETLIFY) {
  app.use((req, res, next) => {
    console.log('[EXPRESS] %s %s', req.method, req.path);
    next();
  });
}

if (!kv.IS_NETLIFY) {
  app.use('/exports', express.static(store.getExportsDir()));
  app.use('/uploads', express.static(UPLOADS_DIR));
}

// MIME guess for attachments served from Blobs (Netlify) or any uploaded
// file whose extension we know.
function guessMime(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.aac': 'audio/aac', '.flac': 'audio/flac',
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.mid': 'audio/midi', '.midi': 'audio/midi',
    '.mxl': 'application/vnd.recordare.musicxml', '.musicxml': 'application/vnd.recordare.musicxml+xml', '.xml': 'application/xml',
    '.txt': 'text/plain', '.md': 'text/markdown',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.rtf': 'application/rtf'
  };
  return map[ext] || 'application/octet-stream';
}

// Seed default users — retry on demand if initial attempt fails (e.g. Netlify cold start)
let _seedDone = false;
const _seedReady = userStore.seedDefaultUsers()
  .then(() => { _seedDone = true; console.log('[SEED] Default users ready'); })
  .catch(e => console.error('[SEED] Initial seed failed:', e.message));

async function ensureSeeded() {
  await _seedReady;
  if (!_seedDone) {
    console.log('[SEED] Retrying seed on demand...');
    try {
      await userStore.seedDefaultUsers();
      _seedDone = true;
      console.log('[SEED] On-demand seed succeeded');
    } catch (e) {
      console.error('[SEED] On-demand seed failed:', e.message, e.stack);
    }
  }
}

// --- AUTH MIDDLEWARE ---
function getSessionToken(req) {
  return req.headers['x-session-token'] || req.query.token || null;
}

async function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  const user = await userStore.getSessionUser(token);
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
app.post('/api/auth/login', async (req, res) => {
  await ensureSeeded();
  const { username, password } = req.body;
  if (!username) {
    console.log('[LOGIN] No username provided in request body');
    return res.status(401).json({ error: 'Please enter your name' });
  }
  console.log('[LOGIN] Attempting login for:', JSON.stringify(username));
  try {
    const user = await userStore.authenticateUser(username, password);
    if (!user) {
      const allUsers = await userStore.listUsers();
      const names = allUsers.map(u => u.username);
      console.log('[LOGIN] Failed for %s — known usernames: %s', username, names.join(', '));
      return res.status(401).json({
        error: 'No account found for "' + username + '". Try: ' + names.join(', ')
      });
    }
    console.log('[LOGIN] Success: %s -> %s (%s)', username, user.displayName, user.role);
    const token = await userStore.createSession(user.id);
    res.json({ token, user });
  } catch (e) {
    console.error('[LOGIN] Error:', e);
    res.status(500).json({ error: 'Login error: ' + e.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = getSessionToken(req);
  if (token) await userStore.destroySession(token);
  res.json({ success: true });
});

// Google OAuth login — verify ID token and match to a user by googleEmail
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'No credential provided' });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google login not configured. Set GOOGLE_CLIENT_ID env variable.' });

  try {
    // Verify the Google ID token via Google's tokeninfo endpoint
    const payload = await new Promise((resolve, reject) => {
      const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
      https.get(url, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          if (resp.statusCode !== 200) return reject(new Error('Token verification failed'));
          const parsed = JSON.parse(data);
          if (parsed.aud !== GOOGLE_CLIENT_ID) return reject(new Error('Token audience mismatch'));
          resolve(parsed);
        });
      }).on('error', reject);
    });

    const email = payload.email;
    if (!email) return res.status(400).json({ error: 'No email in Google token' });

    // Find user by Google email
    const rawUser = await userStore.getUserByGoogleEmail(email);
    if (!rawUser) {
      return res.status(403).json({ error: 'No account linked to ' + email + '. Ask your admin to add your Google email to your user account.' });
    }
    if (!rawUser.active) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    const user = { id: rawUser.id, username: rawUser.username, displayName: rawUser.displayName, role: rawUser.role, active: rawUser.active, createdAt: rawUser.createdAt, googleEmail: rawUser.googleEmail };
    const token = await userStore.createSession(user.id);
    res.json({ token, user });
  } catch (e) {
    res.status(401).json({ error: e.message || 'Google authentication failed' });
  }
});

// Expose Google client ID to the frontend
app.get('/api/auth/google-client-id', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID || null });
});

// Debug endpoint — visit /api/auth/debug in browser to see what's happening
app.get('/api/auth/debug', async (req, res) => {
  try {
    await ensureSeeded();
    const users = await userStore.listUsers();
    res.json({
      ok: true,
      environment: kv.IS_NETLIFY ? 'netlify' : 'local',
      envVars: {
        NETLIFY: !!process.env.NETLIFY,
        NETLIFY_BLOBS_CONTEXT: !!process.env.NETLIFY_BLOBS_CONTEXT,
        DEPLOY_PRIME_URL: !!process.env.DEPLOY_PRIME_URL,
        AWS_LAMBDA_FUNCTION_NAME: !!process.env.AWS_LAMBDA_FUNCTION_NAME
      },
      userCount: users.length,
      users: users.map(u => ({ username: u.username, displayName: u.displayName, role: u.role, active: u.active })),
      seedDone: _seedDone,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: e.stack,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const token = getSessionToken(req);
  const user = await userStore.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(user);
});

// --- USER MANAGEMENT (admin only) ---
app.get('/api/users', requireAuth, requirePermission('manage_users'), async (req, res) => {
  res.json(await userStore.listUsers());
});

app.post('/api/users', requireAuth, requirePermission('manage_users'), async (req, res) => {
  try {
    const user = await userStore.createUser(req.body);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:id', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const user = await userStore.updateUser(req.params.id, req.body);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.delete('/api/users/:id', requireAuth, requirePermission('manage_users'), async (req, res) => {
  await userStore.deleteUser(req.params.id);
  res.json({ success: true });
});

// --- API ROUTES ---

// Season defaults
app.get('/api/season-defaults/:season', (req, res) => {
  if (!SEASONS.includes(req.params.season)) {
    return res.status(400).json({ error: 'Unknown season: ' + req.params.season + '. Must be one of: ' + SEASONS.join(', ') });
  }
  res.json(getSeasonDefaults(req.params.season));
});

// Lenten acclamation options
app.get('/api/lenten-acclamations', (req, res) => {
  res.json(LENTEN_ACCLAMATION_OPTIONS);
});

// Bible translations available for the readings dropdown
app.get('/api/bible-translations', (req, res) => {
  res.json(TRANSLATIONS.map(({ id, label, source }) => ({ id, label, source })));
});

// Auto-derive feast/Sunday name + liturgical season from a date.
// Drives the "Feast / Sunday Name" auto-fill in the editor.
app.get('/api/liturgical-info', (req, res) => {
  const date = String(req.query.date || '');
  const info = getLiturgicalInfo(date);
  if (!info) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(info);
});

// --- ATTACHMENTS LIBRARY ---
// Generic media library — preludes, postludes, anthems, mass settings,
// recordings the parish wants on hand.  Authenticated users with the
// `manage_settings` permission can upload/delete; everyone can list.
app.get('/api/attachments', async (req, res) => {
  try {
    const filter = {};
    if (req.query.kind) filter.kind = String(req.query.kind);
    if (req.query.kinds) filter.kinds = String(req.query.kinds).split(',');
    if (req.query.q) filter.q = String(req.query.q);
    const list = await attachmentsStore.listAttachments(filter);
    res.json({ kinds: attachmentsStore.KINDS, attachments: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/attachments', requireAuth, requirePermission('manage_settings'), attachmentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname);
  const filename = req.file.filename || `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const mime = req.file.mimetype || guessMime(filename);

  if (kv.IS_NETLIFY) {
    await kv.set(attachmentsStore.BLOB_NS, filename, { data: req.file.buffer.toString('base64'), mime });
  }

  const url = kv.IS_NETLIFY ? `/api/uploads/attachments/${filename}` : `/uploads/attachments/${filename}`;
  const meta = await attachmentsStore.saveAttachmentMeta({
    filename,
    originalName: req.file.originalname,
    title: String(req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, ''),
    composer: String(req.body.composer || '').trim(),
    kind: String(req.body.kind || 'general'),
    tags: String(req.body.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    notes: String(req.body.notes || '').trim(),
    mime,
    size: req.file.size,
    url,
    uploadedBy: req.user.displayName,
    uploadedAt: new Date().toISOString()
  });
  res.json(meta);
});

app.put('/api/attachments/:id', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const patch = {};
  ['title', 'composer', 'kind', 'notes'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k] || '').trim();
  });
  if (req.body.tags !== undefined) {
    patch.tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(s => String(s).trim()).filter(Boolean)
      : String(req.body.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  const updated = await attachmentsStore.updateAttachment(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

app.delete('/api/attachments/:id', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  // Look up the metadata first so we can delete the on-disk binary too.
  // (kv's namespace path doesn't line up with multer's diskStorage path,
  // so attachmentsStore.deleteAttachment can't reach the local file alone.)
  const meta = await attachmentsStore.getAttachment(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (!kv.IS_NETLIFY && meta.filename) {
    const filePath = path.join(ATTACHMENTS_DIR, meta.filename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {
      console.warn('[attachments] could not unlink local file:', e.message);
    }
  }
  await attachmentsStore.deleteAttachment(req.params.id);
  res.json({ success: true });
});

app.get('/api/uploads/attachments/:filename', async (req, res) => {
  if (kv.IS_NETLIFY) {
    const item = await kv.get(attachmentsStore.BLOB_NS, req.params.filename);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const buf = Buffer.from(item.data, 'base64');
    res.setHeader('Content-Type', item.mime || guessMime(req.params.filename));
    return res.send(buf);
  }
  // Locally we serve via express.static('/uploads'); provide a fallback.
  const filePath = path.join(ATTACHMENTS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', guessMime(req.params.filename));
  fs.createReadStream(filePath).pipe(res);
});

// Local hymn library — parish-managed catalog. English-only by default.
app.get('/api/hymns/search', async (req, res) => {
  try {
    const lib = await hymnLibrary.loadLibrary();
    const results = hymnLibrary.search(lib, req.query.q || '', {
      englishOnly: req.query.includeNonEnglish !== '1',
      limit: Math.min(parseInt(req.query.limit, 10) || 20, 100)
    });
    res.json({ results, total: lib.entries.length, updatedAt: lib.updatedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/hymns', async (req, res) => {
  try {
    const lib = await hymnLibrary.loadLibrary();
    res.json(lib);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/hymns', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  try {
    const saved = await hymnLibrary.saveLibrary(req.body && req.body.entries);
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cover image concept suggestions — derived from feast/season + tone.
// Returns short concepts, a starter image-generation prompt, and search URLs
// so a designer can pick a stock photo or generate an image.
app.post('/api/cover-suggestions', (req, res) => {
  const { feastName = '', liturgicalSeason = 'ordinary', tone = 'reverent' } = req.body || {};
  const seasonImagery = {
    advent:    ['advent wreath with lit candles', 'starlit night sky over Bethlehem', 'purple and rose vestments', 'open Bible with first candle'],
    christmas: ['nativity scene at night', 'star of Bethlehem', 'candlelit altar with poinsettias', 'angels announcing to shepherds'],
    lent:      ['simple wooden cross at dawn', 'desert landscape', 'crown of thorns on stone', 'ashes in the shape of a cross'],
    easter:    ['empty tomb at sunrise', 'lilies on the altar', 'risen Christ icon', 'paschal candle'],
    ordinary:  ['stained glass cross', 'open Gospel book', 'parish sanctuary detail', 'bread and chalice still life']
  };
  const toneStyles = {
    reverent:      'warm sepia tones, soft chiaroscuro lighting, classical Catholic iconography',
    joyful:        'bright golden light, vibrant color, uplifting composition',
    solemn:        'deep shadows, muted palette, candlelight, prayerful stillness',
    hopeful:       'dawn light breaking through, gentle pastels, open horizon',
    contemplative: 'soft monochrome, minimal composition, quiet space, gentle texture',
    triumphant:    'rich golds and reds, sweeping verticals, banners and incense'
  };
  const baseImagery = seasonImagery[liturgicalSeason] || seasonImagery.ordinary;
  const style = toneStyles[tone] || toneStyles.reverent;
  const subject = feastName.trim() || (liturgicalSeason.charAt(0).toUpperCase() + liturgicalSeason.slice(1));
  const concepts = baseImagery.map(img => ({
    title: img.replace(/^./, c => c.toUpperCase()),
    prompt: `${img}, ${style}, fine-art photography, vertical composition, room for title text at top, no text, ${subject}`
  }));
  const searchTerms = [
    feastName,
    liturgicalSeason + ' liturgy',
    baseImagery[0]
  ].filter(Boolean).map(s => s.trim());
  const searchLinks = searchTerms.map(q => ({
    query: q,
    unsplash: 'https://unsplash.com/s/photos/' + encodeURIComponent(q),
    pexels:   'https://www.pexels.com/search/' + encodeURIComponent(q),
    wikimedia: 'https://commons.wikimedia.org/w/index.php?search=' + encodeURIComponent(q) + '&title=Special:MediaSearch&go=Go&type=image'
  }));
  res.json({ subject, tone, style, concepts, searchLinks });
});

// Fetch Mass readings from USCCB (NABRE Lectionary), optionally re-translated
app.get('/api/readings', async (req, res) => {
  const date = String(req.query.date || '');
  const translation = String(req.query.translation || 'NABRE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const readings = await fetchReadings(date, translation);
    res.json(readings);
  } catch (e) {
    console.error('[readings] fetch failed:', e.message);
    res.status(502).json({ error: 'Failed to fetch readings: ' + e.message });
  }
});

// Validate
app.post('/api/validate', (req, res) => {
  const result = validateInput(req.body);
  const overflows = detectOverflows(req.body);
  res.json({ ...result, overflows });
});

// Preview HTML
app.post('/api/preview', async (req, res) => {
  const settings = await store.loadSettings();
  const { html, warnings } = renderBookletHtml(req.body, { parishSettings: settings });
  const overflows = detectOverflows(req.body);
  res.json({ html, warnings, overflows });
});

// Generate PDF
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const settings = await store.loadSettings();

    // Enforce pastor approval if enabled in settings
    if (settings.requirePastorApproval && req.body.id) {
      const draft = await store.loadDraft(req.body.id);
      if (draft && draft.status !== 'approved') {
        return res.status(403).json({ error: 'Pastor approval required before export. Current status: ' + (draft.status || 'draft') });
      }
    }

    const filename = buildFilename(req.body);
    const outputDir = kv.IS_NETLIFY ? '/tmp' : store.getExportsDir();
    const outputPath = path.join(outputDir, filename);
    const bookletSize = (req.body.bookletSize || req.query.bookletSize || 'half-letter');
    const result = await generatePdf(req.body, outputPath, {
      parishSettings: settings,
      bookletSize
    });

    // Mark draft as exported if it has an id
    if (req.body.id) {
      const draft = await store.loadDraft(req.body.id);
      if (draft) {
        draft.status = 'exported';
        draft.exportedAt = new Date().toISOString();
        await store.saveDraft(draft);
      }
    }

    // On Netlify, send the file directly; locally, return a download URL
    if (kv.IS_NETLIFY) {
      const pdfBuffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
    } else {
      res.json({
        success: true,
        filename,
        downloadUrl: `/exports/${filename}`,
        warnings: result.warnings
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- IMAGE UPLOADS ---
app.post('/api/upload/notation', requireAuth, requirePermission('upload_images'), notationUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname);
  const filename = req.file.filename || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;

  // Auto-crop white margins so scanned sheet music doesn't waste page space.
  let cropInfo = { skipped: true };
  if (kv.IS_NETLIFY) {
    const result = await autoCropNotation({ buffer: req.file.buffer, mime: req.file.mimetype });
    const finalBuf = result.buffer || req.file.buffer;
    await kv.set('uploads-notation', filename, { data: finalBuf.toString('base64'), mime: req.file.mimetype });
    cropInfo = { cropped: !!result.cropped };
  } else {
    const filePath = path.join(NOTATION_DIR, filename);
    cropInfo = await autoCropNotation({ filePath, mime: req.file.mimetype });
  }

  res.json({
    filename,
    url: kv.IS_NETLIFY ? `/api/uploads/notation/${filename}` : `/uploads/notation/${filename}`,
    originalName: req.file.originalname,
    autoCrop: cropInfo
  });
});

app.post('/api/upload/logo', requireAuth, requirePermission('manage_settings'), logoUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname);
  const filename = req.file.filename || `logo-${Date.now()}${ext}`;
  if (kv.IS_NETLIFY) {
    await kv.set('uploads-covers', filename, { data: req.file.buffer.toString('base64'), mime: req.file.mimetype });
  }
  const url = kv.IS_NETLIFY ? `/api/uploads/covers/${filename}` : `/uploads/covers/${filename}`;
  // Persist as the active logo path in parish settings.
  try {
    const settings = await store.loadSettings();
    settings.logoPath = url;
    await store.saveSettings(settings);
  } catch (e) {
    console.warn('[logo] could not persist logoPath:', e.message);
  }
  res.json({ filename, url, originalName: req.file.originalname });
});

app.post('/api/upload/cover', requireAuth, requirePermission('edit_cover'), coverUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname);
  const filename = req.file.filename || `cover-${Date.now()}${ext}`;
  if (kv.IS_NETLIFY) {
    await kv.set('uploads-covers', filename, { data: req.file.buffer.toString('base64'), mime: req.file.mimetype });
  }
  res.json({
    filename,
    url: kv.IS_NETLIFY ? `/api/uploads/covers/${filename}` : `/uploads/covers/${filename}`,
    originalName: req.file.originalname
  });
});

app.get('/api/uploads/notation', async (req, res) => {
  if (kv.IS_NETLIFY) {
    const items = await kv.list('uploads-notation');
    return res.json(items.map(i => ({ filename: i.key || 'unknown', url: `/api/uploads/notation/${i.key || 'unknown'}` })));
  }
  const files = fs.readdirSync(NOTATION_DIR).filter(f => !f.startsWith('.')).map(f => ({
    filename: f,
    url: `/uploads/notation/${f}`
  }));
  res.json(files);
});

// Serve uploaded images from Blobs on Netlify
app.get('/api/uploads/notation/:filename', async (req, res) => {
  const item = await kv.get('uploads-notation', req.params.filename);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const buf = Buffer.from(item.data, 'base64');
  res.setHeader('Content-Type', item.mime);
  res.send(buf);
});

app.get('/api/uploads/covers', async (req, res) => {
  if (kv.IS_NETLIFY) {
    const items = await kv.list('uploads-covers');
    return res.json(items.map(i => ({ filename: i.key || 'unknown', url: `/api/uploads/covers/${i.key || 'unknown'}` })));
  }
  const files = fs.readdirSync(COVERS_DIR).filter(f => !f.startsWith('.')).map(f => ({
    filename: f,
    url: `/uploads/covers/${f}`
  }));
  res.json(files);
});

app.get('/api/uploads/covers/:filename', async (req, res) => {
  const item = await kv.get('uploads-covers', req.params.filename);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const buf = Buffer.from(item.data, 'base64');
  res.setHeader('Content-Type', item.mime);
  res.send(buf);
});

// --- DRAFTS ---
app.post('/api/drafts', async (req, res) => {
  const draft = await store.saveDraft(req.body);
  res.json(draft);
});

app.get('/api/drafts', async (req, res) => {
  res.json(await store.listDrafts());
});

app.get('/api/drafts/:id', async (req, res) => {
  const draft = await store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

app.delete('/api/drafts/:id', async (req, res) => {
  await store.deleteDraft(req.params.id);
  res.json({ success: true });
});

app.post('/api/drafts/:id/duplicate', async (req, res) => {
  const copy = await store.duplicateDraft(req.params.id);
  if (!copy) return res.status(404).json({ error: 'Draft not found' });
  res.json(copy);
});

// --- APPROVAL WORKFLOW ---
app.post('/api/drafts/:id/submit-for-review', requireAuth, async (req, res) => {
  const draft = await store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  draft.status = 'review';
  draft.submittedBy = req.user.displayName;
  draft.submittedAt = new Date().toISOString();
  await store.saveDraft(draft);
  res.json(draft);
});

app.post('/api/drafts/:id/approve', requireAuth, requirePermission('approve'), async (req, res) => {
  const draft = await store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  draft.status = 'approved';
  draft.approvedBy = req.user.displayName;
  draft.approvedAt = new Date().toISOString();
  await store.saveDraft(draft);
  res.json(draft);
});

app.post('/api/drafts/:id/request-changes', requireAuth, requirePermission('approve'), async (req, res) => {
  const draft = await store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  draft.status = 'draft';
  draft.changeRequestedBy = req.user.displayName;
  draft.changeRequestedAt = new Date().toISOString();
  draft.changeNote = (req.body && req.body.note) || '';
  delete draft.approvedBy;
  delete draft.approvedAt;
  await store.saveDraft(draft);
  res.json(draft);
});

// --- STATS ---
// Hymn-usage frequency across all saved drafts. Open to all roles — no auth gate.
const HYMN_FIELDS = [
  'organPrelude', 'processionalOrEntrance', 'kyrieSetting', 'offertoryAnthem',
  'communionHymn', 'hymnOfThanksgiving', 'organPostlude', 'choralAnthemConcluding'
];
const MUSIC_BLOCKS = ['musicSat5pm', 'musicSun9am', 'musicSun11am'];

function _normalizeTitle(s) {
  return String(s || '').trim();
}

app.get('/api/stats/hymns', async (req, res) => {
  try {
    const drafts = await kv.list('drafts');
    const stats = {};
    for (const d of drafts) {
      const date = d.liturgicalDate || '';
      const month = date.slice(0, 7); // YYYY-MM
      const season = d.liturgicalSeason || 'unknown';
      const titles = new Set();
      for (const block of MUSIC_BLOCKS) {
        const m = d[block] || {};
        for (const f of HYMN_FIELDS) {
          const t = _normalizeTitle(m[f]);
          if (t) titles.add(t);
        }
      }
      titles.forEach(t => {
        if (!stats[t]) stats[t] = { title: t, total: 0, byMonth: {}, bySeason: {}, draftDates: [] };
        stats[t].total += 1;
        if (month) stats[t].byMonth[month] = (stats[t].byMonth[month] || 0) + 1;
        stats[t].bySeason[season] = (stats[t].bySeason[season] || 0) + 1;
        if (date) stats[t].draftDates.push(date);
      });
    }
    const list = Object.values(stats).sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
    res.json({ totalDrafts: drafts.length, hymns: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SETTINGS ---
app.get('/api/settings', async (req, res) => {
  res.json(await store.loadSettings());
});

app.put('/api/settings', async (req, res) => {
  const settings = await store.saveSettings(req.body);
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
app.get('/stats', (req, res) => res.send(getAppHtml()));

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
<script src="https://accounts.google.com/gsi/client" async defer></script>
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
.login-error { color: var(--error); font-size: 12px; margin-bottom: 8px; }

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
.fg-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: end; }

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

/* Readings toolbar — dropdown gets the lion's share so the full
   "NABRE (Lectionary, USCCB)" label fits; button hugs its content;
   status message gets its own line below so a long message can wrap
   freely without crushing the toolbar. */
.readings-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; margin-bottom: 4px; }
.readings-toolbar .fg { margin-bottom: 0; min-width: 0; }
.readings-toolbar select { width: 100%; }
.readings-toolbar button { white-space: nowrap; }
.readings-status { font-size: 11px; color: var(--gray); margin: 0 0 10px; min-height: 14px; line-height: 1.3; }

/* Attachments library — a filter bar + list of meta cards. */
.attachment-card { background: white; border: 1px solid var(--border); border-radius: 5px; padding: 8px 10px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.attachment-card .info { flex: 1; min-width: 0; }
.attachment-card .info .t { font-weight: 600; font-size: 12px; word-break: break-word; }
.attachment-card .info .m { font-size: 10px; color: var(--gray); }
.attachment-card .actions { display: flex; gap: 4px; flex-shrink: 0; }
.attachment-kind-pill { display: inline-block; background: #eef0e6; color: #5a5a3a; font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; }
.attachment-list-empty { color: var(--gray); font-style: italic; font-size: 11px; padding: 8px; }
.attachment-pick-row { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; margin-top: 2px; }
.attachment-pick-row select { font-size: 11px; padding: 4px 6px; min-width: 0; }
.attachment-pick-row a { font-size: 10px; color: var(--gold); text-decoration: none; white-space: nowrap; }
.attachment-pick-row a:hover { text-decoration: underline; }
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
    <div id="login-error" class="login-error" style="display:none;"></div>
    <div class="fg"><label>Your Name</label><input type="text" id="login-username" placeholder="e.g., Morris, Kari, Fr. Larry"></div>
    <input type="hidden" id="login-password" value="">
    <button class="btn btn-gold" style="width:100%;justify-content:center;margin-top:8px;" onclick="doLogin()">Sign In</button>
    <div id="google-signin-divider" style="display:none;margin:16px 0 8px;position:relative;text-align:center;">
      <hr style="border:none;border-top:1px solid var(--border);">
      <span style="position:relative;top:-10px;background:white;padding:0 12px;font-size:11px;color:var(--gray);">or</span>
    </div>
    <div id="google-signin-btn" style="display:flex;justify-content:center;"></div>
  </div>
</div>

<nav id="main-nav" style="display:none;">
  <span class="brand">&#x271E; Worship Aid Generator</span>
  <a href="/" class="nav-link active" data-page="editor">Editor</a>
  <a href="/history" class="nav-link" data-page="history">History</a>
  <a href="/stats" class="nav-link" data-page="stats">Stats</a>
  <a href="/admin" class="nav-link" data-page="admin" id="nav-admin">Settings</a>
  <a href="/users" class="nav-link" data-page="users" id="nav-users" style="display:none;">Users</a>
  <span class="spacer"></span>
  <span class="user-info" id="user-display"></span>
  <button class="btn btn-outline btn-sm" onclick="loadSample()">Load Sample</button>
  <button class="btn btn-outline btn-sm" onclick="saveDraft()">Save Draft</button>
  <select id="bookletSize" class="btn-sm" style="margin-right:6px;padding:4px 6px;font-size:11px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:3px;" title="Booklet trim size">
    <option value="half-letter">5.5×8.5 booklet</option>
    <option value="tabloid">8.5×11 booklet (11×17)</option>
  </select>
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
        <div class="fg"><label>Feast / Sunday Name <span style="font-weight:400;text-transform:none;color:var(--gray);">(auto-fills from date when empty)</span></label><input type="text" id="feastName" placeholder="e.g., Second Sunday of Lent"></div>
        <div class="fg-row">
          <div class="fg"><label>Date <span style="font-weight:400;text-transform:none;color:var(--gray);">(defaults to next Sunday)</span></label><input type="date" id="liturgicalDate" onchange="onLiturgicalDateChange()"></div>
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
          <div class="fg"><label>Creed</label><select id="creedType"><option value="nicene">Nicene Creed</option><option value="apostles">Apostles' Creed</option><option value="baptismal_vows">Renewal of Baptismal Vows</option></select></div>
          <div class="fg"><label>Entrance Type</label><select id="entranceType"><option value="processional">Processional Hymn</option><option value="antiphon">Entrance Antiphon</option></select></div>
        </div>
        <div class="fg-row">
          <div class="fg"><label>Holy, Holy, Holy Setting</label><input type="text" id="holyHolySetting" placeholder="e.g., Mass of St. Theresa"></div>
          <div class="fg"><label>Sanctus Language</label>
            <select id="holyHolyLanguage" onchange="this.dataset.userSet='1'">
              <option value="english">English (Holy, Holy, Holy)</option>
              <option value="latin">Latin (Sanctus)</option>
            </select>
          </div>
        </div>
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
        <p class="section-lock">Auto-pulled from <strong>bible.usccb.org</strong> the moment a date is set. Switch translations or click <em>Fetch from USCCB</em> to re-fetch. All fields are editable.</p>
        <div class="readings-toolbar">
          <div class="fg">
            <label>Bible Translation</label>
            <select id="bibleTranslation"></select>
          </div>
          <div class="fg">
            <label>&nbsp;</label>
            <button type="button" class="btn btn-outline btn-sm" id="fetchReadingsBtn" onclick="fetchReadingsFromUsccb()">Fetch from USCCB</button>
          </div>
        </div>
        <p class="readings-status" id="fetchReadingsStatus"></p>
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
        <p class="section-lock">Auto-defaults to ON when school is in session and OFF for summer, Christmas, and Easter. Toggle to override.</p>
        <div class="fg-check">
          <input type="checkbox" id="childrenLiturgyEnabled" onchange="onChildrenLiturgyToggle()">
          <label for="childrenLiturgyEnabled">Enable Children's Liturgy of the Word</label>
          <span id="childrenLiturgyAutoNote" style="font-size: 11px; color: var(--gray); margin-left: 8px;"></span>
        </div>
        <div class="fg-row">
          <div class="fg"><label>Mass Time</label><input type="text" id="childrenLiturgyMassTime" placeholder="Sun 9:00 AM" value="Sun 9:00 AM"></div>
          <div class="fg"><label>Leader (optional)</label><input type="text" id="childrenLiturgyLeader" placeholder="e.g., Mrs. Donna Smith"></div>
        </div>
        <div class="fg-row">
          <div class="fg"><label>Music Title</label><input type="text" id="childrenLiturgyMusic"></div>
          <div class="fg"><label>Composer</label><input type="text" id="childrenLiturgyMusicComposer"></div>
        </div>
        <div class="fg"><label>Notes (printed under the entry)</label><input type="text" id="childrenLiturgyNotes" placeholder="Children dismissed after the Opening Prayer; rejoin parents at the Offertory."></div>
      </div>
    </div>

    <!-- ATTACHMENTS REFERENCED -->
    <div class="form-section">
      <div class="form-section-hdr" onclick="toggle(this)">Files Referenced (preludes, postludes, anthems…) <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock">Pick from the parish library. Add new files in <em>Settings → Music &amp; Document Library</em>. They'll show up here for any worship aid.</p>
        <div class="fg"><label>Add a file</label>
          <select id="attachmentPicker" onchange="addAttachmentRefFromPicker(this)">
            <option value="">— pick from library —</option>
          </select>
        </div>
        <div id="attachmentRefList"></div>
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
        <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;">
          <p style="font-size:11px;color:var(--gray);margin-bottom:6px;">Need ideas? Pick a tone and we'll suggest cover concepts and search prompts.</p>
          <div class="fg-row" style="grid-template-columns: 1fr auto; gap: 8px;">
            <div class="fg"><label>Tone</label>
              <select id="coverTone">
                <option value="reverent">Reverent &amp; traditional</option>
                <option value="joyful">Joyful &amp; celebratory</option>
                <option value="solemn">Solemn &amp; reflective</option>
                <option value="hopeful">Hopeful &amp; expectant</option>
                <option value="contemplative">Contemplative &amp; quiet</option>
                <option value="triumphant">Triumphant &amp; glorious</option>
              </select>
            </div>
            <div class="fg"><label>&nbsp;</label>
              <button type="button" onclick="suggestCoverImages()">Suggest covers</button>
            </div>
          </div>
          <div id="coverSuggestions" style="margin-top:8px;"></div>
        </div>
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

<!-- STATS PAGE -->
<div id="page-stats" style="display:none;">
  <div class="history-view">
    <h2>Hymn Usage Stats</h2>
    <p style="font-size:12px;color:var(--gray);margin-bottom:12px;">How often each hymn appears across saved drafts. Counted once per draft regardless of how many mass times use it.</p>
    <div id="stats-summary" style="font-size:12px;color:var(--gray);margin-bottom:8px;"></div>
    <div id="stats-list"></div>
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
        <div class="fg"><label>Mass Times (one per line — appears on cover)</label>
          <textarea id="s_massTimes" rows="3" placeholder="Sat Vigil — 5:00 PM
Sunday — 9:00 AM
Sunday — 11:00 AM"></textarea>
        </div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Clergy &amp; Staff</div>
      <div class="form-section-body">
        <p class="section-lock">These print on the cover (under the Mass times). Leave blank to omit.</p>
        <div class="fg-row">
          <div class="fg"><label>Pastor</label><input type="text" id="s_pastor" placeholder="Fr. Lawrence Smith"></div>
          <div class="fg"><label>Pastor Title</label><input type="text" id="s_pastorTitle" placeholder="Pastor"></div>
        </div>
        <div class="fg"><label>Associates / Parochial Vicars (one per line)</label>
          <textarea id="s_associates" rows="2" placeholder="Fr. John Doe — Parochial Vicar"></textarea>
        </div>
        <div class="fg"><label>Deacons (one per line)</label>
          <textarea id="s_deacons" rows="2" placeholder="Deacon Bob Roe — Permanent Deacon"></textarea>
        </div>
        <div class="fg"><label>Music Director</label><input type="text" id="s_musicDirector" placeholder="Morris Brown"></div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Standing Worship-Aid Text</div>
      <div class="form-section-body">
        <p class="section-lock">Reused across every worship aid. Leave any field blank to skip.</p>
        <div class="fg"><label>Welcome Message (printed inside cover)</label>
          <textarea id="s_welcomeMessage" rows="2" placeholder="A warm welcome to all who join us today..."></textarea>
        </div>
        <div class="fg"><label>Closing Message (printed on back cover)</label>
          <textarea id="s_closingMessage" rows="2" placeholder="Thank you for worshiping with us today..."></textarea>
        </div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Liturgical Defaults</div>
      <div class="form-section-body">
        <div class="fg"><label>Default Sanctus / Holy, Holy, Holy Language</label>
          <select id="s_defaultSanctusLanguage">
            <option value="english">English (Holy, Holy, Holy)</option>
            <option value="latin">Latin (Sanctus)</option>
          </select>
        </div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Cover Page — Persistent Branding</div>
      <div class="form-section-body">
        <p style="font-size:11px;color:var(--gray);margin-bottom:8px;">These appear on every booklet's cover. The logo (PNG/JPG, transparent background recommended) replaces the default cross. Standing tagline appears under the parish name.</p>
        <div class="fg"><label>Parish Logo</label>
          <div class="upload-area" onclick="document.getElementById('logoFileInput').click()">
            <input type="file" id="logoFileInput" accept="image/png,image/jpeg" onchange="uploadLogo(this)">
            <p style="font-size:11px;color:var(--gray);">Click to upload parish logo</p>
          </div>
          <div id="logo-preview" style="margin-top:6px;"></div>
        </div>
        <div class="fg"><label>Cover Tagline (appears under parish name)</label><input type="text" id="s_coverTagline" placeholder="e.g., A Catholic Community in the Heart of the City"></div>
        <input type="hidden" id="s_logoPath">
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
    <div class="form-section"><div class="form-section-hdr">Music &amp; Document Library</div>
      <div class="form-section-body">
        <p class="section-lock">Upload mass settings, preludes, postludes, anthems, and any other audio / PDF / image / score files you reference in worship aids. Files are reusable across every booklet.</p>
        <div class="upload-area" onclick="document.getElementById('attachmentFileInput').click()">
          <input type="file" id="attachmentFileInput" onchange="uploadAttachmentFromSettings(this)">
          <p style="font-size:11px;color:var(--gray);">Click to upload a file (audio, PDF, image, MusicXML, MIDI, doc — up to 50&nbsp;MB)</p>
        </div>
        <div class="fg-row" style="grid-template-columns: 1fr 1fr;">
          <div class="fg"><label>Title</label><input type="text" id="att_title" placeholder="Toccata in D Minor"></div>
          <div class="fg"><label>Composer</label><input type="text" id="att_composer" placeholder="J.S. Bach"></div>
        </div>
        <div class="fg-row" style="grid-template-columns: 1fr 1fr;">
          <div class="fg"><label>Kind</label>
            <select id="att_kind">
              <option value="prelude">Organ Prelude</option>
              <option value="postlude">Organ Postlude</option>
              <option value="processional">Processional / Entrance</option>
              <option value="kyrie">Kyrie / Lord Have Mercy</option>
              <option value="gloria">Gloria</option>
              <option value="sanctus">Sanctus / Holy, Holy</option>
              <option value="mystery_of_faith">Mystery of Faith</option>
              <option value="agnus_dei">Lamb of God</option>
              <option value="psalm">Responsorial Psalm</option>
              <option value="gospel_acclamation">Gospel Acclamation</option>
              <option value="offertory_anthem">Offertory Anthem</option>
              <option value="communion">Communion</option>
              <option value="thanksgiving">Hymn of Thanksgiving</option>
              <option value="choral_anthem">Choral Anthem</option>
              <option value="mass_setting">Full Mass Setting</option>
              <option value="general">General / Other</option>
            </select>
          </div>
          <div class="fg"><label>Tags (comma-separated)</label><input type="text" id="att_tags" placeholder="advent, organ"></div>
        </div>
        <p id="att_uploadStatus" style="font-size:11px;color:var(--gray);margin:4px 0;"></p>

        <div style="border-top:1px solid var(--border);margin:10px 0 6px;padding-top:8px;">
          <div class="fg-row" style="grid-template-columns: 1fr auto;">
            <div class="fg"><label>Filter library</label>
              <select id="att_filter_kind" onchange="loadAttachmentList()">
                <option value="">All kinds</option>
                <option value="prelude">Preludes</option>
                <option value="postlude">Postludes</option>
                <option value="processional">Processionals</option>
                <option value="kyrie">Kyries</option>
                <option value="gloria">Glorias</option>
                <option value="sanctus">Sanctus</option>
                <option value="mystery_of_faith">Mystery of Faith</option>
                <option value="agnus_dei">Agnus Dei</option>
                <option value="psalm">Psalms</option>
                <option value="gospel_acclamation">Gospel Acclamations</option>
                <option value="offertory_anthem">Offertory Anthems</option>
                <option value="communion">Communion</option>
                <option value="thanksgiving">Thanksgiving</option>
                <option value="choral_anthem">Choral Anthems</option>
                <option value="mass_setting">Mass Settings</option>
                <option value="general">General</option>
              </select>
            </div>
            <div class="fg"><label>&nbsp;</label>
              <button type="button" class="btn btn-outline btn-sm" onclick="loadAttachmentList()">Refresh</button>
            </div>
          </div>
          <div id="att_list"></div>
        </div>
      </div>
    </div>
    <div class="form-section"><div class="form-section-hdr">Hymn Library (English only)</div>
      <div class="form-section-body">
        <p style="font-size:11px;color:var(--gray);margin-bottom:6px;">Music staff can search this catalog when filling in title fields. Edit as JSON; one object per hymn with fields: title, tune, composer, key, meter, source, notes.</p>
        <div class="fg"><label>Library Entries (JSON)</label>
          <textarea id="s_hymnLibrary" rows="14" style="font-family: monospace; font-size: 11px;"></textarea>
        </div>
        <button type="button" class="btn btn-outline btn-sm" onclick="saveHymnLibrary()">Save Library</button>
        <span id="s_hymnLibraryStatus" style="font-size:11px;color:var(--gray);margin-left:8px;"></span>
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
        <div class="fg"><label>Google Email (optional — enables "Sign in with Google")</label><input type="email" id="new_googleEmail" placeholder="user@gmail.com"></div>
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
  ['editor','history','stats','admin','users'].forEach(p => document.getElementById('page-' + p).style.display = 'none');
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
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; errEl.style.display = 'block'; return; }
    _sessionToken = data.token;
    _currentUser = data.user;
    localStorage.setItem('wa_token', _sessionToken);
    showApp();
  } catch(e) { errEl.textContent = 'Connection error'; errEl.style.display = 'block'; }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-session-token': _sessionToken } });
  _sessionToken = null;
  _currentUser = null;
  localStorage.removeItem('wa_token');
  showLogin();
}

// Enter key on login
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

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
  ['editor','history','stats','admin','users'].forEach(p => {
    document.getElementById('page-' + p).style.display = (p === page) ? '' : 'none';
  });
  if (page === 'history') loadHistory();
  if (page === 'stats') loadStats();
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
      holyHolyLanguage: v('holyHolyLanguage') || 'english',
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
    childrenLiturgyLeader: v('childrenLiturgyLeader'),
    childrenLiturgyNotes: v('childrenLiturgyNotes'),
    announcements: v('announcements'),
    specialNotes: v('specialNotes'),
    coverImagePath: window._coverImagePath || undefined,
    attachmentRefs: window._attachmentRefs || []
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
  sv('holyHolyLanguage', ss.holyHolyLanguage || (window._parishSettings && window._parishSettings.defaultSanctusLanguage) || 'english');
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
  // If the saved doc carries an explicit value, respect it; otherwise the
  // load is a no-op and auto-defaults will run on date/season change.
  const _clCb = document.getElementById('childrenLiturgyEnabled');
  if (_clCb) _clCb.dataset.userSet = (data.childrenLiturgyEnabled !== undefined) ? '1' : '';
  updateChildrenLiturgyAutoNote(data.childrenLiturgyEnabled !== undefined);
  sv('childrenLiturgyMassTime', data.childrenLiturgyMassTime);
  sv('childrenLiturgyMusic', data.childrenLiturgyMusic);
  sv('childrenLiturgyMusicComposer', data.childrenLiturgyMusicComposer);
  sv('childrenLiturgyLeader', data.childrenLiturgyLeader);
  sv('childrenLiturgyNotes', data.childrenLiturgyNotes);
  sv('announcements', data.announcements);
  sv('specialNotes', data.specialNotes);
  window._coverImagePath = data.coverImagePath || undefined;
  window._attachmentRefs = Array.isArray(data.attachmentRefs) ? data.attachmentRefs.slice() : [];
  renderAttachmentRefList();
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
    // Sanctus language: respect user override; otherwise fall back to parish default.
    const sanctusEl = document.getElementById('holyHolyLanguage');
    if (sanctusEl && !sanctusEl.dataset.userSet) {
      sanctusEl.value = (window._parishSettings && window._parishSettings.defaultSanctusLanguage) || 'english';
    }
    updateSeasonUI();
    applyChildrenLiturgyAutoDefault();
    toast('Season defaults applied: ' + season, 'success');
  } catch(e) { console.error(e); }
}

function updateSeasonUI() {
  const season = v('liturgicalSeason');
  // Show Lenten acclamation choice only during Lent
  document.getElementById('lentenAcclamationGroup').style.display = (season === 'lent') ? '' : 'none';
}

// --- Children's Liturgy auto-defaults ---
// School in session = Sep through May, with a break ~Dec 22-Jan 6.
// Off during summer (Jun-Aug), Christmas season, and Easter season.
function suggestChildrenLiturgyDefault(dateStr, season) {
  if (!dateStr) return { enabled: false, reason: 'No date set' };
  if (season === 'christmas') return { enabled: false, reason: 'Off during Christmas season' };
  if (season === 'easter')    return { enabled: false, reason: 'Off during Easter season' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return { enabled: false, reason: 'No date set' };
  const month = parseInt(m[2], 10);
  const day   = parseInt(m[3], 10);
  if (month >= 6 && month <= 8) return { enabled: false, reason: 'Off — school summer break' };
  if (month === 12 && day >= 22) return { enabled: false, reason: 'Off — school Christmas break' };
  if (month === 1 && day <= 6)   return { enabled: false, reason: 'Off — school Christmas break' };
  return { enabled: true, reason: 'School in session' };
}

function applyChildrenLiturgyAutoDefault(force) {
  const cb = document.getElementById('childrenLiturgyEnabled');
  if (!cb) return;
  if (!force && cb.dataset.userSet === '1') {
    updateChildrenLiturgyAutoNote(true);
    return;
  }
  const sug = suggestChildrenLiturgyDefault(v('liturgicalDate'), v('liturgicalSeason'));
  cb.checked = sug.enabled;
  cb.dataset.userSet = '';
  updateChildrenLiturgyAutoNote(false, sug.reason);
}

function updateChildrenLiturgyAutoNote(overridden, reason) {
  const note = document.getElementById('childrenLiturgyAutoNote');
  if (!note) return;
  if (overridden) {
    note.textContent = '(manually overridden)';
  } else {
    note.textContent = reason ? '(auto: ' + reason + ')' : '';
  }
}

function onChildrenLiturgyToggle() {
  const cb = document.getElementById('childrenLiturgyEnabled');
  if (cb) cb.dataset.userSet = '1';
  updateChildrenLiturgyAutoNote(true);
}

// --- Liturgical date / season auto-detection ---
// Computus (Anonymous Gregorian) — Western Easter for a given year.
function computeEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function dateOnly(y, m, d) { return new Date(Date.UTC(y, m, d)); }
function addDaysUTC(d, days) { return new Date(d.getTime() + days * 86400000); }

// Given a YYYY-MM-DD date, return the liturgical season per the General Roman
// Calendar (US): advent / christmas / lent / easter / ordinary.
function detectLiturgicalSeason(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const date = dateOnly(year, parseInt(m[2], 10) - 1, parseInt(m[3], 10));

  const easter = computeEaster(year);
  const ashWed = addDaysUTC(easter, -46);
  const pentecost = addDaysUTC(easter, 49);

  // Advent: 4th Sunday before Dec 25 through Dec 24.
  const dec25 = dateOnly(year, 11, 25);
  const dec25Dow = dec25.getUTCDay(); // 0=Sun
  // Sunday on/before Dec 24
  const sundayBeforeChristmas = addDaysUTC(dec25, -((dec25Dow + 7) % 7 || 7));
  const adventStart = addDaysUTC(sundayBeforeChristmas, -21);

  // Christmas season: Dec 25 through Baptism of the Lord (Sunday after Jan 6).
  // Use simpler rule: Dec 25 of (year or year-1) through Sunday after Jan 6.
  const christmasStartThisYear = dateOnly(year, 11, 25);
  const christmasStartLastYear = dateOnly(year - 1, 11, 25);
  function baptismOfLord(yr) {
    const jan6 = dateOnly(yr, 0, 6);
    let d = addDaysUTC(jan6, 1);
    while (d.getUTCDay() !== 0) d = addDaysUTC(d, 1);
    return d;
  }
  const baptism = baptismOfLord(year);

  if (date >= ashWed && date < easter) return 'lent';
  if (date >= easter && date <= pentecost) return 'easter';
  if (date >= adventStart && date < christmasStartThisYear) return 'advent';
  if (date >= christmasStartThisYear) return 'christmas'; // late Dec
  if (date <= baptism && date >= christmasStartLastYear) return 'christmas';
  if (date <= baptism) return 'christmas';
  return 'ordinary';
}

function nextSundayISO(fromDate) {
  const d = fromDate ? new Date(fromDate) : new Date();
  const dow = d.getDay(); // local 0=Sun
  const daysUntilSunday = dow === 0 ? 7 : (7 - dow);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysUntilSunday);
  const iso = next.getFullYear() + '-' +
    String(next.getMonth() + 1).padStart(2, '0') + '-' +
    String(next.getDate()).padStart(2, '0');
  return iso;
}

async function onLiturgicalDateChange() {
  const date = v('liturgicalDate');
  if (!date) return;
  // Server-side liturgical calendar gives us both feast name and season.
  let info = null;
  try {
    const r = await fetch('/api/liturgical-info?date=' + encodeURIComponent(date));
    if (r.ok) info = await r.json();
  } catch (e) { /* fall back to local season detection */ }
  const detected = (info && info.liturgicalSeason) || detectLiturgicalSeason(date);
  const seasonSel = document.getElementById('liturgicalSeason');
  if (detected && seasonSel && seasonSel.value !== detected) {
    seasonSel.value = detected;
    await onSeasonChange(); // applies seasonal defaults + cascades to children's liturgy
  } else {
    applyChildrenLiturgyAutoDefault();
  }
  // Fill the feast/Sunday name only when the field is empty.  This way a
  // manually-typed override is preserved, but starting fresh (or clearing the
  // field) always gets the right Sunday/feast for the chosen date.
  const feastEl = document.getElementById('feastName');
  if (info && info.feastName && feastEl && !feastEl.value.trim()) {
    feastEl.value = info.feastName;
  }
  autoFetchReadingsIfEmpty();
}

// If the readings fields are still empty for this date (i.e. user hasn't
// typed a manual override), kick off a USCCB fetch automatically. Manual
// edits are never overwritten — the function bails as soon as it finds any
// reading content. The Fetch button stays available for re-runs and for
// translation switches.
function autoFetchReadingsIfEmpty() {
  const fields = ['firstReadingCitation','firstReadingText','psalmCitation','psalmRefrain','psalmVerses','secondReadingCitation','secondReadingText','gospelAcclamationVerse','gospelCitation','gospelText'];
  const anyFilled = fields.some(id => v(id));
  if (anyFilled) return;
  if (!v('liturgicalDate')) return;
  fetchReadingsFromUsccb({ silent: true });
}

async function suggestCoverImages() {
  const target = document.getElementById('coverSuggestions');
  if (!target) return;
  target.innerHTML = '<p style="font-size:11px;color:var(--gray);">Generating ideas…</p>';
  try {
    const res = await fetch('/api/cover-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feastName: v('feastName'),
        liturgicalSeason: v('liturgicalSeason'),
        tone: document.getElementById('coverTone').value
      })
    });
    const data = await res.json();
    const conceptHtml = data.concepts.map(c => (
      '<div style="border:1px solid var(--border);border-radius:3px;padding:6px 8px;margin-bottom:6px;">' +
        '<div style="font-weight:600;font-size:12px;">' + esc(c.title) + '</div>' +
        '<div style="font-size:11px;color:var(--gray);margin-top:2px;">' + esc(c.prompt) + '</div>' +
        '<button type="button" style="margin-top:4px;font-size:10px;" onclick="navigator.clipboard.writeText(' + JSON.stringify(c.prompt) + ');toast(\\'Prompt copied\\',\\'success\\');">Copy prompt</button>' +
      '</div>'
    )).join('');
    const linkHtml = data.searchLinks.map(s => (
      '<div style="font-size:11px;margin-bottom:3px;">' +
        '<strong>' + esc(s.query) + ':</strong> ' +
        '<a href="' + s.unsplash + '" target="_blank" rel="noopener">Unsplash</a> &middot; ' +
        '<a href="' + s.pexels + '" target="_blank" rel="noopener">Pexels</a> &middot; ' +
        '<a href="' + s.wikimedia + '" target="_blank" rel="noopener">Wikimedia</a>' +
      '</div>'
    )).join('');
    target.innerHTML =
      '<div style="font-size:11px;color:var(--gray);margin-bottom:6px;">Tone: <em>' + esc(data.tone) + '</em> &middot; ' + esc(data.style) + '</div>' +
      conceptHtml +
      '<div style="margin-top:6px;font-size:11px;font-weight:600;">Stock search:</div>' +
      linkHtml;
  } catch (e) {
    target.innerHTML = '<p style="font-size:11px;color:var(--burgundy);">Could not generate ideas: ' + esc(e.message) + '</p>';
  }
}

async function suggestNextLiturgicalDate() {
  const dateInput = document.getElementById('liturgicalDate');
  if (!dateInput || dateInput.value) return; // don't override an existing pick
  const iso = nextSundayISO();
  dateInput.value = iso;
  // Defer to onLiturgicalDateChange so we use the same server-side calendar
  // path (sets season + feast name + auto-fetches readings).
  await onLiturgicalDateChange();
}

// --- Attachments library ---
const ATTACHMENT_KIND_LABELS = {
  prelude: 'Prelude',
  postlude: 'Postlude',
  processional: 'Processional / Entrance',
  kyrie: 'Kyrie',
  gloria: 'Gloria',
  sanctus: 'Sanctus',
  mystery_of_faith: 'Mystery of Faith',
  agnus_dei: 'Lamb of God',
  psalm: 'Psalm',
  gospel_acclamation: 'Gospel Acclamation',
  offertory_anthem: 'Offertory Anthem',
  communion: 'Communion',
  thanksgiving: 'Thanksgiving',
  choral_anthem: 'Choral Anthem',
  mass_setting: 'Mass Setting',
  general: 'General'
};

window._attachmentRefs = window._attachmentRefs || [];
let _attachmentCache = null;

async function getAttachmentCache(force) {
  if (_attachmentCache && !force) return _attachmentCache;
  try {
    const res = await fetch('/api/attachments');
    const data = await res.json();
    _attachmentCache = (data && data.attachments) || [];
  } catch (e) {
    _attachmentCache = [];
  }
  return _attachmentCache;
}

async function refreshAttachmentPicker() {
  const sel = document.getElementById('attachmentPicker');
  if (!sel) return;
  const list = await getAttachmentCache(true);
  sel.innerHTML = '<option value="">— pick from library —</option>' + list.map(a =>
    '<option value="' + esc(a.id) + '">[' + esc(ATTACHMENT_KIND_LABELS[a.kind] || a.kind) + '] ' +
    esc(a.title || a.originalName) + (a.composer ? ' — ' + esc(a.composer) : '') + '</option>'
  ).join('');
}

async function addAttachmentRefFromPicker(sel) {
  const id = sel.value;
  if (!id) return;
  if (!Array.isArray(window._attachmentRefs)) window._attachmentRefs = [];
  if (window._attachmentRefs.includes(id)) {
    sel.value = '';
    toast('That file is already attached to this worship aid.', 'error');
    return;
  }
  window._attachmentRefs.push(id);
  sel.value = '';
  renderAttachmentRefList();
  toast('File attached', 'success');
}

function removeAttachmentRef(id) {
  window._attachmentRefs = (window._attachmentRefs || []).filter(x => x !== id);
  renderAttachmentRefList();
}

async function renderAttachmentRefList() {
  const target = document.getElementById('attachmentRefList');
  if (!target) return;
  const ids = window._attachmentRefs || [];
  if (!ids.length) { target.innerHTML = '<p class="attachment-list-empty">No files attached yet.</p>'; return; }
  const lib = await getAttachmentCache();
  target.innerHTML = ids.map(id => {
    const a = lib.find(x => x.id === id);
    if (!a) return '<div class="attachment-card"><div class="info">Missing file (id ' + esc(id) + ') — it may have been deleted.</div><div class="actions"><button class="btn btn-outline btn-sm" onclick="removeAttachmentRef(\\'' + id + '\\')">Remove</button></div></div>';
    return '<div class="attachment-card">' +
      '<div class="info">' +
        '<div class="t"><span class="attachment-kind-pill">' + esc(ATTACHMENT_KIND_LABELS[a.kind] || a.kind) + '</span>' + esc(a.title || a.originalName) + '</div>' +
        '<div class="m">' + (a.composer ? esc(a.composer) + ' · ' : '') + esc(a.originalName) + '</div>' +
      '</div>' +
      '<div class="actions">' +
        '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Open</a>' +
        '<button class="btn btn-outline btn-sm" onclick="removeAttachmentRef(\\'' + a.id + '\\')">Remove</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Per-music-slot attachment quick-pick (for non-hymn fields like prelude,
// postlude, kyrie, anthems).  Shown next to the title input — picking an
// entry copies its title (and composer if known) into the music block,
// AND adds the attachment to the worship aid's reference list.
async function pickAttachmentIntoMusicSlot(prefix, slotKey, kind) {
  const lib = await getAttachmentCache();
  const matching = lib.filter(a => a.kind === kind);
  if (!matching.length) {
    toast('No ' + (ATTACHMENT_KIND_LABELS[kind] || kind) + 's in the library yet. Upload one in Settings.', 'error');
    return;
  }
  const sel = document.getElementById(prefix + '_' + slotKey + '_attachmentSelect');
  if (!sel) return;
  const a = matching.find(x => x.id === sel.value);
  if (!a) return;
  const titleInput = document.getElementById(prefix + '_' + slotKey);
  if (titleInput) {
    titleInput.value = a.title || a.originalName;
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const composerId = titleInput && titleInput.dataset.pairComposer;
  if (composerId && a.composer) {
    const cinp = document.getElementById(composerId);
    if (cinp) { cinp.value = a.composer; cinp.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  if (!Array.isArray(window._attachmentRefs)) window._attachmentRefs = [];
  if (!window._attachmentRefs.includes(a.id)) window._attachmentRefs.push(a.id);
  renderAttachmentRefList();
  sel.value = '';
}

async function refreshAttachmentSlotSelectors() {
  const lib = await getAttachmentCache(true);
  document.querySelectorAll('select[data-attachment-slot]').forEach(sel => {
    const kind = sel.dataset.attachmentKind;
    const matches = lib.filter(a => a.kind === kind);
    const prev = sel.value;
    sel.innerHTML = '<option value="">— ' + (matches.length ? 'pick from library' : 'no files yet') + ' —</option>' +
      matches.map(a => '<option value="' + esc(a.id) + '">' + esc(a.title || a.originalName) + (a.composer ? ' — ' + esc(a.composer) : '') + '</option>').join('');
    if (prev) sel.value = prev;
  });
}

async function uploadAttachmentFromSettings(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const status = document.getElementById('att_uploadStatus');
  if (status) status.textContent = 'Uploading ' + file.name + '…';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', v('att_title') || file.name.replace(/\\.[^.]+$/, ''));
  fd.append('composer', v('att_composer'));
  fd.append('kind', v('att_kind') || 'general');
  fd.append('tags', v('att_tags'));
  try {
    const res = await fetch('/api/attachments', { method: 'POST', headers: { 'x-session-token': _sessionToken }, body: fd });
    const data = await res.json();
    if (!res.ok) { if (status) status.textContent = ''; toast(data.error || 'Upload failed', 'error'); return; }
    if (status) status.textContent = 'Uploaded: ' + (data.title || data.originalName);
    sv('att_title', ''); sv('att_composer', ''); sv('att_tags', '');
    input.value = '';
    await loadAttachmentList();
    await refreshAttachmentPicker();
    await refreshAttachmentSlotSelectors();
    toast('File added to library', 'success');
  } catch (e) {
    if (status) status.textContent = '';
    toast('Upload error: ' + e.message, 'error');
  }
}

async function loadAttachmentList() {
  const list = document.getElementById('att_list');
  if (!list) return;
  const kind = v('att_filter_kind');
  const url = '/api/attachments' + (kind ? '?kind=' + encodeURIComponent(kind) : '');
  try {
    const res = await fetch(url);
    const data = await res.json();
    const items = (data && data.attachments) || [];
    if (!items.length) { list.innerHTML = '<p class="attachment-list-empty">No files yet. Upload one above.</p>'; return; }
    list.innerHTML = items.map(a => {
      return '<div class="attachment-card">' +
        '<div class="info">' +
          '<div class="t"><span class="attachment-kind-pill">' + esc(ATTACHMENT_KIND_LABELS[a.kind] || a.kind) + '</span>' + esc(a.title || a.originalName) + '</div>' +
          '<div class="m">' + (a.composer ? esc(a.composer) + ' · ' : '') + esc(a.originalName) + ' · ' + Math.round((a.size || 0) / 1024) + ' KB</div>' +
        '</div>' +
        '<div class="actions">' +
          '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Open</a>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteAttachment(\\'' + a.id + '\\')">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<p class="attachment-list-empty">Could not load library.</p>';
  }
}

async function deleteAttachment(id) {
  if (!confirm('Delete this file from the library? Worship aids that reference it will show "missing".')) return;
  await fetch('/api/attachments/' + id, { method: 'DELETE', headers: { 'x-session-token': _sessionToken } });
  await loadAttachmentList();
  await refreshAttachmentPicker();
  await refreshAttachmentSlotSelectors();
  toast('File removed', 'success');
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

async function uploadLogo(input) {
  if (!input.files || !input.files[0]) return;
  const formData = new FormData();
  formData.append('image', input.files[0]);
  try {
    const res = await fetch('/api/upload/logo', {
      method: 'POST', headers: { 'x-session-token': _sessionToken }, body: formData
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
    sv('s_logoPath', data.url);
    document.getElementById('logo-preview').innerHTML = '<img src="' + data.url + '" class="image-preview" style="max-height:80px;background:#fff;padding:4px;border:1px solid var(--border);" alt="logo">';
    if (window._parishSettings) window._parishSettings.logoPath = data.url;
    toast('Parish logo uploaded', 'success');
  } catch(e) { toast('Upload error', 'error'); }
  input.value = '';
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
    const sel = document.getElementById('bookletSize');
    if (sel) data.bookletSize = sel.value;
    const res = await fetch('/api/generate-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken }, body: JSON.stringify(data) });
    if (!res.ok) {
      const result = await res.json();
      toast('Error: ' + (result.error || ''), 'error'); setStatus('Export blocked'); return;
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      // Direct PDF download (Netlify)
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const cd = res.headers.get('content-disposition') || '';
      const fnMatch = cd.match(/filename="?([^"]+)"?/);
      const filename = fnMatch ? fnMatch[1] : 'worship-aid.pdf';
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      toast('PDF exported: ' + filename, 'success');
    } else {
      // JSON response with download URL (local)
      const result = await res.json();
      const a = document.createElement('a'); a.href = result.downloadUrl; a.download = result.filename; a.click();
      toast('PDF exported: ' + result.filename, 'success');
    }
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

// --- Stats ---
async function loadStats() {
  const list = document.getElementById('stats-list');
  const summary = document.getElementById('stats-summary');
  list.innerHTML = '<p style="color:var(--gray);font-style:italic;">Loading…</p>';
  try {
    const res = await fetch('/api/stats/hymns');
    if (!res.ok) {
      list.innerHTML = '<p style="color:var(--error);">Could not load stats.</p>';
      return;
    }
    const data = await res.json();
    summary.textContent = data.totalDrafts + ' draft' + (data.totalDrafts === 1 ? '' : 's') + ' analyzed · ' + data.hymns.length + ' distinct hymn' + (data.hymns.length === 1 ? '' : 's') + ' used.';
    if (!data.hymns.length) {
      list.innerHTML = '<p style="color:var(--gray);font-style:italic;">No hymn usage yet — save a draft with music titles and refresh.</p>';
      return;
    }
    const seasonOrder = ['advent', 'christmas', 'lent', 'easter', 'ordinary', 'unknown'];
    const seasonLabel = { advent: 'Advent', christmas: 'Christmas', lent: 'Lent', easter: 'Easter', ordinary: 'Ordinary', unknown: '?' };
    list.innerHTML =
      '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="text-align:left;border-bottom:2px solid var(--border);">' +
          '<th style="padding:6px 8px;">Hymn</th>' +
          '<th style="padding:6px 8px;width:60px;text-align:center;">Total</th>' +
          '<th style="padding:6px 8px;">By season</th>' +
          '<th style="padding:6px 8px;">By month</th>' +
        '</tr></thead><tbody>' +
        data.hymns.map(h => {
          const seasons = seasonOrder
            .filter(s => h.bySeason[s])
            .map(s => '<span style="display:inline-block;margin-right:6px;">' + seasonLabel[s] + ': <strong>' + h.bySeason[s] + '</strong></span>')
            .join('');
          const months = Object.keys(h.byMonth).sort()
            .map(m => '<span style="display:inline-block;margin-right:6px;">' + esc(m) + ': <strong>' + h.byMonth[m] + '</strong></span>')
            .join('');
          return '<tr style="border-bottom:1px solid var(--border);">' +
            '<td style="padding:6px 8px;font-weight:600;">' + esc(h.title) + '</td>' +
            '<td style="padding:6px 8px;text-align:center;">' + h.total + '</td>' +
            '<td style="padding:6px 8px;color:var(--gray);">' + seasons + '</td>' +
            '<td style="padding:6px 8px;color:var(--gray);">' + months + '</td>' +
          '</tr>';
        }).join('') +
      '</tbody></table>';
  } catch (e) {
    list.innerHTML = '<p style="color:var(--error);">Error loading stats: ' + esc(e.message) + '</p>';
  }
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
const settingsFields = [
  'parishName','parishAddress','parishPhone','parishUrl','coverTagline','logoPath',
  'massTimes','pastor','pastorTitle','associates','deacons','musicDirector',
  'welcomeMessage','closingMessage','defaultSanctusLanguage',
  'connectBlurb','nurseryBlurb','restroomsBlurb','prayerBlurb',
  'onelicenseNumber','copyrightShort','copyrightFull'
];
const settingsCheckboxes = ['requirePastorApproval'];
async function loadAdminSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  settingsFields.forEach(f => sv('s_' + f, s[f]));
  settingsCheckboxes.forEach(f => sc('s_' + f, s[f]));
  if (s.logoPath) {
    const lp = document.getElementById('logo-preview');
    if (lp) lp.innerHTML = '<img src="' + s.logoPath + '" class="image-preview" style="max-height:80px;background:#fff;padding:4px;border:1px solid var(--border);" alt="logo">';
  }
  window._parishSettings = s;
  try {
    const hr = await fetch('/api/hymns');
    const lib = await hr.json();
    sv('s_hymnLibrary', JSON.stringify(lib.entries || [], null, 2));
  } catch (e) {}
  // Attachments library list lives on the same Settings page.
  loadAttachmentList();
}

async function saveHymnLibrary() {
  const status = document.getElementById('s_hymnLibraryStatus');
  let entries;
  try {
    entries = JSON.parse(v('s_hymnLibrary') || '[]');
  } catch (e) {
    if (status) status.textContent = 'Invalid JSON: ' + e.message;
    toast('Invalid JSON', 'error');
    return;
  }
  try {
    const res = await fetch('/api/hymns', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify({ entries })
    });
    const data = await res.json();
    if (!res.ok) { if (status) status.textContent = data.error || 'Save failed'; toast(data.error || 'Save failed', 'error'); return; }
    if (status) status.textContent = 'Saved ' + data.entries.length + ' hymns';
    toast('Hymn library saved', 'success');
    invalidateHymnCache();
    getHymnCache();
  } catch (e) {
    if (status) status.textContent = 'Error: ' + e.message;
  }
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
    document.getElementById('user-list').innerHTML = users.map(u => {
      const googleBadge = u.googleEmail
        ? '<span style="font-size:10px;color:var(--success);margin-left:4px;" title="Google login enabled">&#x2713; Google</span>'
        : '';
      return '<div class="user-card">' +
        '<div class="info">' +
          '<h3>' + esc(u.displayName) + ' <span class="role-badge ' + u.role + '">' + (roleLabels[u.role] || u.role) + '</span>' + googleBadge + '</h3>' +
          '<p>Username: ' + esc(u.username) + (u.googleEmail ? ' &bull; Google: ' + esc(u.googleEmail) : '') + ' &bull; Created ' + new Date(u.createdAt).toLocaleDateString() + '</p>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn btn-outline btn-sm" onclick="editGoogleEmail(\\'' + u.id + '\\', \\'' + esc(u.googleEmail || '') + '\\')">' + (u.googleEmail ? 'Edit' : 'Link') + ' Google</button>' +
          '<button class="btn btn-danger btn-sm" onclick="removeUser(\\'' + u.id + '\\')">Remove</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) { console.error(e); }
}

async function addUser() {
  const data = {
    username: v('new_username'),
    displayName: v('new_displayName'),
    role: v('new_role'),
    password: v('new_password'),
    googleEmail: v('new_googleEmail') || undefined
  };
  try {
    const res = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify(data)
    });
    if (!res.ok) { const err = await res.json(); toast(err.error || 'Error', 'error'); return; }
    toast('User added', 'success');
    sv('new_username', ''); sv('new_displayName', ''); sv('new_password', ''); sv('new_googleEmail', '');
    loadUsers();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function editGoogleEmail(userId, currentEmail) {
  const email = prompt('Enter Google email address for this user (or leave blank to remove):', currentEmail);
  if (email === null) return; // cancelled
  try {
    const res = await fetch('/api/users/' + userId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify({ googleEmail: email.trim() || '' })
    });
    if (!res.ok) { toast('Failed to update', 'error'); return; }
    toast(email.trim() ? 'Google email linked' : 'Google email removed', 'success');
    loadUsers();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function removeUser(id) {
  if (!confirm('Remove this user?')) return;
  await fetch('/api/users/' + id, { method: 'DELETE', headers: { 'x-session-token': _sessionToken } });
  loadUsers();
}

// --- Bible translations + USCCB readings lookup ---
async function initBibleTranslations() {
  const sel = document.getElementById('bibleTranslation');
  if (!sel || sel.dataset.loaded) return;
  try {
    const res = await fetch('/api/bible-translations');
    const list = await res.json();
    sel.innerHTML = list.map(t =>
      '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>'
    ).join('');
    sel.dataset.loaded = '1';
  } catch (e) {
    sel.innerHTML = '<option value="NABRE">NABRE (Lectionary, USCCB)</option>';
  }
}

async function fetchReadingsFromUsccb(opts) {
  opts = opts || {};
  const silent = !!opts.silent;
  const date = v('liturgicalDate');
  const status = document.getElementById('fetchReadingsStatus');
  if (!date) {
    if (silent) return;
    if (status) status.textContent = 'Set a liturgical date first.';
    toast('Set a liturgical date first', 'error');
    return;
  }
  const transSel = document.getElementById('bibleTranslation');
  const translation = (transSel && transSel.value) || 'NABRE';
  const btn = document.getElementById('fetchReadingsBtn');
  if (btn) btn.disabled = true;
  if (status) status.textContent = (silent ? 'Auto-fetching ' : 'Fetching ') + translation + '…';
  try {
    const res = await fetch('/api/readings?date=' + encodeURIComponent(date) + '&translation=' + encodeURIComponent(translation));
    const data = await res.json();
    if (!res.ok) {
      if (status) status.textContent = '';
      if (!silent) toast(data.error || 'Lookup failed', 'error');
      return;
    }
    sv('firstReadingCitation', data.firstReadingCitation);
    sv('firstReadingText',     data.firstReadingText);
    sv('psalmCitation',        data.psalmCitation);
    sv('psalmRefrain',         data.psalmRefrain);
    sv('psalmVerses',          data.psalmVerses);
    sv('secondReadingCitation', data.secondReadingCitation);
    sv('secondReadingText',     data.secondReadingText);
    const noSecond = document.getElementById('noSecondReading');
    if (noSecond) noSecond.checked = !!data.noSecondReading;
    sv('gospelAcclamationReference', data.gospelAcclamationReference);
    sv('gospelAcclamationVerse',     data.gospelAcclamationVerse);
    sv('gospelCitation', data.gospelCitation);
    sv('gospelText',     data.gospelText);
    if (status) status.textContent = (silent ? 'Auto-loaded ' : 'Loaded ') + (data.translation || translation) + ' (you can edit any field).';
    if (!silent) toast('Readings loaded from USCCB', 'success');
  } catch (e) {
    if (status) status.textContent = '';
    if (!silent) toast('Lookup error: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- Hymn library autocomplete ---
// Attach a typeahead to every input flagged with [data-hymn-search="title"].
// Results show title, tune, composer, and key so the user can choose the
// arrangement that fits the parish.
//
// The library is fetched ONCE at startup and cached in memory. Every keystroke
// filters the cache synchronously — no debounce, no network call, instant.
let _hymnCache = null;
let _hymnCachePromise = null;

function getHymnCache() {
  if (_hymnCache) return Promise.resolve(_hymnCache);
  if (_hymnCachePromise) return _hymnCachePromise;
  _hymnCachePromise = fetch('/api/hymns')
    .then(r => r.ok ? r.json() : { entries: [] })
    .then(lib => {
      _hymnCache = (lib && Array.isArray(lib.entries)) ? lib.entries.filter(e => (e.language || 'en') === 'en') : [];
      return _hymnCache;
    })
    .catch(() => { _hymnCache = []; return _hymnCache; });
  return _hymnCachePromise;
}

function invalidateHymnCache() { _hymnCache = null; _hymnCachePromise = null; }

function searchHymnsLocal(q, limit) {
  const entries = _hymnCache || [];
  const norm = s => String(s || '').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  const query = norm(q).trim();
  if (!query) return entries.slice(0, limit);
  const scored = [];
  for (const e of entries) {
    const title = norm(e.title);
    const tune  = norm(e.tune);
    const composer = norm(e.composer);
    let score = 0;
    if (title.startsWith(query))    score += 100;
    else if (title.includes(query)) score += 50;
    if (tune.startsWith(query))     score += 80;
    else if (tune.includes(query))  score += 40;
    if (composer.includes(query))   score += 10;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(r => r.e);
}

function initHymnAutocomplete() {
  // Pre-warm the cache so the first keystroke is instant
  getHymnCache();
  document.addEventListener('input', e => {
    const t = e.target;
    if (!t || t.dataset.hymnSearch !== 'title') return;
    const q = t.value.trim();
    if (!q) { closeHymnDropdown(); return; }
    runHymnSearch(t, q);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest('.hymn-dropdown') && !(e.target.dataset && e.target.dataset.hymnSearch)) {
      closeHymnDropdown();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeHymnDropdown();
  });
}

async function runHymnSearch(input, q) {
  if (_hymnCache) {
    showHymnDropdown(input, searchHymnsLocal(q, 8));
    return;
  }
  // Cache still loading on first keystroke — wait, then filter
  await getHymnCache();
  // The user may have kept typing; re-read the input value
  const latestQ = input.value.trim();
  if (!latestQ) { closeHymnDropdown(); return; }
  showHymnDropdown(input, searchHymnsLocal(latestQ, 8));
}

function closeHymnDropdown() {
  document.querySelectorAll('.hymn-dropdown').forEach(d => d.remove());
}

function showHymnDropdown(input, results) {
  closeHymnDropdown();
  if (!results.length) return;
  const rect = input.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.className = 'hymn-dropdown';
  dd.style.cssText = 'position:absolute;z-index:1000;background:#fff;border:1px solid var(--border);border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-height:240px;overflow-y:auto;font-size:11px;width:' + Math.max(320, rect.width) + 'px;';
  dd.style.left = (window.scrollX + rect.left) + 'px';
  dd.style.top  = (window.scrollY + rect.bottom + 2) + 'px';
  results.forEach(h => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 8px;border-bottom:1px solid #eee;cursor:pointer;';
    row.onmouseover = () => row.style.background = '#f5f0e6';
    row.onmouseout  = () => row.style.background = '';
    row.innerHTML =
      '<div style="font-weight:600;">' + esc(h.title) + '</div>' +
      '<div style="color:var(--gray);">Tune: ' + esc(h.tune || '—') +
      ' · Key: ' + esc(h.key || '—') +
      (h.composer ? ' · ' + esc(h.composer) : '') + '</div>';
    row.onclick = () => {
      input.value = h.title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const composerId = input.dataset.pairComposer;
      if (composerId && h.composer) {
        const cinp = document.getElementById(composerId);
        if (cinp && !cinp.value) { cinp.value = h.composer; cinp.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      closeHymnDropdown();
    };
    dd.appendChild(row);
  });
  document.body.appendChild(dd);
}

// Module state above is now initialized — safe to run inits (avoids
// Temporal Dead Zone for the let-declared hymn cache).
initBibleTranslations();
suggestNextLiturgicalDate();
initHymnAutocomplete();
// Attachments lookup — populates editor picker + per-music-slot dropdowns
// so the user can pick a prelude/postlude/anthem from the library.
refreshAttachmentPicker();
refreshAttachmentSlotSelectors();
renderAttachmentRefList();

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

// --- Google Sign-In ---
async function initGoogleSignIn() {
  try {
    const res = await fetch('/api/auth/google-client-id');
    const data = await res.json();
    if (!data.clientId) return; // Google not configured, hide the option
    document.getElementById('google-signin-divider').style.display = '';
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.initialize({
        client_id: data.clientId,
        callback: handleGoogleCredential
      });
      google.accounts.id.renderButton(document.getElementById('google-signin-btn'), {
        theme: 'outline', size: 'large', width: 300, text: 'signin_with'
      });
    }
  } catch(e) { /* Google login not available */ }
}

async function handleGoogleCredential(response) {
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Google login failed'; errEl.style.display = 'block'; return; }
    _sessionToken = data.token;
    _currentUser = data.user;
    localStorage.setItem('wa_token', _sessionToken);
    showApp();
  } catch(e) { errEl.textContent = 'Connection error'; errEl.style.display = 'block'; }
}

// --- Init ---
checkAuth();
// Init Google after a short delay to let the GSI library load
setTimeout(initGoogleSignIn, 500);
</script>
</body>
</html>`;
}

// Helper: generates the per-mass-time music fields HTML.
//
// The third tuple entry is the source — 'hymn' wires the hymn-library
// autocomplete; an attachment-kind string (e.g. 'prelude') wires a quick-pick
// dropdown sourced from the parish attachments library instead.  Postludes,
// preludes, anthems, and mass settings are NOT hymns and so don't pull from
// the hymn catalog.
function musicBlockFields(prefix) {
  const fields = [
    // [titleId, composerId, label, source]
    ['organPrelude',  'organPreludeComposer',  'Organ Prelude',                  'prelude'],
    ['processional',  'processionalComposer',  'Processional / Entrance',        'hymn'],
    ['kyrie',         'kyrieComposer',         'Lord, Have Mercy (Kyrie)',       'kyrie'],
    ['offertory',     'offertoryComposer',     'Offertory Anthem',               'offertory_anthem'],
    ['communion',     'communionComposer',     'Communion Hymn',                 'hymn'],
    ['thanksgiving',  'thanksgivingComposer',  'Hymn of Thanksgiving',           'hymn'],
    ['postlude',      'postludeComposer',      'Organ Postlude',                 'postlude'],
    ['choral',        'choralComposer',        'Choral Anthem (Concluding)',     'choral_anthem']
  ];
  return fields.map(([titleId, compId, label, source]) => {
    const titleAttrs = source === 'hymn'
      ? `data-hymn-search="title" data-pair-composer="${prefix}_${compId}"`
      : `data-pair-composer="${prefix}_${compId}"`;
    const helper = source === 'hymn'
      ? ''
      : `
        <div class="attachment-pick-row">
          <select data-attachment-slot="${prefix}_${titleId}" data-attachment-kind="${source}" id="${prefix}_${titleId}_attachmentSelect" onchange="pickAttachmentIntoMusicSlot('${prefix}', '${titleId}', '${source}')">
            <option value="">— pick from library —</option>
          </select>
        </div>`;
    const sourceLabel = source === 'hymn'
      ? '<span style="font-size:9px;color:var(--gray);">type to search hymns</span>'
      : `<span style="font-size:9px;color:var(--gray);">not a hymn — pulls from Music &amp; Document Library</span>`;
    return `
      <div class="fg-row">
        <div class="fg" style="position:relative;">
          <label>${label}</label>
          <input type="text" id="${prefix}_${titleId}" placeholder="Title" autocomplete="off" ${titleAttrs}>
          ${sourceLabel}
          ${helper}
        </div>
        <div class="fg"><label>&nbsp;</label><input type="text" id="${prefix}_${compId}" placeholder="Composer"></div>
      </div>
    `;
  }).join('');
}

module.exports = app;
module.exports.getAppHtml = getAppHtml;
module.exports.seedReady = _seedReady;
