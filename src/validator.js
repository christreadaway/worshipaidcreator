// Input validation using AJV
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

module.exports = { validateInput };
