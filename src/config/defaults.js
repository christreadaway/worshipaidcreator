// Default parish settings — PRD Section 6.2
'use strict';

const DEFAULT_PARISH_SETTINGS = {
  parishName: '[Parish Name]',
  parishAddress: '',
  parishPhone: '',
  parishUrl: '',
  parishPrayerUrl: '',

  // Mass schedule — printed on cover.  Each entry is "label : time", one per
  // line.  e.g. "Sat Vigil : 5:00 PM" or just "Sun : 9:00 AM".
  massTimes: 'Sat Vigil — 5:00 PM\nSunday — 9:00 AM\nSunday — 11:00 AM',

  // Clergy
  pastor: '',
  pastorTitle: 'Pastor',
  associates: '',          // free text: one per line "Name — Title"
  deacons: '',
  musicDirector: '',

  // Per-section text the user wants reused across worship aids.
  nurseryBlurb: 'A nursery is available for children ages 0–3 during the 9:00 AM and 11:00 AM Masses.',
  connectBlurb: 'New to the parish? We would love to meet you! Visit the Welcome Desk in the narthex after Mass.',
  restroomsBlurb: 'Restrooms are located in the narthex and in the lower level of the parish hall.',
  prayerBlurb: 'For prayer requests, please visit our prayer ministry page or contact the parish office.',
  welcomeMessage: '',         // optional standing welcome printed inside booklet
  closingMessage: '',         // optional standing closing message
  coverTagline: '',

  // Branding
  logoPath: '',

  // Licensing
  onelicenseNumber: 'A-702171',
  copyrightShort: 'Music reprinted under OneLicense #A-702171. All rights reserved.',
  copyrightFull: `Excerpts from the Lectionary for Mass for Use in the Dioceses of the United States of America, second typical edition © 2001, 1998, 1997, 1986, 1970 Confraternity of Christian Doctrine, Inc., Washington, DC. Used with permission. All rights reserved.

Excerpts from the English translation of The Roman Missal © 2010, International Commission on English in the Liturgy Corporation. All rights reserved.

Music reprinted under OneLicense #A-702171. All rights reserved.`,

  // Layout / workflow
  minFontSizePt: 9,
  bodyFont: 'EB Garamond',
  headerFont: 'Cinzel',
  requirePastorApproval: false,

  // Default Sanctus (Holy, Holy, Holy) language: 'english' or 'latin'
  defaultSanctusLanguage: 'english'
};

module.exports = { DEFAULT_PARISH_SETTINGS };
