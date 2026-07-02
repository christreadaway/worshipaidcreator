#!/usr/bin/env node
// Extracts the SPA HTML from server.js and writes to public/index.html
// Run during Netlify build: node scripts/extract-html.js
'use strict';

const fs = require('fs');
const path = require('path');

const { getAppHtml } = require('../src/server');

const html = getAppHtml();
const outDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
console.log('Extracted SPA HTML to public/index.html (' + html.length + ' bytes)');

// Publish the classic-design fonts as static files. The preview's
// @font-face rules point at /assets/fonts/classic/*, and on Netlify only
// /api/* reaches the serverless function — everything else must exist under
// public/ or the SPA fallback serves index.html instead of a font.
const fontsSrc = path.join(__dirname, '..', 'src', 'assets', 'fonts', 'classic');
const fontsOut = path.join(outDir, 'assets', 'fonts', 'classic');
fs.mkdirSync(fontsOut, { recursive: true });
let copied = 0;
for (const f of fs.readdirSync(fontsSrc)) {
  if (!/\.(otf|ttf)$/i.test(f)) continue;
  fs.copyFileSync(path.join(fontsSrc, f), path.join(fontsOut, f));
  copied++;
}
console.log('Published ' + copied + ' classic fonts to public/assets/fonts/classic');
