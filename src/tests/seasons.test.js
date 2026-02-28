// Tests for season auto-rules engine and music formatter
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getSeasonDefaults, applySeasonDefaults, SEASONS } = require('../config/seasons');
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
  });

  it('should return correct Ordinary Time defaults', () => {
    const d = getSeasonDefaults('ordinary');
    assert.equal(d.gloria, true);
    assert.equal(d.creedType, 'nicene');
    assert.equal(d.entranceType, 'processional');
  });

  it('should return correct Advent defaults', () => {
    const d = getSeasonDefaults('advent');
    assert.equal(d.gloria, false);
    assert.equal(d.entranceType, 'antiphon');
    assert.equal(d.childrenLiturgyDefault, 'no');
  });

  it('should return correct Christmas defaults', () => {
    const d = getSeasonDefaults('christmas');
    assert.equal(d.gloria, true);
    assert.equal(d.creedType, 'nicene');
  });

  it('should return correct Easter defaults', () => {
    const d = getSeasonDefaults('easter');
    assert.equal(d.gloria, true);
    assert.equal(d.entranceType, 'processional');
  });

  it('should apply season defaults to data', () => {
    const data = { liturgicalSeason: 'lent' };
    const result = applySeasonDefaults(data);
    assert.equal(result.gloria, false);
    assert.equal(result.creedType, 'apostles');
  });

  it('should not override user-set values', () => {
    const data = { liturgicalSeason: 'lent', gloria: true, creedType: 'nicene' };
    const result = applySeasonDefaults(data);
    assert.equal(result.gloria, true); // user override preserved
    assert.equal(result.creedType, 'nicene'); // user override preserved
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
