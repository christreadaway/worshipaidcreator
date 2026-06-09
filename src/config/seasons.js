// Liturgical Season Auto-Rules Engine
// Updated from St. Theresa worksheet (Feb 2026)
// Key changes from worksheet:
//   - Apostles' Creed during Advent, Lent, AND Easter (not just Lent)
//   - Postlude omitted during Lent
//   - Advent Wreath Lighting added during Advent
//   - Two Lenten Gospel Acclamation options available
'use strict';

const SEASONS = ['ordinary', 'advent', 'christmas', 'lent', 'easter'];

const SEASON_RULES = {
  ordinary: {
    gloria: true,
    creedType: 'nicene',
    entranceType: 'processional',
    holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'optional',
    gospelAcclamationType: 'alleluia',
    includePostlude: true,
    adventWreath: false
  },
  advent: {
    gloria: false,
    creedType: 'apostles',      // Worksheet: Apostles' during Advent
    entranceType: 'antiphon',
    holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'no',
    gospelAcclamationType: 'alleluia',
    includePostlude: true,
    adventWreath: true           // Worksheet: Lighting of Advent Wreath added
  },
  christmas: {
    gloria: true,
    creedType: 'nicene',
    entranceType: 'processional',
    holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'no',
    gospelAcclamationType: 'alleluia',
    includePostlude: true,
    adventWreath: false
  },
  lent: {
    gloria: false,
    creedType: 'apostles',
    entranceType: 'antiphon',
    holyHolySetting: 'Vatican Edition XVIII',
    mysteryOfFaithSetting: 'Vatican Edition XVIII',
    lambOfGodSetting: 'Agnus Dei, Vatican Edition XVIII',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'yes',
    childrenLiturgyMassTime: 'Sun 9:00 AM',
    gospelAcclamationType: 'lenten',
    includePostlude: false,      // Worksheet: No postlude during Lent
    adventWreath: false
  },
  easter: {
    gloria: true,
    creedType: 'apostles',      // Worksheet: Apostles' during Easter Season.
                                // Easter Sunday/Vigil itself uses Renewal of
                                // Baptismal Vows; the user can pick that
                                // override from the Creed dropdown.
    entranceType: 'processional',
    holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'optional',
    gospelAcclamationType: 'alleluia',
    includePostlude: true,
    adventWreath: false
  }
};

// Lenten Gospel Acclamation options (worksheet: both used, chosen by music staff)
const LENTEN_ACCLAMATION_OPTIONS = [
  'Praise to you, Lord Jesus Christ, King of endless glory!',
  'Glory and praise to you, Lord Jesus Christ!'
];

function getSeasonDefaults(season) {
  return SEASON_RULES[season] || SEASON_RULES.ordinary;
}

function applySeasonDefaults(data) {
  if (!data.liturgicalSeason) return data;
  const defaults = getSeasonDefaults(data.liturgicalSeason);
  const merged = { ...data };

  // Clone seasonalSettings so we never mutate the caller's object.
  merged.seasonalSettings = { ...(data.seasonalSettings || {}) };
  const ss = merged.seasonalSettings;

  // Only apply defaults for fields the user hasn't explicitly set.
  // Both renderers read these from seasonalSettings, so the defaults must
  // land there (not on the top level of the merged object).
  if (ss.gloria === undefined) ss.gloria = defaults.gloria;
  if (!ss.creedType) ss.creedType = defaults.creedType;
  if (!ss.entranceType) ss.entranceType = defaults.entranceType;
  if (!ss.holyHolySetting) ss.holyHolySetting = defaults.holyHolySetting;
  // NB: `holyHolyLanguage` is intentionally NOT defaulted here — the renderer
  // resolves the fallback chain (per-aid override > parish default > English)
  // so that a parish-wide Latin preference can take effect when the aid
  // didn't pick a language explicitly.
  if (!ss.mysteryOfFaithSetting) ss.mysteryOfFaithSetting = defaults.mysteryOfFaithSetting;
  if (!ss.lambOfGodSetting) ss.lambOfGodSetting = defaults.lambOfGodSetting;
  if (!ss.penitentialAct) ss.penitentialAct = defaults.penitentialAct;
  if (ss.includePostlude === undefined) ss.includePostlude = defaults.includePostlude;
  if (ss.adventWreath === undefined) ss.adventWreath = defaults.adventWreath;

  return merged;
}

module.exports = { SEASONS, SEASON_RULES, LENTEN_ACCLAMATION_OPTIONS, getSeasonDefaults, applySeasonDefaults };
