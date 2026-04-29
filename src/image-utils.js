// Image utilities — currently auto-trims white margins from uploaded
// notation scans so the rendered booklet stays tight around the music.
// Sharp is required dynamically so the rest of the app still runs even
// if the native binding fails to load.
'use strict';

const fs = require('fs');

let _sharp = null;
function getSharp() {
  if (_sharp === null) {
    try { _sharp = require('sharp'); }
    catch (e) { _sharp = false; console.warn('[image-utils] sharp unavailable:', e.message); }
  }
  return _sharp || null;
}

// Given a buffer of an image, return a buffer with surrounding white space
// trimmed. Falls back to the original buffer if sharp can't process it.
async function autoCropBuffer(buf, opts = {}) {
  const sharp = getSharp();
  if (!sharp) return buf;
  try {
    // Sharp's .trim() removes pixels matching the top-left corner color.
    // For scanned music that's typically off-white, so we use a generous
    // threshold and force the comparison color to near-white.
    const threshold = opts.threshold || 18; // 0..255 sensitivity
    const out = await sharp(buf)
      .trim({ background: '#ffffff', threshold })
      .toBuffer();
    return out;
  } catch (e) {
    console.warn('[image-utils] auto-crop failed:', e.message);
    return buf;
  }
}

// Convenience: crop in place on a file path.
async function autoCropFile(filePath, opts = {}) {
  const sharp = getSharp();
  if (!sharp) return { cropped: false, reason: 'sharp unavailable' };
  try {
    const original = fs.readFileSync(filePath);
    const out = await autoCropBuffer(original, opts);
    if (out.length !== original.length) {
      fs.writeFileSync(filePath, out);
      return { cropped: true, beforeBytes: original.length, afterBytes: out.length };
    }
    return { cropped: false, reason: 'no whitespace detected' };
  } catch (e) {
    return { cropped: false, reason: e.message };
  }
}

// Higher-level wrapper used by the notation upload route. Accepts the
// multer file object and the on-disk path (when not running on Netlify
// where the file lives in memory). Returns the buffer or path of the
// processed image. SVGs are passed through unchanged.
async function autoCropNotation({ buffer, filePath, mime }) {
  if (mime && mime.includes('svg')) {
    return { skipped: true, reason: 'svg' };
  }
  if (filePath) return autoCropFile(filePath);
  if (buffer) {
    const out = await autoCropBuffer(buffer);
    return { buffer: out, cropped: out.length !== buffer.length };
  }
  return { skipped: true, reason: 'no input' };
}

module.exports = { autoCropBuffer, autoCropFile, autoCropNotation };
