'use strict';

const serverless = require('serverless-http');
const app = require('../../src/server');
const userStore = require('../../src/store/user-store');

const handler = serverless(app);
let _seededInHandler = false;

// Seed users INSIDE the handler context — Netlify Blobs requires the
// Lambda request context which isn't available at module load time.
module.exports.handler = async (event, context) => {
  console.log('[NETLIFY] Request:', event.httpMethod, event.path);
  if (!_seededInHandler) {
    console.log('[NETLIFY] Cold start — seeding users in handler context...');
    try {
      await userStore.seedDefaultUsers();
      _seededInHandler = true;
      const users = await userStore.listUsers();
      console.log('[NETLIFY] Seeded OK — %d users: %s', users.length, users.map(u => u.username).join(', '));
    } catch (e) {
      console.error('[NETLIFY] Seed FAILED:', e.message, e.stack);
    }
  }
  return handler(event, context);
};
