// Playwright end-to-end config.
//
// These tests exist to cover the browser-only behavior the Node unit suite
// can't reach — the session-snapshot/restore logic (localStorage, multi-user
// state, the page-load lifecycle). That gap is exactly how the "it keeps
// restoring my last session, even as a different user" bug shipped despite a
// green unit suite. Run with `npm run test:e2e`.
'use strict';

const fs = require('fs');
const path = require('path');
const { defineConfig } = require('@playwright/test');

// Resolve a real Chromium binary. In this environment Playwright's browsers
// live under PLAYWRIGHT_BROWSERS_PATH (a build whose number may not match the
// installed @playwright/test), so we point at the binary directly. On a normal
// dev machine `npx playwright install chromium` populates Playwright's own
// cache and this returns undefined → Playwright uses its bundled browser.
function resolveChromium() {
  if (process.env.PW_CHROMIUM && fs.existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dir = fs.readdirSync(base)
      .filter(d => /^chromium-\d+$/.test(d))
      .map(d => path.join(base, d, 'chrome-linux', 'chrome'))
      .find(p => fs.existsSync(p));
    if (dir) return dir;
  } catch (e) { /* fall through to Playwright's own resolution */ }
  return undefined;
}

const executablePath = resolveChromium();
const PORT = process.env.E2E_PORT || '3100';

module.exports = defineConfig({
  testDir: './e2e',
  // The app keeps server-side state (sessions, drafts) and the tests share
  // one logged-in browser context, so run serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox'] // required in the sandboxed CI container
    }
  },
  projects: [{ name: 'chromium' }],
  // Boot the real app for the tests. Beta-mode login means any username works
  // with no password, which is all these snapshot tests need.
  webServer: {
    command: 'node src/server.js',
    env: { PORT, NODE_ENV: 'test' },
    port: Number(PORT),
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
