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

// --- Title-header removal -------------------------------------------------
// Licensed notation (OneLicense downloads, hymnal scans) usually arrives
// with a title/composer header above the music that the parish was cropping
// out by hand. A music staff is machine-recognizable: five parallel dark
// lines spanning most of the image width. We find the first staff system,
// walk up to the white band that separates the music from the header, and
// crop there — keeping anything close to the staff (tempo marks, slurs,
// notes above the top line) and never touching the bottom (lyrics and the
// license-required copyright line stay).
//
// Conservative by design — the crop only happens when ALL of these hold:
//   * a clear staff system is detected,
//   * a clean white gap (>= GAP_MIN rows) separates it from content above,
//   * there actually IS content above the gap (the title), and
//   * the crop removes at most half the image.
// Anything ambiguous returns null and the image is left alone.
const TITLE_CROP = {
  ANALYSIS_WIDTH: 480,  // downscale width for the row-darkness profile —
                        // wide enough that short-wide scans (a single psalm
                        // refrain staff) keep a measurable header gap
  DARK: 160,            // gray value below this counts as "ink"
  CONTENT_FRAC: 0.01,   // row is "content" when >=1% of pixels are ink
  STAFF_FRAC: 0.35,     // row is a staff-line candidate when >=35% is ink
  STAFF_FRAC_NARROW: 0.18, // lower threshold used ONLY by the over-crop guard
                        // to catch narrow real staves the primary pass misses
  LINE_MAX_ROWS: 4,     // a staff LINE is thin — at most this many rows;
                        // a thicker dark band (bold display title, banner)
                        // is not a staff line
  LINE_GAP_MAX: 14,     // staff lines sit within this many rows of each other
  LINES_REQUIRED: 3,    // need a group of thin lines to call it a staff
  // Header/music separator gap and the breathing room kept above the music
  // scale with the analysis height: a fixed 12-row gap was unreachable on
  // wide-but-short scans (one refrain staff downscales to <80 rows total),
  // which is exactly why titles like "Psalm 100: ..." survived the crop.
  GAP_MIN: 12,          // ceiling — taller images use up to this many rows
  GAP_MIN_FLOOR: 5,     // floor for very short images
  GAP_FRAC: 0.035,      // gap = clamp(H * GAP_FRAC, floor, ceiling)
  PAD: 10,              // ceiling for breathing room above the music
  PAD_FLOOR: 3,         // floor for very short images
  PAD_FRAC: 0.02,       // pad = clamp(H * PAD_FRAC, floor, ceiling)
  MAX_CROP_FRAC: 0.5,   // removing more pixels than this needs the shallow-
                        // header escape hatch below
  // A wide-short refrain scan (one staff, title at the top, big white gap)
  // can legitimately need >50% of its PIXELS removed — most of that is
  // white. What must stay small is the CONTENT above the cut: a title/
  // composer header is a shallow band of inked rows. The 17th-Sunday proof
  // showed exactly this shape ("GOSPEL ACCLAMATION" surviving the crop).
  HEADER_ROWS_MAX_FRAC: 0.15, // inked rows above the cut / total height
  MAX_CROP_HARD_FRAC: 0.8     // absolute ceiling, whatever the ink says
};

