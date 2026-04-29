#!/usr/bin/env node
// Enriches the local hymn seed catalog with Hymnary.org metadata.
//
// Reads:  src/assets/hymns/seed.json   (canonical seed list)
// Writes: data/hymn-library-local.json (seed entries + Hymnary metadata)
//
// Hymnary.org exposes a free, no-auth search at
//   https://hymnary.org/search?qu=<query>&format=json
// We respect a 1 req/sec rate limit and add a Hymnary-attribution
// preamble to the output. The script is defensive: if Hymnary is
// unreachable, the entry is written through unchanged so the file is
// still usable as a local cache.
//
// Usage:  npm run fetch-hymns
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SEED_PATH = path.join(__dirname, '..', 'src', 'assets', 'hymns', 'seed.json');
const OUT_PATH  = path.join(__dirname, '..', 'data', 'hymn-library-local.json');
const RATE_MS   = 1100; // a touch over 1 req/sec to be polite

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'WorshipAidGenerator/1.0 (+https://github.com/christreadaway/worshipaidcreator)' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON from ' + url + ': ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout fetching ' + url)); });
  });
}

async function lookupHymnary(entry) {
  // Prefer a tune-name lookup first, then title. Both fall back gracefully.
  const queries = [];
  if (entry.tune)  queries.push('tu:' + entry.tune);
  if (entry.title) queries.push('in:' + entry.title);
  for (const qu of queries) {
    const url = 'https://hymnary.org/search?qu=' + encodeURIComponent(qu) + '&format=json';
    try {
      const data = await fetchJson(url);
      if (data && (Array.isArray(data.results) ? data.results.length : Object.keys(data).length)) {
        return data;
      }
    } catch (e) {
      // Continue to next query — don't fail the whole row on a single 404
      console.warn('  hymnary lookup failed: ' + e.message);
    }
  }
  return null;
}

function summarize(hymnaryData) {
  if (!hymnaryData) return null;
  // Trim to the fields we actually want to surface (meter, scripture, hymnal instances).
  // Hymnary's response shape varies — keep whatever they returned but cap size so the
  // local cache stays sane.
  const summary = { fetchedAt: new Date().toISOString() };
  if (hymnaryData.results) {
    const top = (Array.isArray(hymnaryData.results) ? hymnaryData.results : [hymnaryData.results])[0] || {};
    summary.meter        = top.meter || top.Meter;
    summary.scripture    = top.scripture || top.Scripture;
    summary.hymnalCount  = top.hymnal_count || top.HymnalCount;
    summary.hymnaryUrl   = top.url || top.URL;
    summary.raw          = JSON.stringify(top).slice(0, 4000); // cap raw payload
  } else {
    summary.raw = JSON.stringify(hymnaryData).slice(0, 4000);
  }
  return summary;
}

async function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error('Seed file not found: ' + SEED_PATH);
    console.error('Create src/assets/hymns/seed.json (an array of hymn objects) first.');
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  if (!Array.isArray(seed)) {
    console.error('Seed file must contain a JSON array of hymn objects.');
    process.exit(1);
  }

  console.log('Fetching Hymnary metadata for ' + seed.length + ' hymns...');
  console.log('(Rate-limited to ~1 req/sec — this will take ~' + Math.ceil(seed.length * RATE_MS / 1000) + 's.)\n');

  const enriched = [];
  for (let i = 0; i < seed.length; i++) {
    const entry = seed[i];
    process.stdout.write((i + 1) + '/' + seed.length + ' · ' + (entry.title || '<untitled>'));
    let hymnary = null;
    try { hymnary = await lookupHymnary(entry); }
    catch (e) { console.warn('  ' + e.message); }
    const summary = summarize(hymnary);
    enriched.push({ ...entry, hymnary: summary || null });
    process.stdout.write(summary ? '  [hit]\n' : '  [miss]\n');
    if (i < seed.length - 1) await sleep(RATE_MS);
  }

  const outDir = path.dirname(OUT_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    attribution: 'Hymn metadata enriched from Hymnary.org (https://hymnary.org). Used under their terms of service. No endorsement implied.',
    generatedAt: new Date().toISOString(),
    sourceFile: 'src/assets/hymns/seed.json',
    count: enriched.length,
    entries: enriched
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log('\nWrote ' + enriched.length + ' enriched entries to ' + OUT_PATH);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
