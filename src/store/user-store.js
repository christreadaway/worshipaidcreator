// User management with role-based access
// Roles derived from worksheet: admin (Director of Liturgy), music_director, pastor, staff
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

fs.mkdirSync(USERS_DIR, { recursive: true });

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

function createUser({ username, displayName, role, password }) {
  if (!ROLES.includes(role)) throw new Error('Invalid role: ' + role);
  if (!username || !password) throw new Error('Username and password required');

  const existing = listUsers().find(u => u.username === username);
  if (existing) throw new Error('Username already exists');

  const id = generateId();
  const user = {
    id,
    username,
    displayName: displayName || username,
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    active: true
  };
  const filePath = path.join(USERS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(user, null, 2), 'utf8');
  return sanitizeUser(user);
}

function getUser(id) {
  const filePath = path.join(USERS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getUserByUsername(username) {
  const users = listUsersRaw();
  return users.find(u => u.username === username) || null;
}

function listUsersRaw() {
  const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8')));
}

function listUsers() {
  return listUsersRaw().map(sanitizeUser).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function updateUser(id, updates) {
  const user = getUser(id);
  if (!user) return null;
  if (updates.password) {
    updates.passwordHash = hashPassword(updates.password);
    delete updates.password;
  }
  const updated = { ...user, ...updates, id };
  const filePath = path.join(USERS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
  return sanitizeUser(updated);
}

function deleteUser(id) {
  const filePath = path.join(USERS_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function authenticateUser(username, password) {
  const user = getUserByUsername(username);
  if (!user || !user.active) return null;
  if (user.passwordHash !== hashPassword(password)) return null;
  return sanitizeUser(user);
}

function sanitizeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// Simple session management
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch { return {}; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { userId, createdAt: new Date().toISOString() };
  saveSessions(sessions);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return null;
  const user = getUser(session.userId);
  if (!user) return null;
  return sanitizeUser(user);
}

function destroySession(token) {
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}

function hasPermission(user, permission) {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role] || [];
  return perms.includes(permission) || perms.includes('edit_all');
}

// Seed default users based on worksheet roles
function seedDefaultUsers() {
  const users = listUsersRaw();
  if (users.length > 0) return; // Already seeded

  const defaults = [
    { username: 'jd', displayName: 'J.D. (Director of Liturgy)', role: 'admin', password: 'worship2026' },
    { username: 'musicdirector', displayName: 'Music Director', role: 'music_director', password: 'music2026' },
    { username: 'pastor', displayName: 'Pastor', role: 'pastor', password: 'pastor2026' },
    { username: 'staff', displayName: 'Parish Staff', role: 'staff', password: 'staff2026' }
  ];

  defaults.forEach(u => {
    try { createUser(u); } catch (e) { /* skip if exists */ }
  });
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  createUser,
  getUser,
  getUserByUsername,
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
