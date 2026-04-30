// User management with role-based access
// Roles derived from worksheet: admin (Director of Liturgy), music_director, pastor, staff
'use strict';

const crypto = require('crypto');
const kv = require('./kv');

const ROLES = ['admin', 'music_director', 'pastor', 'staff'];

const ROLE_LABELS = {
  admin: 'Director of Liturgy',
  music_director: 'Music Director',
  pastor: 'Pastor',
  staff: 'Staff'
};

// What each role can do
const ROLE_PERMISSIONS = {
  admin: ['edit_all', 'manage_users', 'manage_settings', 'manage_attachments', 'edit_readings', 'edit_music', 'edit_seasonal', 'approve', 'export_pdf', 'edit_announcements', 'upload_images', 'edit_cover'],
  music_director: ['edit_music', 'edit_seasonal', 'upload_images', 'manage_attachments', 'export_pdf'],
  pastor: ['edit_readings', 'approve', 'edit_announcements'],
  staff: ['edit_readings', 'edit_music', 'edit_announcements', 'edit_seasonal', 'manage_attachments', 'export_pdf']
};

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function createUser({ username, displayName, role, password, googleEmail }) {
  if (!ROLES.includes(role)) throw new Error('Invalid role: ' + role);
  if (!username) throw new Error('Username required');

  const existing = await getUserByUsername(username);
  if (existing) throw new Error('Username already exists');

  const id = generateId();
  const user = {
    id,
    username,
    displayName: displayName || username,
    role,
    passwordHash: password ? hashPassword(password) : '',
    googleEmail: googleEmail || '',
    createdAt: new Date().toISOString(),
    active: true
  };
  await kv.set('users', id, user);
  return sanitizeUser(user);
}

async function getUser(id) {
  return kv.get('users', id);
}

async function getUserByUsername(username) {
  const users = await listUsersRaw();
  const lower = username.toLowerCase();
  // Exact username match (case-insensitive)
  const byUsername = users.find(u => u.username.toLowerCase() === lower);
  if (byUsername) return byUsername;
  // Fallback: strip dots/spaces and compare to username (e.g. "Fr. Larry" -> "frlarry")
  const normalized = lower.replace(/[\s.]+/g, '');
  const byNormalized = users.find(u => u.username.toLowerCase() === normalized);
  if (byNormalized) return byNormalized;
  // Fallback: match by full display name (e.g. "Morris" matches "Morris (Music Director)")
  const byDisplayFull = users.find(u => {
    const namepart = u.displayName.split('(')[0].trim().replace(/[\s.]+/g, '').toLowerCase();
    return namepart === normalized;
  });
  if (byDisplayFull) return byDisplayFull;
  // Fallback: match by any word in display name (e.g. "Larry" matches "Fr. Larry (Pastor)")
  return users.find(u => {
    const words = u.displayName.split('(')[0].trim().split(/[\s.]+/).filter(Boolean);
    return words.some(w => w.toLowerCase() === lower);
  }) || null;
}

async function getUserByGoogleEmail(email) {
  if (!email) return null;
  const users = await listUsersRaw();
  return users.find(u => u.googleEmail && u.googleEmail.toLowerCase() === email.toLowerCase()) || null;
}

async function listUsersRaw() {
  return kv.list('users');
}

async function listUsers() {
  const raw = await listUsersRaw();
  return raw.map(sanitizeUser).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function updateUser(id, updates) {
  const user = await getUser(id);
  if (!user) return null;
  if (updates.password) {
    updates.passwordHash = hashPassword(updates.password);
    delete updates.password;
  }
  const updated = { ...user, ...updates, id };
  await kv.set('users', id, updated);
  return sanitizeUser(updated);
}

async function deleteUser(id) {
  await kv.del('users', id);
  return true;
}

async function authenticateUser(username, password) {
  const user = await getUserByUsername(username);
  if (!user || !user.active) return null;
  // Beta mode: skip password check — login by username only
  // TODO: re-enable password check for production
  // if (user.passwordHash !== hashPassword(password)) return null;
  return sanitizeUser(user);
}

function sanitizeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// --- Sessions: stateless HMAC tokens ---
// Tokens are self-contained: `<userId>.<issuedAtMs>.<hmac>`
// Verification only requires the secret + userId lookup, no per-session
// storage. This eliminates the "Not authenticated" bug on Netlify when
// the in-memory blob fallback drops state between Lambda invocations.
//
// A revocation list is still persisted (in the existing `sessions` KV) so
// logout works; tokens older than SESSION_MAX_AGE_MS (30 days) are rejected
// regardless.

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getSessionSecret() {
  // Process env first (set in production); fall back to a fixed dev secret so
  // local restarts don't invalidate every session. NOT a security boundary
  // for parish use — it just stops accidental cross-user impersonation.
  return process.env.SESSION_SECRET || 'wa-default-dev-secret-please-set-SESSION_SECRET-in-prod';
}

function signSessionToken(userId) {
  const issued = Date.now();
  const payload = `${userId}.${issued}`;
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function parseSessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, issuedStr, sig] = parts;
  const issued = parseInt(issuedStr, 10);
  if (!userId || !Number.isFinite(issued)) return null;
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(`${userId}.${issued}`).digest('hex');
  // Timing-safe compare to avoid leaking signature bytes via response timing.
  const expBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(sig, 'hex');
  if (expBuf.length !== sigBuf.length) return null;
  if (!crypto.timingSafeEqual(expBuf, sigBuf)) return null;
  if (Date.now() - issued > SESSION_MAX_AGE_MS) return null;
  return { userId, issued };
}

