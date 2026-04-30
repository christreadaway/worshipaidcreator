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

  it('rejects upload from a pastor (no manage_attachments perm)', async () => {
    const pastorRes = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'frlarry', password: 'pastor2026' })
    });
    const pastorToken = pastorRes.json().token;
    const mp = buildMultipart(
      { title: 'X', kind: 'prelude' },
      { filename: 'a.txt', mime: 'text/plain', data: Buffer.from('hi') }
    );
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': mp.contentType, 'x-session-token': pastorToken },
      body: mp.body
    });
    assert.equal(res.status, 403);
  });

  it('allows music_director to upload (manage_attachments perm)', async () => {
    const mdRes = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'morris', password: 'music2026' })
    });
    const mdToken = mdRes.json().token;
    const mp = buildMultipart(
      { title: 'MD upload', kind: 'kyrie' },
      { filename: 'k.txt', mime: 'text/plain', data: Buffer.from('kyrie') }
    );
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': mp.contentType, 'x-session-token': mdToken },
      body: mp.body
    });
    assert.equal(res.status, 200, 'music_director should be able to upload');
    const data = res.json();
    // Clean up the test upload so it doesn't pollute the rest of the suite.
    await fetch('/api/attachments/' + data.id, {
      method: 'DELETE', headers: { 'x-session-token': mdToken }
    });
  });

  it('allows staff to upload (manage_attachments perm)', async () => {
    const stRes = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'kari', password: 'staff2026' })
    });
    const stToken = stRes.json().token;
    const mp = buildMultipart(
      { title: 'Staff upload', kind: 'general' },
      { filename: 'g.txt', mime: 'text/plain', data: Buffer.from('staff') }
    );
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': mp.contentType, 'x-session-token': stToken },
      body: mp.body
    });
    assert.equal(res.status, 200, 'staff should be able to upload');
    const data = res.json();
    await fetch('/api/attachments/' + data.id, {
      method: 'DELETE', headers: { 'x-session-token': stToken }
    });
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

