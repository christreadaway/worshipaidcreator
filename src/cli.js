#!/usr/bin/env node
// CLI tool for Worship Aid Generator
'use strict';

const fs = require('fs');
const path = require('path');
const { validateInput } = require('./validator');
const { generatePdf } = require('./pdf-generator');
const { renderBookletHtml } = require('./template-renderer');

const args = process.argv.slice(2);

function usage() {
  console.log(`
Worship Aid Generator v1.0

Usage:
  worship-aid <input.json> [options]

Options:
  --output, -o <path>   Output directory (default: ./output)
  --compact             Use compact (9pt) font for overflow pages
  --html                Also generate HTML preview
  --help, -h            Show this help

Examples:
  worship-aid sample/second-sunday-lent.json
  worship-aid input.json --compact --output ./build
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

  const compact = args.includes('--compact');
  const generateHtml = args.includes('--html');
  let outputDir = './output';
  const outputIdx = args.indexOf('--output') !== -1 ? args.indexOf('--output') : args.indexOf('-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputDir = args[outputIdx + 1];
  }

  // Read and parse input
  let data;
  try {
    const raw = fs.readFileSync(inputFile, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading input file: ${err.message}`);
    process.exit(1);
  }

  // Validate
  const validation = validateInput(data);
  if (!validation.valid) {
    console.error('Validation errors:');
    for (const e of validation.errors) console.error(e);
    process.exit(1);
  }

  // Ensure output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const dateSlug = data.occasionDate || 'undated';
  const baseName = `worship-aid-${dateSlug}`;

  // Generate PDF
  console.log('Generating PDF...');
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);
  const result = await generatePdf(data, pdfPath, { compact });
  console.log(`PDF created: ${result.outputPath}`);

  // Generate HTML preview if requested
  if (generateHtml) {
    console.log('Generating HTML preview...');
    const { html, warnings: htmlWarnings } = renderBookletHtml(data, { compact });
    const htmlPath = path.join(outputDir, `${baseName}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`HTML created: ${htmlPath}`);
    result.warnings.push(...htmlWarnings);
  }

  // Write build log
  const logPath = path.join(outputDir, 'build.log');
  const logContent = [
    `Worship Aid Generator — Build Log`,
    `Date: ${new Date().toISOString()}`,
    `Input: ${inputFile}`,
    `Output: ${pdfPath}`,
    `Compact: ${compact}`,
    '',
    `Warnings (${result.warnings.length}):`,
    ...result.warnings.map(w => `  - ${w}`),
    result.warnings.length === 0 ? '  (none)' : ''
  ].join('\n');
  fs.writeFileSync(logPath, logContent, 'utf8');
  console.log(`Build log: ${logPath}`);

  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
