// Key-value storage abstraction
// Local dev: uses filesystem under data/
// Netlify: uses @netlify/blobs for persistent storage
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

// Lazy-loaded Netlify Blobs store
let _blobStores = {};
function getBlobStore(namespace) {
  if (!_blobStores[namespace]) {
    const { getStore } = require('@netlify/blobs');
    _blobStores[namespace] = getStore(namespace);
  }
  return _blobStores[namespace];
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
    const store = getBlobStore(namespace);
    const data = await store.get(key, { type: 'json' });
    return data || null;
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function set(namespace, key, value) {
  if (IS_NETLIFY) {
    const store = getBlobStore(namespace);
    await store.setJSON(key, value);
    return;
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function del(namespace, key) {
  if (IS_NETLIFY) {
    const store = getBlobStore(namespace);
    await store.delete(key);
    return;
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function list(namespace) {
  if (IS_NETLIFY) {
    const store = getBlobStore(namespace);
    const { blobs } = await store.list();
    const results = [];
    for (const blob of blobs) {
      const data = await store.get(blob.key, { type: 'json' });
      if (data) results.push(data);
    }
    return results;
  }
  const dir = ensureDir(namespace);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

module.exports = { get, set, del, list, IS_NETLIFY, DATA_DIR };