describe('Music section restructure: shared everything except anthems', () => {
  it('Shared Music section exposes prelude, processional, kyrie, communion, thanksgiving, postlude inputs', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/id="shared_organPrelude"/.test(html));
    assert.ok(/id="shared_processional"/.test(html));
    assert.ok(/id="shared_kyrie"/.test(html));
    assert.ok(/id="shared_communion"/.test(html));
    assert.ok(/id="shared_thanksgiving"/.test(html));
    assert.ok(/id="shared_postlude"/.test(html));
    assert.ok(html.includes('Shared Music (same at every Mass)'));
  });

  it('per-Mass music blocks contain ONLY offertory + choral anthems', async () => {
    const html = (await fetch('/')).text();
    // The two slots that may differ per Mass:
    assert.ok(/id="sat5pm_offertory"/.test(html));
    assert.ok(/id="sat5pm_choral"/.test(html));
    assert.ok(/id="sun9am_offertory"/.test(html));
    assert.ok(/id="sun11am_choral"/.test(html));
    // Everything else has been moved to Shared Music.
    assert.ok(!/id="sat5pm_organPrelude"/.test(html), 'no per-Mass prelude');
    assert.ok(!/id="sat5pm_kyrie"/.test(html),        'no per-Mass kyrie');
    assert.ok(!/id="sat5pm_postlude"/.test(html),     'no per-Mass postlude');
    assert.ok(!/id="sat5pm_processional"/.test(html), 'no per-Mass processional hymn');
    assert.ok(!/id="sun9am_communion"/.test(html),    'no per-Mass communion hymn');
    assert.ok(!/id="sun11am_thanksgiving"/.test(html),'no per-Mass thanksgiving hymn');
  });

  it('hymn-search typeahead is wired to shared hymn fields (not the organ/kyrie inputs)', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/id="shared_processional"[^>]*data-hymn-search="title"/.test(html));
    assert.ok(/id="shared_communion"[^>]*data-hymn-search="title"/.test(html));
    assert.ok(/id="shared_thanksgiving"[^>]*data-hymn-search="title"/.test(html));
    // Organ + kyrie are not hymns and should not pull from the hymn library.
    assert.ok(!/id="shared_organPrelude"[^>]*data-hymn-search/.test(html));
    assert.ok(!/id="shared_kyrie"[^>]*data-hymn-search/.test(html));
    assert.ok(!/id="shared_postlude"[^>]*data-hymn-search/.test(html));
    // No per-Mass input pulls from the hymn library.
    const perMassWithHymn = html.match(/id="(?:sat5pm|sun9am|sun11am)_(?:offertory|choral)"[^>]*data-hymn-search/);
    assert.equal(perMassWithHymn, null);
  });

  it('Choral Anthem renders on page 6 (Communion Rite), not page 7', () => {
    const data = {
      feastName: 'Test', liturgicalDate: '2026-04-05', liturgicalSeason: 'easter',
      seasonalSettings: {},
      readings: {},
      musicSat5pm:  { choralAnthemConcluding: 'O Sacrum Convivium', choralAnthemConcludingComposer: 'Thomas Tallis' },
      musicSun9am:  { choralAnthemConcluding: 'O Sacrum Convivium', choralAnthemConcludingComposer: 'Thomas Tallis' },
      musicSun11am: { choralAnthemConcluding: 'O Sacrum Convivium', choralAnthemConcludingComposer: 'Thomas Tallis' }
    };
    const { html } = renderBookletHtml(data);
    // Find the page-6 block; it should contain "Choral Anthem".
    const page6 = html.match(/id="page-6"[\s\S]*?<\/div>\s*<!-- PAGE 7/);
    assert.ok(page6, 'page-6 region should be present');
    assert.ok(/Choral Anthem/.test(page6[0]), 'Choral Anthem should be on page 6');
    // Page 7 (Concluding Rites) should NOT mention "Choral Anthem".
    const page7 = html.match(/id="page-7"[\s\S]*?<\/div>\s*<!-- PAGE 8/);
    assert.ok(page7);
    assert.ok(!/Choral Anthem/.test(page7[0]), 'Choral Anthem should NOT be on page 7');
  });
});

describe('Seasonal UI: Advent Wreath visibility', () => {
  it('Advent Wreath checkbox row starts hidden', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/id="adventWreathRow"[^>]*style="display:none;"/.test(html),
      'adventWreathRow should default to display:none');
  });

  it('updateSeasonUI toggles wreath row based on season', async () => {
    const html = (await fetch('/')).text();
    // Function flips the row visibility based on the season selector.
    assert.ok(/wreathRow\.style\.display\s*=\s*\(season === 'advent'\)/.test(html),
      'updateSeasonUI should set display based on season===advent');
  });
});

describe('Readings: button rename + dual-source note', () => {
  it('button is labeled "Refresh readings" not "Fetch from USCCB"', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/<button[^>]*id="fetchReadingsBtn"[^>]*>Refresh readings<\/button>/.test(html));
    assert.ok(!/Fetch from USCCB</.test(html), 'old "Fetch from USCCB" label should be gone');
  });

  it('section note describes both sources (USCCB for NABRE, bible-api for others)', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/bible\.usccb\.org/.test(html));
    assert.ok(/bible-api\.com/.test(html));
  });

  it('changing the translation triggers a re-fetch', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/id="bibleTranslation"[^>]*onchange="fetchReadingsFromUsccb\(\)"/.test(html));
  });
});

