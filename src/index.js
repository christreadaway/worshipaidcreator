// Worship Aid Generator — Main entry point
'use strict';

const { validateInput, detectOverflows } = require('./validator');
const { generatePdf, buildFilename } = require('./pdf-generator');
const { renderBookletHtml } = require('./template-renderer');
const { getSeasonDefaults, applySeasonDefaults } = require('./config/seasons');
const store = require('./store/file-store');

module.exports = {
  validateInput,
  detectOverflows,
  generatePdf,
  buildFilename,
  renderBookletHtml,
  getSeasonDefaults,
  applySeasonDefaults,
  store
};
