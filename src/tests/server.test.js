// Tests for web server API endpoints
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const app = require('../server');

let server;
let baseUrl;

function fetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          text: () => data,
          json: () => JSON.parse(data)
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

before((_, done) => {
  server = app.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

after((_, done) => { server.close(done); });

const validBody = JSON.stringify({
  feastName: 'Test Sunday',
  liturgicalDate: '2026-03-01',
  liturgicalSeason: 'ordinary',
  readings: { firstReadingCitation: 'Gen 1:1', firstReadingText: 'In the beginning...', gospelCitation: 'Jn 1:1', gospelText: 'In the beginning was the Word...' }
});

describe('GET /', () => {
  it('should return the web UI', async () => {
    const res = await fetch('/');
    assert.equal(res.status, 200);
    const html = res.text();
    assert.ok(html.includes('Worship Aid Generator'));
    assert.ok(html.includes('form-section'));
  });
});

describe('GET /api/season-defaults/:season', () => {
  it('should return Lent defaults', async () => {
    const res = await fetch('/api/season-defaults/lent');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.gloria, false);
    assert.equal(data.creedType, 'apostles');
    assert.equal(data.entranceType, 'antiphon');
  });

  it('should return Ordinary Time defaults', async () => {
    const res = await fetch('/api/season-defaults/ordinary');
    const data = res.json();
    assert.equal(data.gloria, true);
    assert.equal(data.creedType, 'nicene');
    assert.equal(data.entranceType, 'processional');
  });
});

describe('POST /api/validate', () => {
  it('should validate correct input', async () => {
    const res = await fetch('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody });
    const result = res.json();
    assert.equal(result.valid, true);
  });

  it('should reject invalid input', async () => {
    const res = await fetch('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"bad":"data"}' });
    const result = res.json();
    assert.equal(result.valid, false);
  });
});

describe('POST /api/preview', () => {
  it('should return HTML with 8 pages', async () => {
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.ok(result.html);
    assert.ok(result.html.includes('Test Sunday'));
    assert.ok(result.html.includes('page-8'));
  });
});

describe('POST /api/generate-pdf', () => {
  it('should generate PDF and return download URL', async () => {
    const res = await fetch('/api/generate-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.equal(result.success, true);
    assert.ok(result.downloadUrl);
    assert.ok(result.filename.includes('2026_03_01'));
  });
});

describe('Drafts CRUD', () => {
  let draftId;

  it('should save a draft', async () => {
    const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.id);
    draftId = data.id;
  });

  it('should list drafts', async () => {
    const res = await fetch('/api/drafts');
    const list = res.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0);
  });

  it('should load a draft by id', async () => {
    const res = await fetch('/api/drafts/' + draftId);
    const data = res.json();
    assert.equal(data.id, draftId);
    assert.equal(data.feastName, 'Test Sunday');
  });

  it('should duplicate a draft', async () => {
    const res = await fetch('/api/drafts/' + draftId + '/duplicate', { method: 'POST' });
    const copy = res.json();
    assert.ok(copy.id !== draftId);
    assert.ok(copy.feastName.includes('copy'));
  });

  it('should delete a draft', async () => {
    const res = await fetch('/api/drafts/' + draftId, { method: 'DELETE' });
    const data = res.json();
    assert.equal(data.success, true);
  });
});

describe('Settings', () => {
  it('should load default settings', async () => {
    const res = await fetch('/api/settings');
    const data = res.json();
    assert.ok(data.onelicenseNumber);
    assert.ok(data.nurseryBlurb);
  });

  it('should save settings', async () => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parishName: 'Test Parish', onelicenseNumber: 'A-999' })
    });
    const data = res.json();
    assert.equal(data.parishName, 'Test Parish');
  });
});
