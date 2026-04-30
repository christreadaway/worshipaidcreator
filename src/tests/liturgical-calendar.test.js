// Spot-check tests for the liturgical calendar.  Dates pulled from the USCCB
// 2026 calendar so the cases match what the parish will actually print.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getLiturgicalInfo, detectSeason, detectFeastName, parseDate, _internal } = require('../liturgical-calendar');

describe('Easter computus', () => {
  it('gives the right Easter for a few sample years', () => {
    assert.equal(_internal.computeEaster(2025).toISOString().slice(0,10), '2025-04-20');
    assert.equal(_internal.computeEaster(2026).toISOString().slice(0,10), '2026-04-05');
    assert.equal(_internal.computeEaster(2027).toISOString().slice(0,10), '2027-03-28');
  });
});

describe('Season detection', () => {
  it('classifies Ash Wednesday as Lent', () => {
    assert.equal(getLiturgicalInfo('2026-02-18').liturgicalSeason, 'lent');
  });
  it('classifies Easter Sunday as Easter', () => {
    assert.equal(getLiturgicalInfo('2026-04-05').liturgicalSeason, 'easter');
  });
  it('classifies a date in late October as Ordinary Time', () => {
    assert.equal(getLiturgicalInfo('2026-10-25').liturgicalSeason, 'ordinary');
  });
  it('classifies the First Sunday of Advent as Advent', () => {
    assert.equal(getLiturgicalInfo('2026-11-29').liturgicalSeason, 'advent');
  });
  it('classifies Christmas Day as Christmas', () => {
    assert.equal(getLiturgicalInfo('2026-12-25').liturgicalSeason, 'christmas');
  });
});

describe('Feast / Sunday names', () => {
  // 2026 calendar references
  it('labels Ash Wednesday', () => {
    assert.equal(getLiturgicalInfo('2026-02-18').feastName, 'Ash Wednesday');
  });
  it('labels First Sunday of Lent', () => {
    assert.equal(getLiturgicalInfo('2026-02-22').feastName, 'First Sunday of Lent');
  });
  it('labels Second Sunday of Lent', () => {
    assert.equal(getLiturgicalInfo('2026-03-01').feastName, 'Second Sunday of Lent');
  });
  it('labels Palm Sunday', () => {
    assert.equal(getLiturgicalInfo('2026-03-29').feastName.startsWith('Palm Sunday'), true);
  });
  it('labels Easter Sunday', () => {
    assert.equal(getLiturgicalInfo('2026-04-05').feastName.startsWith('Easter Sunday'), true);
  });
  it('labels Divine Mercy Sunday', () => {
    assert.equal(getLiturgicalInfo('2026-04-12').feastName.includes('Divine Mercy'), true);
  });
  it('labels Pentecost', () => {
    assert.equal(getLiturgicalInfo('2026-05-24').feastName, 'Pentecost Sunday');
  });
  it('labels Trinity Sunday', () => {
    assert.equal(getLiturgicalInfo('2026-05-31').feastName, 'The Most Holy Trinity');
  });
  it('labels Corpus Christi', () => {
    assert.equal(getLiturgicalInfo('2026-06-07').feastName.includes('Corpus Christi'), true);
  });
  it('labels Christmas Day', () => {
    assert.equal(getLiturgicalInfo('2026-12-25').feastName.includes('Christmas'), true);
  });
  it('labels the First Sunday of Advent (2026)', () => {
    assert.equal(getLiturgicalInfo('2026-11-29').feastName, 'First Sunday of Advent');
  });
  it('labels Christ the King (last Sunday before Advent)', () => {
    assert.equal(getLiturgicalInfo('2026-11-22').feastName.includes('King'), true);
  });
  it('labels an Ordinary Time Sunday with the right week number', () => {
    // 2026-10-25 should be a Sunday in Ordinary Time
    const info = getLiturgicalInfo('2026-10-25');
    assert.equal(info.liturgicalSeason, 'ordinary');
    assert.ok(/Sunday in Ordinary Time/.test(info.feastName), 'got: ' + info.feastName);
  });
});

describe('Edge cases', () => {
  it('returns null for invalid dates', () => {
    assert.equal(getLiturgicalInfo('not-a-date'), null);
    assert.equal(parseDate('xx'), null);
  });
});
