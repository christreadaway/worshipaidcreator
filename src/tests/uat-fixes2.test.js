// Regression tests for the second round of UAT fixes (June 2026 beta):
//   - Notation Images list is actionable: each uploaded image gets a
//     "Print in:" dropdown of booklet spots plus pills showing where it
//     currently prints
//   - Client-side notation file cache (window._notationFiles) defeats
//     the eventually-consistent Netlify Blobs list() — uploads are pushed
//     into the cache immediately, server results are merged in
//   - Refresh control on the Notation Images section
//   - Per-slot pick dropdowns group options via <optgroup>: uploaded
//     images + image attachments from the Library (kind-matched first)
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const app = require('../server');

let server, baseUrl;

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

let releaseLock;
before(async () => {
  // Serialize against the other suites that share the on-disk data/ dir.
  releaseLock = await require('./_shared-state-lock').acquireSharedStateLock();
  await app.seedReady;
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (releaseLock) releaseLock();
});

describe('Actionable Notation Images list', () => {
  let html;
  before(async () => {
    const res = await fetch('/');
    assert.equal(res.status, 200);
    html = res.text();
  });

  it('renders a "Print in" assignment dropdown on each listed image', () => {
    assert.ok(html.includes('Print in: choose a spot'), 'list rows offer a Print in: select');
    assert.ok(html.includes('assignNotationFromList'), 'select wires up assignNotationFromList');
  });

  it('keeps a client-side cache of uploaded notation files', () => {
    assert.ok(html.includes('window._notationFiles'), 'window._notationFiles cache exists');
    assert.ok(html.includes('addNotationFile'), 'cache add/merge helper exists');
    assert.ok(html.includes('renderNotationList'), 'list renders from the cache');
  });

  it('merges server list results into the cache instead of replacing', () => {
    const m = html.match(/async function loadNotationList\(\)[\s\S]*?\n\}/);
    assert.ok(m, 'loadNotationList present');
    assert.ok(m[0].includes('addNotationFile'), 'loadNotationList merges via addNotationFile');
  });

  it('has a Refresh control on the Notation Images section', () => {
    const section = html.slice(html.indexOf('id="section-notation"'));
    const hdrEnd = section.indexOf('notation-list');
    assert.ok(section.slice(0, hdrEnd).includes('>Refresh<'), 'Refresh button in section');
    assert.ok(section.slice(0, hdrEnd).includes('loadNotationList()'), 'Refresh re-loads the list');
  });

  it('notes that uploads can take a moment to appear after a reload', () => {
    assert.ok(/take a moment to appear/i.test(html), 'eventual-consistency note present');
    assert.ok(/newly uploaded files always show immediately/i.test(html), 'immediate-show note present');
  });

  it('shows where an image currently prints, with a detach control', () => {
    assert.ok(html.includes('notation-use-pill'), 'usage pills rendered');
    const pillBlock = html.match(/notation-use-pill[^>]*>' \+[\s\S]*?detachNotation/);
    assert.ok(pillBlock, 'pill x button calls detachNotation');
  });
});

describe('Per-slot notation pick dropdowns', () => {
  let html;
  before(async () => {
    const res = await fetch('/');
    html = res.text();
  });

  it('refreshNotationPicks groups options via <optgroup>', () => {
    const m = html.match(/async function refreshNotationPicks\(\)[\s\S]*?\n\}/);
    assert.ok(m, 'refreshNotationPicks present');
    assert.ok(m[0].includes('<optgroup'), 'uses <optgroup>');
    assert.ok(m[0].includes('Uploaded images'), 'Uploaded images group');
    assert.ok(m[0].includes('Library files'), 'Library files group');
    assert.ok(m[0].includes('getAttachmentCache'), 'library files come from the attachment cache');
    assert.ok(m[0].includes("indexOf('image/')"), 'only image attachments are listed');
  });

  it('maps library attachment kinds to notation slots', () => {
    assert.ok(html.includes('ATTACHMENT_KIND_TO_SLOT'), 'kind->slot map exists');
    assert.ok(html.includes("agnus_dei: 'lambOfGod'"), 'agnus_dei maps to lambOfGod');
    assert.ok(html.includes("mystery_of_faith: 'mysteryOfFaith'"), 'mystery_of_faith maps to mysteryOfFaith');
    assert.ok(html.includes("gospel_acclamation: 'gospelAcclamation'"), 'gospel_acclamation maps to gospelAcclamation');
  });

  it('slot label list covers every booklet spot', () => {
    const labels = ['Processional Hymn', 'Communion Hymn', 'Hymn of Thanksgiving', 'Kyrie',
      'Gloria', 'Holy, Holy, Holy (Sanctus)', 'Mystery of Faith', 'Lamb of God',
      'Psalm Refrain', 'Gospel Acclamation'];
    for (const label of labels) {
      assert.ok(html.includes("'" + label + "'"), 'slot label present: ' + label);
    }
  });
});
