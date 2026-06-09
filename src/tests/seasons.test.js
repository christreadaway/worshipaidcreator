// Tests for season auto-rules engine and music formatter
// Updated: Advent/Easter creed, postlude, advent wreath per worksheet
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getSeasonDefaults, applySeasonDefaults, SEASONS, LENTEN_ACCLAMATION_OPTIONS } = require('../config/seasons');
const { formatMusicSlot, renderMusicLineText, formatTimeLabel } = require('../music-formatter');

describe('Season auto-rules', () => {
  it('should define all 5 seasons', () => {
    assert.deepEqual(SEASONS, ['ordinary', 'advent', 'christmas', 'lent', 'easter']);
  });

  it('should return correct Lent defaults', () => {
    const d = getSeasonDefaults('lent');
    assert.equal(d.gloria, false);
    assert.equal(d.creedType, 'apostles');
    assert.equal(d.entranceType, 'antiphon');
    assert.ok(d.holyHolySetting.includes('Vatican'));
    assert.equal(d.gospelAcclamationType, 'lenten');
    assert.equal(d.includePostlude, false, 'Lent should suppress postlude');
    assert.equal(d.adventWreath, false);
  });

  it('should return correct Ordinary Time defaults', () => {
    const d = getSeasonDefaults('ordinary');
    assert.equal(d.gloria, true);
    assert.equal(d.creedType, 'nicene');
    assert.equal(d.entranceType, 'processional');
    assert.equal(d.includePostlude, true);
    assert.equal(d.adventWreath, false);
  });

  it('should return correct Advent defaults with Apostles Creed and wreath', () => {
    const d = getSeasonDefaults('advent');
    assert.equal(d.gloria, false);
    assert.equal(d.entranceType, 'antiphon');
    assert.equal(d.childrenLiturgyDefault, 'no');
    assert.equal(d.creedType, 'apostles', 'Worksheet: Apostles Creed during Advent');
    assert.equal(d.adventWreath, true, 'Worksheet: Advent Wreath Lighting during Advent');
    assert.equal(d.includePostlude, true);
  });

  it('should return correct Christmas defaults', () => {
    const d = getSeasonDefaults('christmas');
    assert.equal(d.gloria, true);
    assert.equal(d.creedType, 'nicene');
    assert.equal(d.adventWreath, false);
  });

  it('should return correct Easter defaults with Apostles Creed', () => {
    const d = getSeasonDefaults('easter');
    assert.equal(d.gloria, true);
    assert.equal(d.entranceType, 'processional');
    assert.equal(d.creedType, 'apostles', 'Worksheet: Apostles Creed during Easter');
    assert.equal(d.includePostlude, true);
  });

  it('should apply season defaults to seasonalSettings (where renderers read them)', () => {
    const data = { liturgicalSeason: 'lent' };
    const result = applySeasonDefaults(data);
    assert.equal(result.seasonalSettings.gloria, false);
    assert.equal(result.seasonalSettings.creedType, 'apostles');
    assert.equal(result.seasonalSettings.entranceType, 'antiphon');
  });

  it('should default creedType=apostles into seasonalSettings for Advent/Lent/Easter', () => {
    for (const season of ['advent', 'lent', 'easter']) {
      const result = applySeasonDefaults({ liturgicalSeason: season });
      assert.equal(result.seasonalSettings.creedType, 'apostles',
        `${season} should default to Apostles' Creed per worksheet`);
    }
    assert.equal(applySeasonDefaults({ liturgicalSeason: 'ordinary' }).seasonalSettings.creedType, 'nicene');
    assert.equal(applySeasonDefaults({ liturgicalSeason: 'christmas' }).seasonalSettings.creedType, 'nicene');
  });

  it('should not override user-set values', () => {
    const data = { liturgicalSeason: 'lent', seasonalSettings: { gloria: true, creedType: 'nicene' } };
    const result = applySeasonDefaults(data);
    assert.equal(result.seasonalSettings.gloria, true); // user override preserved
    assert.equal(result.seasonalSettings.creedType, 'nicene'); // user override preserved
  });

  it('should not mutate the caller\'s data or seasonalSettings object', () => {
    const ss = { gloria: true };
    const data = { liturgicalSeason: 'lent', seasonalSettings: ss };
    const result = applySeasonDefaults(data);
    assert.notEqual(result.seasonalSettings, ss, 'seasonalSettings must be cloned');
    assert.deepEqual(ss, { gloria: true }, 'input seasonalSettings must not be mutated');
    assert.deepEqual(data, { liturgicalSeason: 'lent', seasonalSettings: { gloria: true } });
    assert.equal(result.seasonalSettings.creedType, 'apostles'); // defaults applied to the clone
  });

  it('should apply includePostlude and adventWreath defaults', () => {
    const adventData = { liturgicalSeason: 'advent' };
    const adventResult = applySeasonDefaults(adventData);
    assert.equal(adventResult.seasonalSettings.adventWreath, true);
    assert.equal(adventResult.seasonalSettings.includePostlude, true);

    const lentData = { liturgicalSeason: 'lent' };
    const lentResult = applySeasonDefaults(lentData);
    assert.equal(lentResult.seasonalSettings.includePostlude, false);
    assert.equal(lentResult.seasonalSettings.adventWreath, false);
  });

  it('should export Lenten acclamation options', () => {
    assert.ok(Array.isArray(LENTEN_ACCLAMATION_OPTIONS));
    assert.equal(LENTEN_ACCLAMATION_OPTIONS.length, 2);
    assert.ok(LENTEN_ACCLAMATION_OPTIONS[0].includes('Praise'));
    assert.ok(LENTEN_ACCLAMATION_OPTIONS[1].includes('Glory'));
  });
});

