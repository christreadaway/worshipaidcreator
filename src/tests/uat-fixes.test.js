// Regression tests for the June 2026 UAT fixes:
//   - TIFF (and other non-embeddable formats) accepted + converted to PNG
//     on notation and attachment uploads
//   - Per-slot notation images render in HTML preview and embed in the PDF
//   - New reserved music areas: Gloria, Psalm refrain, Gospel Acclamation,
//     Mystery of Faith — and music replaces the spoken text
//   - Gloria setting line
//   - Anthems: structured offertory/choral lists with per-Mass tags
//   - Stable seed-user ids (session tokens survive a re-seed)
//   - Descriptive upload errors (bad type / too large)
//   - PDF fonts vendored with the repo (no Helvetica .afm dependency)
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');
const userStore = require('../store/user-store');
const { renderBookletHtml } = require('../template-renderer');
const { generatePdf } = require('../pdf-generator');
const { getImageDimensions, normalizeNotationImage } = require('../image-utils');
const { resolveNotationImages } = require('../notation-resolver');
const { validateInput } = require('../validator');

let server, baseUrl, adminToken;

function fetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: () => body,
          text: () => body.toString('utf8'),
          json: () => JSON.parse(body.toString('utf8'))
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function buildMultipart(fieldName, fields, file) {
  const boundary = '----uatfix' + Math.random().toString(36).slice(2);
  const parts = [];
  Object.entries(fields).forEach(([k, v]) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  });
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`
  ));
  parts.push(file.data);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(parts) };
}

// Minimal valid 4x4 white PNG built at runtime (no fixtures needed).
function tinyPng() {
  const zlib = require('zlib');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(crcBuf) : require('zlib').crc32(crcBuf));
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 0x40)])));
  const idat = require('zlib').deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'sample', 'second-sunday-lent.json'), 'utf8'));
const outputDir = path.join(__dirname, '..', '..', 'output', 'uat-fixes-tests');

let releaseLock;
before(async () => {
  releaseLock = await require('./_shared-state-lock').acquireSharedStateLock();
  fs.mkdirSync(outputDir, { recursive: true });
  await app.seedReady;
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  const login = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'jd', password: 'worship2026' })
  });
  adminToken = login.json().token;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try {
    for (const f of fs.readdirSync(outputDir)) fs.unlinkSync(path.join(outputDir, f));
    fs.rmdirSync(outputDir);
  } catch (e) { /* best effort */ }
  if (releaseLock) releaseLock();
});

describe('image utils', () => {
  it('reads PNG dimensions', () => {
    const dims = getImageDimensions(tinyPng());
    assert.deepEqual(dims, { width: 4, height: 4 });
  });

  it('converts TIFF to PNG (with crop) via normalizeNotationImage', async () => {
    const sharp = require('sharp');
    const tiff = await sharp(tinyPng()).tiff().toBuffer();
    const out = await normalizeNotationImage(tiff, '.tiff');
    assert.equal(out.ext, '.png');
    assert.equal(out.mime, 'image/png');
    assert.ok(out.converted);
    assert.ok(getImageDimensions(out.buffer));
  });

  it('rejects unsupported extensions with a readable error', async () => {
    await assert.rejects(() => normalizeNotationImage(Buffer.from('x'), '.exe'), /Unsupported image type/);
  });
});

describe('title-header removal (keep just notation + lyrics)', () => {
  const sharp = require('sharp');
  const { stripTitleHeader } = require('../image-utils');

  // Synthetic sheet music, 1500x2000: title + composer header, a big white
  // gap, then a tempo mark hugging the first 5-line staff, notes, lyrics,
  // a second system, and a copyright line at the very bottom.
  function buildScore({ withTitle }) {
    const W = 1500, H = 2000;
    const img = Buffer.alloc(W * H, 255);
    const blob = (x0, x1, y0, y1, density) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
        if (Math.random() < density) img[y * W + x] = 20;
    };
    const staff = (top) => {
      for (const sy of [top, top + 20, top + 40, top + 60, top + 80])
        for (let yy = sy; yy < sy + 4; yy++) for (let x = 80; x < 1420; x++) img[yy * W + x] = 10;
    };
    if (withTitle) {
      blob(400, 1100, 90, 150, 0.25);  // title line
      blob(950, 1350, 190, 220, 0.2);  // composer credit
    }
    blob(120, 260, 560, 590, 0.25);    // tempo mark close above the staff
    staff(620);
    blob(100, 1400, 600, 720, 0.06);   // notes around staff 1
    blob(100, 1400, 760, 800, 0.18);   // lyrics line 1
    staff(1100);
    blob(100, 1400, 1240, 1280, 0.18); // lyrics line 2
    blob(300, 1200, 1920, 1940, 0.15); // copyright (license requires keeping it)
    return sharp(img, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  }

  it('crops the title block but keeps tempo mark, music, lyrics, copyright', async () => {
    const png = await buildScore({ withTitle: true });
    const out = await stripTitleHeader(png);
    assert.equal(out.cropped, true);
    // Crop lands in the white gap: below the composer line (220), above the
    // tempo mark (560).
    assert.ok(out.removedPx > 230 && out.removedPx < 560,
      `crop at ${out.removedPx}, expected inside the 230-560 white gap`);
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.height, 2000 - out.removedPx, 'only the top is removed');
  });

  it('leaves an image without a title header untouched', async () => {
    const png = await buildScore({ withTitle: false });
    const out = await stripTitleHeader(png);
    assert.equal(out.cropped, false);
  });

  it('is idempotent — re-running on a cropped image does nothing', async () => {
    const png = await buildScore({ withTitle: true });
    const once = await stripTitleHeader(png);
    const twice = await stripTitleHeader(once.buffer);
    assert.equal(twice.cropped, false);
  });

  it('normalizeNotationImage honors the stripTitle option both ways', async () => {
    const png = await buildScore({ withTitle: true });
    const on = await normalizeNotationImage(png, '.png', { stripTitle: true });
    assert.equal(on.titleCropped, true);
    const off = await normalizeNotationImage(png, '.png', { stripTitle: false });
    assert.equal(off.titleCropped, false);
  });

  it('editor exposes the strip-title checkbox and sends the flag', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/id="stripTitleHeaders"[^>]*checked/.test(html));
    assert.ok(html.includes("fd.append('stripTitle'"));
  });
});

describe('uploads: TIFF accepted + converted, errors are descriptive', () => {
  it('notation upload converts a TIFF to PNG', async () => {
    const sharp = require('sharp');
    const tiff = await sharp(tinyPng()).tiff().toBuffer();
    const mp = buildMultipart('image', {}, { filename: 'refrain.tif', mime: 'image/tiff', data: tiff });
    const res = await fetch('/api/upload/notation', {
      method: 'POST',
      headers: { 'x-session-token': adminToken, 'Content-Type': mp.contentType },
      body: mp.body
    });
    assert.equal(res.status, 200);
    const out = res.json();
    assert.ok(out.converted, 'should report conversion');
    assert.ok(out.filename.endsWith('.png'), 'stored as PNG');
    // The stored file must be retrievable and a real PNG.
    const file = await fetch(out.url);
    assert.equal(file.status, 200);
    assert.ok(getImageDimensions(file.buffer()), 'served file parses as PNG/JPEG');
  });

  it('attachment upload converts a TIFF to PNG', async () => {
    const sharp = require('sharp');
    const tiff = await sharp(tinyPng()).tiff().toBuffer();
    const mp = buildMultipart('file', { title: 'Test Tiff Kyrie', kind: 'kyrie' },
      { filename: 'kyrie.tiff', mime: 'image/tiff', data: tiff });
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'x-session-token': adminToken, 'Content-Type': mp.contentType },
      body: mp.body
    });
    assert.equal(res.status, 200);
    const meta = res.json();
    assert.equal(meta.mime, 'image/png');
    assert.ok(meta.filename.endsWith('.png'));
    // Clean up.
    await fetch('/api/attachments/' + meta.id, { method: 'DELETE', headers: { 'x-session-token': adminToken } });
  });

  it('rejects a disallowed file type with the allowed list in the message', async () => {
    const mp = buildMultipart('image', {}, { filename: 'malware.exe', mime: 'application/octet-stream', data: Buffer.from('nope') });
    const res = await fetch('/api/upload/notation', {
      method: 'POST',
      headers: { 'x-session-token': adminToken, 'Content-Type': mp.contentType },
      body: mp.body
    });
    assert.equal(res.status, 400);
    assert.match(res.json().error, /not accepted .* \.png/i);
  });
});

describe('notation images in renderers', () => {
  it('HTML preview embeds slot images instead of paste boxes', () => {
    const data = {
      ...sample,
      notationImages: { kyrie: '/uploads/notation/k.png', communion: '/uploads/notation/c.png' }
    };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('src="/uploads/notation/k.png"'));
    assert.ok(html.includes('src="/uploads/notation/c.png"'));
    // Slots WITHOUT an image keep their paste boxes.
    assert.ok(html.includes('Lamb of God — music notation'));
  });

  it('new reserved areas exist: Gloria, psalm refrain, acclamation, Mystery of Faith', () => {
    const data = { ...sample, liturgicalSeason: 'ordinary', seasonalSettings: { ...sample.seasonalSettings, gloria: true } };
    const { html } = renderBookletHtml(data);
    for (const label of ['Gloria — music notation', 'Responsorial Psalm refrain — music notation',
                         'Gospel Acclamation — music notation', 'Mystery of Faith — music notation']) {
      assert.ok(html.includes(label), label);
    }
  });

  it('notation images scale to full width; tall ones are capped AND centered', async () => {
    const sharp = require('sharp');
    const zlib = require('zlib');
    const tall = await sharp({ create: { width: 800, height: 2400, channels: 3, background: '#222' } }).png().toBuffer();
    const wide = await sharp({ create: { width: 2000, height: 500, channels: 3, background: '#333' } }).png().toBuffer();
    const out = path.join(outputDir, 'center.pdf');
    await generatePdf(sample, out, {
      bookletSize: 'tabloid',
      notationImages: { kyrie: tall, lambOfGod: wide }
    });
    // Pull every image-draw transform (w 0 0 -h x y cm … /In Do) out of the
    // deflated content streams.
    const bytes = fs.readFileSync(out);
    const draws = [];
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;
    while ((m = streamRe.exec(bytes.toString('latin1'))) !== null) {
      let txt;
      try { txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
      catch (e) { continue; }
      const drawRe = /([\d.]+) 0 0 (-?[\d.]+) ([\d.]+) ([\d.]+) cm\s*\n\/I\d+ Do/g;
      let d;
      while ((d = drawRe.exec(txt)) !== null) {
        draws.push({ w: parseFloat(d[1]), x: parseFloat(d[3]) });
      }
    }
    assert.equal(draws.length, 2, 'both images embedded');
    // Tabloid content area: margin 72, width 468.
    const wideDraw = draws.find(d => d.w > 400);
    const tallDraw = draws.find(d => d.w < 400);
    assert.ok(wideDraw, 'wide image uses (nearly) full content width');
    assert.ok(Math.abs(wideDraw.x - 72) < 1, 'full-width image starts at the margin');
    assert.ok(tallDraw, 'tall image is height-capped (narrower than content)');
    const expectedCenterX = 72 + (468 - tallDraw.w) / 2;
    assert.ok(Math.abs(tallDraw.x - expectedCenterX) < 1,
      `capped image must be centered (x=${tallDraw.x}, expected ~${expectedCenterX})`);
  });

  it('HTML centers capped notation images and sizes ordinary images per geometry', () => {
    const data = { ...sample, notationImages: { kyrie: '/uploads/notation/k.png' } };
    const half = renderBookletHtml(data, { bookletSize: 'half-letter' }).html;
    const tab = renderBookletHtml(data, { bookletSize: 'tabloid' }).html;
    assert.match(half, /\.notation-image\s*{[^}]*object-position:\s*center top/);
    assert.match(half, /\.notation-image\.ordinary\s*{\s*max-height:\s*2\.4in/);
    assert.match(tab, /\.notation-image\.ordinary\s*{\s*max-height:\s*3in/);
  });

  it('PDF embeds slot image buffers and stays at exactly 8 pages', async () => {
    const out = path.join(outputDir, 'notation-embed.pdf');
    const result = await generatePdf(sample, out, {
      bookletSize: 'tabloid',
      notationImages: { kyrie: tinyPng(), communion: tinyPng(), psalmRefrain: tinyPng() }
    });
    assert.equal(result.pageCount, 8);
    const bytes = fs.readFileSync(out);
    const imageCount = (bytes.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
    assert.ok(imageCount >= 3, `expected >=3 embedded images, got ${imageCount}`);
  });

  it('notation resolver loads local upload files referenced by a draft', async () => {
    const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'notation');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `test-resolver-${Date.now()}.png`;
    fs.writeFileSync(path.join(dir, fname), tinyPng());
    try {
      const { images, missing } = await resolveNotationImages({
        notationImages: { kyrie: `/uploads/notation/${fname}`, gloria: '/uploads/notation/missing-file.png' }
      });
      assert.ok(Buffer.isBuffer(images.kyrie));
      assert.deepEqual(missing, ['gloria']);
    } finally {
      fs.unlinkSync(path.join(dir, fname));
    }
  });

  it('preview falls back to the paste box when a notation file is gone (no dead <img>)', async () => {
    // A slot pointing at a deleted/never-persisted file used to emit a dead
    // <img> that rendered as an invisible blank gap in the preview — the
    // "processional hymn has no placeholder" report.
    const res = await fetch('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...sample,
        seasonalSettings: { ...sample.seasonalSettings, entranceType: 'processional' },
        notationImages: { processional: '/uploads/notation/file-that-is-gone.png' }
      })
    });
    assert.equal(res.status, 200);
    const out = res.json();
    assert.ok(!out.html.includes('file-that-is-gone.png'), 'dead img must be stripped');
    const page2 = out.html.slice(out.html.indexOf('id="page-2"'), out.html.indexOf('id="page-3"'));
    assert.match(page2, /hymn-music-space/, 'paste box must come back');
    assert.ok(out.warnings.some(w => /processional/.test(w) && /no longer exists/.test(w)),
      'warning must name the slot');
  });

  it('preview keeps the <img> when the notation file exists', async () => {
    const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'notation');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `test-preview-${Date.now()}.png`;
    fs.writeFileSync(path.join(dir, fname), tinyPng());
    try {
      const res = await fetch('/api/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...sample,
          seasonalSettings: { ...sample.seasonalSettings, entranceType: 'processional' },
          notationImages: { processional: `/uploads/notation/${fname}` }
        })
      });
      const out = res.json();
      assert.ok(out.html.includes(fname), 'existing image renders');
      const page2 = out.html.slice(out.html.indexOf('id="page-2"'), out.html.indexOf('id="page-3"'));
      assert.doesNotMatch(page2, /hymn-music-space/, 'image replaces the paste box');
    } finally {
      fs.unlinkSync(path.join(dir, fname));
    }
  });
});

describe('PDF fonts ship with the repo', () => {
  it('vendored Liberation Sans files exist', () => {
    const dir = path.join(__dirname, '..', 'assets', 'fonts');
    for (const f of ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf']) {
      assert.ok(fs.existsSync(path.join(dir, f)), f);
    }
  });

  it('generated PDF embeds Liberation Sans (not built-in Helvetica metrics)', async () => {
    const out = path.join(outputDir, 'fonts.pdf');
    await generatePdf(sample, out, { bookletSize: 'half-letter' });
    const txt = fs.readFileSync(out).toString('latin1');
    assert.match(txt, /LiberationSans/);
  });
});

describe('anthems data model', () => {
  it('schema accepts the structured anthems lists', () => {
    const data = {
      ...sample,
      anthems: {
        offertory: [
          { title: 'Ave Verum', composer: 'Mozart', masses: ['sat5pm', 'sun9am'] },
          { title: 'Let Us Come', composer: 'Marolli', masses: ['sun11am'] }
        ],
        choral: [{ title: 'Panis Angelicus', composer: 'Franck', masses: ['sun11am'] }]
      },
      serviceMusicCarryover: true,
      seasonalSettings: { ...sample.seasonalSettings, gloriaSetting: 'Mass of Creation' }
    };
    const result = validateInput(data);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('SPA exposes the anthem row + carryover helpers', async () => {
    const html = (await fetch('/')).text();
    for (const fn of ['addAnthemRow', 'collectAnthems', 'anthemFieldsForMass', 'anthemRowsFromBlocks',
                      'applyServiceMusicCarryover', 'uploadNotationForSlot', 'handle401', 'checkStorageHealth']) {
      assert.ok(html.includes('function ' + fn), fn + ' missing from SPA');
    }
    assert.ok(html.includes('storage-warning'));
  });
});

describe('stable seed-user ids', () => {
  it('seed users use their username as id so tokens survive re-seeds', async () => {
    // Applies to fresh seeds; pre-existing user stores keep their old ids
    // (tokens reference whatever id the store holds). Verify createUser
    // honors a fixed id.
    const name = 'uat-fixed-id-' + Date.now();
    const u = await userStore.createUser({ id: name, username: name, role: 'staff', displayName: 'T' });
    try {
      assert.equal(u.id, name);
    } finally {
      await userStore.deleteUser(u.id);
    }
  });
});
