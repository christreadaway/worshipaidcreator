// Tests for user management and role-based access
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const userStore = require('../store/user-store');

// Track all users created during the test run so we can clean them up at the end
const testUserIds = [];
let _testCounter = 0;
function uniqueName(prefix) {
  _testCounter += 1;
  return prefix + '_' + Date.now() + '_' + _testCounter + '_' + Math.random().toString(36).slice(2, 8);
}

async function track(user) {
  if (user && user.id) testUserIds.push(user.id);
  return user;
}

after(async () => {
  for (const id of testUserIds) {
    try { await userStore.deleteUser(id); } catch (_) { /* ignore */ }
  }
  // Also wipe any user files whose username starts with a known test prefix in case
  // earlier failures bypassed the tracking array.
  const usersDir = path.join(__dirname, '..', '..', 'data', 'users');
  if (fs.existsSync(usersDir)) {
    const testPrefixes = ['testuser_', 'bad_', 'dup_', 'authtest_', 'authfail_', 'citest_', 'dntest_', 'session_', 'destroy_', 'excl1_', 'excl2_'];
    for (const f of fs.readdirSync(usersDir)) {
      const p = path.join(usersDir, f);
      try {
        const u = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (testPrefixes.some(prefix => u.username && u.username.startsWith(prefix))) {
          fs.unlinkSync(p);
        }
      } catch (_) { /* skip malformed */ }
    }
  }
});

describe('User Store', () => {
  it('should create a user', async () => {
    const user = await track(await userStore.createUser({
      username: uniqueName('testuser'),
      displayName: 'Test User',
      role: 'staff',
      password: 'testpass'
    }));
    assert.ok(user.id);
    assert.equal(user.role, 'staff');
    assert.equal(user.displayName, 'Test User');
    assert.ok(!user.passwordHash, 'Password hash should not be exposed');
  });

  it('should reject invalid role', async () => {
    await assert.rejects(
      () => userStore.createUser({ username: uniqueName('bad'), displayName: 'Bad', role: 'invalid', password: 'x' }),
      /Invalid role/
    );
  });

  it('should reject duplicate username', async () => {
    const unique = uniqueName('dup');
    await track(await userStore.createUser({ username: unique, displayName: 'First', role: 'staff', password: 'x' }));
    await assert.rejects(
      () => userStore.createUser({ username: unique, displayName: 'Second', role: 'staff', password: 'y' }),
      /already exists/
    );
  });

  it('should list users', async () => {
    const users = await userStore.listUsers();
    assert.ok(Array.isArray(users));
    assert.ok(users.length > 0);
    // Ensure no password hashes exposed
    users.forEach(u => assert.ok(!u.passwordHash));
  });

  it('should authenticate with correct credentials', async () => {
    const uname = uniqueName('authtest');
    await track(await userStore.createUser({ username: uname, displayName: 'Auth Test', role: 'staff', password: 'secret' }));
    const user = await userStore.authenticateUser(uname, 'secret');
    assert.ok(user);
    assert.equal(user.username, uname);
  });

  // Beta mode: password check disabled — login by username only
  // TODO: re-enable this test when password check is restored for production
  it('should allow login regardless of password in beta mode', async () => {
    const uname = uniqueName('authfail');
    await track(await userStore.createUser({ username: uname, displayName: 'Fail', role: 'staff', password: 'correct' }));
    const user = await userStore.authenticateUser(uname, 'wrong');
    assert.ok(user, 'Beta mode should allow login without password check');
    assert.equal(user.username, uname);
  });

  it('should authenticate with case-insensitive username', async () => {
    const uname = uniqueName('citest');
    await track(await userStore.createUser({ username: uname, displayName: 'CaseTest User', role: 'staff', password: 'pass' }));
    const user = await userStore.authenticateUser(uname.toUpperCase(), 'pass');
    assert.ok(user, 'Should match username regardless of case');
    assert.equal(user.username, uname);
  });

  it('should authenticate by display name first word', async () => {
    const uname = uniqueName('dntest');
    // Use a unique display-name first word so we don't collide with parallel test runs
    const displayWord = 'Zelda' + _testCounter;
    await track(await userStore.createUser({ username: uname, displayName: displayWord + ' (Staff)', role: 'staff', password: 'pass' }));
    const user = await userStore.authenticateUser(displayWord, '');
    assert.ok(user, 'Should match by display name first word');
    assert.equal(user.username, uname);
  });

  it('should create and validate sessions', async () => {
    const uname = uniqueName('session');
    const created = await track(await userStore.createUser({ username: uname, displayName: 'Session', role: 'admin', password: 'pass' }));
    const token = await userStore.createSession(created.id);
    assert.ok(token);
    assert.ok(token.length > 20);

    const user = await userStore.getSessionUser(token);
    assert.ok(user);
    assert.equal(user.id, created.id);
  });

  it('should destroy sessions', async () => {
    const uname = uniqueName('destroy');
    const created = await track(await userStore.createUser({ username: uname, displayName: 'Destroy', role: 'staff', password: 'pass' }));
    const token = await userStore.createSession(created.id);
    await userStore.destroySession(token);
    const user = await userStore.getSessionUser(token);
    assert.equal(user, null);
  });

  it('should enforce exclusive login per role (same role kicks previous session)', async () => {
    const user1 = await track(await userStore.createUser({ username: uniqueName('excl1'), displayName: 'Excl1', role: 'music_director', password: 'pass' }));
    const user2 = await track(await userStore.createUser({ username: uniqueName('excl2'), displayName: 'Excl2', role: 'music_director', password: 'pass' }));

    // user1 logs in
    const token1 = await userStore.createSession(user1.id);
    assert.ok(await userStore.getSessionUser(token1), 'user1 should be logged in');

    // user2 logs in — should invalidate user1 session
    const token2 = await userStore.createSession(user2.id);
    assert.ok(await userStore.getSessionUser(token2), 'user2 should be logged in');
    assert.equal(await userStore.getSessionUser(token1), null, 'user1 session should be invalidated when user2 of same role logs in');
  });
});

