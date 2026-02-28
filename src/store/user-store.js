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
  admin: ['edit_all', 'manage_users', 'manage_settings', 'edit_readings', 'edit_music', 'edit_seasonal', 'approve', 'export_pdf', 'edit_announcements', 'upload_images', 'edit_cover'],
  music_director: ['edit_music', 'edit_seasonal', 'upload_images', 'export_pdf'],
  pastor: ['edit_readings', 'approve', 'edit_announcements'],
  staff: ['edit_readings', 'edit_music', 'edit_announcements', 'edit_seasonal', 'export_pdf']
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
  return users.find(u => u.username === username) || null;
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

// Simple session management
async function loadSessions() {
  const data = await kv.get('sessions', '_all');
  return data || {};
}

async function saveSessions(sessions) {
  await kv.set('sessions', '_all', sessions);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = await loadSessions();

  // Enforce exclusive login: only one active session per role
  const user = await getUser(userId);
  if (user) {
    const toRemove = [];
    for (const [tok, sess] of Object.entries(sessions)) {
      const sessUser = await getUser(sess.userId);
      if (sessUser && sessUser.role === user.role && sessUser.id !== userId) {
        toRemove.push(tok);
      }
    }
    toRemove.forEach(tok => delete sessions[tok]);
  }

  sessions[token] = { userId, createdAt: new Date().toISOString() };
  await saveSessions(sessions);
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const sessions = await loadSessions();
  const session = sessions[token];
  if (!session) return null;
  const user = await getUser(session.userId);
  if (!user) return null;
  return sanitizeUser(user);
}

async function destroySession(token) {
  const sessions = await loadSessions();
  delete sessions[token];
  await saveSessions(sessions);
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
  seedDefaultUsers
};
