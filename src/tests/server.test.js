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
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => data,
            json: () => JSON.parse(data)
          });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, text: () => data, json: () => ({}) });
        }
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

after((_, done) => {
  server.close(done);
});

const validBody = JSON.stringify({
  occasionName: 'Test Sunday',
  occasionDate: '2026-03-01',
  massTimes: ['Sun 9 AM'],
  firstReading: { citation: 'Gen 1:1', text: 'In the beginning...' },
  responsorialPsalm: { citation: 'Psalm 1' },
  gospel: { citation: 'John 1:1', text: 'In the beginning was the Word...' }
});

describe('GET /', () => {
  it('should return the web UI HTML', async () => {
    const res = await fetch('/');
    assert.equal(res.status, 200);
    const html = res.text();
    assert.ok(html.includes('Worship Aid Generator'));
    assert.ok(html.includes('<form') || html.includes('form-section'));
  });
});

describe('GET /api/sample', () => {
  it('should return sample data JSON', async () => {
    const res = await fetch('/api/sample');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.occasionName);
    assert.ok(data.occasionDate);
    assert.ok(Array.isArray(data.massTimes));
    assert.ok(data.firstReading);
    assert.ok(data.gospel);
  });
});

describe('POST /api/validate', () => {
  it('should validate correct input', async () => {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody
    });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.equal(result.valid, true);
  });

  it('should reject invalid input', async () => {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occasionName: 'Test' })
    });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});

describe('POST /api/preview', () => {
  it('should return HTML preview for valid input', async () => {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody
    });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.ok(result.html);
    assert.ok(result.html.includes('Test Sunday'));
    assert.ok(Array.isArray(result.warnings));
  });

  it('should return 400 for invalid input', async () => {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true })
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/generate-pdf', () => {
  it('should generate PDF and return download URL', async () => {
    const res = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody
    });
    assert.equal(res.status, 200);
    const result = res.json();
    assert.equal(result.success, true);
    assert.ok(result.downloadUrl);
    assert.ok(result.downloadUrl.includes('.pdf'));
  });

  it('should return 400 for invalid input', async () => {
    const res = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'data' })
    });
    assert.equal(res.status, 400);
  });
});
