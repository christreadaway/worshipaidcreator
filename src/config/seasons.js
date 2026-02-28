// Liturgical Season Auto-Rules Engine
// PRD Section 5.1 — When user selects a season, these defaults apply automatically
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
    gospelAcclamationType: 'alleluia'
  },
  advent: {
    gloria: false,
    creedType: 'nicene',
    entranceType: 'antiphon',
    holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'no',
    gospelAcclamationType: 'alleluia'
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
    gospelAcclamationType: 'alleluia'
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
    gospelAcclamationType: 'lenten'
  },
  easter: {
    gloria: true,
    creedType: 'nicene',
    entranceType: 'processional',
    holyHolySetting: 'Mass of St. Theresa',
    mysteryOfFaithSetting: 'Mass of St. Theresa',
    lambOfGodSetting: 'Mass of St. Theresa',
    penitentialAct: 'confiteor',
    childrenLiturgyDefault: 'optional',
    gospelAcclamationType: 'alleluia'
  }
};

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

  return merged;
}

module.exports = { SEASONS, SEASON_RULES, getSeasonDefaults, applySeasonDefaults };