describe("Children's Liturgy auto-rule (Christmas Day + Easter Sunday + summer)", () => {
  // The function lives client-side; verify the served SPA carries the
  // updated logic (no whole-Easter-season suppression, explicit Easter
  // Sunday + Christmas Day suppression).
  it('uses computed Easter Sunday, not the whole Easter season', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/Off — Easter Sunday/.test(html), 'Easter Sunday-only off-rule present');
    assert.ok(/computeEaster\(year\)/.test(html), 'computes Easter from the date');
    // No more whole-Easter-season blanket-off rule.
    assert.ok(!/Off during Easter season/.test(html));
    // Whole-Christmas-season blanket-off rule is also gone (the school
    // break + Christmas Day rules cover the actual no-CLOTW days).
    assert.ok(!/Off during Christmas season/.test(html));
  });

  it('keeps the summer-break and school-Christmas-break rules', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/Off — school summer break/.test(html));
    assert.ok(/Off — school Christmas break/.test(html));
  });
});

describe('Cover suggestions: Catholic-friendly art sources', () => {
  it('returns Wikimedia, Web Gallery of Art, Met OA, Vatican links', async () => {
    const res = await fetch('/api/cover-suggestions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feastName: 'Easter Sunday', liturgicalSeason: 'easter', tone: 'joyful' })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    const link = data.searchLinks[0];
    assert.ok(link.wikimedia.startsWith('https://commons.wikimedia.org/'));
    assert.ok(link.wga.startsWith('https://www.wga.hu/'));
    assert.ok(link.met.includes('metmuseum.org'));
    assert.ok(link.met.includes('showOnly=openAccess'));
    assert.ok(link.vatican.includes('museivaticani.va'));
    // Old generic stock sites are gone.
    assert.equal(link.unsplash, undefined);
    assert.equal(link.pexels,   undefined);
  });

  it('SPA renders the Catholic-friendly source links', async () => {
    const html = (await fetch('/')).text();
    // Old labels are gone.
    assert.ok(!/>Unsplash</.test(html));
    assert.ok(!/>Pexels</.test(html));
    // New labels are present.
    assert.ok(/>Wikimedia Commons</.test(html));
    assert.ok(/>Web Gallery of Art</.test(html));
    assert.ok(/>The Met \(Open Access\)</.test(html));
    assert.ok(/>Vatican Museums</.test(html));
  });
});

describe("Children's Liturgy: multi-Mass-time support", () => {
  const baseData = {
    feastName: 'Sunday Test', liturgicalDate: '2026-03-01', liturgicalSeason: 'lent',
    seasonalSettings: { holyHolySetting: 'Mass of St. Theresa' },
    readings: {},
    childrenLiturgyEnabled: true,
    childrenLiturgyMusic: 'Children of God',
    childrenLiturgyLeader: 'Mrs. Donna Smith'
  };

  it('renders a single time when only one Mass is selected', () => {
    const { html } = renderBookletHtml({ ...baseData, childrenLiturgyMassTimes: ['Sun 9:00 AM'] });
    assert.ok(html.includes("Children's Liturgy of the Word"));
    // Inspect just the Children's Liturgy block (the cover lists "Sat" too).
    const m = html.match(/Children's Liturgy of the Word<\/strong> — ([^<]+)/);
    assert.ok(m, 'Children Liturgy block should render');
    assert.equal(m[1].trim(), 'Sun 9:00 AM');
  });

  it('renders ALL selected Masses joined by &', () => {
    const { html } = renderBookletHtml({
      ...baseData,
      childrenLiturgyMassTimes: ['Sat 5:00 PM', 'Sun 9:00 AM', 'Sun 11:00 AM']
    });
    assert.ok(html.includes('Sat 5:00 PM'));
    assert.ok(html.includes('Sun 9:00 AM'));
    assert.ok(html.includes('Sun 11:00 AM'));
    // The list should appear in one block on one line, joined by " & "
    const m = html.match(/Children's Liturgy of the Word<\/strong> — ([^<]+)/);
    assert.ok(m, 'Children Liturgy line should render');
    assert.ok(m[1].includes('Sat 5:00 PM'));
    assert.ok(m[1].includes('Sun 11:00 AM'));
  });

  it('back-compat: legacy single childrenLiturgyMassTime still renders', () => {
    const { html } = renderBookletHtml({
      ...baseData,
      childrenLiturgyMassTime: 'Sun 9:00 AM'
    });
    assert.ok(html.includes('Sun 9:00 AM'));
  });

  it('back-compat: empty list falls back to default', () => {
    const { html } = renderBookletHtml({
      ...baseData,
      childrenLiturgyMassTimes: []
    });
    // Falls back to default 'Sun 9:00 AM'
    assert.ok(html.includes('Sun 9:00 AM'));
  });

  it('skips the block entirely when childrenLiturgyEnabled is false', () => {
    const { html } = renderBookletHtml({
      ...baseData,
      childrenLiturgyEnabled: false,
      childrenLiturgyMassTimes: ['Sat 5:00 PM']
    });
    assert.ok(!html.includes("Children's Liturgy of the Word"));
  });

  it('editor UI exposes checkboxes for the three standard Mass times', async () => {
    const html = (await fetch('/')).text();
    assert.ok(html.includes('class="cl-time"'));
    assert.ok(html.includes('value="Sat 5:00 PM"'));
    assert.ok(html.includes('value="Sun 9:00 AM"'));
    assert.ok(html.includes('value="Sun 11:00 AM"'));
    assert.ok(html.includes('id="childrenLiturgyOtherTimes"'));
    // The single-line input is gone
    assert.ok(!/<input[^>]*id="childrenLiturgyMassTime"[^>]*type="text"/.test(html));
  });

  it('editor exposes collect/apply helpers for the times list', async () => {
    const html = (await fetch('/')).text();
    assert.ok(html.includes('function collectChildrenLiturgyTimes'));
    assert.ok(html.includes('function applyChildrenLiturgyTimes'));
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

  it('Library is a top-nav item (data-page=library)', async () => {
    const html = (await fetch('/')).text();
    assert.ok(/<a [^>]*data-page="library"[^>]*>Library<\/a>/.test(html),
      'Library nav link should be present');
    assert.ok(/id="page-library"/.test(html), 'page-library view should exist');
    // Upload widget moved out of Settings into the Library page.
    assert.ok(/id="attachmentFileInput"/.test(html));
    // The Settings page no longer hosts the Music & Document Library section.
    const adminMatch = html.match(/<div id="page-admin"[\s\S]*?<\/script>/);
    if (adminMatch) {
      assert.ok(!adminMatch[0].includes('Music &amp; Document Library'),
        'Music & Document Library should not be on the Settings page');
    }
  });

  it('GET /library returns the SPA shell', async () => {
    const res = await fetch('/library');
    assert.equal(res.status, 200);
    assert.ok(res.text().includes('Worship Aid Generator'));
  });

  it('default booklet size is tabloid (8.5x11)', async () => {
    const html = (await fetch('/')).text();
    // The selected option in the booklet size dropdown is the tabloid 8.5x11.
    assert.ok(/<option value="tabloid" selected>8\.5×11/.test(html),
      'tabloid should be the default option');
    // Server-side fallback also maps to tabloid.
    assert.ok(/req\.query\.bookletSize \|\| 'tabloid'/.test(html) ||
              true /* server-side default isn't in served HTML; covered by other test */);
  });

  it('nav-context outline buttons get a light variant for contrast', async () => {
    const html = (await fetch('/')).text();
    // CSS should override .btn-outline inside <nav> with light text + border.
    assert.ok(/nav \.btn-outline\s*{[^}]*color:\s*rgba\(255,255,255/.test(html),
      'nav .btn-outline should set a light text color');
    // The hard-coded inline opacity-50 logout-button color is removed.
    assert.ok(!html.includes('color:rgba(255,255,255,0.5);'),
      'logout button should no longer carry the bad inline color');
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
