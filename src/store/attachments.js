// Generic attachments library — arbitrary files (audio, PDF, image, score)
// that can be referenced anywhere in the worship aid: preludes, postludes,
// choral anthems, mass settings, supplementary readings, choir notes, etc.
//
// We store two pieces of state:
//   * the binary in `uploads-attachments` (one blob per file)
//   * a metadata record per attachment in `attachments` (title, kind,
//     composer, tags, mime, size, url)
//
// Data shape per metadata entry:
//   {
//     id: '...',
//     filename: 'stored-name.mp3',
//     originalName: 'Bach - Toccata in D Minor.mp3',
//     title: 'Toccata in D Minor',
//     composer: 'J.S. Bach',
//     kind: 'prelude' | 'postlude' | 'anthem' | 'kyrie' | 'sanctus' |
//           'agnus_dei' | 'mystery_of_faith' | 'gloria' | 'psalm' |
//           'communion' | 'thanksgiving' | 'general',
//     tags: ['advent', 'organ'],
//     mime: 'audio/mpeg',
//     size: 1234567,
//     url: '/api/uploads/attachments/<filename>',
//     uploadedAt: ISO,
//     uploadedBy: 'displayName'
//   }
'use strict';

const crypto = require('crypto');
const kv = require('./kv');

const META_NS = 'attachments';
const BLOB_NS = 'uploads-attachments';

const KINDS = [
  'prelude', 'postlude', 'processional', 'kyrie', 'gloria',
  'psalm', 'gospel_acclamation', 'sanctus', 'mystery_of_faith',
  'agnus_dei', 'offertory_anthem', 'communion', 'thanksgiving',
  'choral_anthem', 'mass_setting', 'general'
];

// Kinds that are NOT congregational hymns and should NOT be served from
// the hymn library.  The UI uses this to decide whether a music input
// should autocomplete from the attachments library or the hymn library.
const NON_HYMN_KINDS = new Set([
  'prelude', 'postlude', 'kyrie', 'gloria', 'sanctus',
  'mystery_of_faith', 'agnus_dei', 'offertory_anthem',
  'choral_anthem', 'mass_setting'
]);

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

async function listAttachments(filter) {
  const all = await kv.list(META_NS);
  let entries = all.slice();
  if (filter && filter.kind) {
    entries = entries.filter(e => e.kind === filter.kind);
  }
  if (filter && filter.kinds && filter.kinds.length) {
    const set = new Set(filter.kinds);
    entries = entries.filter(e => set.has(e.kind));
  }
  if (filter && filter.q) {
    const q = String(filter.q).toLowerCase();
    entries = entries.filter(e =>
      String(e.title || '').toLowerCase().includes(q) ||
      String(e.composer || '').toLowerCase().includes(q) ||
      String(e.originalName || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => String(t).toLowerCase().includes(q))
    );
  }
  return entries.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
}

async function getAttachment(id) {
  return kv.get(META_NS, id);
}

async function saveAttachmentMeta(meta) {
  const record = { ...meta, id: meta.id || newId() };
  if (!record.uploadedAt) record.uploadedAt = new Date().toISOString();
  await kv.set(META_NS, record.id, record);
  return record;
}

async function updateAttachment(id, patch) {
  const existing = await kv.get(META_NS, id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, filename: existing.filename, url: existing.url };
  await kv.set(META_NS, id, merged);
  return merged;
}

async function deleteAttachment(id) {
  const existing = await kv.get(META_NS, id);
  if (!existing) return false;
  if (existing.filename) await kv.del(BLOB_NS, existing.filename);
  await kv.del(META_NS, id);
  return true;
}

module.exports = {
  KINDS,
  NON_HYMN_KINDS,
  META_NS,
  BLOB_NS,
  newId,
  listAttachments,
  getAttachment,
  saveAttachmentMeta,
  updateAttachment,
  deleteAttachment
};
