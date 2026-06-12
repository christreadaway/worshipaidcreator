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
