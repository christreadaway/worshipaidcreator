// Key-value storage abstraction
// Local dev: uses filesystem under data/
// Netlify: uses @netlify/blobs for persistent storage
'use strict';

const fs = require('fs');
const path = require('path');

const IS_NETLIFY = !!process.env.NETLIFY;
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

// Ensure local directory exists
function ensureDir(namespace) {
  const dir = path.join(DATA_DIR, namespace);
  fs.mkdirSync(dir, { recursive: true });
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