// Returns the full-resolution Y to crop at, or null when no confident
// title header is found.
async function detectTitleCropY(buf) {
  const sharp = getSharp();
  if (!sharp) return null;
  const C = TITLE_CROP;
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' }) // alpha -> white, not black
    .greyscale()
    .resize({ width: C.ANALYSIS_WIDTH, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // Height-adaptive gap/pad — see TITLE_CROP comments.
  const gapMin = Math.max(C.GAP_MIN_FLOOR, Math.min(C.GAP_MIN, Math.round(H * C.GAP_FRAC)));
  const pad = Math.max(C.PAD_FLOOR, Math.min(C.PAD, Math.round(H * C.PAD_FRAC)));
  if (H < gapMin * 3) return null;

  // Fraction of "ink" pixels per row.
  const frac = new Array(H);
  for (let y = 0; y < H; y++) {
    let dark = 0;
    const off = y * W;
    for (let x = 0; x < W; x++) if (data[off + x] < C.DARK) dark++;
    frac[y] = dark / W;
  }

  // First staff SYSTEM among rows [0, endRow): a group of thin near-full-width
  // dark lines with small gaps. A single wide dark band (a bold display title,
  // a banner) must NOT qualify, so candidates are grouped into runs and only
  // thin runs count as lines. `staffFrac` is the width threshold for a line —
  // the primary pass uses STAFF_FRAC; the over-crop guard below re-scans at a
  // lower threshold to catch NARROW real staves the primary pass misses.
  const findStaffRow = (endRow, staffFrac) => {
    const runs = [];
    let runStart = null;
    for (let y = 0; y <= endRow; y++) {
      const isCandidate = y < endRow && frac[y] >= staffFrac;
      if (isCandidate && runStart === null) runStart = y;
      else if (!isCandidate && runStart !== null) {
        runs.push({ start: runStart, len: y - runStart });
        runStart = null;
      }
    }
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].len > C.LINE_MAX_ROWS) continue;
      let count = 1;
      let prevEnd = runs[i].start + runs[i].len;
      for (let j = i + 1; j < runs.length && count < C.LINES_REQUIRED; j++) {
        if (runs[j].len > C.LINE_MAX_ROWS) break;
        const gap = runs[j].start - prevEnd;
        if (gap < 1 || gap > C.LINE_GAP_MAX) break;
        count++;
        prevEnd = runs[j].start + runs[j].len;
      }
      if (count >= C.LINES_REQUIRED) return runs[i].start;
    }
    return -1;
  };
  const firstStaffRow = findStaffRow(H, C.STAFF_FRAC);
  if (firstStaffRow <= 0) return null;

  // Walk up from the staff to the white band above the music block. Content
  // hanging close to the staff (notes, slurs, tempo text) keeps the walk
  // going, so it survives the crop.
  let whiteRun = 0;
  let musicTop = -1;
  for (let y = firstStaffRow; y >= 0; y--) {
    if (frac[y] >= C.CONTENT_FRAC) {
      whiteRun = 0;
    } else {
      whiteRun++;
      if (whiteRun >= gapMin) { musicTop = y + gapMin; break; }
    }
  }
  if (musicTop <= 0) return null; // music starts at the top — nothing to crop

  // Require real content above the gap; otherwise it's just margin.
  let hasHeader = false;
  for (let y = 0; y < musicTop - gapMin; y++) {
    if (frac[y] >= C.CONTENT_FRAC) { hasHeader = true; break; }
  }
  if (!hasHeader) return null;

  const cropAnalysisY = Math.max(0, musicTop - pad);
  const cropFrac = cropAnalysisY / H;
  if (cropFrac > C.MAX_CROP_FRAC) {
    // A tall crop removes lots of WHITE, which is fine — but it must NEVER
    // remove real music. The primary staff pass only recognizes staves at
    // least STAFF_FRAC wide, so a NARROW real staff above the cut (an
    // incipit, an ossia, a cantor intonation line, a right-aligned pickup)
    // can be mistaken for header content and cropped away. Re-scan the
    // region above the cut at a lower width threshold; if any staff group
    // is found up there, refuse the crop — music is never lost.
    if (findStaffRow(cropAnalysisY, C.STAFF_FRAC_NARROW) >= 0) return null;
    // Otherwise the guard that matters is how much CONTENT the crop removes:
    // allow a tall crop when the region above is a shallow header band (few
    // inked rows), refuse when it holds anything deeper, and never exceed the
    // hard ceiling.
    let contentRowsAbove = 0;
    for (let y = 0; y < cropAnalysisY; y++) {
      if (frac[y] >= C.CONTENT_FRAC) contentRowsAbove++;
    }
    if (cropFrac > C.MAX_CROP_HARD_FRAC || contentRowsAbove / H > C.HEADER_ROWS_MAX_FRAC) return null;
  }

  // Map back to the full-resolution image.
  const meta = await sharp(buf).metadata();
  const fullH = meta.height || H;
  return Math.floor(cropAnalysisY * (fullH / H));
}

// Crop the title header off a notation image. Returns the original buffer
// (cropped: false) whenever detection isn't confident or sharp is missing.
async function stripTitleHeader(buf) {
  const sharp = getSharp();
  if (!sharp) return { buffer: buf, cropped: false };
  try {
    // Bake EXIF orientation into the pixels FIRST: detection and extract()
    // both work on raw pixel rows, and extract() strips the EXIF tag — a
    // phone-photographed score cropped without this would embed sideways.
    const meta0 = await sharp(buf).metadata();
    if (meta0.orientation && meta0.orientation !== 1) {
      buf = await sharp(buf).rotate().toBuffer();
    }
    const cropY = await detectTitleCropY(buf);
    if (!cropY || cropY < 4) return { buffer: buf, cropped: false };
    const meta = await sharp(buf).metadata();
    const out = await sharp(buf)
      .extract({ left: 0, top: cropY, width: meta.width, height: meta.height - cropY })
      .toBuffer();
    return { buffer: out, cropped: true, removedPx: cropY };
  } catch (e) {
    console.warn('[image-utils] title-strip failed (image left intact):', e.message);
    return { buffer: buf, cropped: false };
  }
}

// Normalize an uploaded notation/score image for embedding: rotate per
// EXIF, optionally strip the title header, trim white margins, and convert
// non-embeddable formats to PNG.
// Returns { buffer, ext, mime, converted, titleCropped }. Throws a
// user-presentable error when the format needs conversion but sharp isn't
// available.
async function normalizeNotationImage(buffer, ext, opts = {}) {
  ext = String(ext || '').toLowerCase();
  const sharp = getSharp();

  if (EMBEDDABLE_EXTS.has(ext)) {
    let out = buffer;
    let titleCropped = false;
    if (opts.stripTitle) {
      const stripped = await stripTitleHeader(out);
      out = stripped.buffer;
      titleCropped = stripped.cropped;
    }
    out = await autoCropBuffer(out);
    return { buffer: out, ext, mime: ext === '.png' ? 'image/png' : 'image/jpeg', converted: false, titleCropped };
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
  let titleCropped = false;
  try {
    out = await pipeline.toBuffer();
    if (opts.stripTitle) {
      const stripped = await stripTitleHeader(out);
      out = stripped.buffer;
      titleCropped = stripped.cropped;
    }
    // Trim in a second pass — .trim() before format conversion can fail on
    // some TIFF colorspaces.
    out = await sharp(out).trim({ background: '#ffffff', threshold }).toBuffer();
  } catch (e) {
    throw new Error(`Could not read this ${ext.toUpperCase().slice(1)} file (${e.message}). Try re-saving it as PNG or JPG.`);
  }
  return { buffer: out, ext: '.png', mime: 'image/png', converted: true, titleCropped };
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

module.exports = { autoCropBuffer, normalizeNotationImage, detectTitleCropY, stripTitleHeader, getImageDimensions, EMBEDDABLE_EXTS, CONVERTIBLE_EXTS };