describe('Music formatter', () => {
  it('should return empty array for no music', () => {
    const data = {};
    const items = formatMusicSlot(data, 'organPrelude', 'organPreludeComposer');
    assert.deepEqual(items, []);
  });

  it('should return single item without time label when all same', () => {
    const data = {
      musicSat5pm: { organPrelude: 'Test', organPreludeComposer: 'Bach' },
      musicSun9am: { organPrelude: 'Test', organPreludeComposer: 'Bach' },
      musicSun11am: { organPrelude: 'Test', organPreludeComposer: 'Bach' }
    };
    const items = formatMusicSlot(data, 'organPrelude', 'organPreludeComposer');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Test');
    assert.equal(items[0].timeLabel, '');
  });

  it('should keep the time label when only some Masses have the slot filled', () => {
    // Regression: a hymn entered for just one Mass used to print with no
    // time qualifier, implying it was sung at all three Masses.
    const data = {
      musicSat5pm: { offertoryAnthem: 'Solo Hymn', offertoryAnthemComposer: 'Bach' }
    };
    const items = formatMusicSlot(data, 'offertoryAnthem', 'offertoryAnthemComposer');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Solo Hymn');
    assert.equal(items[0].timeLabel, 'Sat, 5 PM');
  });

  it('should keep time labels when two of three Masses share the same selection', () => {
    const data = {
      musicSat5pm: { communionHymn: 'Shared Hymn' },
      musicSun9am: { communionHymn: 'Shared Hymn' }
    };
    const items = formatMusicSlot(data, 'communionHymn', 'communionHymnComposer');
    assert.equal(items.length, 1);
    assert.equal(items[0].timeLabel, 'Sat, 5 PM & Sun, 9 AM');
  });

  it('should group by selection when different', () => {
    const data = {
      musicSat5pm: { offertoryAnthem: 'Hymn A', offertoryAnthemComposer: 'Comp A' },
      musicSun9am: { offertoryAnthem: 'Hymn A', offertoryAnthemComposer: 'Comp A' },
      musicSun11am: { offertoryAnthem: 'Hymn B', offertoryAnthemComposer: 'Comp B' }
    };
    const items = formatMusicSlot(data, 'offertoryAnthem', 'offertoryAnthemComposer');
    assert.equal(items.length, 2);
    assert.ok(items[0].timeLabel.includes('Sat'));
    assert.ok(items[1].timeLabel.includes('Sun, 11'));
  });

  it('should format time labels correctly', () => {
    const label = formatTimeLabel(['Sat 5:00 PM', 'Sun 9:00 AM']);
    assert.equal(label, 'Sat, 5 PM & Sun, 9 AM');
  });

  it('should render music line as text', () => {
    const text = renderMusicLineText({ title: 'Test Hymn', composer: 'Bach', timeLabel: 'Sat, 5 PM' });
    assert.equal(text, 'Test Hymn, Bach (Sat, 5 PM)');
  });

  it('should render without time label when empty', () => {
    const text = renderMusicLineText({ title: 'Test Hymn', composer: 'Bach', timeLabel: '' });
    assert.equal(text, 'Test Hymn, Bach');
  });
});
