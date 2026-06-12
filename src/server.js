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
const { normalizeNotationImage, CONVERTIBLE_EXTS, EMBEDDABLE_EXTS } = require('./image-utils');
const { resolveNotationImages, findMissingNotationSlots } = require('./notation-resolver');
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

// Multer config — memory storage everywhere. Uploads are post-processed
// (TIFF→PNG conversion, auto-crop) before being written to disk locally or
// to Netlify Blobs, so the original never needs to land on disk first.
// A rejected file type produces a descriptive 400 (handled by the upload
// error middleware below) instead of the old silent "No file uploaded".
function makeUploadConfig(allowedExts, maxSize) {
  return multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedExts.includes(ext)) return cb(null, true);
      const err = new Error(`File type "${ext || 'unknown'}" is not accepted here. Allowed: ${allowedExts.join(', ')}`);
      err.statusCode = 400;
      cb(err);
    },
    limits: { fileSize: maxSize }
  });
}

// Notation images now accept TIFF (what OneLicense supplies) plus BMP and
// WebP — everything that isn't already PNG/JPEG is converted to PNG at
// upload time so browsers and the PDF embedder can render it.
const IMAGE_UPLOAD_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.tif', '.tiff', '.bmp', '.webp'];
const notationUpload = makeUploadConfig(IMAGE_UPLOAD_EXTS, 15 * 1024 * 1024);

const coverUpload = makeUploadConfig(['.png', '.jpg', '.jpeg'], 10 * 1024 * 1024);

const logoUpload = makeUploadConfig(['.png', '.jpg', '.jpeg'], 5 * 1024 * 1024);

