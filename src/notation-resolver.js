// Resolves a draft's per-slot notation-image URLs into PNG/JPEG buffers the
// PDF generator can embed. URLs come from the upload routes:
//   local:   /uploads/notation/<filename>         (file on disk under data/)
//   netlify: /api/uploads/notation/<filename>     (base64 record in Blobs KV)
// Slots may also point at library attachments (same record shape):
//   local:   /uploads/attachments/<filename>      (file on disk under data/)
//   netlify: /api/uploads/attachments/<filename>  (base64 record in Blobs KV)
'use strict';

const fs = require('fs');
const path = require('path');
const kv = require('./store/kv');

const NOTATION_DIR = path.join(kv.DATA_DIR, 'uploads', 'notation');
const ATTACHMENTS_DIR = path.join(kv.DATA_DIR, 'uploads', 'attachments');

function filenameFromUrl(url) {
  const base = path.basename(String(url || '').split('?')[0]);
  return kv.isSafeKey(base) ? base : null;
}

// Picks the storage location for a slot URL. Attachment URLs carry an
// explicit '/uploads/attachments/' path segment; everything else (including
// bare filenames) defaults to the notation store.
function sourceForUrl(url) {
  const clean = String(url || '').split('?')[0];
  if (clean.includes('/uploads/attachments/')) {
    return { namespace: 'uploads-attachments', dir: ATTACHMENTS_DIR };
  }
  return { namespace: 'uploads-notation', dir: NOTATION_DIR };
}

// Returns { slot: Buffer } for every slot whose image could be loaded.
// Missing/unreadable images are skipped (the renderer falls back to the
// paste box) and reported in the returned `missing` array.
async function resolveNotationImages(data) {
  const out = { images: {}, missing: [] };
  const map = (data && data.notationImages) || {};
  await Promise.all(Object.entries(map).map(async ([slot, url]) => {
    if (!url) return;
    const filename = filenameFromUrl(url);
    if (!filename) { out.missing.push(slot); return; }
    const source = sourceForUrl(url);
    try {
      if (kv.IS_NETLIFY) {
        const item = await kv.get(source.namespace, filename);
        if (item && item.data) {
          out.images[slot] = Buffer.from(item.data, 'base64');
          return;
        }
      } else {
        const filePath = path.join(source.dir, filename);
        if (fs.existsSync(filePath)) {
          out.images[slot] = fs.readFileSync(filePath);
          return;
        }
      }
      out.missing.push(slot);
    } catch (e) {
      console.warn('[notation-resolver] could not load %s (%s): %s', slot, filename, e.message);
      out.missing.push(slot);
    }
  }));
  return out;
}

// Existence-only check (no byte loading) — which slots reference notation
// files that no longer exist in storage. The preview route uses this to
// fall back to the paste box exactly like the PDF does, instead of
// emitting a dead <img> that renders as a blank gap in the booklet.
async function findMissingNotationSlots(data) {
  const map = (data && data.notationImages) || {};
  const entries = Object.entries(map).filter(([, url]) => url);
  if (!entries.length) return [];
  const missing = [];
  // On Netlify, list each namespace once instead of fetching every blob.
  const netlifyKeys = {};
  if (kv.IS_NETLIFY) {
    for (const ns of ['uploads-notation', 'uploads-attachments']) {
      try { netlifyKeys[ns] = new Set(await kv.listKeys(ns)); }
      catch (e) { return []; } // storage unreachable — leave the draft alone
    }
  }
  for (const [slot, url] of entries) {
    const filename = filenameFromUrl(url);
    if (!filename) { missing.push(slot); continue; }
    const source = sourceForUrl(url);
    const exists = kv.IS_NETLIFY
      ? netlifyKeys[source.namespace].has(filename)
      : fs.existsSync(path.join(source.dir, filename));
    if (!exists) missing.push(slot);
  }
  return missing;
}

module.exports = { resolveNotationImages, findMissingNotationSlots, filenameFromUrl, NOTATION_DIR, ATTACHMENTS_DIR };