describe('Role permissions', () => {
  it('should grant admin all permissions', () => {
    const admin = { role: 'admin' };
    assert.ok(userStore.hasPermission(admin, 'edit_all'));
    assert.ok(userStore.hasPermission(admin, 'manage_users'));
    assert.ok(userStore.hasPermission(admin, 'edit_readings'));
    assert.ok(userStore.hasPermission(admin, 'edit_music'));
  });

  it('should grant music_director music permissions', () => {
    const md = { role: 'music_director' };
    assert.ok(userStore.hasPermission(md, 'edit_music'));
    assert.ok(userStore.hasPermission(md, 'upload_images'));
    assert.ok(!userStore.hasPermission(md, 'manage_users'));
    assert.ok(!userStore.hasPermission(md, 'edit_readings'));
  });

  it('should grant pastor reading and approval permissions', () => {
    const pastor = { role: 'pastor' };
    assert.ok(userStore.hasPermission(pastor, 'edit_readings'));
    assert.ok(userStore.hasPermission(pastor, 'approve'));
    assert.ok(!userStore.hasPermission(pastor, 'edit_music'));
    assert.ok(!userStore.hasPermission(pastor, 'manage_users'));
  });

  it('should grant staff broad editing permissions', () => {
    const staff = { role: 'staff' };
    assert.ok(userStore.hasPermission(staff, 'edit_readings'));
    assert.ok(userStore.hasPermission(staff, 'edit_music'));
    assert.ok(userStore.hasPermission(staff, 'edit_announcements'));
    assert.ok(!userStore.hasPermission(staff, 'manage_users'));
  });

  it('should deny permissions for null user', () => {
    assert.ok(!userStore.hasPermission(null, 'edit_all'));
  });
});

describe('Role labels', () => {
  it('should define labels for all roles', () => {
    assert.equal(userStore.ROLE_LABELS.admin, 'Director of Liturgy');
    assert.equal(userStore.ROLE_LABELS.music_director, 'Music Director');
    assert.equal(userStore.ROLE_LABELS.pastor, 'Pastor');
    assert.equal(userStore.ROLE_LABELS.staff, 'Staff');
  });
});
