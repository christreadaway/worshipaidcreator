// Input validation using AJV + overflow detection
'use strict';

const Ajv = require('ajv');
const { inputSchema } = require('./schema');

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const validate = ajv.compile(inputSchema);

function validateInput(data) {
  const valid = validate(data);
  if (!valid) {
    const errors = validate.errors.map(e => {
      const path = e.instancePath || '(root)';
      return `  ${path}: ${e.message}`;
    });
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

// Per-page overflow detection — PRD Section 5.2
// Estimates line counts per page block and flags overflows
const PAGE_CAPACITIES = {
  3: { maxLines: 85, name: 'Liturgy of the Word' },
  4: { maxLines: 75, name: 'Gospel & Creed' }
};

function estimateLines(text, charsPerLine = 65) {
  if (!text) return 0;
  return text.split('\n').reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / charsPerLine));
  }, 0);
}

function detectOverflows(data) {
  const warnings = [];
  const r = data.readings || {};

  // Page 3: First Reading + Psalm + Second Reading + Gospel Acclamation
  const page3Blocks = [
    { name: 'First Reading', lines: estimateLines(r.firstReadingText) },
    { name: 'Responsorial Psalm', lines: estimateLines(r.psalmVerses) + estimateLines(r.psalmRefrain) },
    { name: 'Second Reading', lines: r.noSecondReading ? 0 : estimateLines(r.secondReadingText) },
    { name: 'Gospel Acclamation', lines: 3 }
  ];
  const page3Total = page3Blocks.reduce((s, b) => s + b.lines, 0);
  if (page3Total > PAGE_CAPACITIES[3].maxLines) {
    const over = page3Total - PAGE_CAPACITIES[3].maxLines;
    const biggest = page3Blocks.reduce((a, b) => b.lines > a.lines ? b : a);
    warnings.push({
      page: 3,
      severity: 'error',
      message: `Page 3 overflow: ${biggest.name} is the largest block (${biggest.lines} lines). Total is approximately ${over} lines over capacity. Consider shortening or using a shorter form of the reading.`
    });
  }

  // Page 4: Gospel + Creed
  const creedLines = (data.seasonalSettings?.creedType === 'apostles') ? 18 : 32;
  const page4Blocks = [
    { name: 'Gospel', lines: estimateLines(r.gospelText) },
    { name: 'Creed', lines: creedLines }
  ];
  const page4Total = page4Blocks.reduce((s, b) => s + b.lines, 0);
  if (page4Total > PAGE_CAPACITIES[4].maxLines) {
    const over = page4Total - PAGE_CAPACITIES[4].maxLines;
    const biggest = page4Blocks.reduce((a, b) => b.lines > a.lines ? b : a);
    warnings.push({
      page: 4,
      severity: 'error',
      message: `Page 4 overflow: ${biggest.name} is approximately ${over} lines over capacity. Consider shortening the Gospel text or switching to Apostles' Creed.`
    });
  }

  return warnings;
}

module.exports = { validateInput, detectOverflows, estimateLines };
