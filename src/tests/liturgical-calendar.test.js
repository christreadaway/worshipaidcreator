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

describe('Sunday precedence over fixed-date feasts (regressions)', () => {
  it('Holy Family wins over Holy Innocents when Dec 28 is a Sunday (2025)', () => {
    assert.equal(getLiturgicalInfo('2025-12-28').feastName, 'The Holy Family of Jesus, Mary and Joseph');
  });
  it('Holy Family wins over St. Stephen when Dec 26 is a Sunday (2021)', () => {
    assert.equal(getLiturgicalInfo('2021-12-26').feastName, 'The Holy Family of Jesus, Mary and Joseph');
  });
  it('Holy Family wins over 7th Day of the Octave when Dec 31 is a Sunday (2023)', () => {
    assert.equal(getLiturgicalInfo('2023-12-31').feastName, 'The Holy Family of Jesus, Mary and Joseph');
  });
  it('Fourth Sunday of Advent wins over Christmas Eve on Sunday Dec 24 (2023)', () => {
    assert.equal(getLiturgicalInfo('2023-12-24').feastName, 'Fourth Sunday of Advent');
  });
  it('fixed feasts still apply on weekdays (St. Stephen 2025 = Friday)', () => {
    assert.equal(getLiturgicalInfo('2025-12-26').feastName, 'St. Stephen, the First Martyr');
  });
  it('Sunday-displacing solemnities still win on Sundays (Assumption 2021, All Saints 2020)', () => {
    assert.equal(getLiturgicalInfo('2021-08-15').feastName, 'The Assumption of the Blessed Virgin Mary'); // Sunday
    assert.equal(getLiturgicalInfo('2020-11-01').feastName, 'All Saints'); // Sunday
  });
});

describe('Epiphany / Baptism of the Lord (regressions)', () => {
  it('Epiphany on Sunday Jan 8 (2023)', () => {
    assert.equal(getLiturgicalInfo('2023-01-08').feastName, 'The Epiphany of the Lord');
  });
  it('Baptism of the Lord on the following MONDAY when Epiphany is Jan 7/8 (2023)', () => {
    assert.equal(getLiturgicalInfo('2023-01-09').feastName, 'The Baptism of the Lord');
  });
  it('Baptism of the Lord on the following Sunday in normal years (2026)', () => {
    assert.equal(getLiturgicalInfo('2026-01-04').feastName, 'The Epiphany of the Lord');
    assert.equal(getLiturgicalInfo('2026-01-11').feastName, 'The Baptism of the Lord');
  });
  it('no fixed Epiphany on Jan 6 (US Sunday transfer)', () => {
    assert.notEqual(getLiturgicalInfo('2025-01-06').feastName, 'The Epiphany of the Lord');
  });
});

describe('Immaculate Conception transfer (regressions)', () => {
  it('Dec 8 on a Sunday is the Second Sunday of Advent (2024)', () => {
    assert.equal(getLiturgicalInfo('2024-12-08').feastName, 'Second Sunday of Advent');
  });
  it('Immaculate Conception transfers to Monday Dec 9 when Dec 8 is a Sunday (2024)', () => {
    assert.equal(getLiturgicalInfo('2024-12-09').feastName, 'The Immaculate Conception of the Blessed Virgin Mary');
  });
  it('Immaculate Conception stays on Dec 8 when it is a weekday (2025)', () => {
    assert.equal(getLiturgicalInfo('2025-12-08').feastName, 'The Immaculate Conception of the Blessed Virgin Mary');
    assert.notEqual(getLiturgicalInfo('2025-12-09').feastName, 'The Immaculate Conception of the Blessed Virgin Mary');
  });
});

describe('Ascension (US Sunday transfer is the default)', () => {
  // Easter 2025 = Apr 20 → Thursday Ascension would be May 29; transferred Sunday is Jun 1.
  it('labels Easter + 42 (Sunday) as the Ascension by default', () => {
    assert.equal(getLiturgicalInfo('2025-06-01').feastName, 'The Ascension of the Lord');
    assert.notEqual(getLiturgicalInfo('2025-05-29').feastName, 'The Ascension of the Lord');
  });
  it('keeps Thursday Ascension behind the ascensionOnThursday option', () => {
    const opts = { ascensionOnThursday: true };
    assert.equal(getLiturgicalInfo('2025-05-29', opts).feastName, 'The Ascension of the Lord');
    assert.equal(getLiturgicalInfo('2025-06-01', opts).feastName, 'Seventh Sunday of Easter');
  });
});

describe('Chair of St. Peter', () => {
  it('is keyed to Feb 22, not Feb 25', () => {
    // 2025-02-22 is a Saturday
    assert.equal(getLiturgicalInfo('2025-02-22').feastName, 'The Chair of St. Peter');
    assert.notEqual(getLiturgicalInfo('2025-02-25').feastName, 'The Chair of St. Peter');
  });
});

describe('Edge cases', () => {
  it('returns null for invalid dates', () => {
    assert.equal(getLiturgicalInfo('not-a-date'), null);
    assert.equal(parseDate('xx'), null);
  });
});
