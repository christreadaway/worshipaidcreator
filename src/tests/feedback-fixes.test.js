// Tests for the colleague-feedback fixes:
//   - Readings reflow (lectionary -> paragraph)  → readings-fetcher.test.js
//   - Hymnal + number on hymn entries
//   - OneLicense search URL helper
//   - Responsorial Psalm music slot in shared music section
//   - Hymnal/#number rendering in music lines
//   - Stateless HMAC session tokens
//   - Per-user preferences API
//   - Health endpoint reports KV backend status
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const app = require('../server');
const hymnLib = require('../store/hymn-library');
const userStore = require('../store/user-store');
const kv = require('../store/kv');
const musicFmt = require('../music-formatter');
const { renderBookletHtml } = require('../template-renderer');

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

before(async () => {
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
});

describe('Hymn library: hymnal + number fields', () => {
  it('saveLibrary normalises hymnal/hymnNumber when present', async () => {
    const saved = await hymnLib.saveLibrary([
      { title: 'Be Thou My Vision', tune: 'SLANE', hymnal: 'Worship IV', hymnNumber: '612' }
    ]);
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0].hymnal, 'Worship IV');
    assert.equal(saved.entries[0].hymnNumber, '612');
  });

  it('search ranks exact hymnNumber match very high', () => {
    const lib = { entries: [
      { title: 'Be Thou My Vision',     hymnal: 'Worship IV',  hymnNumber: '612', language: 'en' },
      { title: 'Lift High the Cross',   hymnal: 'Gather III',  hymnNumber: '737', language: 'en' },
      { title: 'For All the Saints',    hymnal: 'Worship IV',  hymnNumber: '786', language: 'en' }
    ] };
    // Searching for "612" should return Be Thou My Vision first
    const results = hymnLib.search(lib, '612', { limit: 5 });
    assert.equal(results[0].title, 'Be Thou My Vision');
  });

  it('search includes hymnal name match', () => {
    const lib = { entries: [
      { title: 'Be Thou My Vision',     hymnal: 'Worship IV',  hymnNumber: '612', language: 'en' },
      { title: 'Random Other Hymn',     hymnal: 'Gather III',  hymnNumber: '999', language: 'en' }
    ] };
    const results = hymnLib.search(lib, 'worship', { limit: 5 });
    assert.equal(results[0].hymnal, 'Worship IV');
  });

  it('oneLicenseSearchUrl prefers hymnal + number when present', () => {
    const url = hymnLib.oneLicenseSearchUrl({ title: 'X', composer: 'Y', hymnal: 'Worship IV', hymnNumber: '612' });
    assert.match(url, /onelicense\.net\/search\?text=/);
    assert.match(decodeURIComponent(url), /Worship IV #612/);
    // Title/composer not included when hymnal+number present.
    assert.ok(!decodeURIComponent(url).includes('Y'));
  });

  it('oneLicenseSearchUrl falls back to title + composer', () => {
    const url = hymnLib.oneLicenseSearchUrl({ title: 'On Eagle\'s Wings', composer: 'Joncas' });
    assert.match(decodeURIComponent(url), /On Eagle.*Joncas/);
  });

  it('oneLicenseSearchUrl returns empty for empty entry', () => {
    assert.equal(hymnLib.oneLicenseSearchUrl({}), '');
    assert.equal(hymnLib.oneLicenseSearchUrl(null), '');
  });
});

