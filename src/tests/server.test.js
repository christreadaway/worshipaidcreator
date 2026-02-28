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

before(async () => {
  // Wait for user seeding to complete before starting tests
  await app.seedReady;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => { await new Promise(resolve => server.close(resolve)); });

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

  it('should include requirePastorApproval in defaults', async () => {
    const res = await fetch('/api/settings');
    const data = res.json();
    assert.equal(typeof data.requirePastorApproval, 'boolean');
  });
});

describe('Auth', () => {
  it('should login with valid credentials', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'jd', password: 'worship2026' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.token);
    assert.equal(data.user.username, 'jd');
    assert.equal(data.user.role, 'admin');
  });

  it('should reject invalid credentials', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'jd', password: 'wrong' })
    });
    assert.equal(res.status, 401);
  });

  it('should login as morris (music_director)', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'morris', password: 'music2026' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.user.role, 'music_director');
  });

  it('should login as frlarry (pastor)', async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'frlarry', password: 'pastor2026' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.user.role, 'pastor');
  });
});

describe('Approval Workflow', () => {
  let draftId;
  let adminToken;
  let pastorToken;

  before(async () => {
    // Login as admin
    const adminRes = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'jd', password: 'worship2026' })
    });
    adminToken = adminRes.json().token;

    // Login as pastor
    const pastorRes = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'frlarry', password: 'pastor2026' })
    });
    pastorToken = pastorRes.json().token;

    // Create a draft
    const draftRes = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody });
    draftId = draftRes.json().id;
  });

  it('should submit a draft for review', async () => {
    const res = await fetch('/api/drafts/' + draftId + '/submit-for-review', {
      method: 'POST', headers: { 'x-session-token': adminToken }
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.status, 'review');
  });

  it('should approve a draft', async () => {
    const res = await fetch('/api/drafts/' + draftId + '/approve', {
      method: 'POST', headers: { 'x-session-token': pastorToken }
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.status, 'approved');
    assert.ok(data.approvedBy);
  });

  it('should request changes on a draft', async () => {
    // First re-submit
    await fetch('/api/drafts/' + draftId + '/submit-for-review', {
      method: 'POST', headers: { 'x-session-token': adminToken }
    });
    const res = await fetch('/api/drafts/' + draftId + '/request-changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': pastorToken },
      body: JSON.stringify({ note: 'Please fix reading' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.status, 'draft');
    assert.equal(data.changeNote, 'Please fix reading');
  });

  it('should block PDF export when approval required and draft not approved', async () => {
    // Enable approval requirement
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirePastorApproval: true })
    });

    const bodyWithId = JSON.stringify({ ...JSON.parse(validBody), id: draftId });
    const res = await fetch('/api/generate-pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: bodyWithId
    });
    assert.equal(res.status, 403);

    // Disable approval requirement again
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirePastorApproval: false })
    });
  });

  it('should allow PDF export when draft is approved', async () => {
    // Enable approval requirement
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirePastorApproval: true })
    });

    // Submit and approve the draft
    await fetch('/api/drafts/' + draftId + '/submit-for-review', {
      method: 'POST', headers: { 'x-session-token': adminToken }
    });
    await fetch('/api/drafts/' + draftId + '/approve', {
      method: 'POST', headers: { 'x-session-token': pastorToken }
    });

    const bodyWithId = JSON.stringify({ ...JSON.parse(validBody), id: draftId });
    const res = await fetch('/api/generate-pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: bodyWithId
    });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.equal(result.success, true);

    // Disable approval requirement again
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirePastorApproval: false })
    });
  });
});
