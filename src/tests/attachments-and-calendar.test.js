// Server endpoints + renderer behaviour added in the file-uploads branch:
// liturgical-info auto-detect, attachments CRUD, Sanctus language toggle.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');
const { renderBookletHtml } = require('../template-renderer');

let server;
let baseUrl;
let adminToken;

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
    if (options.body) {
      if (Buffer.isBuffer(options.body)) req.write(options.body);
      else req.write(options.body);
    }
    req.end();
  });
}

// Multipart helper — keeps the test free of an extra dependency.
function buildMultipart(fields, file) {
  const boundary = '----wagb' + Math.random().toString(36).slice(2);
  const parts = [];
  Object.entries(fields).forEach(([k, v]) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  });
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(parts) };
}

before(async () => {
  await app.seedReady;
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  // Need an admin session to upload/delete attachments.
  const login = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'jd', password: 'worship2026' })
  });
  adminToken = login.json().token;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('GET /api/liturgical-info', () => {
  it('returns season + feast for a known Sunday', async () => {
    const res = await fetch('/api/liturgical-info?date=2026-04-05');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.liturgicalSeason, 'easter');
    assert.ok(/Easter Sunday/.test(data.feastName));
  });

  it('returns 400 for an invalid date', async () => {
    const res = await fetch('/api/liturgical-info?date=not-a-date');
    assert.equal(res.status, 400);
  });

  it('labels Ordinary Time Sundays with a week number', async () => {
    const res = await fetch('/api/liturgical-info?date=2026-10-25');
    const data = res.json();
    assert.equal(data.liturgicalSeason, 'ordinary');
    assert.ok(/Sunday in Ordinary Time/.test(data.feastName));
  });
});

describe('Attachments CRUD', () => {
  let attachmentId;

  it('rejects upload without auth', async () => {
    const mp = buildMultipart({ title: 'X', kind: 'prelude' }, { filename: 'a.txt', mime: 'text/plain', data: Buffer.from('hi') });
    const res = await fetch('/api/attachments', {
      method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body
    });
    assert.equal(res.status, 401);
  });

  it('uploads an attachment and stores metadata', async () => {
    const mp = buildMultipart(
      { title: 'Toccata in D Minor', composer: 'J.S. Bach', kind: 'prelude', tags: 'organ, advent' },
      { filename: 'toccata.txt', mime: 'text/plain', data: Buffer.from('fake-audio-bytes') }
    );
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': mp.contentType, 'x-session-token': adminToken },
      body: mp.body
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.id);
    assert.equal(data.title, 'Toccata in D Minor');
    assert.equal(data.composer, 'J.S. Bach');
    assert.equal(data.kind, 'prelude');
    assert.deepEqual(data.tags, ['organ', 'advent']);
    assert.ok(data.url.endsWith(data.filename));
    attachmentId = data.id;
  });

  it('lists attachments', async () => {
    const res = await fetch('/api/attachments');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data.attachments));
    assert.ok(Array.isArray(data.kinds));
    assert.ok(data.attachments.find(a => a.id === attachmentId));
  });

  it('filters attachments by kind', async () => {
    const res = await fetch('/api/attachments?kind=prelude');
    const data = res.json();
    assert.ok(data.attachments.every(a => a.kind === 'prelude'));
  });

  it('serves the uploaded file', async () => {
    const meta = (await fetch('/api/attachments').then(r => r.json())).attachments.find(a => a.id === attachmentId);
    const res = await fetch(meta.url);
    assert.equal(res.status, 200);
    assert.equal(res.text(), 'fake-audio-bytes');
  });

  it('updates attachment metadata', async () => {
    const res = await fetch('/api/attachments/' + attachmentId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-session-token': adminToken },
      body: JSON.stringify({ title: 'Toccata (revised)', tags: 'organ' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.title, 'Toccata (revised)');
    assert.deepEqual(data.tags, ['organ']);
  });

  it('deletes an attachment and removes the file', async () => {
    const meta = await fetch('/api/attachments').then(r => r.json()).then(d => d.attachments.find(a => a.id === attachmentId));
    const localPath = path.join(__dirname, '..', '..', 'data', 'uploads', 'attachments', meta.filename);
    if (fs.existsSync(localPath)) assert.ok(true, 'file exists before delete');
    const res = await fetch('/api/attachments/' + attachmentId, {
      method: 'DELETE', headers: { 'x-session-token': adminToken }
    });
    assert.equal(res.status, 200);
    // Metadata gone
    const list = (await fetch('/api/attachments').then(r => r.json())).attachments;
    assert.ok(!list.find(a => a.id === attachmentId), 'metadata should be deleted');
    // Binary gone (regression test for the namespace mismatch bug).
    assert.ok(!fs.existsSync(localPath), 'binary should be removed from disk');
  });

  it('returns 404 deleting a missing attachment', async () => {
    const res = await fetch('/api/attachments/nope-not-real', {
      method: 'DELETE', headers: { 'x-session-token': adminToken }
    });
    assert.equal(res.status, 404);
  });
});

