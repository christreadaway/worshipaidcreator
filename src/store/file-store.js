// Persistence for drafts and parish settings
// Uses KV abstraction: filesystem locally, Netlify Blobs in production
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kv = require('./kv');

const EXPORTS_DIR = path.join(kv.DATA_DIR, 'exports');
if (!kv.IS_NETLIFY) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

// --- DRAFTS ---

async function saveDraft(data) {
  const id = data.id || generateId();
  const now = new Date().toISOString();
  const record = {
    ...data,
    id,
    updatedAt: now,
    createdAt: data.createdAt || now,
    status: data.status || 'draft'
  };
  await kv.set('drafts', id, record);
  return record;
}

async function loadDraft(id) {
  return kv.get('drafts', id);
}

async function listDrafts() {
  const all = await kv.list('drafts');
  const drafts = all.map(data => ({
    id: data.id,
    feastName: data.feastName,
    liturgicalDate: data.liturgicalDate,
    liturgicalSeason: data.liturgicalSeason,
    status: data.status,
    lastEditedBy: data.lastEditedBy,
    approvedBy: data.approvedBy,
    approvedAt: data.approvedAt,
    submittedBy: data.submittedBy,
    updatedAt: data.updatedAt,
    createdAt: data.createdAt
  }));
  return drafts.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function deleteDraft(id) {
  await kv.del('drafts', id);
  return true;
}

async function duplicateDraft(id) {
  const original = await loadDraft(id);
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

async function loadSettings() {
  const { DEFAULT_PARISH_SETTINGS } = require('../config/defaults');
  const saved = await kv.get('settings', 'parish');
  if (!saved) {
    await kv.set('settings', 'parish', DEFAULT_PARISH_SETTINGS);
    return { ...DEFAULT_PARISH_SETTINGS };
  }
  return { ...DEFAULT_PARISH_SETTINGS, ...saved };
}

async function saveSettings(settings) {
  await kv.set('settings', 'parish', settings);
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
