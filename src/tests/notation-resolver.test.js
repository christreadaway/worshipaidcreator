// Pure-module tests for src/notation-resolver.js: slot URLs that point at
// the notation upload store (/uploads/notation/...) and at library
// attachments (/uploads/attachments/...) both resolve to Buffers locally;
// missing files and path-traversal attempts land in missing[] without
// throwing.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { acquireSharedStateLock } = require('./_shared-state-lock');
const {
  resolveNotationImages,
  filenameFromUrl,
  NOTATION_DIR,
  ATTACHMENTS_DIR
} = require('../notation-resolver');

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const unique = `test-resolver-${process.pid}-${Date.now()}`;
const notationFile = `${unique}-notation.png`;
const attachmentFile = `${unique}-attachment.png`;
const notationPath = path.join(NOTATION_DIR, notationFile);
const attachmentPath = path.join(ATTACHMENTS_DIR, attachmentFile);

let release;

describe('notation-resolver', () => {
  before(async () => {
    release = await acquireSharedStateLock();
    fs.mkdirSync(NOTATION_DIR, { recursive: true });
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    fs.writeFileSync(notationPath, TINY_PNG);
    fs.writeFileSync(attachmentPath, TINY_PNG);
  });

  after(() => {
    try { fs.unlinkSync(notationPath); } catch (_) { /* already gone */ }
    try { fs.unlinkSync(attachmentPath); } catch (_) { /* already gone */ }
    if (release) release();
  });

  it('resolves notation and attachment URLs to Buffers', async () => {
    const { images, missing } = await resolveNotationImages({
      notationImages: {
        openingHymn: `/uploads/notation/${notationFile}`,
        psalm: `/uploads/attachments/${attachmentFile}`
      }
    });
    assert.ok(Buffer.isBuffer(images.openingHymn), 'notation slot resolves to a Buffer');
    assert.ok(Buffer.isBuffer(images.psalm), 'attachment slot resolves to a Buffer');
    assert.deepEqual(images.openingHymn, TINY_PNG);
    assert.deepEqual(images.psalm, TINY_PNG);
    assert.deepEqual(missing, []);
  });

  it('reports a missing attachment file in missing[]', async () => {
    const { images, missing } = await resolveNotationImages({
      notationImages: {
        psalm: `/api/uploads/attachments/${unique}-no-such-file.png`
      }
    });
    assert.equal(images.psalm, undefined);
    assert.deepEqual(missing, ['psalm']);
  });

  it('rejects path-traversal URLs into missing[] without throwing', async () => {
    const { images, missing } = await resolveNotationImages({
      notationImages: {
        sneakyEncoded: '/uploads/attachments/..%2f..%2fetc',
        sneakyRelative: `../../${unique}-x.png`
      }
    });
    assert.deepEqual(images, {});
    assert.deepEqual(missing.sort(), ['sneakyEncoded', 'sneakyRelative']);
  });

  it('keeps filenameFromUrl behavior: safe basenames pass, unsafe are null', () => {
    assert.equal(filenameFromUrl(`/uploads/notation/${notationFile}?v=2`), notationFile);
    assert.equal(filenameFromUrl('/uploads/attachments/..%2f..%2fetc'), null);
    assert.equal(filenameFromUrl(''), null);
  });
});
