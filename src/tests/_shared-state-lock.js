// Cross-process lock that serializes the test files which share the
// on-disk data/ directory (server.test.js, feedback-fixes.test.js,
// attachments-and-calendar.test.js, user-store.test.js).
//
// `node --test` runs each test file in its own process, in parallel. These
// four suites all hit the same data/ stores: logins revoke other same-role
// session tokens (exclusive-login rule), and the parish settings file is
// toggled by approval-gate tests while other suites run exports — so running
// them concurrently produces spurious 401/403s and settings races. Taking an
// exclusive lock for the duration of each suite keeps every file's
// assertions intact while making the combined run deterministic.
'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_PATH = path.join(__dirname, '..', '..', 'data', '.test-suite-lock');
// A holder that has not refreshed mtime for this long is considered crashed.
const STALE_MS = 60 * 1000;

async function acquireSharedStateLock(timeoutMs = 5 * 60 * 1000) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      // Keep the lock "fresh" so a crash (which skips release) is detectable
      // via a stale mtime by the next waiter.
      const heartbeat = setInterval(() => {
        try { const now = new Date(); fs.utimesSync(LOCK_PATH, now, now); } catch (_) { /* released */ }
      }, STALE_MS / 4);
      heartbeat.unref();
      return function release() {
        clearInterval(heartbeat);
        try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Reap locks left behind by a crashed process.
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > STALE_MS) fs.unlinkSync(LOCK_PATH);
      } catch (_) { /* raced with the releaser */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for the shared-state test lock: ' + LOCK_PATH);
      }
      await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 150)));
    }
  }
}

module.exports = { acquireSharedStateLock };
