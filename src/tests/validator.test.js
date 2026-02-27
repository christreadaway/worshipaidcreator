// Tests for input validation
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateInput } = require('../validator');

describe('validateInput', () => {
  const minimalValid = {
    occasionName: 'Test Sunday',
    occasionDate: '2026-03-01',
    massTimes: ['Sun 9:00 AM'],
    firstReading: { citation: 'Gen 1:1', text: 'In the beginning...' },
    responsorialPsalm: { citation: 'Psalm 23' },
    gospel: { citation: 'John 3:16', text: 'For God so loved...' }
  };

  it('should accept minimal valid input', () => {
    const result = validateInput(minimalValid);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('should reject missing occasionName', () => {
    const data = { ...minimalValid };
    delete data.occasionName;
    const result = validateInput(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('should reject missing massTimes', () => {
    const data = { ...minimalValid };
    delete data.massTimes;
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should reject empty massTimes array', () => {
    const data = { ...minimalValid, massTimes: [] };
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should reject invalid date format', () => {
    const data = { ...minimalValid, occasionDate: 'March 1, 2026' };
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should reject missing firstReading', () => {
    const data = { ...minimalValid };
    delete data.firstReading;
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should reject missing gospel', () => {
    const data = { ...minimalValid };
    delete data.gospel;
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should accept full input with all optional fields', () => {
    const full = {
      ...minimalValid,
      organPrelude: { title: 'Test Prelude', composer: 'Test Composer' },
      entranceAntiphon: { citation: 'Ps 1:1', composerCredit: 'Test' },
      penitentialAct: 'default',
      kyrieSettings: [{ massTime: 'Sun 9 AM', settingName: 'Mass of Creation' }],
      gloria: true,
      collect: 'O God...',
      secondReading: { citation: 'Rom 1:1', text: 'Paul...' },
      gospelAcclamation: { citation: 'Mt 1:1', verse: 'Alleluia', lenten: false },
      creedType: 'nicene',
      announcements: 'Test announcements',
      offertoryAnthems: [{ massTime: 'All', title: 'Hymn', composer: 'Author' }],
      holySanctus: { settingName: 'Test' },
      mysteryOfFaith: { settingName: 'Test', option: 'A' },
      agnus: { settingName: 'Test' },
      communionAntiphon: { composerCredit: 'Test' },
      communionHymns: [{ massTime: 'All', title: 'Hymn' }],
      hymnThanksgiving: { title: 'Thanks' },
      choralAnthems: [{ title: 'Anthem', composer: 'Comp' }],
      prayerAfterCommunion: 'We give thanks...',
      qrCodes: { give: 'https://give.test', join: 'https://join.test' },
      socialHandles: { instagram: 'test', facebook: 'test' },
      compact: false
    };
    const result = validateInput(full);
    assert.equal(result.valid, true);
  });

  it('should reject invalid creedType', () => {
    const data = { ...minimalValid, creedType: 'lutheran' };
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should reject invalid mysteryOfFaith option', () => {
    const data = { ...minimalValid, mysteryOfFaith: { settingName: 'X', option: 'D' } };
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });

  it('should reject extra properties', () => {
    const data = { ...minimalValid, unknownField: 'test' };
    const result = validateInput(data);
    assert.equal(result.valid, false);
  });
});