// Persisted revocation list — small, just tokens that have been logged out.
async function loadRevoked() {
  const data = await kv.get('sessions', '_revoked');
  return (data && Array.isArray(data.tokens)) ? data.tokens : [];
}

async function saveRevoked(tokens) {
  await kv.set('sessions', '_revoked', { tokens });
}

async function createSession(userId) {
  // Enforce exclusive login per role: invalidate older sessions belonging
  // to OTHER users with the same role.  A parish wants only one music
  // director / pastor / staff / admin actively editing at a time.
  // Implementation: bump revokedBefore on every same-role user so any
  // token issued earlier no longer validates.
  const user = await getUser(userId);
  if (user) {
    const all = await listUsersRaw();
    const sameRole = all.filter(u => u.role === user.role && u.id !== userId);
    const now = Date.now();
    for (const u of sameRole) {
      if (!u.revokedBefore || u.revokedBefore < now) {
        await kv.set('users', u.id, { ...u, revokedBefore: now });
      }
    }
  }
  return signSessionToken(userId);
}

async function getSessionUser(token) {
  const parsed = parseSessionToken(token);
  if (!parsed) return null;
  const revoked = await loadRevoked();
  if (revoked.includes(token)) return null;
  const user = await getUser(parsed.userId);
  if (!user || !user.active) return null;
  // Per-user revocation cutoff (set when another same-role user logs in,
  // or when the user explicitly logs everything out).
  if (user.revokedBefore && parsed.issued < user.revokedBefore) return null;
  return sanitizeUser(user);
}

async function destroySession(token) {
  const parsed = parseSessionToken(token);
  if (!parsed) return; // already invalid; nothing to revoke
  const revoked = await loadRevoked();
  if (!revoked.includes(token)) {
    revoked.push(token);
    // Cap the list at a reasonable size so it doesn't grow unbounded —
    // older tokens self-expire via SESSION_MAX_AGE_MS anyway.
    const trimmed = revoked.slice(-500);
    await saveRevoked(trimmed);
  }
}

function hasPermission(user, permission) {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role] || [];
  return perms.includes(permission) || perms.includes('edit_all');
}

// Seed default users based on worksheet roles
async function seedDefaultUsers() {
  const defaults = [
    { username: 'jd', displayName: 'J.D. (Director of Liturgy)', role: 'admin', password: 'worship2026' },
    { username: 'morris', displayName: 'Morris (Music Director)', role: 'music_director', password: 'music2026' },
    { username: 'vincent', displayName: 'Vincent (Music Director)', role: 'music_director', password: 'music2026' },
    { username: 'frlarry', displayName: 'Fr. Larry (Pastor)', role: 'pastor', password: 'pastor2026' },
    { username: 'kari', displayName: 'Kari (Staff)', role: 'staff', password: 'staff2026' },
    { username: 'donna', displayName: 'Donna (Staff)', role: 'staff', password: 'staff2026' }
  ];

  for (const u of defaults) {
    const existing = await getUserByUsername(u.username);
    if (!existing) {
      try { await createUser(u); } catch (e) { /* skip if exists */ }
    }
  }
}

// Per-user preferences — small JSON object stored alongside the user record.
// These are static "week to week" for the same user (e.g. their preferred
// default Sanctus language, default booklet size, last-used hymnal).
// Distinct from parish-wide settings (which apply to all users).
async function getUserPrefs(userId) {
  const user = await getUser(userId);
  return (user && user.prefs) || {};
}

async function setUserPrefs(userId, prefs) {
  const user = await getUser(userId);
  if (!user) return null;
  const merged = { ...(user.prefs || {}), ...(prefs || {}) };
  const updated = { ...user, prefs: merged };
  await kv.set('users', userId, updated);
  return merged;
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  createUser,
  getUser,
  getUserByUsername,
  getUserByGoogleEmail,
  listUsers,
  updateUser,
  deleteUser,
  authenticateUser,
  createSession,
  getSessionUser,
  destroySession,
  hasPermission,
  seedDefaultUsers,
  getUserPrefs,
  setUserPrefs
};
