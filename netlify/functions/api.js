'use strict';

const serverless = require('serverless-http');
const app = require('../../src/server');

// Wrap Express app as a Netlify Function
module.exports.handler = serverless(app);
