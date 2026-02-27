// Worship Aid Generator — Main entry point
'use strict';

const { validateInput } = require('./validator');
const { generatePdf } = require('./pdf-generator');
const { renderBookletHtml } = require('./template-renderer');

module.exports = { validateInput, generatePdf, renderBookletHtml };
