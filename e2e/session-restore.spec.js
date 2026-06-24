// End-to-end coverage for the editor session-snapshot/restore behavior — the
// browser-only code path the Node unit suite can't exercise (localStorage,
// multi-user state, the page-load lifecycle).
//
// These reproduce the reported bug ("it keeps restoring my last session,
// mistakes and all — even as a different user, even after logout, even after
// closing the browser") and pin the fixed behavior:
//   1. a reload never silently restores — it offers a Restore button;
//   2. Restore (explicit) brings the work back; Discard wipes it for good;
//   3. logout clears that user's snapshot;
//   4. a different user never inherits the previous user's snapshot;
//   5. the legacy global key is purged on load and never restored.
'use strict';

const { test, expect } = require('@playwright/test');

// A value that would never appear on a genuinely fresh load (the feast name
// otherwise auto-derives from the date), so "is it back?" is unambiguous.
const SENTINEL = 'ZZZ Sentinel Feast (e2e)';

// The app shell pulls Google's Sign-In script and Google Fonts. Those external
// resources stall the navigation `load` event in a sandboxed/proxied CI box,
// so block everything that isn't the app itself — the editor needs none of it,
// and it keeps the suite fast and offline-deterministic.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') route.continue();
    else route.abort();
  });
});

async function gotoApp(page, urlPath = '/') {
  await page.goto(urlPath, { waitUntil: 'domcontentloaded' });
}
async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function login(page, name) {
  await gotoApp(page);
  await expect(page.locator('#page-login')).toBeVisible();
  await page.fill('#login-username', name);
  await page.click('#page-login button:has-text("Sign In")');
  // Editor is up once the feast-name field is present and interactive.
  await expect(page.locator('#feastName')).toBeVisible();
}

async function logout(page) {
  await page.click('button:has-text("Logout")');
  await expect(page.locator('#page-login')).toBeVisible();
}

// Type a feast name and wait until the debounced snapshot has actually been
// written to this user's per-user localStorage key.
async function setFeastAndWaitForSnapshot(page, value) {
  await page.fill('#feastName', value);
  await page.waitForFunction(
    (v) => Object.keys(localStorage).some(
      (k) => k.startsWith('wa_editor_snapshot:') && (localStorage.getItem(k) || '').includes(v)),
    value,
    { timeout: 6000 }
  );
}

function snapshotKeys(page) {
  return page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('wa_editor_snapshot')));
}

test.describe('editor session snapshot', () => {
  test('a reload never auto-restores — it only offers a Restore button', async ({ page }) => {
    await login(page, 'jd');
    await setFeastAndWaitForSnapshot(page, SENTINEL);

    await reloadApp(page);
    await expect(page.locator('#feastName')).toBeVisible();

    // The bug: the sentinel came back on its own. The fix: it must NOT.
    await expect(page.locator('#feastName')).not.toHaveValue(SENTINEL);
    // Recovery is still one click away.
    await expect(page.locator('#btn-restore')).toBeVisible();

    await page.click('#btn-restore');
    await expect(page.locator('#feastName')).toHaveValue(SENTINEL);
  });

  test('Discard clears the saved session for good', async ({ page }) => {
    await login(page, 'jd');
    await setFeastAndWaitForSnapshot(page, SENTINEL);
    await reloadApp(page);
    await expect(page.locator('#btn-restore')).toBeVisible();

    await page.click('#btn-restore-dismiss');
    await expect(page.locator('#btn-restore')).toBeHidden();
    expect(await snapshotKeys(page)).toHaveLength(0);

    // Stays gone across another reload.
    await reloadApp(page);
    await expect(page.locator('#feastName')).toBeVisible();
    await expect(page.locator('#btn-restore')).toBeHidden();
  });

  test('logout clears the snapshot; the next login starts clean', async ({ page }) => {
    await login(page, 'jd');
    await setFeastAndWaitForSnapshot(page, SENTINEL);
    await logout(page);

    await login(page, 'jd');
    await expect(page.locator('#btn-restore')).toBeHidden();
    await expect(page.locator('#feastName')).not.toHaveValue(SENTINEL);
  });

  test('a different user never inherits the previous user’s session', async ({ page }) => {
    await login(page, 'jd');
    await setFeastAndWaitForSnapshot(page, SENTINEL);
    // jd's own recovery exists, keyed to jd.
    await reloadApp(page);
    await expect(page.locator('#btn-restore')).toBeVisible();
    expect(await snapshotKeys(page)).toContain('wa_editor_snapshot:jd');

    await logout(page);
    await login(page, 'morris');

    // Morris sees no Restore offer and no sentinel — and there is no snapshot
    // keyed to morris.
    await expect(page.locator('#btn-restore')).toBeHidden();
    await expect(page.locator('#feastName')).not.toHaveValue(SENTINEL);
    expect(await snapshotKeys(page)).not.toContain('wa_editor_snapshot:morris');
  });

  test('a legacy global snapshot key is purged on load and never restored', async ({ page }) => {
    await login(page, 'jd');
    // Plant the pre-fix global key (the shape that leaked across users).
    await page.evaluate((v) => {
      localStorage.setItem('wa_editor_snapshot', JSON.stringify({ savedAt: Date.now(), data: { feastName: v } }));
    }, SENTINEL);

    await reloadApp(page);
    await expect(page.locator('#feastName')).toBeVisible();

    // The global key is gone and was never used to populate the form.
    const hasGlobal = await page.evaluate(() => localStorage.getItem('wa_editor_snapshot') !== null);
    expect(hasGlobal).toBe(false);
    await expect(page.locator('#feastName')).not.toHaveValue(SENTINEL);
  });
});