describe('Music formatter: hymnal citation in rendered line', () => {
  const data = {
    musicSat5pm:  { processionalOrEntrance: 'Be Thou My Vision', processionalOrEntranceComposer: 'Irish trad.', processionalOrEntranceHymnal: 'Worship IV', processionalOrEntranceHymnNumber: '612' },
    musicSun9am:  { processionalOrEntrance: 'Be Thou My Vision', processionalOrEntranceComposer: 'Irish trad.', processionalOrEntranceHymnal: 'Worship IV', processionalOrEntranceHymnNumber: '612' },
    musicSun11am: { processionalOrEntrance: 'Be Thou My Vision', processionalOrEntranceComposer: 'Irish trad.', processionalOrEntranceHymnal: 'Worship IV', processionalOrEntranceHymnNumber: '612' }
  };

  it('formatMusicSlot includes hymnal + hymnNumber on the item', () => {
    const items = musicFmt.formatMusicSlot(data, 'processionalOrEntrance', 'processionalOrEntranceComposer');
    assert.equal(items.length, 1);
    assert.equal(items[0].hymnal, 'Worship IV');
    assert.equal(items[0].hymnNumber, '612');
  });

  it('renderMusicLineHtml renders [Hymnal #N] before composer', () => {
    const items = musicFmt.formatMusicSlot(data, 'processionalOrEntrance', 'processionalOrEntranceComposer');
    const html = musicFmt.renderMusicLineHtml(items[0]);
    assert.match(html, /Worship IV #612/);
    assert.match(html, /<em>Be Thou My Vision<\/em>/);
  });

  it('renderMusicLineText also renders hymnal citation', () => {
    const items = musicFmt.formatMusicSlot(data, 'processionalOrEntrance', 'processionalOrEntranceComposer');
    const text = musicFmt.renderMusicLineText(items[0]);
    assert.match(text, /\[Worship IV #612\]/);
  });
});

describe('Responsorial Psalm music slot', () => {
  it('shared music section in the editor exposes a Responsorial Psalm input', async () => {
    const html = (await fetch('/')).text();
    assert.match(html, /id="shared_responsorialPsalm"/);
    assert.match(html, /id="shared_responsorialPsalmComposer"/);
  });

  it('OneLicense-by-refrain helper exists in the editor JS', async () => {
    const html = (await fetch('/')).text();
    assert.match(html, /openOneLicenseForPsalm/);
  });

  it('autofill prefills the psalm slot with the refrain on fetchReadings', async () => {
    const html = (await fetch('/')).text();
    // The editor pulls the refrain into shared_responsorialPsalm when readings load.
    assert.match(html, /shared_responsorialPsalm/);
    assert.match(html, /data\.psalmRefrain/);
  });

  it('renderBookletHtml shows the psalm setting on the readings page', () => {
    const data = {
      feastName: 'Test', liturgicalDate: '2026-04-05', liturgicalSeason: 'easter',
      seasonalSettings: {},
      readings: { psalmCitation: 'Ps 27', psalmRefrain: 'The Lord is my light.' },
      musicSat5pm:  { responsorialPsalmSetting: 'Psalm 27 (Joncas)', responsorialPsalmSettingComposer: 'Joncas' },
      musicSun9am:  { responsorialPsalmSetting: 'Psalm 27 (Joncas)', responsorialPsalmSettingComposer: 'Joncas' },
      musicSun11am: { responsorialPsalmSetting: 'Psalm 27 (Joncas)', responsorialPsalmSettingComposer: 'Joncas' }
    };
    const { html } = renderBookletHtml(data);
    assert.match(html, /Psalm 27 \(Joncas\)/);
    assert.match(html, /Joncas/);
  });
});

describe('OneLicense search button (shared hymn slots)', () => {
  it('editor exposes openOneLicenseSearch JS helper', async () => {
    const html = (await fetch('/')).text();
    assert.match(html, /function openOneLicenseSearch/);
  });

  it('processional / communion / thanksgiving slots have OneLicense buttons', async () => {
    const html = (await fetch('/')).text();
    assert.match(html, /onclick="openOneLicenseSearch\('shared_processional'/);
    assert.match(html, /onclick="openOneLicenseSearch\('shared_communion'/);
    assert.match(html, /onclick="openOneLicenseSearch\('shared_thanksgiving'/);
  });

  it('hymn slots have hymnal + number inputs', async () => {
    const html = (await fetch('/')).text();
    assert.match(html, /id="shared_processional_hymnal"/);
    assert.match(html, /id="shared_processional_hymnNumber"/);
    assert.match(html, /id="shared_communion_hymnal"/);
    assert.match(html, /id="shared_thanksgiving_hymnal"/);
  });
});

describe('Stateless HMAC session tokens survive store wipe', () => {
  it('a token issued before a sessions-store wipe still validates', async () => {
    const morris = await userStore.getUserByUsername('morris');
    const token = await userStore.createSession(morris.id);
    // Wipe the revocation list (simulates Netlify in-memory blob fallback).
    await kv.set('sessions', '_revoked', { tokens: [] });
    const user = await userStore.getSessionUser(token);
    assert.ok(user, 'token should still validate after sessions-store wipe');
    assert.equal(user.username, 'morris');
  });

  it('garbage tokens are rejected', async () => {
    assert.equal(await userStore.getSessionUser('not-a-real-token'), null);
    assert.equal(await userStore.getSessionUser(''), null);
    assert.equal(await userStore.getSessionUser(null), null);
  });

  it('tokens with tampered signatures are rejected', async () => {
    const morris = await userStore.getUserByUsername('morris');
    const token = await userStore.createSession(morris.id);
    const tampered = token.slice(0, -2) + '00';
    assert.equal(await userStore.getSessionUser(tampered), null);
  });

  it('destroySession revokes the token (logout works)', async () => {
    // Use vincent so we don't disturb morris' tokens used by other tests.
    const vincent = await userStore.getUserByUsername('vincent');
    const token = await userStore.createSession(vincent.id);
    assert.ok(await userStore.getSessionUser(token));
    await userStore.destroySession(token);
    assert.equal(await userStore.getSessionUser(token), null);
  });
});

describe('Per-user preferences API', () => {
  it('GET /api/user-prefs requires auth', async () => {
    const res = await fetch('/api/user-prefs');
    assert.equal(res.status, 401);
  });

  it('round-trips prefs for the authenticated user', async () => {
    let res = await fetch('/api/user-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-session-token': adminToken },
      body: JSON.stringify({ bookletSize: 'half-letter', preferredHymnal: 'Worship IV' })
    });
    assert.equal(res.status, 200);

    res = await fetch('/api/user-prefs', { headers: { 'x-session-token': adminToken } });
    const prefs = res.json();
    assert.equal(prefs.bookletSize, 'half-letter');
    assert.equal(prefs.preferredHymnal, 'Worship IV');
  });

  it('PUT merges (does not replace) prefs', async () => {
    await fetch('/api/user-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-session-token': adminToken },
      body: JSON.stringify({ tone: 'reverent' })
    });
    const res = await fetch('/api/user-prefs', { headers: { 'x-session-token': adminToken } });
    const prefs = res.json();
    // Earlier-set values still present
    assert.equal(prefs.bookletSize, 'half-letter');
    assert.equal(prefs.preferredHymnal, 'Worship IV');
    assert.equal(prefs.tone, 'reverent');
  });
});

describe('Health endpoint reports KV backend status', () => {
  it('returns environment + persistence info', async () => {
    const res = await fetch('/api/health');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.timestamp);
    assert.ok(['local', 'netlify'].includes(data.environment));
    assert.ok(['filesystem', 'netlify-blobs', 'in-memory', 'unknown'].includes(data.persistence));
  });

  it('shows filesystem persistence in local environment', async () => {
    const res = await fetch('/api/health');
    const data = res.json();
    assert.equal(data.environment, 'local');
    assert.equal(data.persistence, 'filesystem');
  });
});

describe('Preview matches selected booklet size', () => {
  it('preview API echoes the booklet size + page dimensions', async () => {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feastName: 'Test', liturgicalDate: '2026-04-05', liturgicalSeason: 'easter',
        bookletSize: 'tabloid'
      })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.bookletSize, 'tabloid');
    assert.equal(data.pageWidth, '8.5in');
    assert.equal(data.pageHeight, '11in');
  });

  it('half-letter preview returns 5.5x8.5 dimensions', async () => {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feastName: 'Test', liturgicalDate: '2026-04-05', liturgicalSeason: 'easter',
        bookletSize: 'half-letter'
      })
    });
    const data = res.json();
    assert.equal(data.pageWidth, '5.5in');
    assert.equal(data.pageHeight, '8.5in');
  });

  it('preview iframe is sized to match the selected booklet size', async () => {
    const html = (await fetch('/')).text();
    // The preview generator sets the frame width to the server-reported pageWidth.
    assert.match(html, /frame\.style\.width = result\.pageWidth/);
  });
});

describe('Settings persist across saves (round-trip)', () => {
  it('PUT then GET returns the same values', async () => {
    const settings = {
      parishName: 'St. Test',
      pastor: 'Fr. Round Trip',
      onelicenseNumber: 'A-123456',
      requirePastorApproval: true,
      welcomeMessage: 'Welcome.'
    };
    let res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    assert.equal(res.status, 200);

    res = await fetch('/api/settings');
    const back = res.json();
    assert.equal(back.parishName, 'St. Test');
    assert.equal(back.pastor, 'Fr. Round Trip');
    assert.equal(back.onelicenseNumber, 'A-123456');
    assert.equal(back.requirePastorApproval, true);
    assert.equal(back.welcomeMessage, 'Welcome.');
  });
});
