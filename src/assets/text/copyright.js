// Default copyright block
'use strict';

const { DEFAULT_PARISH_SETTINGS } = require('../../config/defaults');

// Single source of truth for the default full-copyright wording is
// DEFAULT_PARISH_SETTINGS.copyrightFull (config/defaults.js). This helper
// substitutes the parish's OneLicense number into that default so both
// renderers (HTML preview and PDF) print identical text.
function getDefaultCopyrightFull(onelicenseNumber) {
  const num = onelicenseNumber || DEFAULT_PARISH_SETTINGS.onelicenseNumber;
  return DEFAULT_PARISH_SETTINGS.copyrightFull.replace(/#A-702171/g, `#${num}`);
}

function getDefaultCopyrightShort(onelicenseNumber) {
  const num = onelicenseNumber || DEFAULT_PARISH_SETTINGS.onelicenseNumber;
  return DEFAULT_PARISH_SETTINGS.copyrightShort.replace(/#A-702171/g, `#${num}`);
}

// Legacy export, kept for back-compat.
const DEFAULT_COPYRIGHT = `Excerpts from the Lectionary for Mass for Use in the Dioceses of the United States of America, second typical edition © 2001, 1998, 1997, 1986, 1970 Confraternity of Christian Doctrine, Inc., Washington, DC. Used with permission. All rights reserved.

Music reprinted under OneLicense #A-702171. All rights reserved.

© ${new Date().getFullYear()} All rights reserved.`;

module.exports = { DEFAULT_COPYRIGHT, getDefaultCopyrightFull, getDefaultCopyrightShort };
