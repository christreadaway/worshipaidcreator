// Helpers shared by BOTH renderers (the PDF generator and the HTML preview).
// The preview exists to proof the export, so anything that can influence
// visible output — QR availability, small-caps word treatment, parish
// short-name derivation, default cover copy — must resolve identically in
// both. Keeping these in one module makes that true by construction.
'use strict';

const { DEFAULT_PARISH_SETTINGS } = require('./config/defaults');

// Lazy loader for the optional `qrcode` dependency (classic design's
// Give/Join/Bulletin codes). When the dep is missing the QR row is simply
// omitted — in BOTH renderers, because they share this loader.
let _qrcode = null;
function getQRCode() {
  if (_qrcode === null) {
    try { _qrcode = require('qrcode'); }
    catch (e) { _qrcode = false; }
  }
  return _qrcode || null;
}

// Connective words rendered italic-lowercase inside classic small-caps
// titles ("THE LITURGY of the WORD"). The leading word of a title is always
// a full small-cap regardless.
const SMALLCAPS_CONNECTORS = new Set(['of', 'the', 'in', 'and', 'to', 'for', 'a']);

// "St. Theresa Catholic Church" -> "St. Theresa" for the classic cover's
// "If you are new to <parish>…" greeting.
function shortParishName(name) {
  if (!name) return null;
  return String(name).replace(/\b(Catholic|Church|Parish|Roman)\b/gi, '').replace(/\s+/g, ' ').trim() || null;
}

// The classic cover greeting line, resolved the same way everywhere.
function classicGreeting(parishSettings) {
  const ps = parishSettings || {};
  const short = ps.parishShortName || shortParishName(ps.parishName) || 'our parish';
  return ps.newcomerHeading || `If you are new to ${short}…`;
}

// Classic cover info blocks (label + body), falling back to the app's ONE
// canonical set of parish defaults so the preview and the export can never
// print different cover copy.
function classicCoverBlocks(parishSettings) {
  const ps = parishSettings || {};
  const D = DEFAULT_PARISH_SETTINGS;
  return [
    ['CONNECT', ps.connectBlurb || D.connectBlurb],
    ['NURSERY', ps.nurseryBlurb || D.nurseryBlurb],
    ['RESTROOMS', ps.restroomsBlurb || D.restroomsBlurb],
    ['REQUEST PRAYER', ps.prayerBlurb || D.prayerBlurb]
  ];
}

// The Children's Liturgy Mass times, with the legacy single-time field and
// the historical default — one resolution for every renderer.
function resolveChildrenLiturgyTimes(data) {
  const d = data || {};
  if (Array.isArray(d.childrenLiturgyMassTimes) && d.childrenLiturgyMassTimes.length) {
    return d.childrenLiturgyMassTimes;
  }
  return d.childrenLiturgyMassTime ? [d.childrenLiturgyMassTime] : ['Sun 9:00 AM'];
}

module.exports = {
  getQRCode,
  SMALLCAPS_CONNECTORS,
  shortParishName,
  classicGreeting,
  classicCoverBlocks,
  resolveChildrenLiturgyTimes
};
