// File-based persistence for drafts and parish settings
// Replaces Firebase Firestore for local/dev use — PRD Section 4.4, 6.2
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings', 'parish-settings.json');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

// Ensure directories exist
[DRAFTS_DIR, path.dirname(SETTINGS_FILE), EXPORTS_DIR].forEach(d => {
  fs.mkdirSync(d, { recursive: true });
});

// --- DRAFTS ---

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function saveDraft(data) {
  const id = data.id || generateId();
  const now = new Date().toISOString();
  const record = {
    ...data,
    id,
    updatedAt: now,
    createdAt: data.createdAt || now,
    status: data.status || 'draft'
  };
  const filePath = path.join(DRAFTS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

function loadDraft(id) {
  const filePath = path.join(DRAFTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listDrafts() {
  const files = fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json'));
  const drafts = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
    return {
      id: data.id,
      feastName: data.feastName,
      liturgicalDate: data.liturgicalDate,
      liturgicalSeason: data.liturgicalSeason,
      status: data.status,
      updatedAt: data.updatedAt,
      createdAt: data.createdAt
    };
  });
  return drafts.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function deleteDraft(id) {
  const filePath = path.join(DRAFTS_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function duplicateDraft(id) {
  const original = loadDraft(id);
  if (!original) return null;
  const newId = generateId();
  const copy = {
    ...original,
    id: newId,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    feastName: original.feastName + ' (copy)'
  };
  return saveDraft(copy);
}

// --- PARISH SETTINGS ---

function loadSettings() {
  const { DEFAULT_PARISH_SETTINGS } = require('../config/defaults');
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_PARISH_SETTINGS, null, 2), 'utf8');
    return { ...DEFAULT_PARISH_SETTINGS };
  }
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  return { ...DEFAULT_PARISH_SETTINGS, ...saved };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

// --- EXPORTS ---

function getExportsDir() {
  return EXPORTS_DIR;
}

module.exports = {
  saveDraft,
  loadDraft,
  listDrafts,
  deleteDraft,
  duplicateDraft,
  loadSettings,
  saveSettings,
  getExportsDir,
  generateId
};
