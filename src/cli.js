#!/usr/bin/env node
// CLI tool for Worship Aid Generator
'use strict';

const fs = require('fs');
const path = require('path');
const { validateInput, detectOverflows } = require('./validator');
const { generatePdf, buildFilename } = require('./pdf-generator');
const { renderBookletHtml } = require('./template-renderer');
const store = require('./store/file-store');

const args = process.argv.slice(2);

function usage() {
  console.log(`
Worship Aid Generator v1.0

Usage:
  worship-aid <input.json> [options]

Options:
  --output, -o <path>   Output directory (default: ./data/exports)
  --html                Also generate HTML preview
  --help, -h            Show this help

Examples:
  worship-aid sample/second-sunday-lent.json
  worship-aid input.json --output ./build
  worship-aid input.json --html
`);
}

async function main() {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    usage();
    process.exit(0);
  }

  const inputFile = args.find(a => !a.startsWith('-'));
  if (!inputFile) {
    console.error('Error: No input file specified.');
    usage();
    process.exit(1);
  }

  const generateHtml = args.includes('--html');
  let outputDir = store.getExportsDir();
  const outputIdx = args.indexOf('--output') !== -1 ? args.indexOf('--output') : args.indexOf('-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputDir = args[outputIdx + 1];
  }

  let data;
  try {
    const raw = fs.readFileSync(inputFile, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading input file: ${err.message}`);
    process.exit(1);
  }

  const validation = validateInput(data);
  if (!validation.valid) {
    console.error('Validation errors:');
    for (const e of validation.errors) console.error(e);
    process.exit(1);
  }

  // Overflow warnings
  const overflows = detectOverflows(data);
  if (overflows.length > 0) {
    console.log(`\nOverflow warnings (${overflows.length}):`);
    for (const o of overflows) console.log(`  Page ${o.page}: ${o.message}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const filename = buildFilename(data);
  const pdfPath = path.join(outputDir, filename);

  const settings = store.loadSettings();

  console.log('Generating PDF...');
  const result = await generatePdf(data, pdfPath, { parishSettings: settings });
  console.log(`PDF created: ${result.outputPath}`);

  if (generateHtml) {
    console.log('Generating HTML preview...');
    const { html, warnings: htmlWarnings } = renderBookletHtml(data, { parishSettings: settings });
    const htmlFilename = filename.replace('.pdf', '.html');
    const htmlPath = path.join(outputDir, htmlFilename);
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`HTML created: ${htmlPath}`);
    result.warnings.push(...htmlWarnings);
  }

  // Build log
  const logPath = path.join(outputDir, 'build.log');
  const logContent = [
    `Worship Aid Generator — Build Log`,
    `Date: ${new Date().toISOString()}`,
    `Input: ${inputFile}`,
    `Output: ${pdfPath}`,
    '',
    `Overflows (${overflows.length}):`,
    ...overflows.map(o => `  Page ${o.page}: ${o.message}`),
    overflows.length === 0 ? '  (none)' : '',
    '',
    `Warnings (${result.warnings.length}):`,
    ...result.warnings.map(w => `  - ${w}`),
    result.warnings.length === 0 ? '  (none)' : ''
  ].join('\n');
  fs.writeFileSync(logPath, logContent, 'utf8');
  console.log(`Build log: ${logPath}`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
