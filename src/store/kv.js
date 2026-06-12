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
let _blobsLastFailedAt = 0; // retry window — a cold-start hiccup must not
                            // strand the instance in memory mode forever
const BLOBS_RETRY_MS = 30 * 1000;

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

// Lazy-loaded Netlify Blobs store.
// getStore(name) alone only works when the runtime has already injected the
// Blobs context (NETLIFY_BLOBS_CONTEXT). Under the Lambda-compatibility
// function signature this app uses, that context arrives on each event and
// must be wired up via connectLambda() — see connectBlobsFromLambdaEvent
// below, called by netlify/functions/api.js on every request. As a final
// fallback, explicit credentials can be supplied via env vars.
let _blobStores = {};
function getBlobStore(namespace) {
  if (!_blobStores[namespace]) {
    const { getStore } = require('@netlify/blobs');
    const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || '';
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || '';
    if (siteID && token) {
      _blobStores[namespace] = getStore({ name: namespace, siteID, token });
    } else {
      _blobStores[namespace] = getStore(namespace);
    }
  }
  return _blobStores[namespace];
}

// Wire the Netlify Blobs environment context from a Lambda-compat event.
// Safe to call on every request; a no-op when the event carries no blobs
// context. Resets the availability cache when a context appears so an
// instance that started in memory-fallback mode can recover.
function connectBlobsFromLambdaEvent(event) {
  if (!event || !event.blobs) return false;
  try {
    const { connectLambda } = require('@netlify/blobs');
    connectLambda(event);
    if (_blobsAvailable === false) {
      _blobsAvailable = null; // force a re-check now that context exists
      _blobStores = {};
    }
    return true;
  } catch (e) {
    console.warn('[KV] connectLambda failed:', e.message);
    return false;
  }
}

// Test if blobs are actually usable. A success is cached for the process
// lifetime; a failure is retried after BLOBS_RETRY_MS so a transient
// cold-start error doesn't permanently strand the instance on the lossy
// in-memory fallback.
async function checkBlobsAvailable() {
  if (_blobsAvailable === true) return true;
  if (_blobsAvailable === false && Date.now() - _blobsLastFailedAt < BLOBS_RETRY_MS) return false;
  try {
    _blobStores = {}; // re-create stores in case the context just changed
    const store = getBlobStore('_health');
    await store.setJSON('_ping', { t: Date.now() });
    _blobsAvailable = true;
    console.log('[KV] Netlify Blobs: available');
  } catch (e) {
    _blobsAvailable = false;
    _blobsLastFailedAt = Date.now();
    console.error('[KV] Netlify Blobs NOT available — using in-memory fallback. Data will NOT persist across requests. Sessions, settings, drafts and uploads WILL be lost.');
    console.error('[KV] Reason:', e.message);
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

// Keys and namespaces become filesystem paths locally and blob keys on
// Netlify. Reject anything that could escape the namespace directory —
// path separators, '..' segments, leading dots. Keys come from user input
// in places (draft ids in request bodies, :filename URL params), so this
// is a security boundary, not just hygiene.
const SAFE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9 ._@()-]*$/;
function assertSafeKey(s, what) {
  const str = String(s);
  if (!SAFE_KEY_RE.test(str) || str.includes('..')) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(str).slice(0, 60)}`);
  }
  return str;
}
function isSafeKey(s) {
  const str = String(s);
  return SAFE_KEY_RE.test(str) && !str.includes('..');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    // A single corrupt record must not take down every caller of list()
    // (e.g. one bad user file breaking all logins).
    console.warn('[KV] Skipping corrupt record:', filePath, e.message);
    return null;
  }
}

async function get(namespace, key) {
  assertSafeKey(namespace, 'namespace');
  assertSafeKey(key, 'key');
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      try {
        const data = await store.get(key, { type: 'json' });
        return data || null;
      } catch (e) {
        console.warn('[KV] Skipping corrupt blob:', namespace, key, e.message);
        return null;
      }
    }
    return memGet(namespace, key);
  }
  const dir = ensureDir(namespace);
  const filePath = path.join(dir, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;
  return readJsonFile(filePath);
}

async function set(namespace, key, value) {
  assertSafeKey(namespace, 'namespace');
  assertSafeKey(key, 'key');
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
  assertSafeKey(namespace, 'namespace');
  assertSafeKey(key, 'key');
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
  assertSafeKey(namespace, 'namespace');
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      const { blobs } = await store.list();
      const results = [];
      for (const blob of blobs) {
        try {
          const data = await store.get(blob.key, { type: 'json' });
          if (data) results.push(data);
        } catch (e) {
          console.warn('[KV] Skipping corrupt blob:', namespace, blob.key, e.message);
        }
      }
      return results;
    }
    return memList(namespace);
  }
  const dir = ensureDir(namespace);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(f => readJsonFile(path.join(dir, f))).filter(Boolean);
}

// Key names only — used by listing endpoints that need filenames (list()
// returns values, which lose the blob key on Netlify).
async function listKeys(namespace) {
  assertSafeKey(namespace, 'namespace');
  if (IS_NETLIFY) {
    if (await checkBlobsAvailable()) {
      const store = getBlobStore(namespace);
      const { blobs } = await store.list();
      return blobs.map(b => b.key);
    }
    return Object.keys(_memStore[namespace] || {});
  }
  const dir = ensureDir(namespace);
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}

module.exports = { get, set, del, list, listKeys, isSafeKey, IS_NETLIFY, DATA_DIR, connectBlobsFromLambdaEvent, checkBlobsAvailable };
