// Resolves a draft's per-slot notation-image URLs into PNG/JPEG buffers the
// PDF generator can embed. URLs come from the upload routes:
//   local:   /uploads/notation/<filename>      (file on disk under data/)
//   netlify: /api/uploads/notation/<filename>  (base64 record in Blobs KV)
'use strict';

const fs = require('fs');
const path = require('path');
const kv = require('./store/kv');

const NOTATION_DIR = path.join(kv.DATA_DIR, 'uploads', 'notation');

function filenameFromUrl(url) {
  const base = path.basename(String(url || '').split('?')[0]);
  return kv.isSafeKey(base) ? base : null;
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
    try {
      if (kv.IS_NETLIFY) {
        const item = await kv.get('uploads-notation', filename);
        if (item && item.data) {
          out.images[slot] = Buffer.from(item.data, 'base64');
          return;
        }
      } else {
        const filePath = path.join(NOTATION_DIR, filename);
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

module.exports = { resolveNotationImages, filenameFromUrl, NOTATION_DIR };
