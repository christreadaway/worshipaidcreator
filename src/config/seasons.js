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
    creedType: 'apostles',      // Worksheet: Apostles' during Easter Season
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

  // Only apply defaults for fields the user hasn't explicitly set
  if (merged.gloria === undefined) merged.gloria = defaults.gloria;
  if (!merged.creedType) merged.creedType = defaults.creedType;
  if (!merged.entranceType) merged.entranceType = defaults.entranceType;
  if (!merged.seasonalSettings) merged.seasonalSettings = {};
  if (!merged.seasonalSettings.holyHolySetting) merged.seasonalSettings.holyHolySetting = defaults.holyHolySetting;
  if (!merged.seasonalSettings.mysteryOfFaithSetting) merged.seasonalSettings.mysteryOfFaithSetting = defaults.mysteryOfFaithSetting;
  if (!merged.seasonalSettings.lambOfGodSetting) merged.seasonalSettings.lambOfGodSetting = defaults.lambOfGodSetting;
  if (!merged.seasonalSettings.penitentialAct) merged.seasonalSettings.penitentialAct = defaults.penitentialAct;
  if (merged.seasonalSettings.includePostlude === undefined) merged.seasonalSettings.includePostlude = defaults.includePostlude;
  if (merged.seasonalSettings.adventWreath === undefined) merged.seasonalSettings.adventWreath = defaults.adventWreath;

  return merged;
}

module.exports = { SEASONS, SEASON_RULES, LENTEN_ACCLAMATION_OPTIONS, getSeasonDefaults, applySeasonDefaults };
