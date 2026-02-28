// Key-value storage abstraction
// Local dev: uses filesystem under data/
// Netlify: uses @netlify/blobs, with in-memory fallback if blobs aren't configured
'use strict';

const fs = require('fs');
const path = require('path');

// Detect Netlify environment — check multiple indicators because
// process.env.NETLIFY may not be set in the function runtime
const IS_NETLIFY = !!(
  process.env.NETLIFY ||
  process.env.NETLIFY_BLOBS_CONTEXT ||
  process.env.DEPLOY_PRIME_URL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// In-memory fallback store for when Netlify Blobs aren't configured
// Data persists within a single Lambda invocation but is lost on cold start
const _memStore = {};
let _blobsAvailable = null; // null = unknown, true/false after first attempt

function memGet(namespace, key) {
  return (_memStore[namespace] && _memStore[namespace][key]) || null;
}
function memSet(namespace, key, value) {
  if (!_memStore[namespace]) _memStore[namespace] = {};
  _memStore[namespace][key] = JSON.parse(JSON.stringify(value));
}
function memDel(namespace, key) {
  if (_memStore[namespace]) delete _memStore[namespace][key];
}
function memList(namespace) {
  if (!_memStore[namespace]) return [];
  return Object.values(_memStore[namespace]).map(v => JSON.parse(JSON.stringify(v)));
}

// Lazy-loaded Netlify Blobs store
let _blobStores = {};
function getBlobStore(namespace) {
  if (!_blobStores[namespace]) {
    const { getStore } = require('@netlify/blobs');
    _blobStores[namespace] = getStore(namespace);
  }
  return _blobStores[namespace];
}

// Test if blobs are actually usable (runs once)
async function checkBlobsAvailable() {
  if (_blobsAvailable !== null) return _blobsAvailable;
  try {
    const store = getBlobStore('_health');
    await store.setJSON('_ping', { t: Date.now() });
    _blobsAvailable = true;
    console.log('[KV] Netlify Blobs: available');
  } catch (e) {
    _blobsAvailable = false;
    console.warn('[KV] Netlify Blobs NOT available — using in-memory fallback. Data will not persist across cold starts.');
    console.warn('[KV] Reason:', e.message);
  }
  return _blobsAvailable;
}

// Ensure local directory exists (only used in non-Netlify mode)
function ensureDir(namespace) {
  const dir = path.join(DATA_DIR, namespace);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    console.warn('[KV] Cannot create dir (read-only fs?):', dir, e.message);
  }
  return dir;
}

async function get(namespace, key) {
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      const data = await store.get(key, { type: 'json' });
      return data || null;
    }
    return memGet(namespace, key);
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function set(namespace, key, value) {
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      await store.setJSON(key, value);
      return;
    }
    memSet(namespace, key, value);
    return;
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function del(namespace, key) {
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      await store.delete(key);
      return;
    }
    memDel(namespace, key);
    return;
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function list(namespace) {
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      const { blobs } = await store.list();
      const results = [];
      for (const blob of blobs) {
        const data = await store.get(blob.key, { type: 'json' });
        if (data) results.push(data);
      }
      return results;
    }
    return memList(namespace);
  }
  const dir = ensureDir(namespace);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

module.exports = { get, set, del, list, IS_NETLIFY, DATA_DIR };