describe('Sanctus language toggle', () => {
  const baseData = {
    feastName: 'Test', liturgicalDate: '2026-04-05', liturgicalSeason: 'easter',
    seasonalSettings: { holyHolySetting: 'Mass of St. Theresa' },
    readings: {}
  };

  it('renders English Sanctus by default', () => {
    const { html } = renderBookletHtml(baseData);
    assert.ok(html.includes('Holy, Holy, Holy'));
    assert.ok(html.includes('Holy, Holy, Holy Lord God of hosts'));
    assert.ok(!html.includes('Sanctus, Sanctus, Sanctus'));
  });

  it('renders Latin Sanctus when language=latin', () => {
    const data = { ...baseData, seasonalSettings: { ...baseData.seasonalSettings, holyHolyLanguage: 'latin' } };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('Sanctus, Sanctus, Sanctus'));
    assert.ok(html.includes('Pleni sunt'));
  });

  it('honors parish default if per-aid override absent', () => {
    const { html } = renderBookletHtml(baseData, { parishSettings: { defaultSanctusLanguage: 'latin' } });
    assert.ok(html.includes('Sanctus, Sanctus, Sanctus'));
  });

  it('per-aid override beats parish default', () => {
    const data = { ...baseData, seasonalSettings: { ...baseData.seasonalSettings, holyHolyLanguage: 'english' } };
    const { html } = renderBookletHtml(data, { parishSettings: { defaultSanctusLanguage: 'latin' } });
    assert.ok(html.includes('Holy, Holy, Holy Lord God of hosts'));
    assert.ok(!html.includes('Sanctus, Sanctus, Sanctus'));
  });
});

describe('Parish settings on cover', () => {
  const baseData = {
    feastName: 'Christmas Eve', liturgicalDate: '2026-12-24', liturgicalSeason: 'christmas',
    seasonalSettings: { holyHolySetting: 'Mass of St. Theresa' },
    readings: {}
  };

  it('renders mass times, parish name, clergy, and welcome message', () => {
    const settings = {
      parishName: 'St. Theresa Parish',
      coverTagline: 'A Catholic Community',
      massTimes: 'Sat Vigil — 5:00 PM\nSunday — 9:00 AM\nSunday — 11:00 AM',
      pastor: 'Fr. Lawrence Smith', pastorTitle: 'Pastor',
      associates: 'Fr. John Doe — Parochial Vicar',
      musicDirector: 'Morris Brown',
      welcomeMessage: 'Welcome to all who join us today.',
      closingMessage: 'Thank you for worshiping with us.'
    };
    const { html } = renderBookletHtml(baseData, { parishSettings: settings });
    assert.ok(html.includes('St. Theresa Parish'));
    assert.ok(html.includes('A Catholic Community'));
    assert.ok(html.includes('Sat Vigil'));
    assert.ok(html.includes('Fr. Lawrence Smith'));
    assert.ok(html.includes('Fr. John Doe'));
    assert.ok(html.includes('Morris Brown'));
    assert.ok(html.includes('Welcome to all who join us'));
    assert.ok(html.includes('Thank you for worshiping'));
  });

  it('falls back to placeholder mass times when none configured', () => {
    const { html } = renderBookletHtml(baseData);
    assert.ok(html.includes('Sat 5:00 PM'));
    assert.ok(html.includes('Sun 9:00 AM'));
  });
});

describe('Login still works after refactor', () => {
  it('admin login by username succeeds', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'jd', password: 'worship2026' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.token);
    assert.equal(data.user.role, 'admin');
  });

  it('music_director login succeeds', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'morris', password: 'music2026' })
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().user.role, 'music_director');
  });

  it('returns 401 for missing username', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 401);
  });
});

describe('Editor HTML smoke', () => {
  it('serves the editor with all the new sections', async () => {
    const res = await fetch('/');
    assert.equal(res.status, 200);
    const html = res.text();
    // Sanctus language toggle wired up
    assert.ok(html.includes('id="holyHolyLanguage"'));
    // Attachments picker present
    assert.ok(html.includes('id="attachmentPicker"'));
    // Parish settings inputs
    assert.ok(html.includes('id="s_massTimes"'));
    assert.ok(html.includes('id="s_pastor"'));
    assert.ok(html.includes('id="s_associates"'));
    assert.ok(html.includes('id="s_musicDirector"'));
    assert.ok(html.includes('id="s_welcomeMessage"'));
    assert.ok(html.includes('id="s_closingMessage"'));
    assert.ok(html.includes('id="s_defaultSanctusLanguage"'));
    // Attachments uploader on settings page
    assert.ok(html.includes('id="attachmentFileInput"'));
    // Music & Document Library label
    assert.ok(html.includes('Music &amp; Document Library'));
    // Children's Liturgy leader/notes inputs
    assert.ok(html.includes('id="childrenLiturgyLeader"'));
    assert.ok(html.includes('id="childrenLiturgyNotes"'));
  });

  it('readings toolbar uses the simplified 2-col layout + status row', async () => {
    const html = (await fetch('/')).text();
    // Toolbar div exists and contains the dropdown + button
    assert.ok(html.includes('class="readings-toolbar"'));
    assert.ok(html.includes('id="bibleTranslation"'));
    assert.ok(html.includes('id="fetchReadingsBtn"'));
    // Status moved to its own paragraph below
    assert.ok(/<p class="readings-status" id="fetchReadingsStatus">/.test(html));
    // CSS no longer references the old 3-column layout
    assert.ok(!html.includes('readings-status-cell'));
    assert.ok(html.includes('grid-template-columns: minmax(0, 1fr) auto'));
  });

  it('exposes reconcileSeasonAndFeastFromDate for draft loads', async () => {
    const html = (await fetch('/')).text();
    // Function defined in the SPA so populateForm can call it on draft load.
    assert.ok(/function reconcileSeasonAndFeastFromDate/.test(html));
    // populateForm calls it after setting the date so the season tracks
    // the date even when the field is full.
    assert.ok(html.includes('reconcileSeasonAndFeastFromDate({ feastFillIfEmpty: true })'));
  });
});
