// Image utilities — currently auto-trims white margins from uploaded
// notation scans so the rendered booklet stays tight around the music.
// Sharp is required dynamically so the rest of the app still runs even
// if the native binding fails to load.
'use strict';

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
    const threshold = opts.threshold ?? 18; // 0..255 sensitivity (0 is valid)
    const out = await sharp(buf)
      .rotate() // apply EXIF orientation before trimming
      .trim({ background: '#ffffff', threshold })
      .toBuffer();
    return out;
  } catch (e) {
    console.warn('[image-utils] auto-crop failed:', e.message);
    return buf;
  }
}

// Formats browsers can display inline AND PDFKit can embed. Everything else
// (TIFF — what OneLicense supplies — plus BMP, GIF, SVG, WebP) gets
// converted to PNG at upload time.
const EMBEDDABLE_EXTS = new Set(['.png', '.jpg', '.jpeg']);
const CONVERTIBLE_EXTS = new Set(['.tif', '.tiff', '.bmp', '.gif', '.webp', '.svg']);

// Normalize an uploaded notation/score image for embedding: rotate per
// EXIF, trim white margins, and convert non-embeddable formats to PNG.
// Returns { buffer, ext, mime, converted }. Throws a user-presentable
// error when the format needs conversion but sharp isn't available.
async function normalizeNotationImage(buffer, ext) {
  ext = String(ext || '').toLowerCase();
  const sharp = getSharp();

  if (EMBEDDABLE_EXTS.has(ext)) {
    const out = await autoCropBuffer(buffer);
    return { buffer: out, ext, mime: ext === '.png' ? 'image/png' : 'image/jpeg', converted: false };
  }

  if (!CONVERTIBLE_EXTS.has(ext)) {
    throw new Error(`Unsupported image type "${ext}". Use PNG, JPG, TIFF, BMP, GIF, WebP, or SVG.`);
  }
  if (!sharp) {
    throw new Error(`This server cannot convert ${ext.toUpperCase().slice(1)} files right now — please upload a PNG or JPG instead.`);
  }
  const threshold = 18;
  let pipeline = sharp(buffer, ext === '.svg' ? { density: 300 } : {}).rotate().png();
  let out;
  try {
    out = await pipeline.toBuffer();
    // Trim in a second pass — .trim() before format conversion can fail on
    // some TIFF colorspaces.
    out = await sharp(out).trim({ background: '#ffffff', threshold }).toBuffer();
  } catch (e) {
    throw new Error(`Could not read this ${ext.toUpperCase().slice(1)} file (${e.message}). Try re-saving it as PNG or JPG.`);
  }
  return { buffer: out, ext: '.png', mime: 'image/png', converted: true };
}

// Pixel dimensions of a PNG or JPEG buffer — enough for the PDF generator
// to scale embedded notation without pulling in a full image library.
function getImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG: 8-byte signature, IHDR width/height at offsets 16/20.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan segments for a SOFn marker carrying the frame size.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      // SOF0–SOF15 except DHT(C4)/JPG(C8)/DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

module.exports = { autoCropBuffer, normalizeNotationImage, getImageDimensions, EMBEDDABLE_EXTS, CONVERTIBLE_EXTS };