// Attachments: notation images first and foremost (PNG/JPG/TIFF), plus
// audio / PDF / score files the parish wants reused.
// Keep the size cap generous so MP3 anthems and full PDF scores still fit.
const attachmentUpload = makeUploadConfig(
  [
    ...IMAGE_UPLOAD_EXTS,
    '.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac',
    '.pdf',
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

// Health endpoint — reports whether the KV backend is properly persisting.
// Useful for diagnosing the "Settings keep getting reset" / "Not authenticated"
// failure modes that happen when Netlify Blobs aren't configured and the
// in-memory fallback drops state between Lambda invocations.
app.get('/api/health', async (req, res) => {
  const out = {
    ok: true,
    timestamp: new Date().toISOString(),
    environment: kv.IS_NETLIFY ? 'netlify' : 'local',
    persistence: kv.IS_NETLIFY ? 'unknown' : 'filesystem'
  };
  if (kv.IS_NETLIFY) {
    try {
      const probeKey = '_health-probe';
      await kv.set('_health', probeKey, { t: Date.now() });
      const back = await kv.get('_health', probeKey);
      out.persistence = back ? 'netlify-blobs' : 'in-memory';
      out.persistsAcrossInvocations = !!back;
    } catch (e) {
      out.persistence = 'in-memory';
      out.persistsAcrossInvocations = false;
      out.persistenceError = e.message;
    }
  }
  if (out.persistence === 'in-memory') {
    out.warning = 'KV is using in-memory fallback — sessions, settings, and uploads will NOT persist across Lambda cold starts. Configure Netlify Blobs to fix this.';
  }
  res.json(out);
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
// `manage_attachments` permission can upload/delete; everyone can list.
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

app.post('/api/attachments', requireAuth, requirePermission('manage_attachments'), attachmentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let ext = path.extname(req.file.originalname).toLowerCase();
  let buffer = req.file.buffer;
  let mime = req.file.mimetype || guessMime(req.file.originalname);
  let converted = false;

  // ALL image attachments get the same normalization as notation uploads:
  // format conversion (TIFF → PNG), white-margin trim, and title-header
  // removal by default — library attachments can print in the booklet as
  // notation, so a title left on here would still reach the page. The
  // title detector requires a clear music staff, so it never crops
  // non-music images (logos, posters) — they still get the white-margin
  // trim and a re-encode like every other upload.
  if (CONVERTIBLE_EXTS.has(ext) || EMBEDDABLE_EXTS.has(ext)) {
    try {
      const processed = await normalizeNotationImage(buffer, ext, {
        stripTitle: req.body.stripTitle !== '0'
      });
      buffer = processed.buffer;
      ext = processed.ext;
      mime = processed.mime;
      converted = processed.converted;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const filename = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  if (kv.IS_NETLIFY) {
    await kv.set(attachmentsStore.BLOB_NS, filename, { data: buffer.toString('base64'), mime });
  } else {
    fs.writeFileSync(path.join(ATTACHMENTS_DIR, filename), buffer);
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
    size: buffer.length,
    converted,
    url,
    uploadedBy: req.user.displayName,
    uploadedAt: new Date().toISOString()
  });
  res.json(meta);
});

// Promote an uploaded notation image into the reusable Library (custom
// music, staff/clergy compositions). Copies the stored bytes into the
// attachments store with proper metadata; the original upload stays.
app.post('/api/attachments/from-notation', requireAuth, requirePermission('manage_attachments'), async (req, res) => {
  const src = String((req.body && req.body.filename) || '');
  if (src !== path.basename(src) || !kv.isSafeKey(src)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  let buffer = null;
  let mime = guessMime(src);
  if (kv.IS_NETLIFY) {
    const item = await kv.get('uploads-notation', src);
    if (item && item.data) { buffer = Buffer.from(item.data, 'base64'); mime = item.mime || mime; }
  } else {
    const filePath = path.join(NOTATION_DIR, src);
    if (fs.existsSync(filePath)) buffer = fs.readFileSync(filePath);
  }
  if (!buffer) return res.status(404).json({ error: 'Notation file not found' });

  const ext = path.extname(src) || '.png';
  const filename = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  if (kv.IS_NETLIFY) {
    await kv.set(attachmentsStore.BLOB_NS, filename, { data: buffer.toString('base64'), mime });
  } else {
    fs.writeFileSync(path.join(ATTACHMENTS_DIR, filename), buffer);
  }
  const meta = await attachmentsStore.saveAttachmentMeta({
    filename,
    originalName: src,
    title: String(req.body.title || '').trim() || src.replace(/\.[^.]+$/, ''),
    composer: String(req.body.composer || '').trim(),
    kind: String(req.body.kind || 'general'),
    tags: [],
    notes: 'Saved from uploaded notation',
    mime,
    size: buffer.length,
    url: kv.IS_NETLIFY ? `/api/uploads/attachments/${filename}` : `/uploads/attachments/${filename}`,
    uploadedBy: req.user.displayName,
    uploadedAt: new Date().toISOString()
  });
  res.json(meta);
});

app.put('/api/attachments/:id', requireAuth, requirePermission('manage_attachments'), async (req, res) => {
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

app.delete('/api/attachments/:id', requireAuth, requirePermission('manage_attachments'), async (req, res) => {
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

// Express decodes %2f in path params, so :filename can contain slashes /
// '..' segments — reject anything that isn't a plain filename before it
// touches the filesystem or KV layer.
function safeFilenameParam(req, res) {
  const raw = String(req.params.filename || '');
  if (raw !== path.basename(raw) || !kv.isSafeKey(raw)) {
    res.status(400).json({ error: 'Invalid filename' });
    return null;
  }
  return raw;
}

// Browsers execute script inside SVGs opened as documents. Uploads are
// parish-managed, but serve them with a sandbox CSP anyway so a malicious
// SVG can't run in the app's origin.
function setUploadHeaders(res, mime) {
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (/svg/i.test(mime)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

app.get('/api/uploads/attachments/:filename', async (req, res) => {
  const filename = safeFilenameParam(req, res);
  if (!filename) return;
  if (kv.IS_NETLIFY) {
    const item = await kv.get(attachmentsStore.BLOB_NS, filename);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const buf = Buffer.from(item.data, 'base64');
    setUploadHeaders(res, item.mime || guessMime(filename));
    return res.send(buf);
  }
  // Locally we serve via express.static('/uploads'); provide a fallback.
  const filePath = path.join(ATTACHMENTS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  setUploadHeaders(res, guessMime(filename));
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
  // Generic stock-photo sites (Unsplash, Pexels) returned worthless results
  // for liturgical subjects.  Point users at sources with substantial sacred
  // / Catholic art holdings instead — all permit free reuse for parish
  // bulletins and worship aids:
  //   * Wikimedia Commons      — public-domain icons, paintings, architecture
  //   * Web Gallery of Art     — Renaissance / Baroque religious painting
  //   * The Met (open access)  — open-access images, religious painting
  //     and sculpture from across the world
  //   * Vatican Museums        — search browser (no direct image API)
  const searchLinks = searchTerms.map(q => ({
    query: q,
    wikimedia: 'https://commons.wikimedia.org/w/index.php?search=' + encodeURIComponent(q) + '&title=Special:MediaSearch&go=Go&type=image',
    wga:       'https://www.wga.hu/cgi-bin/search.cgi?Search&Author=&Title=' + encodeURIComponent(q) + '&Comment=&Time=Any&School=Any&Form=Any&Type=Any&Technique=&Location=',
    met:       'https://www.metmuseum.org/art/collection/search?searchField=All&showOnly=openAccess&q=' + encodeURIComponent(q),
    vatican:   'https://www.museivaticani.va/content/museivaticani/en/search.html?q=' + encodeURIComponent(q)
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
  const bookletSize = req.body.bookletSize || req.query.bookletSize || 'tabloid';
  const data = { ...req.body };
  // A slot pointing at a deleted/never-persisted notation file would emit a
  // dead <img> — which the sandboxed preview iframe renders as an invisible
  // blank gap. Strip those references so the renderer falls back to the
  // paste box, exactly like the PDF path does, and say so in the warnings.
  const missingSlots = await findMissingNotationSlots(data);
  if (missingSlots.length) {
    data.notationImages = { ...data.notationImages };
    missingSlots.forEach(slot => delete data.notationImages[slot]);
  }
  const { html, warnings, pageWidth, pageHeight } = renderBookletHtml(data, {
    parishSettings: settings,
    bookletSize
  });
  missingSlots.forEach(slot => warnings.push(
    `The notation image attached to "${slot}" no longer exists on the server — showing the blank paste area instead. Re-upload and re-attach it.`));
  const overflows = detectOverflows(data);
  res.json({ html, warnings, overflows, bookletSize, pageWidth, pageHeight });
});

// Generate PDF
app.post('/api/generate-pdf', requireAuth, requirePermission('export_pdf'), async (req, res) => {
  try {
    const settings = await store.loadSettings();

    // Enforce pastor approval if enabled in settings. Unsaved content (no
    // id) can't have been approved, so it can't be exported either —
    // otherwise the gate could be bypassed by simply not saving.
    if (settings.requirePastorApproval) {
      if (!req.body.id) {
        return res.status(403).json({ error: 'Pastor approval required before export. Save the draft and submit it for approval first.' });
      }
      const draft = await store.loadDraft(req.body.id);
      if (!draft || draft.status !== 'approved') {
        return res.status(403).json({ error: 'Pastor approval required before export. Current status: ' + ((draft && draft.status) || 'draft') });
      }
    }

    const filename = buildFilename(req.body);
    const outputDir = kv.IS_NETLIFY ? '/tmp' : store.getExportsDir();
    const outputPath = path.join(outputDir, filename);
    const bookletSize = (req.body.bookletSize || req.query.bookletSize || 'tabloid');
    // Load any per-slot notation images so the PDF embeds them in the
    // reserved music areas (uploaded TIFFs were converted to PNG at upload).
    const notation = await resolveNotationImages(req.body);
    const result = await generatePdf(req.body, outputPath, {
      parishSettings: settings,
      bookletSize,
      notationImages: notation.images
    });
    if (notation.missing.length) {
      result.warnings.push('Notation images missing for: ' + notation.missing.join(', '));
    }

    // Every export lands in History as the week's FINAL: mark a saved
    // draft exported, or auto-save an unsaved one so the printed version
    // is never missing from the record.
    let exportedDraftId = req.body.id || null;
    if (req.body.id) {
      const draft = await store.loadDraft(req.body.id);
      if (draft) {
        draft.status = 'exported';
        draft.exportedAt = new Date().toISOString();
        await store.saveDraft(draft);
      }
    } else {
      try {
        const saved = await store.saveDraft({ ...req.body, status: 'exported', exportedAt: new Date().toISOString() });
        exportedDraftId = saved.id;
      } catch (e) {
        console.warn('[export] could not auto-save exported aid:', e.message);
      }
    }

    // Export log: one record per liturgical week, keyed by the liturgical
    // date so re-exports overwrite — hymn stats count what was actually
    // PRINTED (the last export of each week), not every draft ever saved.
    if (req.body.liturgicalDate && kv.isSafeKey(req.body.liturgicalDate)) {
      try {
        await kv.set('export-log', req.body.liturgicalDate, {
          liturgicalDate: req.body.liturgicalDate,
          feastName: req.body.feastName || '',
          liturgicalSeason: req.body.liturgicalSeason || '',
          exportedAt: new Date().toISOString(),
          exportedBy: req.user.displayName,
          draftId: exportedDraftId,
          musicSat5pm: req.body.musicSat5pm || {},
          musicSun9am: req.body.musicSun9am || {},
          musicSun11am: req.body.musicSun11am || {}
        });
      } catch (e) {
        console.warn('[export-log] could not record export:', e.message);
      }
    }

    // On Netlify, send the file directly; locally, return a download URL
    if (kv.IS_NETLIFY) {
      const pdfBuffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // The PDF body leaves no room for a JSON warnings list — carry the
      // generator's warnings in a header so the editor can still show them.
      if (result.warnings && result.warnings.length) {
        res.setHeader('X-Export-Warnings', encodeURIComponent(JSON.stringify(result.warnings)));
      }
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
// Notation images: normalize at upload (EXIF rotation, white-margin crop,
// TIFF/BMP/GIF/SVG/WebP → PNG) so every stored file is a PNG/JPEG that the
// HTML preview can display and the PDF generator can embed.
app.post('/api/upload/notation', requireAuth, requirePermission('upload_images'), notationUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();

  let processed;
  try {
    // stripTitle defaults ON: licensed notation usually arrives with a
    // title/composer header the parish was cropping out by hand. The
    // detector is conservative (clear staff + clear gap + real header
    // content, max 50% removed) and the editor checkbox can turn it off.
    processed = await normalizeNotationImage(req.file.buffer, ext, {
      stripTitle: req.body.stripTitle !== '0'
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Content de-dupe: uploading the same scan twice (very common — once per
  // slot, or retries) must NOT create another copy in the list. We index
  // processed-content hashes; a match reuses the already-stored file.
  const contentHash = require('crypto').createHash('sha256').update(processed.buffer).digest('hex');
  let filename = null;
  let deduped = false;
  try {
    const indexed = await kv.get('notation-hash-index', contentHash);
    if (indexed && indexed.filename) {
      const stillThere = kv.IS_NETLIFY
        ? !!(await kv.get('uploads-notation', indexed.filename))
        : fs.existsSync(path.join(NOTATION_DIR, indexed.filename));
      if (stillThere) { filename = indexed.filename; deduped = true; }
    }
  } catch (e) { /* index miss/corrupt — store normally */ }

  if (!filename) {
    filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${processed.ext}`;
    if (kv.IS_NETLIFY) {
      await kv.set('uploads-notation', filename, { data: processed.buffer.toString('base64'), mime: processed.mime });
    } else {
      fs.writeFileSync(path.join(NOTATION_DIR, filename), processed.buffer);
    }
    try { await kv.set('notation-hash-index', contentHash, { filename }); } catch (e) { /* best effort */ }
  }

  res.json({
    filename,
    url: kv.IS_NETLIFY ? `/api/uploads/notation/${filename}` : `/uploads/notation/${filename}`,
    originalName: req.file.originalname,
    converted: processed.converted,
    deduped,
    titleCropped: !!processed.titleCropped
  });
});

app.post('/api/upload/logo', requireAuth, requirePermission('manage_settings'), logoUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const filename = `logo-${Date.now()}${ext}`;
  if (kv.IS_NETLIFY) {
    await kv.set('uploads-covers', filename, { data: req.file.buffer.toString('base64'), mime: req.file.mimetype });
  } else {
    fs.writeFileSync(path.join(COVERS_DIR, filename), req.file.buffer);
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
  const ext = path.extname(req.file.originalname).toLowerCase();
  const filename = `cover-${Date.now()}${ext}`;
  if (kv.IS_NETLIFY) {
    await kv.set('uploads-covers', filename, { data: req.file.buffer.toString('base64'), mime: req.file.mimetype });
  } else {
    fs.writeFileSync(path.join(COVERS_DIR, filename), req.file.buffer);
  }
  res.json({
    filename,
    url: kv.IS_NETLIFY ? `/api/uploads/covers/${filename}` : `/uploads/covers/${filename}`,
    originalName: req.file.originalname
  });
});

app.get('/api/uploads/notation', async (req, res) => {
  if (kv.IS_NETLIFY) {
    // kv.list returns values (which lose the blob key) — use listKeys so
    // the response carries real filenames instead of 'unknown'.
    const keys = await kv.listKeys('uploads-notation');
    return res.json(keys.map(k => ({ filename: k, url: `/api/uploads/notation/${k}` })));
  }
  const files = fs.readdirSync(NOTATION_DIR).filter(f => !f.startsWith('.')).map(f => ({
    filename: f,
    url: `/uploads/notation/${f}`
  }));
  res.json(files);
});

// Where has each notation image printed before? Walks saved drafts newest-
// first and reports, per image URL, the most recent slot it was assigned to.
// Drives the "last printed in …" hints and the use-it-again defaults in the
// editor's Notation Images list.
app.get('/api/notation-usage', requireAuth, async (req, res) => {
  try {
    const drafts = await kv.list('drafts');
    drafts.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const byUrl = {};
    for (const d of drafts) {
      const map = d.notationImages || {};
      for (const [slot, url] of Object.entries(map)) {
        if (!url || byUrl[url]) continue; // newest draft wins
        byUrl[url] = {
          slot,
          liturgicalDate: d.liturgicalDate || '',
          feastName: d.feastName || ''
        };
      }
    }
    res.json({ byUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove an uploaded notation image. Drafts that still reference it keep
// working — the preview/PDF fall back to the paste box with a warning.
app.delete('/api/uploads/notation/:filename', requireAuth, requirePermission('upload_images'), async (req, res) => {
  const filename = safeFilenameParam(req, res);
  if (!filename) return;
  // Clear the content-hash index entry first so a future identical upload
  // doesn't follow a stale pointer (the dedupe re-checks existence anyway,
  // so a failure here only costs a redundant re-store).
  try {
    let buf = null;
    if (kv.IS_NETLIFY) {
      const item = await kv.get('uploads-notation', filename);
      if (item && item.data) buf = Buffer.from(item.data, 'base64');
    } else {
      const filePath = path.join(NOTATION_DIR, filename);
      if (fs.existsSync(filePath)) buf = fs.readFileSync(filePath);
    }
    if (buf) {
      const hash = require('crypto').createHash('sha256').update(buf).digest('hex');
      await kv.del('notation-hash-index', hash);
    }
  } catch (e) { /* best effort */ }
  if (kv.IS_NETLIFY) {
    await kv.del('uploads-notation', filename);
  } else {
    const filePath = path.join(NOTATION_DIR, filename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {
      return res.status(500).json({ error: 'Could not delete: ' + e.message });
    }
  }
  res.json({ success: true });
});

// Serve uploaded images from Blobs on Netlify
app.get('/api/uploads/notation/:filename', async (req, res) => {
  const filename = safeFilenameParam(req, res);
  if (!filename) return;
  const item = await kv.get('uploads-notation', filename);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const buf = Buffer.from(item.data, 'base64');
  setUploadHeaders(res, item.mime || guessMime(filename));
  res.send(buf);
});

app.get('/api/uploads/covers', async (req, res) => {
  if (kv.IS_NETLIFY) {
    const keys = await kv.listKeys('uploads-covers');
    return res.json(keys.map(k => ({ filename: k, url: `/api/uploads/covers/${k}` })));
  }
  const files = fs.readdirSync(COVERS_DIR).filter(f => !f.startsWith('.')).map(f => ({
    filename: f,
    url: `/uploads/covers/${f}`
  }));
  res.json(files);
});

app.get('/api/uploads/covers/:filename', async (req, res) => {
  const filename = safeFilenameParam(req, res);
  if (!filename) return;
  const item = await kv.get('uploads-covers', filename);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const buf = Buffer.from(item.data, 'base64');
  setUploadHeaders(res, item.mime || guessMime(filename));
  res.send(buf);
});

// --- DRAFTS ---
// All draft routes require a signed-in user: drafts are parish content and
// the delete route is destructive.
app.post('/api/drafts', requireAuth, async (req, res) => {
  try {
    const draft = await store.saveDraft(req.body);
    res.json(draft);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/drafts', requireAuth, async (req, res) => {
  const drafts = await store.listDrafts();
  // FINAL = the draft whose export is the one recorded for its week
  // (export-log keeps only the last export per liturgical date).
  try {
    const log = await kv.list('export-log');
    const finalByDate = {};
    log.forEach(r => { if (r.liturgicalDate) finalByDate[r.liturgicalDate] = r; });
    drafts.forEach(d => {
      const rec = finalByDate[d.liturgicalDate];
      d.isFinal = !!(rec && rec.draftId && rec.draftId === d.id);
      if (rec && rec.draftId === d.id) d.finalExportedAt = rec.exportedAt;
    });
  } catch (e) { /* history still works without final flags */ }
  res.json(drafts);
});

app.get('/api/drafts/:id', requireAuth, async (req, res) => {
  const draft = await store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

app.delete('/api/drafts/:id', requireAuth, async (req, res) => {
  await store.deleteDraft(req.params.id);
  res.json({ success: true });
});

app.post('/api/drafts/:id/duplicate', requireAuth, async (req, res) => {
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

// Manually mark a draft as the week's FINAL (overrides which export is the
// version of record — e.g. when the truly-printed file came from elsewhere).
// Open to any signed-in user by design.
app.post('/api/drafts/:id/mark-final', requireAuth, async (req, res) => {
  const draft = await store.loadDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (!draft.liturgicalDate || !kv.isSafeKey(draft.liturgicalDate)) {
    return res.status(400).json({ error: 'Draft needs a liturgical date before it can be FINAL' });
  }
  await kv.set('export-log', draft.liturgicalDate, {
    liturgicalDate: draft.liturgicalDate,
    feastName: draft.feastName || '',
    liturgicalSeason: draft.liturgicalSeason || '',
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.displayName,
    manual: true,
    draftId: draft.id,
    musicSat5pm: draft.musicSat5pm || {},
    musicSun9am: draft.musicSun9am || {},
    musicSun11am: draft.musicSun11am || {}
  });
  res.json({ success: true, draftId: draft.id, liturgicalDate: draft.liturgicalDate });
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
    // Stats reflect what was actually PRINTED: one export-log record per
    // liturgical week (last export of that week wins), not every saved
    // draft revision.
    const drafts = await kv.list('export-log');
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
    res.json({ totalDrafts: drafts.length, totalWeeks: drafts.length, hymns: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SETTINGS ---
app.get('/api/settings', async (req, res) => {
  res.json(await store.loadSettings());
});

app.put('/api/settings', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const settings = await store.saveSettings(req.body);
  res.json(settings);
});

// --- PER-USER PREFERENCES ---
// These persist across drafts for the same user — preferred booklet size,
// default Sanctus language override, last-used hymnal, etc.  Distinct from
// the parish-wide /api/settings.
app.get('/api/user-prefs', requireAuth, async (req, res) => {
  res.json(await userStore.getUserPrefs(req.user.id));
});

app.put('/api/user-prefs', requireAuth, async (req, res) => {
  const prefs = await userStore.setUserPrefs(req.user.id, req.body || {});
  res.json(prefs);
});

// --- SAMPLE ---
app.get('/api/sample', (req, res) => {
  // Candidate paths cover the local checkout AND the Netlify bundle, where
  // __dirname is the bundled function dir and included_files live under
  // process.cwd() (/var/task).
  const candidates = [
    path.join(__dirname, '..', 'sample', 'second-sunday-lent.json'),
    path.join(process.cwd(), 'sample', 'second-sunday-lent.json'),
    path.join(__dirname, '..', '..', 'sample', 'second-sunday-lent.json')
  ];
  for (const samplePath of candidates) {
    try {
      if (fs.existsSync(samplePath)) {
        return res.json(JSON.parse(fs.readFileSync(samplePath, 'utf8')));
      }
    } catch (e) { /* try next */ }
  }
  res.status(404).json({ error: 'Sample not found' });
});

// --- UPLOAD ERROR HANDLER ---
// Multer rejections (bad file type, file too large) and any other route
// error become a descriptive JSON message instead of the generic "No file
// uploaded" / HTML error page the beta testers hit.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const note = kv.IS_NETLIFY
      ? ' Note: the hosted site cannot accept uploads over ~4.5 MB — downscale the image or save it at a lower resolution and try again.'
      : '';
    return res.status(413).json({ error: 'That file is too large.' + note });
  }
  if (err && (err.statusCode || err.status)) {
    return res.status(err.statusCode || err.status).json({ error: err.message });
  }
  if (err) {
    console.error('[ERROR]', req.method, req.path, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
  next();
});

// --- MAIN UI ---
app.get('/', (req, res) => res.send(getAppHtml()));
app.get('/login', (req, res) => res.send(getAppHtml()));
app.get('/admin', (req, res) => res.send(getAppHtml()));
app.get('/history', (req, res) => res.send(getAppHtml()));
app.get('/library', (req, res) => res.send(getAppHtml()));
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

/* Outline buttons sitting in the dark navy nav need light text + a visible
   border so they don't disappear ("Load Sample", "Save Draft", "Logout"). */
nav .btn-outline { color: rgba(255,255,255,0.92); border-color: rgba(255,255,255,0.55); background: rgba(255,255,255,0.04); }
nav .btn-outline:hover { color: var(--white); border-color: var(--gold-light); background: rgba(255,255,255,0.12); }

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

/* Preview — size matches the selected booklet trim so the preview is a
   true-scale rendering of the exported PDF.  Width is set inline by the
   preview generator based on the current bookletSize. */
.preview-frame { background: white; margin: 0 auto 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); border-radius: 2px; max-width: 100%; }
.preview-frame iframe { width: 100%; border: none; }

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
.status-badge.final { background: var(--gold); color: #fff; letter-spacing: 0.5px; }
.notation-lib-pill { display: inline-block; background: #e8d5f5; color: var(--purple); font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.attachment-card img.att-thumb { max-height: 56px; max-width: 110px; border: 1px solid var(--border); border-radius: 3px; background: #fff; cursor: zoom-in; }

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

/* Children's Liturgy mass-time checkboxes — wrap inline */
.children-liturgy-times { display: flex; flex-wrap: wrap; gap: 12px 16px; margin-bottom: 4px; }
.children-liturgy-times .fg-check { margin-bottom: 0; }

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
.notation-row { background: white; border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.notation-row img { max-height: 72px; max-width: 150px; border: 1px solid var(--border); border-radius: 3px; background: #fff; flex-shrink: 0; cursor: zoom-in; }
.notation-last { font-size: 9px; color: var(--gray); white-space: nowrap; }
.notation-last button { font-size: 9px; padding: 1px 6px; margin-left: 3px; border: 1px solid var(--gold); border-radius: 8px; background: #fdf8ec; color: #7a5f1a; cursor: pointer; }
.notation-last button:hover { background: var(--gold); color: #fff; }
/* Floating zoom preview — notation thumbnails are unreadable at list size,
   so hovering any of them shows the image near full size. */
#notation-zoom { position: fixed; z-index: 600; pointer-events: none; background: #fff; border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 8px 28px rgba(0,0,0,0.3); padding: 6px; display: none; }
#notation-zoom img { display: block; max-width: min(620px, 62vw); max-height: 72vh; }
.notation-row .fn { font-size: 10px; color: var(--gray); flex: 1; min-width: 80px; word-break: break-all; }
.notation-row select { font-size: 11px; padding: 3px 4px; max-width: 200px; }
.notation-use-pill { display: inline-block; background: #eef0e6; color: #5a5a3a; font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 8px; margin: 1px 2px 1px 0; white-space: nowrap; }
.notation-use-pill button { background: none; border: none; cursor: pointer; color: #5a5a3a; font-size: 11px; padding: 0 0 0 2px; line-height: 1; }
.attachment-pick-row { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; margin-top: 2px; }
.attachment-pick-row select { font-size: 11px; padding: 4px 6px; min-width: 0; }
.attachment-pick-row a { font-size: 10px; color: var(--gold); text-decoration: none; white-space: nowrap; }
.attachment-pick-row a:hover { text-decoration: underline; }

/* Anthem rows — one row per anthem with per-Mass checkboxes. */
.anthem-row { background: var(--parchment); border: 1px solid var(--border); border-radius: 4px; padding: 6px; margin-bottom: 6px; }
.anthem-row .anthem-inputs { display: grid; grid-template-columns: 3fr 2fr; gap: 4px; margin-bottom: 4px; }
.anthem-row input[type="text"] { width: 100%; padding: 5px 7px; border: 1px solid var(--border); border-radius: 3px; font-size: 12px; }
.anthem-row .anthem-masses { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; }
.anthem-row .anthem-masses label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.anthem-row .anthem-remove { margin-left: auto; background: none; border: none; color: var(--gray); cursor: pointer; font-size: 13px; padding: 0 4px; }
.anthem-row .anthem-remove:hover { color: var(--error); }

/* Per-slot notation attach control: upload button + existing-image picker + thumbnail. */
.notation-ctl { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.notation-ctl .btn { padding: 3px 8px; font-size: 10px; }
.notation-ctl select { font-size: 10px; padding: 3px 5px; max-width: 150px; }
.notation-thumb { display: inline-flex; align-items: center; gap: 4px; }
.notation-thumb img { height: 40px; border: 1px solid var(--border); border-radius: 2px; background: #fff; cursor: zoom-in; }
.notation-thumb button { background: none; border: none; color: var(--error); cursor: pointer; font-size: 12px; padding: 0 2px; }

/* Storage health warning — shown when the server is running on the lossy
   in-memory fallback (Netlify Blobs not connected). */
.storage-warning { background: #c0392b; color: #fff; font-size: 12px; padding: 8px 16px; text-align: center; }
.storage-warning a { color: #ffd9d2; }

/* Service-music carryover */
.carryover-note { font-size: 11px; color: var(--success); margin: 2px 0 8px; }
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
  <a href="/library" class="nav-link" data-page="library" id="nav-library" style="display:none;">Library</a>
  <a href="/stats" class="nav-link" data-page="stats">Stats</a>
  <a href="/admin" class="nav-link" data-page="admin" id="nav-admin">Settings</a>
  <a href="/users" class="nav-link" data-page="users" id="nav-users" style="display:none;">Users</a>
  <span class="spacer"></span>
  <span class="user-info" id="user-display"></span>
  <button class="btn btn-outline btn-sm" id="btn-restore" style="display:none;" onclick="restoreSnapshot()" title="Bring back what you were working on before the page reloaded">&#10226; Restore last session</button>
  <button class="btn btn-outline btn-sm" onclick="loadSample()">Load Sample</button>
  <button class="btn btn-outline btn-sm" onclick="saveDraft()">Save Draft</button>
  <select id="bookletSize" class="btn-sm" style="margin-right:6px;padding:4px 6px;font-size:11px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:3px;" title="Booklet trim size — saved per user" onchange="saveUserPrefs({ bookletSize: this.value })">
    <option value="tabloid" selected>8.5×11 booklet (11×17)</option>
    <option value="half-letter">5.5×8.5 booklet</option>
  </select>
  <button class="btn btn-gold btn-sm" onclick="generatePreview()">Preview</button>
  <button class="btn btn-navy btn-sm" id="btn-export" onclick="generatePdfExport()">Export PDF</button>
  <button class="btn btn-outline btn-sm" onclick="doLogout()">Logout</button>
</nav>

<div id="storage-warning" class="storage-warning" style="display:none;">
  &#9888; Server storage is not connected &mdash; logins, settings, drafts, and uploads will NOT be saved.
  Ask the site admin to enable Netlify Blobs (see /api/health).
</div>

<!-- EDITOR PAGE -->
<div class="app" id="page-editor" style="display:none;">
  <div class="editor" id="editor">

    <!-- LITURGICAL DATE -->
    <div class="form-section">
      <div class="form-section-hdr" onclick="toggle(this)">Liturgical Date &amp; Season <span>&#9660;</span></div>
      <div class="form-section-body">
        <div class="fg"><label>Feast / Sunday Name <span style="font-weight:400;text-transform:none;color:var(--gray);">(tracks the date — type your own name to override)</span></label><input type="text" id="feastName" placeholder="e.g., Second Sunday of Lent" oninput="this.dataset.userSet = this.value.trim() ? '1' : ''"></div>
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

    <!-- SERVICE MUSIC + SEASONAL SETTINGS -->
    <div class="form-section" id="section-seasonal">
      <div class="form-section-hdr" onclick="toggle(this)">Service Music &amp; Seasonal Settings <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock" id="seasonal-lock-note">The sung Mass parts (Kyrie, Gloria, Holy Holy Holy, Mystery of Faith, Lamb of God) usually stay the same for a whole season.</p>
        <div class="fg-check">
          <input type="checkbox" id="serviceMusicCarryover" checked onchange="onServiceMusicCarryoverToggle()">
          <label for="serviceMusicCarryover">Same service music as last week (carry over)</label>
        </div>
        <p class="carryover-note" id="carryoverNote"></p>
        <div id="serviceMusicFields">
          <div class="fg-row">
            <div class="fg"><label>Lord, Have Mercy (Kyrie) Setting</label><input type="text" id="shared_kyrie" placeholder="e.g., Kyrie, Mass of St. Theresa" autocomplete="off" data-pair-composer="shared_kyrieComposer"></div>
            <div class="fg"><label>&nbsp;</label><input type="text" id="shared_kyrieComposer" placeholder="Composer"></div>
          </div>
          ${notationCtl('kyrie', 'Kyrie notation')}
          <div class="fg"><label>Gloria Setting <span style="font-weight:400;text-transform:none;color:var(--gray);">(which setting is being sung)</span></label><input type="text" id="gloriaSetting" placeholder="e.g., Mass of Creation"></div>
          ${notationCtl('gloria', 'Gloria notation')}
          <div class="fg-row">
            <div class="fg"><label>Holy, Holy, Holy Setting</label><input type="text" id="holyHolySetting" placeholder="e.g., Mass of St. Theresa"></div>
            <div class="fg"><label>Sanctus Language</label>
              <select id="holyHolyLanguage" onchange="this.dataset.userSet='1'">
                <option value="english">English (Holy, Holy, Holy)</option>
                <option value="latin">Latin (Sanctus)</option>
              </select>
            </div>
          </div>
          ${notationCtl('sanctus', 'Holy Holy Holy notation')}
          <div class="fg"><label>Mystery of Faith Setting</label><input type="text" id="mysteryOfFaithSetting"></div>
          ${notationCtl('mysteryOfFaith', 'Mystery of Faith notation')}
          <div class="fg"><label>Lamb of God Setting</label><input type="text" id="lambOfGodSetting"></div>
          ${notationCtl('lambOfGod', 'Lamb of God notation')}
          <div class="fg"><label>Gospel Acclamation Music <span style="font-weight:400;text-transform:none;color:var(--gray);">(the sung Alleluia setting)</span></label></div>
          ${notationCtl('gospelAcclamation', 'Gospel Acclamation notation')}
        </div>
        <div class="fg-check"><input type="checkbox" id="gloria"><label for="gloria">Include Gloria</label></div>
        <div class="fg-row">
          <div class="fg"><label>Creed</label><select id="creedType"><option value="nicene">Nicene Creed</option><option value="apostles">Apostles' Creed</option><option value="baptismal_vows">Renewal of Baptismal Vows</option></select></div>
          <div class="fg"><label>Entrance Type</label><select id="entranceType"><option value="processional">Processional Hymn</option><option value="antiphon">Entrance Antiphon</option></select></div>
        </div>
        <div class="fg"><label>Penitential Act</label><select id="penitentialAct"><option value="confiteor">Confiteor (I confess)</option><option value="kyrie_only">Kyrie Only</option></select></div>
        <div class="fg-check"><input type="checkbox" id="includePostlude"><label for="includePostlude">Include Organ Postlude</label></div>
        <div class="fg-check" id="adventWreathRow" style="display:none;"><input type="checkbox" id="adventWreath"><label for="adventWreath">Lighting of the Advent Wreath</label></div>
        <div class="fg" id="lentenAcclamationGroup" style="display:none;">
          <label>Lenten Gospel Acclamation</label>
          <select id="lentenAcclamation">
            <option value="standard">Praise to you, Lord Jesus Christ, King of endless glory!</option>
            <option value="alternate">Glory and praise to you, Lord Jesus Christ!</option>
          </select>
        </div>
        <div class="fg">
          <label>Please Sit / Stand / Kneel Rubric Alignment</label>
          <select id="rubricAlignment">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div class="fg-check"><input type="checkbox" id="twoColumnCreed"><label for="twoColumnCreed">Two-column Creed layout (Nicene/Apostles' — saves space on page 4)</label></div>
      </div>
    </div>

    <!-- READINGS -->
    <div class="form-section" id="section-readings">
      <div class="form-section-hdr" onclick="toggle(this)">Readings <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock">Auto-fetched the moment a date is set — NABRE comes from <strong>bible.usccb.org</strong> (the U.S. Lectionary) and other translations come from <strong>bible-api.com</strong> using the same citations. Switch translations to re-fetch in that translation. Use the button to refresh manually. All fields are editable.</p>
        <div class="readings-toolbar">
          <div class="fg">
            <label>Bible Translation</label>
            <select id="bibleTranslation" onchange="fetchReadingsFromUsccb()"></select>
          </div>
          <div class="fg">
            <label>&nbsp;</label>
            <button type="button" class="btn btn-outline btn-sm" id="fetchReadingsBtn" onclick="fetchReadingsFromUsccb()">Refresh readings</button>
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

    <!-- SHARED MUSIC — same at every Mass -->
    <div class="form-section" id="section-shared-music">
      <div class="form-section-hdr" onclick="toggle(this)">Shared Music (same at every Mass) <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock">Organ prelude/postlude and the congregational hymns are the same at every Mass — type the title and composer once here. Anthems (the only music that differs per Mass) have their own section below; the sung Mass parts live under Service Music above.</p>
        <p class="section-lock">Drop the licensed notation (from OneLicense — TIFFs are converted automatically) onto each hymn with <em>Attach notation</em> and it prints right in the booklet. With no image attached, the booklet reserves a blank paste area instead.</p>
        <div class="fg-check">
          <input type="checkbox" id="reserveHymnSpace" checked>
          <label for="reserveHymnSpace">Reserve music areas for hymns &amp; sung responses when no image is attached</label>
        </div>
        ${sharedMusicFields()}
      </div>
    </div>

    <!-- ANTHEMS (the only per-Mass music) -->
    <div class="form-section" id="section-anthems">
      <div class="form-section-hdr" onclick="toggle(this)">Anthems (vary by Mass) <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock">Enter each anthem once — title and composer — and check the Masses where it will be sung. Use <em>Add anthem</em> for additional pieces.</p>
        <div class="fg">
          <label>Offertory Anthems</label>
          <div id="offertoryAnthemRows"></div>
          <button type="button" class="btn btn-outline btn-sm" onclick="addAnthemRow('offertory')">+ Add anthem</button>
        </div>
        <div class="fg" style="margin-top:10px;">
          <label>Choral Anthem (Communion)</label>
          <div id="choralAnthemRows"></div>
          <button type="button" class="btn btn-outline btn-sm" onclick="addAnthemRow('choral')">+ Add anthem</button>
        </div>
      </div>
    </div>

    <!-- NOTATION IMAGES -->
    <div class="form-section" id="section-notation">
      <div class="form-section-hdr" onclick="toggle(this)">Notation Images <button type="button" class="btn btn-outline btn-sm" style="float:right;margin-right:8px;" onclick="event.stopPropagation(); loadNotationList(); toast('Refreshing notation images…', 'success')">Refresh</button> <span>&#9660;</span></div>
      <div class="form-section-body">
        <p style="font-size:11px;color:var(--gray);margin-bottom:8px;">All uploaded notation images (PNG, JPG, TIFF — TIFFs convert to PNG automatically, white margins are trimmed). Use the <em>Print in</em> dropdown on each image below to choose where it prints in the booklet, or use the <em>Attach notation</em> buttons in Service Music and Shared Music. Note: after a page reload, uploads can take a moment to appear in this list (hit Refresh) — newly uploaded files always show immediately.</p>
        <div class="fg-check">
          <input type="checkbox" id="stripTitleHeaders" checked>
          <label for="stripTitleHeaders">Remove title headers automatically — keep just the notation &amp; lyrics <span style="color:var(--gray);">(only crops when a clear title block sits above the first staff; uncheck if an upload loses too much)</span></label>
        </div>
        <div class="upload-area" onclick="document.getElementById('notationFileInput').click()">
          <input type="file" id="notationFileInput" accept="image/*,.tif,.tiff" onchange="uploadNotation(this)">
          <p style="font-size:11px;color:var(--gray);">Click to upload a notation image (PNG, JPG, TIFF, BMP, WebP, SVG)</p>
        </div>
        <div id="notation-list"></div>
      </div>
    </div>

    <!-- CHILDREN'S LITURGY -->
    <div class="form-section">
      <div class="form-section-hdr" onclick="toggle(this)">Children's Liturgy <span>&#9660;</span></div>
      <div class="form-section-body">
        <p class="section-lock">Auto-defaults to ON when school is in session and OFF for summer, Christmas, and Easter. Children's Liturgy can run at any subset of Masses — check every one that applies.</p>
        <div class="fg-check">
          <input type="checkbox" id="childrenLiturgyEnabled" onchange="onChildrenLiturgyToggle()">
          <label for="childrenLiturgyEnabled">Enable Children's Liturgy of the Word</label>
          <span id="childrenLiturgyAutoNote" style="font-size: 11px; color: var(--gray); margin-left: 8px;"></span>
        </div>
        <div class="fg">
          <label>Mass Times (check all that apply)</label>
          <div class="children-liturgy-times">
            <label class="fg-check"><input type="checkbox" class="cl-time" value="Sat 5:00 PM"> Sat 5:00 PM</label>
            <label class="fg-check"><input type="checkbox" class="cl-time" value="Sun 9:00 AM"> Sun 9:00 AM</label>
            <label class="fg-check"><input type="checkbox" class="cl-time" value="Sun 11:00 AM"> Sun 11:00 AM</label>
          </div>
          <input type="text" id="childrenLiturgyOtherTimes" placeholder="Other Mass times, comma-separated (optional)" style="margin-top:4px;">
        </div>
        <div class="fg"><label>Leader (optional)</label><input type="text" id="childrenLiturgyLeader" placeholder="e.g., Mrs. Donna Smith"></div>
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
        <p class="section-lock">Pick from the parish library. Upload new files on the <em>Library</em> page (top nav). They'll show up here for any worship aid.</p>
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
    <p style="font-size:12px;color:var(--gray);margin-bottom:12px;"><span class="status-badge final">FINAL</span> marks the version actually printed — the last PDF export for that week. Everything else is a working draft.</p>
    <div id="history-list"></div>
  </div>
</div>

<!-- LIBRARY PAGE -->
<div id="page-library" style="display:none;">
  <div class="history-view">
    <h2>Music &amp; Document Library</h2>
    <p style="font-size:12px;color:var(--gray);margin-bottom:14px;">Upload notation images (PNG, JPG, <strong>TIFF</strong> — TIFFs are converted automatically) plus any audio / PDF / score files you want on hand. Files are reusable across every booklet — pick them in the Editor's <em>Files Referenced</em> section.</p>

    <div class="form-section">
      <div class="form-section-hdr">Upload a New File</div>
      <div class="form-section-body">
        <div class="upload-area" onclick="document.getElementById('attachmentFileInput').click()">
          <input type="file" id="attachmentFileInput" accept="image/*,.tif,.tiff,.pdf,audio/*,.mid,.midi,.mxl,.musicxml,.xml,.txt,.md,.doc,.docx,.rtf" onchange="uploadAttachmentFromSettings(this)">
          <p style="font-size:12px;color:var(--gray);">Click to upload a file — images (PNG, JPG, TIFF), audio, PDF, MusicXML, MIDI, doc. On the hosted site keep files under ~4.5&nbsp;MB.</p>
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
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-hdr">Library Contents</div>
      <div class="form-section-body">
        <div class="fg-row" style="grid-template-columns: 1fr auto;">
          <div class="fg"><label>Filter by kind</label>
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
</div>

<!-- STATS PAGE -->
<div id="page-stats" style="display:none;">
  <div class="history-view">
    <h2>Hymn Usage Stats</h2>
    <p style="font-size:12px;color:var(--gray);margin-bottom:12px;">How often each hymn was actually printed. Counted from PDF exports — one per liturgical week, using the last export of that week (drafts and re-exports do not double-count).</p>
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
  ['editor','history','library','stats','admin','users'].forEach(p => document.getElementById('page-' + p).style.display = 'none');
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

  // Load per-user preferences (booklet size, default Sanctus, etc.)
  // Persists for the user across sessions, drafts, and devices.
  try {
    const ur = await fetch('/api/user-prefs', { headers: { 'x-session-token': _sessionToken } });
    if (ur.ok) {
      window._userPrefs = await ur.json();
      const sizeSel = document.getElementById('bookletSize');
      if (sizeSel && window._userPrefs.bookletSize) sizeSel.value = window._userPrefs.bookletSize;
    } else {
      window._userPrefs = {};
    }
  } catch(e) { window._userPrefs = {}; }

  applyRolePermissions();
  showPage('editor');
  checkStorageHealth();
  // Restore in-progress work first (a reload must not blow it away); only a
  // genuinely fresh session gets the carry-over-from-last-week defaults.
  const restored = offerSnapshotRestore();
  if (!restored) applyServiceMusicCarryover({ silent: true });
  loadNotationUsage();
}

// Surface the lossy in-memory fallback loudly — this is the failure mode
// behind "session expired" loops, upload lists resetting, and settings
// never persisting on a misconfigured deploy.
async function checkStorageHealth() {
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    window._serverHealth = h || {};
    const warn = document.getElementById('storage-warning');
    if (warn) warn.style.display = (h && h.persistence === 'in-memory') ? '' : 'none';
  } catch(e) { /* health endpoint unreachable — leave banner hidden */ }
}

// Serverless deployments cap request bodies at ~6 MB (≈4.5 MB of file after
// form encoding). Fail fast with advice instead of a mysterious network
// error. Local/Docker servers have no such cap.
function uploadTooLarge(file) {
  const isServerless = window._serverHealth && window._serverHealth.environment === 'netlify';
  if (isServerless && file.size > 4.5 * 1024 * 1024) {
    toast('That file is over the hosted upload limit (~4.5 MB). Downscale the scan or re-save it smaller and try again.', 'error');
    return true;
  }
  return false;
}

// Shared 401 handling: clear the stale token and bounce to login with a
// clear message instead of surfacing a raw "Not authenticated" error.
function handle401(res) {
  if (!res || res.status !== 401) return false;
  toast('Your session expired — please log in again.', 'error');
  _sessionToken = null;
  localStorage.removeItem('wa_token');
  showLogin();
  return true;
}

// Save the user's per-user prefs in the background.  Fire-and-forget; no UI
// signal needed because the field already shows what was selected.
async function saveUserPrefs(patch) {
  if (!_sessionToken) return;
  try {
    await fetch('/api/user-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify(patch)
    });
    window._userPrefs = { ...(window._userPrefs || {}), ...patch };
  } catch(e) { /* ignore — non-critical */ }
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
  admin: ['edit_all', 'manage_users', 'manage_settings', 'manage_attachments', 'edit_readings', 'edit_music', 'edit_seasonal', 'approve', 'export_pdf', 'edit_announcements', 'upload_images', 'edit_cover'],
  music_director: ['edit_music', 'edit_seasonal', 'upload_images', 'manage_attachments', 'export_pdf'],
  pastor: ['edit_readings', 'approve', 'edit_announcements'],
  staff: ['edit_readings', 'edit_music', 'edit_announcements', 'edit_seasonal', 'manage_attachments', 'export_pdf']
};

function hasRole(perm) {
  if (!_currentUser) return false;
  const perms = rolePerms[_currentUser.role] || [];
  return perms.includes(perm) || perms.includes('edit_all');
}

function applyRolePermissions() {
  // Music sections: only music_director, admin, staff
  const musicSections = ['section-shared-music', 'section-anthems', 'section-notation'];
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
  // Library nav: anyone who can manage attachments (admin, music_director, staff)
  const libNav = document.getElementById('nav-library');
  if (libNav) libNav.style.display = hasRole('manage_attachments') ? '' : 'none';
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
  ['editor','history','library','stats','admin','users'].forEach(p => {
    document.getElementById('page-' + p).style.display = (p === page) ? '' : 'none';
  });
  if (page === 'history') loadHistory();
  if (page === 'stats')   loadStats();
  if (page === 'admin')   loadAdminSettings();
  if (page === 'users')   loadUsers();
  if (page === 'library') loadAttachmentList();
}

// --- Form helpers ---
function toggle(hdr) {
  const body = hdr.nextElementSibling;
  const arrow = hdr.querySelector('span');
  body.classList.toggle('collapsed');
  arrow.textContent = body.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
// For values embedded inside inline onclick JS string literals — esc() is
// HTML-escaping only and would let a quote terminate the JS string.
function jsq(s) { return String(s || '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function ch(id) { const el = document.getElementById(id); return el ? el.checked : false; }
function sv(id, val) { const el = document.getElementById(id); if (el) el.value = val || ''; }
function sc(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; }

// --- Anthems: one Offertory list + one Choral list, each anthem tagged with
// the Masses where it's sung (UAT June 2026 — no more retyping the same
// anthem into three per-Mass dropdowns).
const ANTHEM_MASSES = [
  ['sat5pm',  'Sat 5:00 PM'],
  ['sun9am',  'Sun 9:00 AM'],
  ['sun11am', 'Sun 11:00 AM']
];

function addAnthemRow(slot, data) {
  const container = document.getElementById(slot === 'offertory' ? 'offertoryAnthemRows' : 'choralAnthemRows');
  if (!container) return;
  data = data || {};
  const masses = new Set(data.masses || []);
  const row = document.createElement('div');
  row.className = 'anthem-row';
  row.innerHTML =
    '<div class="anthem-inputs">' +
      '<input type="text" class="anthem-title" placeholder="Title">' +
      '<input type="text" class="anthem-composer" placeholder="Composer">' +
    '</div>' +
    '<div class="anthem-masses">' +
      ANTHEM_MASSES.map(([key, label]) =>
        '<label><input type="checkbox" class="anthem-mass" value="' + key + '"' + (masses.has(key) ? ' checked' : '') + '> ' + label + '</label>'
      ).join('') +
      '<button type="button" class="anthem-remove" title="Remove this anthem" onclick="this.closest(\\'.anthem-row\\').remove()">&times;</button>' +
    '</div>';
  row.querySelector('.anthem-title').value = data.title || '';
  row.querySelector('.anthem-composer').value = data.composer || '';
  container.appendChild(row);
}

function renderAnthemRows(slot, rows, minRows) {
  const container = document.getElementById(slot === 'offertory' ? 'offertoryAnthemRows' : 'choralAnthemRows');
  if (!container) return;
  container.innerHTML = '';
  (rows || []).forEach(r => addAnthemRow(slot, r));
  while (container.children.length < (minRows || 1)) addAnthemRow(slot);
}

function collectAnthems(slot) {
  const container = document.getElementById(slot === 'offertory' ? 'offertoryAnthemRows' : 'choralAnthemRows');
  if (!container) return [];
  const rows = [];
  container.querySelectorAll('.anthem-row').forEach(row => {
    const title = row.querySelector('.anthem-title').value.trim();
    const composer = row.querySelector('.anthem-composer').value.trim();
    const masses = Array.from(row.querySelectorAll('.anthem-mass:checked')).map(cb => cb.value);
    if (title) rows.push({ title, composer, masses });
  });
  return rows;
}

// For one Mass, combine every anthem checked for it into the per-Mass block
// fields the renderers consume ("A / B" when two anthems are sung).
function anthemFieldsForMass(rows, massKey) {
  const sung = rows.filter(r => (r.masses || []).includes(massKey));
  const titles = sung.map(r => r.title).join(' / ');
  const composers = [];
  sung.forEach(r => { if (r.composer && !composers.includes(r.composer)) composers.push(r.composer); });
  return { title: titles, composer: composers.join('; ') };
}

// Reconstruct anthem rows from a draft's per-Mass blocks (legacy drafts and
// any draft saved before the anthems field existed).
function anthemRowsFromBlocks(data, titleField, composerField) {
  const blockKeys = [['sat5pm', 'musicSat5pm'], ['sun9am', 'musicSun9am'], ['sun11am', 'musicSun11am']];
  const map = new Map();
  blockKeys.forEach(([massKey, blockKey]) => {
    const block = (data && data[blockKey]) || {};
    const title = (block[titleField] || '').trim();
    if (!title) return;
    const composer = (block[composerField] || '').trim();
    const key = title + '|||' + composer;
    if (!map.has(key)) map.set(key, { title, composer, masses: [] });
    map.get(key).masses.push(massKey);
  });
  return Array.from(map.values());
}

function buildMusicBlock(prefix, offertoryRows, choralRows) {
  // All shared values come from the Shared Music + Service Music sections
  // and are copied into every per-Mass block here so the saved-draft schema
  // (musicSat5pm / musicSun9am / musicSun11am) stays the same — this keeps
  // the renderer's consolidation logic happy and means legacy drafts open
  // cleanly. Anthems come from the anthem rows filtered to this Mass.
  const off = anthemFieldsForMass(offertoryRows, prefix);
  const cho = anthemFieldsForMass(choralRows, prefix);
  return {
    organPrelude: v('shared_organPrelude'),
    organPreludeComposer: v('shared_organPreludeComposer'),
    processionalOrEntrance: v('shared_processional'),
    processionalOrEntranceComposer: v('shared_processionalComposer'),
    processionalOrEntranceHymnal: v('shared_processional_hymnal'),
    processionalOrEntranceHymnNumber: v('shared_processional_hymnNumber'),
    kyrieSetting: v('shared_kyrie'),
    kyrieComposer: v('shared_kyrieComposer'),
    responsorialPsalmSetting: v('shared_responsorialPsalm'),
    responsorialPsalmSettingComposer: v('shared_responsorialPsalmComposer'),
    offertoryAnthem: off.title,
    offertoryAnthemComposer: off.composer,
    communionHymn: v('shared_communion'),
    communionHymnComposer: v('shared_communionComposer'),
    communionHymnHymnal: v('shared_communion_hymnal'),
    communionHymnHymnNumber: v('shared_communion_hymnNumber'),
    hymnOfThanksgiving: v('shared_thanksgiving'),
    hymnOfThanksgivingComposer: v('shared_thanksgivingComposer'),
    hymnOfThanksgivingHymnal: v('shared_thanksgiving_hymnal'),
    hymnOfThanksgivingHymnNumber: v('shared_thanksgiving_hymnNumber'),
    organPostlude: v('shared_postlude'),
    organPostludeComposer: v('shared_postludeComposer'),
    choralAnthemConcluding: cho.title,
    choralAnthemConcludingComposer: cho.composer
  };
}

// Pull the shared values out of a saved draft.  We look at every per-Mass
// block and use the first non-empty value found (legacy drafts have the same
// value across blocks for shared slots; new drafts will have it on Sat).
function populateSharedMusic(data) {
  function pickFromBlocks(field) {
    for (const key of ['musicSat5pm', 'musicSun9am', 'musicSun11am']) {
      const value = data && data[key] && data[key][field];
      if (value) return value;
    }
    return '';
  }
  sv('shared_organPrelude',         pickFromBlocks('organPrelude'));
  sv('shared_organPreludeComposer', pickFromBlocks('organPreludeComposer'));
  sv('shared_processional',         pickFromBlocks('processionalOrEntrance'));
  sv('shared_processionalComposer', pickFromBlocks('processionalOrEntranceComposer'));
  sv('shared_processional_hymnal',     pickFromBlocks('processionalOrEntranceHymnal'));
  sv('shared_processional_hymnNumber', pickFromBlocks('processionalOrEntranceHymnNumber'));
  sv('shared_kyrie',                pickFromBlocks('kyrieSetting'));
  sv('shared_kyrieComposer',        pickFromBlocks('kyrieComposer'));
  sv('shared_responsorialPsalm',         pickFromBlocks('responsorialPsalmSetting'));
  sv('shared_responsorialPsalmComposer', pickFromBlocks('responsorialPsalmSettingComposer'));
  sv('shared_communion',            pickFromBlocks('communionHymn'));
  sv('shared_communionComposer',    pickFromBlocks('communionHymnComposer'));
  sv('shared_communion_hymnal',     pickFromBlocks('communionHymnHymnal'));
  sv('shared_communion_hymnNumber', pickFromBlocks('communionHymnHymnNumber'));
  sv('shared_thanksgiving',         pickFromBlocks('hymnOfThanksgiving'));
  sv('shared_thanksgivingComposer', pickFromBlocks('hymnOfThanksgivingComposer'));
  sv('shared_thanksgiving_hymnal',     pickFromBlocks('hymnOfThanksgivingHymnal'));
  sv('shared_thanksgiving_hymnNumber', pickFromBlocks('hymnOfThanksgivingHymnNumber'));
  sv('shared_postlude',             pickFromBlocks('organPostlude'));
  sv('shared_postludeComposer',     pickFromBlocks('organPostludeComposer'));
}

function buildData() {
  const offertoryRows = collectAnthems('offertory');
  const choralRows = collectAnthems('choral');
  return {
    id: window._currentDraftId || undefined,
    feastName: v('feastName'),
    liturgicalDate: v('liturgicalDate'),
    liturgicalSeason: v('liturgicalSeason'),
    lastEditedBy: _currentUser ? _currentUser.displayName : undefined,
    seasonalSettings: {
      gloria: ch('gloria'),
      gloriaSetting: v('gloriaSetting'),
      creedType: v('creedType'),
      entranceType: v('entranceType'),
      holyHolySetting: v('holyHolySetting'),
      holyHolyLanguage: v('holyHolyLanguage') || 'english',
      mysteryOfFaithSetting: v('mysteryOfFaithSetting'),
      lambOfGodSetting: v('lambOfGodSetting'),
      penitentialAct: v('penitentialAct'),
      includePostlude: ch('includePostlude'),
      adventWreath: ch('adventWreath'),
      lentenAcclamation: v('lentenAcclamation'),
      rubricAlignment: v('rubricAlignment') || 'left',
      twoColumnCreed: ch('twoColumnCreed')
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
    musicSat5pm: buildMusicBlock('sat5pm', offertoryRows, choralRows),
    musicSun9am: buildMusicBlock('sun9am', offertoryRows, choralRows),
    musicSun11am: buildMusicBlock('sun11am', offertoryRows, choralRows),
    anthems: { offertory: offertoryRows, choral: choralRows },
    reserveHymnSpace: ch('reserveHymnSpace'),
    serviceMusicCarryover: ch('serviceMusicCarryover'),
    notationImages: { ...(window._notationImages || {}) },
    childrenLiturgyEnabled: ch('childrenLiturgyEnabled'),
    childrenLiturgyMassTimes: collectChildrenLiturgyTimes(),
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
  // A draft-loaded name is NOT a manual override: the load-time reconcile
  // below keeps it (fill-if-empty), but a subsequent date change should
  // replace it with the new weekend's name.
  const _feastEl = document.getElementById('feastName');
  if (_feastEl) _feastEl.dataset.userSet = '';
  sv('liturgicalDate', data.liturgicalDate);
  sv('liturgicalSeason', data.liturgicalSeason);
  const ss = data.seasonalSettings || {};
  sc('gloria', ss.gloria);
  sv('gloriaSetting', ss.gloriaSetting);
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
  sv('rubricAlignment', ss.rubricAlignment || 'left');
  sc('twoColumnCreed', !!ss.twoColumnCreed);
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
  // Anthems: prefer the structured anthem lists; reconstruct from the
  // per-Mass blocks for drafts saved before the anthems field existed.
  const anthems = data.anthems || {};
  const offertoryRows = (anthems.offertory && anthems.offertory.length)
    ? anthems.offertory
    : anthemRowsFromBlocks(data, 'offertoryAnthem', 'offertoryAnthemComposer');
  const choralRows = (anthems.choral && anthems.choral.length)
    ? anthems.choral
    : anthemRowsFromBlocks(data, 'choralAnthemConcluding', 'choralAnthemConcludingComposer');
  renderAnthemRows('offertory', offertoryRows, 2);
  renderAnthemRows('choral', choralRows, 1);
  populateSharedMusic(data);
  // Per-slot notation images (uploaded music that prints in the booklet).
  window._notationImages = (data.notationImages && typeof data.notationImages === 'object') ? { ...data.notationImages } : {};
  renderNotationThumbs();
  renderNotationList();
  refreshNotationPicks();
  // Saved drafts show their actual values — reflect the stored carryover
  // flag but never re-copy from a previous week on load.
  sc('serviceMusicCarryover', !!data.serviceMusicCarryover);
  updateServiceMusicVisibility();
  // Default ON for drafts saved before the field existed.
  sc('reserveHymnSpace', data.reserveHymnSpace !== false);
  sc('childrenLiturgyEnabled', data.childrenLiturgyEnabled);
  // If the saved doc carries an explicit value, respect it; otherwise the
  // load is a no-op and auto-defaults will run on date/season change.
  const _clCb = document.getElementById('childrenLiturgyEnabled');
  if (_clCb) _clCb.dataset.userSet = (data.childrenLiturgyEnabled !== undefined) ? '1' : '';
  updateChildrenLiturgyAutoNote(data.childrenLiturgyEnabled !== undefined);
  // Children's Liturgy can happen at any number of Masses. New drafts use
  // childrenLiturgyMassTimes (array); legacy drafts have a single
  // childrenLiturgyMassTime string — migrate it on load so the user sees
  // the right boxes ticked.
  applyChildrenLiturgyTimes(
    Array.isArray(data.childrenLiturgyMassTimes) && data.childrenLiturgyMassTimes.length
      ? data.childrenLiturgyMassTimes
      : (data.childrenLiturgyMassTime ? [data.childrenLiturgyMassTime] : [])
  );
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
  // After loading a saved draft, force the liturgical season to track the
  // saved date.  The date is the source of truth — if a draft was saved
  // with a stale or incorrect season, loading it should fix the field
  // automatically.  This runs async; it does NOT clobber the user's
  // saved seasonal sub-settings (Gloria, creed, settings names) because
  // we only call onSeasonChange() if the season selector value actually
  // changes, which preserves manual overrides.
  if (data.liturgicalDate) {
    reconcileSeasonAndFeastFromDate({ feastFillIfEmpty: true });
  }
}

// Re-derive the liturgical season + feast name from the current date and
// apply them.  Used both when the user changes the date and when loading
// a saved draft.  By default the feast name is filled only when empty,
// matching the date-change behavior.
async function reconcileSeasonAndFeastFromDate(opts) {
  const date = v('liturgicalDate');
  if (!date) return;
  let info = null;
  try {
    const r = await fetch('/api/liturgical-info?date=' + encodeURIComponent(date));
    if (r.ok) info = await r.json();
  } catch (e) { /* network blip — leave fields alone */ }
  if (!info) return;
  const seasonSel = document.getElementById('liturgicalSeason');
  if (info.liturgicalSeason && seasonSel && seasonSel.value !== info.liturgicalSeason) {
    seasonSel.value = info.liturgicalSeason;
    // Don't run onSeasonChange here — we don't want to overwrite the
    // user's saved seasonal sub-settings on draft load.  The season
    // selector itself reflects the date; the rest is preserved.
    updateSeasonUI();
  }
  if (opts && opts.feastFillIfEmpty) {
    const feastEl = document.getElementById('feastName');
    if (info.feastName && feastEl && !feastEl.value.trim()) {
      feastEl.value = info.feastName;
    }
  }
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
  // Lighting of the Advent Wreath is only meaningful during Advent.
  const wreathRow = document.getElementById('adventWreathRow');
  if (wreathRow) {
    wreathRow.style.display = (season === 'advent') ? '' : 'none';
    if (season !== 'advent') {
      const cb = document.getElementById('adventWreath');
      if (cb) cb.checked = false;
    }
  }
}

// --- Children's Liturgy auto-defaults ---
// School in session = Sep through May, with a break ~Dec 22-Jan 6.
// Off during summer (Jun-Aug), Christmas season, and Easter season.
function suggestChildrenLiturgyDefault(dateStr, season) {
  if (!dateStr) return { enabled: false, reason: 'No date set' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return { enabled: false, reason: 'No date set' };
  const year  = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day   = parseInt(m[3], 10);
  // Christmas Day itself: no Children's Liturgy.  (The school-Christmas-break
  // rule below covers it, but we keep an explicit check for clarity.)
  if (month === 12 && day === 25) return { enabled: false, reason: 'Off — Christmas Day' };
  // Easter Sunday itself: no Children's Liturgy.  Other Sundays in the
  // Easter season DO get it (kids are back from school break by then).
  const easter = computeEaster(year);
  if (date_isSameUTC(year, month, day, easter)) {
    return { enabled: false, reason: 'Off — Easter Sunday' };
  }
  // Summer break — kids are out of town / on vacation.
  if (month >= 6 && month <= 8) return { enabled: false, reason: 'Off — school summer break' };
  // School Christmas break (covers Dec 25 above + the surrounding window).
  if (month === 12 && day >= 22) return { enabled: false, reason: 'Off — school Christmas break' };
  if (month === 1 && day <= 6)   return { enabled: false, reason: 'Off — school Christmas break' };
  return { enabled: true, reason: 'School in session' };
}

// Compare a calendar y/m/d to a Date object treating both as UTC midnight.
function date_isSameUTC(y, m, d, dateObj) {
  return dateObj.getUTCFullYear() === y &&
         (dateObj.getUTCMonth() + 1) === m &&
         dateObj.getUTCDate() === d;
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

// Collect every checked "Mass Time" box plus the free-form "Other"
// list, deduped, in the order checkbox-first then custom entries.
function collectChildrenLiturgyTimes() {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('.cl-time:checked').forEach(cb => {
    const v = (cb.value || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  });
  const other = (document.getElementById('childrenLiturgyOtherTimes') || {}).value || '';
  other.split(',').map(s => s.trim()).filter(Boolean).forEach(v => {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  });
  return out;
}

// Tick the right "Mass Time" boxes for an array of labels; anything not in
// the standard list goes into the "Other" text input.
function applyChildrenLiturgyTimes(times) {
  const standard = new Set();
  document.querySelectorAll('.cl-time').forEach(cb => {
    standard.add(cb.value);
    cb.checked = false;
  });
  const others = [];
  (times || []).forEach(t => {
    const v = String(t || '').trim();
    if (!v) return;
    if (standard.has(v)) {
      const cb = document.querySelector('.cl-time[value="' + v.replace(/"/g, '\\"') + '"]');
      if (cb) cb.checked = true;
    } else {
      others.push(v);
    }
  });
  const otherEl = document.getElementById('childrenLiturgyOtherTimes');
  if (otherEl) otherEl.value = others.join(', ');
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
  // Liturgical season ALWAYS tracks the date — even if the field already
  // has a value.  We still only run onSeasonChange (which resets seasonal
  // defaults) when the season actually changes, so manual seasonal
  // overrides aren't clobbered on every date tweak.
  if (detected && seasonSel) {
    if (seasonSel.value !== detected) {
      seasonSel.value = detected;
      await onSeasonChange(); // applies seasonal defaults + cascades to children's liturgy
    } else {
      // Same season — but make sure the selector is visibly correct and
      // re-run the children's-liturgy school-calendar check.
      seasonSel.value = detected;
      applyChildrenLiturgyAutoDefault();
    }
  }
  // The feast/Sunday name TRACKS the date. The old fill-only-when-empty rule
  // meant the name never updated once anything had filled it (startup
  // auto-fill, a loaded draft) — picking a new weekend kept last week's
  // name. A name the user actually typed (dataset.userSet, set by the
  // field's oninput) is preserved until they clear the field.
  const feastEl = document.getElementById('feastName');
  if (info && info.feastName && feastEl && feastEl.dataset.userSet !== '1') {
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

function copyPromptFromButton(btn) {
  const text = btn.getAttribute('data-prompt') || '';
  navigator.clipboard.writeText(text).then(
    () => toast('Prompt copied', 'success'),
    () => toast('Could not copy prompt', 'error')
  );
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
        // The prompt travels in a data attribute (HTML-escaped via esc) —
        // inlining JSON.stringify into onclick breaks the attribute on the
        // first double quote.
        '<button type="button" style="margin-top:4px;font-size:10px;" data-prompt="' + esc(c.prompt) + '" onclick="copyPromptFromButton(this)">Copy prompt</button>' +
      '</div>'
    )).join('');
    const linkHtml = data.searchLinks.map(s => (
      '<div style="font-size:11px;margin-bottom:3px;">' +
        '<strong>' + esc(s.query) + ':</strong> ' +
        '<a href="' + s.wikimedia + '" target="_blank" rel="noopener">Wikimedia Commons</a> &middot; ' +
        '<a href="' + s.wga + '" target="_blank" rel="noopener">Web Gallery of Art</a> &middot; ' +
        '<a href="' + s.met + '" target="_blank" rel="noopener">The Met (Open Access)</a> &middot; ' +
        '<a href="' + s.vatican + '" target="_blank" rel="noopener">Vatican Museums</a>' +
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
    toast('No ' + (ATTACHMENT_KIND_LABELS[kind] || kind) + 's in the library yet. Upload one on the Library page.', 'error');
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
  if (!_sessionToken) {
    toast('You are signed out — please log in to upload files.', 'error');
    showLogin();
    return;
  }
  const file = input.files[0];
  const status = document.getElementById('att_uploadStatus');
  if (uploadTooLarge(file)) { input.value = ''; return; }
  if (status) status.textContent = 'Uploading ' + file.name + '…';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', v('att_title') || file.name.replace(/\\.[^.]+$/, ''));
  fd.append('composer', v('att_composer'));
  fd.append('kind', v('att_kind') || 'general');
  fd.append('tags', v('att_tags'));
  try {
    const res = await fetch('/api/attachments', { method: 'POST', headers: { 'x-session-token': _sessionToken }, body: fd });
    if (res.status === 401) {
      if (status) status.textContent = '';
      toast('Your session expired — please log in again.', 'error');
      _sessionToken = null;
      localStorage.removeItem('wa_token');
      showLogin();
      return;
    }
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
      const isImage = a.mime && a.mime.indexOf('image/') === 0;
      return '<div class="attachment-card">' +
        (isImage ? '<span class="notation-thumb"><img class="att-thumb" src="' + esc(a.url) + '" alt="music" title="Hover to zoom"></span>' : '') +
        '<div class="info">' +
          '<div class="t"><span class="attachment-kind-pill">' + esc(ATTACHMENT_KIND_LABELS[a.kind] || a.kind) + '</span>' + esc(a.title || a.originalName) + '</div>' +
          '<div class="m">' + (a.composer ? esc(a.composer) + ' · ' : '') + esc(a.originalName) + ' · ' + Math.round((a.size || 0) / 1024) + ' KB</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn btn-outline btn-sm" onclick="editAttachmentMeta(\\'' + a.id + '\\')">Edit</button>' +
          '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Open</a>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteAttachment(\\'' + a.id + '\\')">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<p class="attachment-list-empty">Could not load library.</p>';
  }
}

async function editAttachmentMeta(id) {
  const lib = await getAttachmentCache();
  const a = lib.find(x => x.id === id);
  if (!a) return;
  const title = prompt('Title:', a.title || '');
  if (title === null) return;
  const composer = prompt('Composer:', a.composer || '');
  if (composer === null) return;
  try {
    const res = await fetch('/api/attachments/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify({ title: title.trim(), composer: composer.trim() })
    });
    if (handle401(res)) return;
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || 'Update failed', 'error'); return; }
    await getAttachmentCache(true);
    await loadAttachmentList();
    await loadNotationList();
    toast('Library entry updated', 'success');
  } catch (e) { toast('Update failed: ' + e.message, 'error'); }
}

async function deleteAttachment(id) {
  if (!confirm('Delete this file from the library? Worship aids that reference it will show "missing".')) return;
  try {
    const res = await fetch('/api/attachments/' + id, { method: 'DELETE', headers: { 'x-session-token': _sessionToken } });
    if (handle401(res)) return;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast('Delete failed: ' + (data.error || res.status), 'error');
      return;
    }
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); return; }
  await loadAttachmentList();
  await refreshAttachmentPicker();
  await refreshAttachmentSlotSelectors();
  toast('File removed', 'success');
}

// --- Per-slot notation images ---
// Each music slot (hymns, Mass ordinary parts, sung responses) can carry an
// uploaded notation image that prints inside its reserved area in the
// booklet. window._notationImages maps slot -> upload URL.
window._notationImages = window._notationImages || {};

// Client-side cache of uploaded notation files: [{filename, url}].
// Netlify Blobs list() is eventually consistent, so a fresh GET right
// after an upload may not include the new file yet. We merge server
// results into this cache (never replace it) and push uploads into it
// immediately, so newly uploaded files always show right away.
window._notationFiles = window._notationFiles || [];

// Booklet spots a notation image can print in (slot -> human label).
const NOTATION_SLOT_LABELS = {
  processional: 'Processional Hymn',
  communion: 'Communion Hymn',
  thanksgiving: 'Hymn of Thanksgiving',
  kyrie: 'Kyrie',
  gloria: 'Gloria',
  sanctus: 'Holy, Holy, Holy (Sanctus)',
  mysteryOfFaith: 'Mystery of Faith',
  lambOfGod: 'Lamb of God',
  psalmRefrain: 'Psalm Refrain',
  gospelAcclamation: 'Gospel Acclamation'
};

// Library attachment kind -> notation slot (for ordering library files
// in the per-slot pick dropdowns).
const ATTACHMENT_KIND_TO_SLOT = {
  kyrie: 'kyrie',
  gloria: 'gloria',
  sanctus: 'sanctus',
  mystery_of_faith: 'mysteryOfFaith',
  agnus_dei: 'lambOfGod',
  psalm: 'psalmRefrain',
  gospel_acclamation: 'gospelAcclamation',
  processional: 'processional',
  communion: 'communion',
  thanksgiving: 'thanksgiving'
};

// Add an uploaded file to the cache (dedupe by url).
function addNotationFile(filename, url) {
  if (!url) return;
  if (!Array.isArray(window._notationFiles)) window._notationFiles = [];
  if (!window._notationFiles.some(f => f.url === url)) {
    window._notationFiles.push({ filename: filename || url.split('/').pop(), url });
  }
}

async function uploadNotationForSlot(slot, input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!_sessionToken) {
    toast('You are signed out — please log in to upload notation.', 'error');
    showLogin(); input.value = ''; return;
  }
  if (uploadTooLarge(file)) { input.value = ''; return; }
  const fd = new FormData();
  fd.append('image', file);
  // Strip titles by DEFAULT — only send '0' when the user explicitly
  // unchecked the box. ch() returns false for a missing element, which
  // would silently disable stripping.
  var _stripEl = document.getElementById('stripTitleHeaders');
  fd.append('stripTitle', _stripEl && !_stripEl.checked ? '0' : '1');
  toast('Uploading ' + file.name + '…', 'success');
  try {
    const res = await fetch('/api/upload/notation', { method: 'POST', headers: { 'x-session-token': _sessionToken }, body: fd });
    if (handle401(res)) return;
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
    // Cache the new file immediately — the server list is eventually
    // consistent and may not include it yet.
    addNotationFile(data.filename || data.originalName, data.url);
    attachNotation(slot, data.url);
    renderNotationList();
    refreshNotationPicks();
    let msg = data.converted ? 'Converted to PNG and attached' : 'Notation attached';
    if (data.titleCropped) msg += ' — title header removed';
    if (data.deduped) msg = 'Already uploaded — reusing the existing image';
    toast(msg, 'success');
  } catch (e) {
    toast('Upload error: ' + e.message, 'error');
  } finally {
    input.value = '';
  }
}

function attachNotation(slot, url) {
  if (!url) return;
  window._notationImages[slot] = url;
  renderNotationThumbs();
  renderNotationList();
}

function detachNotation(slot) {
  delete window._notationImages[slot];
  renderNotationThumbs();
  renderNotationList();
}

function attachNotationFromPick(slot, sel) {
  if (sel.value) attachNotation(slot, sel.value);
  sel.value = '';
}

// "Print in:" dropdown on a Notation Images list row. The select is STICKY —
// it shows the image's current spot. Picking a different spot MOVES the
// single assignment; picking the blank option removes it. (Images printing
// in several spots keep the pills with their × buttons.)
function assignNotationFromList(idx, sel) {
  const f = (window._notationFiles || [])[idx];
  if (!f) return;
  const slot = sel.value;
  const current = Object.keys(NOTATION_SLOT_LABELS).filter(s => (window._notationImages || {})[s] === f.url);
  if (!slot) {
    current.forEach(s => delete window._notationImages[s]);
    renderNotationThumbs();
    renderNotationList();
    toast('Removed from the booklet', 'success');
    return;
  }
  // Move semantics when the image had exactly one spot.
  if (current.length === 1 && current[0] !== slot) delete window._notationImages[current[0]];
  attachNotation(slot, f.url);
  toast('Will print in: ' + (NOTATION_SLOT_LABELS[slot] || slot), 'success');
}

// Where was this image used in a previous week? { url: {slot, liturgicalDate, feastName} }
window._notationUsage = window._notationUsage || {};
async function loadNotationUsage() {
  if (!_sessionToken) return;
  try {
    const res = await fetch('/api/notation-usage', { headers: { 'x-session-token': _sessionToken } });
    if (res.ok) {
      const data = await res.json();
      window._notationUsage = (data && data.byUrl) || {};
      renderNotationList();
    }
  } catch (e) { /* hints are best-effort */ }
}

async function deleteNotationFile(idx) {
  const f = (window._notationFiles || [])[idx];
  if (!f) return;
  if (!confirm('Delete "' + f.filename + '" from uploaded notation? Booklets that still reference it will show the blank paste area instead.')) return;
  try {
    const res = await fetch('/api/uploads/notation/' + encodeURIComponent(f.filename), {
      method: 'DELETE', headers: { 'x-session-token': _sessionToken }
    });
    if (handle401(res)) return;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast('Delete failed: ' + (data.error || res.status), 'error');
      return;
    }
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); return; }
  // Detach it anywhere it was printing and drop it from the cache.
  Object.keys(NOTATION_SLOT_LABELS).forEach(s => {
    if ((window._notationImages || {})[s] === f.url) delete window._notationImages[s];
  });
  window._notationFiles.splice(idx, 1);
  renderNotationThumbs();
  renderNotationList();
  refreshNotationPicks();
  toast('Image deleted', 'success');
}

// Fill every per-slot "uploaded images" picker from the client cache plus
// image attachments in the Library (attachments whose kind matches the
// slot come first), so one upload can be reused across slots/weeks.
async function refreshNotationPicks() {
  const files = window._notationFiles || [];
  let lib = [];
  try {
    lib = (await getAttachmentCache()).filter(a => a.url && a.mime && a.mime.indexOf('image/') === 0);
  } catch (e) { lib = []; }
  document.querySelectorAll('select[data-notation-pick]').forEach(sel => {
    const slot = (sel.id || '').replace(/^npick_/, '');
    const matching = lib.filter(a => ATTACHMENT_KIND_TO_SLOT[a.kind] === slot);
    const ordered = matching.concat(lib.filter(a => ATTACHMENT_KIND_TO_SLOT[a.kind] !== slot));
    let html = '<option value="">' + ((files.length || ordered.length) ? '— or pick an uploaded image —' : '— no uploaded images yet —') + '</option>';
    if (files.length) {
      html += '<optgroup label="Uploaded images">' +
        files.map(f => '<option value="' + esc(f.url) + '">' + esc(f.filename) + '</option>').join('') +
        '</optgroup>';
    }
    if (ordered.length) {
      html += '<optgroup label="Library files">' +
        ordered.map(a => '<option value="' + esc(a.url) + '">' + esc(a.title || a.originalName || a.url) + (a.composer ? ' (' + esc(a.composer) + ')' : '') + '</option>').join('') +
        '</optgroup>';
    }
    sel.innerHTML = html;
  });
}

function renderNotationThumbs() {
  document.querySelectorAll('.notation-thumb[data-slot]').forEach(span => {
    const slot = span.dataset.slot;
    const url = window._notationImages[slot];
    span.innerHTML = url
      ? '<img src="' + esc(url) + '" alt="notation"> <button type="button" title="Remove this notation" onclick="detachNotation(\\'' + slot + '\\')">&times;</button>'
      : '';
  });
}

// --- Service music carryover ---
// Default behavior (UAT June 2026): a new week's draft carries the service
// music over from the most recent draft. Checked = full carryover (fields
// collapsed); unchecked = the individual parts open up for editing.
function updateServiceMusicVisibility() {
  const fields = document.getElementById('serviceMusicFields');
  if (fields) fields.style.display = ch('serviceMusicCarryover') ? 'none' : '';
}

async function applyServiceMusicCarryover(opts) {
  opts = opts || {};
  updateServiceMusicVisibility();
  if (!ch('serviceMusicCarryover')) return;
  if (window._currentDraftId) return; // editing a saved draft — keep its values
  if (!_sessionToken) return;
  try {
    const res = await fetch('/api/drafts', { headers: { 'x-session-token': _sessionToken } });
    if (!res.ok) return;
    const drafts = await res.json();
    if (!drafts.length) {
      const note = document.getElementById('carryoverNote');
      if (note) note.textContent = 'No previous week found yet — fill in the parts below.';
      const cb = document.getElementById('serviceMusicCarryover');
      if (cb) { cb.checked = false; updateServiceMusicVisibility(); }
      return;
    }
    const latest = drafts[0]; // listed newest-first
    const dres = await fetch('/api/drafts/' + latest.id, { headers: { 'x-session-token': _sessionToken } });
    if (!dres.ok) return;
    const d = await dres.json();
    const ss = d.seasonalSettings || {};
    sv('gloriaSetting', ss.gloriaSetting);
    sv('holyHolySetting', ss.holyHolySetting);
    sv('holyHolyLanguage', ss.holyHolyLanguage || 'english');
    sv('mysteryOfFaithSetting', ss.mysteryOfFaithSetting);
    sv('lambOfGodSetting', ss.lambOfGodSetting);
    if (ss.penitentialAct) sv('penitentialAct', ss.penitentialAct);
    // Kyrie lives in the per-Mass blocks (same at every Mass).
    const blocks = [d.musicSat5pm, d.musicSun9am, d.musicSun11am].filter(Boolean);
    const kyrieBlock = blocks.find(b => b.kyrieSetting) || {};
    sv('shared_kyrie', kyrieBlock.kyrieSetting);
    sv('shared_kyrieComposer', kyrieBlock.kyrieComposer);
    // Carry over ALL notation-image placements from last week — every image
    // defaults to the spot it printed in last time. Swapping a hymn is one
    // pick in the "Print in" dropdown (which replaces the assignment).
    window._notationImages = { ...(d.notationImages || {}) };
    renderNotationThumbs();
    renderNotationList();
    const note = document.getElementById('carryoverNote');
    if (note) note.textContent = 'Carried over from ' + (d.feastName || 'previous draft') + (d.liturgicalDate ? ' (' + d.liturgicalDate + ')' : '') + '.';
    if (!opts.silent) toast('Service music carried over from last week', 'success');
  } catch (e) { /* carryover is best-effort */ }
}

function onServiceMusicCarryoverToggle() {
  if (ch('serviceMusicCarryover')) {
    applyServiceMusicCarryover();
  } else {
    updateServiceMusicVisibility();
    const note = document.getElementById('carryoverNote');
    if (note) note.textContent = '';
  }
}

// --- Image Uploads ---
async function uploadNotation(input) {
  if (!input.files || !input.files[0]) return;
  if (!_sessionToken) {
    toast('You are signed out — please log in to upload notation.', 'error');
    showLogin();
    input.value = '';
    return;
  }
  const formData = new FormData();
  formData.append('image', input.files[0]);
  // Strip titles by DEFAULT — only send '0' on an explicit uncheck.
  var _stripEl2 = document.getElementById('stripTitleHeaders');
  formData.append('stripTitle', _stripEl2 && !_stripEl2.checked ? '0' : '1');
  try {
    const res = await fetch('/api/upload/notation', {
      method: 'POST', headers: { 'x-session-token': _sessionToken }, body: formData
    });
    if (res.status === 401) {
      toast('Your session expired — please log in again.', 'error');
      _sessionToken = null;
      localStorage.removeItem('wa_token');
      showLogin();
      return;
    }
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
    toast((data.deduped ? 'Already uploaded — reusing the existing image' : 'Image uploaded' + (data.converted ? ' (converted to PNG)' : '') + (data.titleCropped ? ' — title header removed' : '')) + ': ' + data.originalName, 'success');
    // Cache the new file immediately — the server list is eventually
    // consistent and may not include it yet.
    addNotationFile(data.filename || data.originalName, data.url);
    renderNotationList();
    refreshNotationPicks();
  } catch(e) { toast('Upload error', 'error'); }
  input.value = '';
}

// Fetch the server's notation upload list and MERGE it into the client
// cache (dedupe by url) — never replace the cache, so files uploaded this
// session stay visible even while the server list lags behind.
async function loadNotationList() {
  try {
    const res = await fetch('/api/uploads/notation');
    const files = await res.json();
    (Array.isArray(files) ? files : []).forEach(f => addNotationFile(f.filename, f.url));
  } catch(e) {}
  // Library images appear in the same list (marked) so reusable music —
  // custom settings, staff/clergy compositions — is one dropdown away.
  try {
    const lib = (await getAttachmentCache()).filter(a => a.url && a.mime && a.mime.indexOf('image/') === 0);
    lib.forEach(a => {
      const existing = (window._notationFiles || []).find(f => f.url === a.url);
      if (existing) { existing.library = true; existing.filename = a.title || existing.filename; }
      else { window._notationFiles.push({ filename: a.title || a.originalName, url: a.url, library: true }); }
    });
  } catch (e) { /* library hints are best-effort */ }
  renderNotationList();
  refreshNotationPicks();
}

// Promote an uploaded notation image into the Library so it's reusable
// week after week (custom music, staff/clergy compositions).
async function saveNotationToLibrary(idx) {
  const f = (window._notationFiles || [])[idx];
  if (!f || f.library) return;
  const title = prompt('Library title for this music:', f.filename.replace(/\.[^.]+$/, ''));
  if (title === null) return;
  const composer = prompt('Composer (optional):', '') || '';
  try {
    const res = await fetch('/api/attachments/from-notation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken },
      body: JSON.stringify({ filename: f.url.split('/').pop(), title: title.trim() || f.filename, composer: composer.trim(), kind: 'general' })
    });
    if (handle401(res)) return;
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Could not save to Library', 'error'); return; }
    await getAttachmentCache(true);
    await loadNotationList();
    await refreshAttachmentPicker();
    toast('Saved to the Library: ' + (data.title || ''), 'success');
  } catch (e) { toast('Could not save to Library: ' + e.message, 'error'); }
}

// Render the Notation Images list from the client cache (deduped by URL).
// Each row: a hover-zoomable thumbnail, the filename, a STICKY "Print in:"
// dropdown showing the image's current spot, pills for multi-spot images,
// a "last printed in …" history hint with a one-click re-use button, and a
// delete button.
function renderNotationList() {
  const target = document.getElementById('notation-list');
  if (!target) return;
  // Re-rendering swaps the <img> under the cursor, so its mouseout never
  // fires — hide the zoom panel or it sticks open.
  const _z = document.getElementById('notation-zoom');
  if (_z) _z.style.display = 'none';
  // Defensive de-dupe by URL — duplicate rows confused testers.
  const seen = new Set();
  window._notationFiles = (window._notationFiles || []).filter(f => {
    if (!f || !f.url || seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });
  const files = window._notationFiles;
  if (!files.length) {
    target.innerHTML = '<p class="attachment-list-empty">No notation images uploaded yet.</p>';
    return;
  }
  const ni = window._notationImages || {};
  target.innerHTML = files.map((f, idx) => {
    const usedIn = Object.keys(NOTATION_SLOT_LABELS).filter(slot => ni[slot] === f.url);
    const pills = usedIn.length > 1 ? usedIn.map(slot =>
      '<span class="notation-use-pill">' + esc(NOTATION_SLOT_LABELS[slot]) +
      ' <button type="button" title="Don\\'t print in ' + esc(NOTATION_SLOT_LABELS[slot]) + '" onclick="detachNotation(\\'' + slot + '\\')">&times;</button></span>'
    ).join('') : '';
    // Sticky select: shows the current single assignment right in the box.
    const selectedSlot = usedIn.length === 1 ? usedIn[0] : '';
    const placeholder = usedIn.length === 0 ? 'Print in: choose a spot…'
      : (usedIn.length === 1 ? 'Don\\u2019t print this image' : 'Printing in ' + usedIn.length + ' spots — add another…');
    const options = '<option value="">' + placeholder + '</option>' +
      Object.keys(NOTATION_SLOT_LABELS).map(slot =>
        '<option value="' + slot + '"' + (slot === selectedSlot ? ' selected' : '') + '>' + esc(NOTATION_SLOT_LABELS[slot]) + '</option>'
      ).join('');
    // History: where this image printed in a previous week, with one-click
    // re-use (skip when it's already placed there).
    const last = (window._notationUsage || {})[f.url];
    let lastHtml = '';
    if (last && last.slot && NOTATION_SLOT_LABELS[last.slot] && !usedIn.includes(last.slot)) {
      lastHtml = '<span class="notation-last">last printed in ' + esc(NOTATION_SLOT_LABELS[last.slot]) +
        (last.liturgicalDate ? ' (' + esc(last.liturgicalDate) + ')' : '') +
        '<button type="button" onclick="attachNotation(\\'' + last.slot + '\\', \\'' + esc(jsq(f.url)) + '\\')">Use again</button></span>';
    }
    return '<div class="notation-row"' + (usedIn.length ? ' style="border-color:var(--gold);"' : '') + '>' +
      '<img src="' + esc(f.url) + '" alt="notation" title="Hover to zoom — click to open full size" onclick="window.open(\\'' + esc(jsq(f.url)) + '\\', \\'_blank\\')">' +
      '<span class="fn">' + (f.library ? '<span class="notation-lib-pill" title="Reusable Library music — manage it on the Library page">Library</span> ' : '') + esc(f.filename) + '</span>' +
      '<select onchange="assignNotationFromList(' + idx + ', this)" title="Choose where this image prints in the booklet">' + options + '</select>' +
      (pills ? '<span>' + pills + '</span>' : '') +
      lastHtml +
      (f.library ? '' :
        '<button type="button" class="btn btn-outline btn-sm" style="font-size:9px;padding:2px 6px;" title="Save to the Library as reusable music" onclick="saveNotationToLibrary(' + idx + ')">+ Library</button>' +
        '<button type="button" class="anthem-remove" title="Delete this uploaded image" onclick="deleteNotationFile(' + idx + ')">&times;</button>') +
    '</div>';
  }).join('');
}

// --- Hover zoom for notation thumbnails ---
// List thumbnails are too small to tell scans apart; hovering any notation
// image shows it near full size in a floating panel.
function _notationZoomEl() {
  let z = document.getElementById('notation-zoom');
  if (!z) {
    z = document.createElement('div');
    z.id = 'notation-zoom';
    z.innerHTML = '<img alt="zoomed notation">';
    document.body.appendChild(z);
  }
  return z;
}
function _positionZoom(z, e) {
  const pad = 16;
  const rect = z.getBoundingClientRect();
  let x = e.clientX + pad;
  if (x + rect.width > window.innerWidth - 8) x = Math.max(8, e.clientX - rect.width - pad);
  let y = Math.min(e.clientY - 40, window.innerHeight - rect.height - 8);
  if (y < 8) y = 8;
  z.style.left = x + 'px';
  z.style.top = y + 'px';
}
function _isNotationThumb(t) {
  return t && t.tagName === 'IMG' && (t.closest('.notation-row') || t.closest('.notation-thumb'));
}
document.addEventListener('mouseover', e => {
  if (!_isNotationThumb(e.target)) return;
  const z = _notationZoomEl();
  z.querySelector('img').src = e.target.src;
  z.style.display = 'block';
  _positionZoom(z, e);
});
document.addEventListener('mousemove', e => {
  const z = document.getElementById('notation-zoom');
  if (z && z.style.display === 'block' && _isNotationThumb(e.target)) _positionZoom(z, e);
});
document.addEventListener('mouseout', e => {
  if (!_isNotationThumb(e.target)) return;
  const z = document.getElementById('notation-zoom');
  if (z) z.style.display = 'none';
});

async function uploadLogo(input) {
  if (!input.files || !input.files[0]) return;
  if (!_sessionToken) {
    toast('You are signed out — please log in to upload a logo.', 'error');
    showLogin();
    input.value = '';
    return;
  }
  const formData = new FormData();
  formData.append('image', input.files[0]);
  try {
    const res = await fetch('/api/upload/logo', {
      method: 'POST', headers: { 'x-session-token': _sessionToken }, body: formData
    });
    if (res.status === 401) {
      toast('Your session expired — please log in again.', 'error');
      _sessionToken = null;
      localStorage.removeItem('wa_token');
      showLogin();
      return;
    }
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
  if (!_sessionToken) {
    toast('You are signed out — please log in to upload a cover.', 'error');
    showLogin();
    input.value = '';
    return;
  }
  const formData = new FormData();
  formData.append('image', input.files[0]);
  try {
    const res = await fetch('/api/upload/cover', {
      method: 'POST', headers: { 'x-session-token': _sessionToken }, body: formData
    });
    if (res.status === 401) {
      toast('Your session expired — please log in again.', 'error');
      _sessionToken = null;
      localStorage.removeItem('wa_token');
      showLogin();
      return;
    }
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
    const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken }, body: JSON.stringify(data) });
    if (handle401(res)) return;
    const result = await res.json();
    if (!res.ok) { toast('Save failed: ' + (result.error || res.status), 'error'); return; }
    window._currentDraftId = result.id;
    toast('Draft saved', 'success');
    setStatus('Draft saved at ' + new Date().toLocaleTimeString());
  } catch(e) { toast('Save error: ' + e.message, 'error'); }
}

async function generatePreview() {
  setStatus('Generating preview...');
  try {
    const data = buildData();
    const sizeSel = document.getElementById('bookletSize');
    if (sizeSel) data.bookletSize = sizeSel.value;
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    document.getElementById('preview-placeholder').style.display = 'none';
    document.getElementById('preview-content').style.display = 'block';
    // Size the preview frame to match the booklet trim so the preview is
    // a true-scale rendering of what'll print.  We respond to the server-
    // reported pageWidth (e.g., "5.5in" or "8.5in") and let the iframe
    // grow to fit each page's height x 8 pages.
    const frame = document.querySelector('.preview-frame');
    if (frame && result.pageWidth) frame.style.width = result.pageWidth;
    const iframe = document.getElementById('preview-iframe');
    iframe.srcdoc = result.html;
    iframe.onload = () => {
      // Body scrollHeight gives the rendered total; pad slightly so the
      // last page's content isn't clipped by the iframe.
      iframe.style.height = (iframe.contentDocument.body.scrollHeight + 16) + 'px';
      // The HTML preview clips overfull pages (fixed page boxes) — never
      // silently. Flag them so nobody discovers a cut-off Gloria in print:
      // the exported PDF shrinks content to fit the page (music blocks
      // stay whole) and reports anything it can't fit as a warning.
      try {
        const clipped = [];
        iframe.contentDocument.querySelectorAll('.page').forEach((p, i) => {
          if (p.scrollHeight > p.clientHeight + 4) clipped.push(i + 1);
        });
        if (clipped.length) {
          const warnEl = document.getElementById('overflow-warnings');
          warnEl.innerHTML += '<div class="overflow-indicator">Preview page' + (clipped.length > 1 ? 's' : '') + ' ' +
            clipped.join(', ') + ' hold more than fits the page box — the preview clips it, but the EXPORTED PDF shrinks the content to fit the page (music blocks stay whole). Export to see the real layout; any content the PDF cannot fit is reported as an export warning.</div>';
        }
      } catch (e) { /* same-origin only; never block the preview */ }
    };

    // Show overflow warnings AND renderer warnings (e.g. a notation image
    // that no longer exists on the server) — a count in the status bar is
    // too easy to miss.
    const warnEl = document.getElementById('overflow-warnings');
    warnEl.innerHTML = (result.overflows || []).map(o =>
      '<div class="overflow-indicator">' + esc(o.message) + '</div>'
    ).join('') + (result.warnings || []).map(w =>
      '<div class="overflow-indicator">' + esc(w) + '</div>'
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
    if (handle401(res)) { setStatus('Export blocked — signed out'); return; }
    if (!res.ok) {
      const result = await res.json();
      toast('Error: ' + (result.error || ''), 'error'); setStatus('Export blocked'); return;
    }
    const contentType = res.headers.get('content-type') || '';
    let exportWarnings = [];
    if (contentType.includes('application/pdf')) {
      // Direct PDF download (Netlify) — warnings ride in a header.
      try {
        const wh = res.headers.get('x-export-warnings');
        if (wh) exportWarnings = JSON.parse(decodeURIComponent(wh));
      } catch (e) { /* malformed header — never block the download */ }
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
      exportWarnings = result.warnings || [];
      const a = document.createElement('a'); a.href = result.downloadUrl; a.download = result.filename; a.click();
      toast('PDF exported: ' + result.filename, 'success');
    }
    // The export must NEVER drop or shrink content silently — show every
    // generator warning in the warnings panel and call it out in a toast.
    const exWarnEl = document.getElementById('overflow-warnings');
    if (exWarnEl) {
      exWarnEl.innerHTML = exportWarnings.map(w =>
        '<div class="overflow-indicator">' + esc(w) + '</div>'
      ).join('');
    }
    if (exportWarnings.length) {
      toast(exportWarnings.length + ' export warning(s) — see the warnings panel above the preview.', 'error');
      setStatus('PDF exported', exportWarnings.length + ' warning(s)');
    } else {
      setStatus('PDF exported');
    }
  } catch(e) { toast('PDF error: ' + e.message, 'error'); }
}

// --- History ---
async function loadHistory() {
  try {
    const res = await fetch('/api/drafts', { headers: { 'x-session-token': _sessionToken } });
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
            '<h3>' + esc(d.feastName || 'Untitled') + ' ' +
              (d.isFinal
                ? '<span class="status-badge final" title="The last PDF exported for this week — what was printed">FINAL</span>'
                : '<span class="status-badge ' + status + '">' + (status === 'exported' ? 'exported (superseded)' : status) + '</span>') +
            '</h3>' +
            '<p>' + esc(d.liturgicalDate || '') + ' &bull; ' + esc(d.liturgicalSeason || '') + ' &bull; Updated ' + new Date(d.updatedAt).toLocaleDateString() + (d.lastEditedBy ? ' by ' + esc(d.lastEditedBy) : '') + approvalInfo + '</p>' +
          '</div>' +
          '<div class="actions">' +
            approvalBtns +
            (!d.isFinal && d.liturgicalDate ? '<button class="btn btn-outline btn-sm" style="border-color:var(--gold);color:#7a5f1a;" title="Make this the week\\u2019s version of record (stats follow it)" onclick="markDraftFinal(\\'' + d.id + '\\')">Mark FINAL</button>' : '') +
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
    summary.textContent = data.totalDrafts + ' exported week' + (data.totalDrafts === 1 ? '' : 's') + ' analyzed · ' + data.hymns.length + ' distinct hymn' + (data.hymns.length === 1 ? '' : 's') + ' used.';
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

async function markDraftFinal(id) {
  if (!confirm('Make this the FINAL version of record for its week? The current FINAL (if any) becomes a superseded draft, and hymn stats will count this version.')) return;
  try {
    const res = await fetch('/api/drafts/' + id + '/mark-final', { method: 'POST', headers: { 'x-session-token': _sessionToken } });
    if (handle401(res)) return;
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Could not mark as FINAL', 'error'); return; }
    toast('Marked as the week\\u2019s FINAL', 'success');
    loadHistory();
  } catch (e) { toast('Could not mark as FINAL: ' + e.message, 'error'); }
}

async function openDraft(id) {
  const res = await fetch('/api/drafts/' + id, { headers: { 'x-session-token': _sessionToken } });
  const data = await res.json();
  populateForm(data);
  showPage('editor');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector('[data-page="editor"]').classList.add('active');
  toast('Draft loaded', 'success');
}

async function dupDraft(id) {
  await fetch('/api/drafts/' + id + '/duplicate', { method: 'POST', headers: { 'x-session-token': _sessionToken } });
  loadHistory();
  toast('Draft duplicated', 'success');
}

async function delDraft(id) {
  if (!confirm('Delete this draft?')) return;
  await fetch('/api/drafts/' + id, { method: 'DELETE', headers: { 'x-session-token': _sessionToken } });
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
  try {
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-session-token': _sessionToken }, body: JSON.stringify(s) });
    if (handle401(res)) return;
    const saved = await res.json();
    if (!res.ok) { toast('Settings NOT saved: ' + (saved.error || res.status), 'error'); return; }
    // Keep the in-memory copy in sync with what the server actually stored
    // (merged over existing settings) so previews immediately reflect it.
    window._parishSettings = saved;
    toast('Settings saved', 'success');
  } catch (e) {
    toast('Settings NOT saved: ' + e.message, 'error');
  }
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
    // Pre-fill the Responsorial Psalm music slot with the refrain text so
    // the music director can search OneLicense for a matching setting
    // without retyping. Skip the autofill if a setting is already chosen.
    const psalmSlot = document.getElementById('shared_responsorialPsalm');
    if (psalmSlot && !psalmSlot.value && data.psalmRefrain) {
      psalmSlot.value = data.psalmRefrain;
      psalmSlot.dispatchEvent(new Event('input', { bubbles: true }));
    }
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

// --- OneLicense search helpers ---
// OneLicense's basic search takes a free-text query.  Hymnal + number is
// the most specific identifier the music director can give it; we fall
// back to title + composer when those aren't filled in.
function openOneLicenseSearch(titleId, hymnalId, numberId, composerId) {
  const title    = v(titleId);
  const hymnal   = v(hymnalId);
  const number   = v(numberId);
  const composer = v(composerId);
  let query = '';
  if (hymnal && number) query = hymnal + ' #' + number;
  else if (hymnal)      query = hymnal;
  else if (number)      query = '#' + number;
  else                  query = [title, composer].filter(Boolean).join(' ');
  if (!query) {
    toast('Enter a hymnal & number, or a title, to search OneLicense', 'error');
    return;
  }
  const url = 'https://www.onelicense.net/search?text=' + encodeURIComponent(query);
  window.open(url, '_blank', 'noopener');
}

// Search OneLicense by the responsorial-psalm refrain. The refrain text is
// the most useful query for finding a published psalm setting that matches
// today's lectionary.
function openOneLicenseForPsalm() {
  const refrain = v('psalmRefrain');
  const citation = v('psalmCitation');
  let query = refrain || citation || '';
  if (!query) {
    toast('Set a psalm refrain (or fetch readings) before searching', 'error');
    return;
  }
  const url = 'https://www.onelicense.net/search?text=' + encodeURIComponent(query);
  window.open(url, '_blank', 'noopener');
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
    // Hymnal + number (e.g., "Worship IV #612") is the most useful identifier
    // for the music director — that's what they type into OneLicense.
    const hymnalLabel = [h.hymnal, h.hymnNumber ? '#' + h.hymnNumber : ''].filter(Boolean).join(' ');
    row.innerHTML =
      '<div style="font-weight:600;">' + esc(h.title) + (hymnalLabel ? ' <span style="color:var(--burgundy);font-weight:500;">[' + esc(hymnalLabel) + ']</span>' : '') + '</div>' +
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
      // Auto-populate the paired hymnal + number inputs if the slot has them.
      const hymnalId = input.dataset.pairHymnal;
      if (hymnalId && h.hymnal) {
        const hinp = document.getElementById(hymnalId);
        if (hinp && !hinp.value) { hinp.value = h.hymnal; hinp.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      const hymnNumberId = input.dataset.pairHymnnumber;
      if (hymnNumberId && h.hymnNumber) {
        const ninp = document.getElementById(hymnNumberId);
        if (ninp && !ninp.value) { ninp.value = h.hymnNumber; ninp.dispatchEvent(new Event('input', { bubbles: true })); }
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
// so the user can pick a psalm setting etc. from the library.
refreshAttachmentPicker();
refreshAttachmentSlotSelectors();
renderAttachmentRefList();
// Anthem rows: two offertory slots + one choral slot by default (UAT).
renderAnthemRows('offertory', [], 2);
renderAnthemRows('choral', [], 1);
// Notation list + pickers (renders from the client cache after merging the
// server's eventually-consistent list) + carryover field visibility.
loadNotationList();
updateServiceMusicVisibility();

// --- Auto-save ---
let _autoSaveTimer;
document.getElementById('editor').addEventListener('input', () => {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    if (v('feastName') || v('liturgicalDate')) saveDraft();
  }, 30000);
});

// --- Session snapshot: a reload must not blow away in-progress work ---
// Every edit (debounced) snapshots the full form to localStorage. On the
// next load, recent work (< 24h) restores automatically; older work (up to
// 7 days) is offered via a Restore button so a new week can start fresh.
const SNAPSHOT_KEY = 'wa_editor_snapshot';
let _snapshotTimer;
function snapshotEditor() {
  clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(() => {
    try {
      const data = buildData();
      if (!data.feastName && !data.liturgicalDate) return;
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch (e) { /* quota/serialization — snapshot is best-effort */ }
  }, 1500);
}
document.getElementById('editor').addEventListener('input', snapshotEditor);
document.getElementById('editor').addEventListener('change', snapshotEditor);
window.addEventListener('beforeunload', () => {
  clearTimeout(_snapshotTimer);
  try {
    const data = buildData();
    if (data.feastName || data.liturgicalDate) {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    }
  } catch (e) { /* best-effort */ }
});

function readSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.data || !snap.savedAt) return null;
    if (Date.now() - snap.savedAt > 7 * 24 * 60 * 60 * 1000) return null; // stale
    return snap;
  } catch (e) { return null; }
}

function restoreSnapshot() {
  const snap = readSnapshot();
  if (!snap) { toast('Nothing to restore', 'error'); return; }
  populateForm(snap.data);
  const btn = document.getElementById('btn-restore');
  if (btn) btn.style.display = 'none';
  toast('Restored your last session (' + new Date(snap.savedAt).toLocaleString() + ') — Save Draft to keep it', 'success');
}

// Called once after login: fresh work resumes automatically; older work
// gets a Restore button in the nav.
function offerSnapshotRestore() {
  const snap = readSnapshot();
  if (!snap) return false;
  const ageHours = (Date.now() - snap.savedAt) / 3600000;
  if (ageHours < 24) {
    restoreSnapshot();
    return true;
  }
  const btn = document.getElementById('btn-restore');
  if (btn) btn.style.display = '';
  return false;
}

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

// Helper: per-slot notation attach control. Upload a new image (TIFF/JPG/
// PNG — converted + cropped server-side) or pick one already uploaded; the
// image then prints inside the slot's reserved music area in the booklet.
function notationCtl(slot, label) {
  return `
        <div class="notation-ctl" id="nctl_${slot}">
          <input type="file" id="nfile_${slot}" accept="image/*,.tif,.tiff" style="display:none" onchange="uploadNotationForSlot('${slot}', this)">
          <button type="button" class="btn btn-outline btn-sm" title="${label}" onclick="document.getElementById('nfile_${slot}').click()">&#9834; Attach notation</button>
          <select data-notation-pick id="npick_${slot}" onchange="attachNotationFromPick('${slot}', this)">
            <option value="">— or pick an uploaded image —</option>
          </select>
          <span class="notation-thumb" data-slot="${slot}"></span>
        </div>`;
}

// Helper: the Shared Music section — every slot that's the same at every
// Mass. Organ prelude/postlude are typed in directly (title + composer —
// no library hookup, per UAT). Hymns get the hymn-library typeahead,
// hymnal/number inputs, OneLicense search, and a notation attach control.
// The Kyrie and the other sung Mass parts live in Service Music & Seasonal
// Settings; anthems have their own per-Mass section.
function sharedMusicFields() {
  // [titleId, composerId, label, source]   source: 'hymn', 'psalm', or 'plain'
  const fields = [
    ['organPrelude',         'organPreludeComposer',  'Organ Prelude',                    'plain'],
    ['processional',         'processionalComposer',  'Processional / Entrance Hymn',     'hymn'],
    // Responsorial Psalm setting — printed in the booklet's psalm section,
    // and the refrain text feeds the OneLicense search so the music
    // director can find a published setting that matches.
    ['responsorialPsalm',    'responsorialPsalmComposer', 'Responsorial Psalm Setting',   'psalm'],
    ['communion',            'communionComposer',     'Communion Hymn',                   'hymn'],
    ['thanksgiving',         'thanksgivingComposer',  'Hymn of Thanksgiving',             'hymn'],
    ['postlude',             'postludeComposer',      'Organ Postlude',                   'plain']
  ];
  const NOTATION_SLOT = {
    processional: 'processional',
    communion: 'communion',
    thanksgiving: 'thanksgiving',
    responsorialPsalm: 'psalmRefrain'
  };
  return fields.map(([titleId, compId, label, source]) => {
    const isHymn = source === 'hymn';
    const isPsalm = source === 'psalm';
    const titleAttrs = isHymn
      ? `data-hymn-search="title" data-pair-composer="shared_${compId}" data-pair-hymnal="shared_${titleId}_hymnal" data-pair-hymnnumber="shared_${titleId}_hymnNumber"`
      : `data-pair-composer="shared_${compId}"`;
    let helper;
    if (isHymn) {
      helper = `
        <span style="font-size:9px;color:var(--gray);">type to search the hymn library — picks fill hymnal &amp; number</span>
        <div class="hymnal-pick-row" style="display:grid;grid-template-columns:2fr 1fr auto;gap:4px;align-items:center;margin-top:2px;">
          <input type="text" id="shared_${titleId}_hymnal" placeholder="Hymnal (e.g., Worship IV)" style="font-size:11px;padding:4px 6px;">
          <input type="text" id="shared_${titleId}_hymnNumber" placeholder="#" style="font-size:11px;padding:4px 6px;">
          <button type="button" class="btn btn-outline btn-sm" style="padding:4px 8px;font-size:10px;" onclick="openOneLicenseSearch('shared_${titleId}', 'shared_${titleId}_hymnal', 'shared_${titleId}_hymnNumber', 'shared_${compId}')">OneLicense</button>
        </div>
        ${notationCtl(NOTATION_SLOT[titleId], label + ' notation')}`;
    } else if (isPsalm) {
      helper = `
        <span style="font-size:9px;color:var(--gray);">setting for today's psalm — refrain feeds the OneLicense search</span>
        <div class="attachment-pick-row">
          <select data-attachment-slot="shared_${titleId}" data-attachment-kind="psalm" id="shared_${titleId}_attachmentSelect" onchange="pickAttachmentIntoMusicSlot('shared', '${titleId}', 'psalm')">
            <option value="">— pick from library —</option>
          </select>
        </div>
        <button type="button" class="btn btn-outline btn-sm" style="padding:4px 8px;font-size:10px;margin-top:2px;" onclick="openOneLicenseForPsalm()">Search OneLicense by refrain</button>
        ${notationCtl(NOTATION_SLOT[titleId], 'Psalm refrain notation')}`;
    } else {
      // Organ prelude / postlude: plain title + composer, typed in directly.
      helper = '';
    }
    return `
      <div class="fg-row">
        <div class="fg" style="position:relative;">
          <label>${label}</label>
          <input type="text" id="shared_${titleId}" placeholder="Title" autocomplete="off" ${titleAttrs}>
          ${helper}
        </div>
        <div class="fg"><label>&nbsp;</label><input type="text" id="shared_${compId}" placeholder="Composer"></div>
      </div>
    `;
  }).join('');
}

module.exports = app;
module.exports.getAppHtml = getAppHtml;
module.exports.seedReady = _seedReady;
