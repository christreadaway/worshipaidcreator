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
