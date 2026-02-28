// Tests for input validation and overflow detection
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateInput, detectOverflows, estimateLines } = require('../validator');

const minValid = {
  feastName: 'Test Sunday',
  liturgicalDate: '2026-03-01',
  liturgicalSeason: 'ordinary'
};

describe('validateInput', () => {
  it('should accept minimal valid input', () => {
    const result = validateInput(minValid);
    assert.equal(result.valid, true);
  });

  it('should reject missing feastName', () => {
    const data = { ...minValid };
    delete data.feastName;
    assert.equal(validateInput(data).valid, false);
  });

  it('should reject missing liturgicalDate', () => {
    const data = { ...minValid };
    delete data.liturgicalDate;
    assert.equal(validateInput(data).valid, false);
  });

  it('should reject invalid date format', () => {
    assert.equal(validateInput({ ...minValid, liturgicalDate: 'March 1' }).valid, false);
  });

  it('should reject invalid liturgicalSeason', () => {
    assert.equal(validateInput({ ...minValid, liturgicalSeason: 'pentecost' }).valid, false);
  });

  it('should accept all valid seasons', () => {
    for (const season of ['ordinary', 'advent', 'christmas', 'lent', 'easter']) {
      assert.equal(validateInput({ ...minValid, liturgicalSeason: season }).valid, true);
    }
  });

  it('should accept full input with readings and music', () => {
    const full = {
      ...minValid,
      readings: {
        firstReadingCitation: 'Gen 1:1',
        firstReadingText: 'In the beginning...',
        psalmCitation: 'Psalm 23',
        psalmRefrain: 'The Lord is my shepherd.',
        gospelCitation: 'John 3:16',
        gospelText: 'For God so loved...'
      },
      seasonalSettings: {
        gloria: true,
        creedType: 'nicene',
        entranceType: 'processional',
        holyHolySetting: 'Mass of St. Theresa',
        penitentialAct: 'confiteor'
      },
      musicSat5pm: {
        organPrelude: 'Test Prelude',
        organPreludeComposer: 'Bach',
        offertoryAnthem: 'Test Offertory'
      },
      musicSun9am: { organPrelude: 'Test' },
      musicSun11am: { organPrelude: 'Test' },
      childrenLiturgyEnabled: true,
      childrenLiturgyMassTime: 'Sun 9:00 AM',
      announcements: 'Test announcement',
      specialNotes: 'Test note'
    };
    assert.equal(validateInput(full).valid, true);
  });
});

describe('estimateLines', () => {
  it('should count newlines', () => {
    assert.equal(estimateLines('line1\nline2\nline3'), 3);
  });

  it('should account for line wrapping', () => {
    const longLine = 'a'.repeat(200);
    assert.ok(estimateLines(longLine) > 1);
  });

  it('should return 0 for empty/null', () => {
    assert.equal(estimateLines(''), 0);
    assert.equal(estimateLines(null), 0);
  });
});

describe('detectOverflows', () => {
  it('should return empty array for short content', () => {
    const data = {
      ...minValid,
      readings: { firstReadingText: 'Short.', gospelText: 'Short.', psalmRefrain: 'R.' }
    };
    assert.deepEqual(detectOverflows(data), []);
  });

  it('should detect page 3 overflow for very long readings', () => {
    const longText = ('This is a long sentence that repeats many times. '.repeat(50) + '\n').repeat(10);
    const data = {
      ...minValid,
      readings: { firstReadingText: longText, secondReadingText: longText, psalmVerses: longText }
    };
    const overflows = detectOverflows(data);
    assert.ok(overflows.some(o => o.page === 3));
  });

  it('should detect page 4 overflow for long gospel + nicene creed', () => {
    const longGospel = ('The Gospel text continues with many verses. '.repeat(60) + '\n').repeat(5);
    const data = {
      ...minValid,
      readings: { gospelText: longGospel },
      seasonalSettings: { creedType: 'nicene' }
    };
    const overflows = detectOverflows(data);
    assert.ok(overflows.some(o => o.page === 4));
  });

  it('should include page number and severity', () => {
    const longText = ('text '.repeat(100) + '\n').repeat(20);
    const data = {
      ...minValid,
      readings: { firstReadingText: longText, secondReadingText: longText, psalmVerses: longText }
    };
    const overflows = detectOverflows(data);
    if (overflows.length > 0) {
      assert.ok(overflows[0].page);
      assert.ok(overflows[0].severity);
      assert.ok(overflows[0].message);
    }
  });
});
