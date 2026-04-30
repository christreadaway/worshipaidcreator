// Liturgical calendar — derives feast/Sunday name and season from a YYYY-MM-DD
// date.  Coverage is the General Roman Calendar in the United States: Sundays
// across all seasons, the major feast days that displace Sunday, the moveable
// feasts of the Easter cycle, and the patronal solemnities the parish marks
// (Ash Wednesday, Holy Week, Sacred Heart, Christ the King, etc.).
//
// The function aims to give the music staff a sensible default in the
// "Feast / Sunday Name" field.  Anything missing from the calendar simply
// returns the day-of-week + month/day so the user can edit it.
'use strict';

function dateOnly(y, m, d) { return new Date(Date.UTC(y, m, d)); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function sameDay(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear()
      && a.getUTCMonth()    === b.getUTCMonth()
      && a.getUTCDate()     === b.getUTCDate();
}
function diffDays(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }

function parseDate(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(yyyyMmDd || ''));
  if (!m) return null;
  return dateOnly(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

// Anonymous Gregorian (Computus) — Western Easter for a given year.
function computeEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return dateOnly(year, month - 1, day);
}

// First Sunday of Advent: the Sunday closest to Nov 30 (St. Andrew). In
// practice that's the Sunday on or after Nov 27 and on or before Dec 3.
function firstSundayOfAdvent(year) {
  // Sunday on/before Dec 24 minus 21 days.
  const dec25 = dateOnly(year, 11, 25);
  const dec25Dow = dec25.getUTCDay();          // 0=Sun ... 6=Sat
  const sundayBeforeChristmas = addDays(dec25, -((dec25Dow + 7) % 7 || 7));
  return addDays(sundayBeforeChristmas, -21);
}

// Baptism of the Lord: Sunday after Jan 6 (or Jan 9 if Epiphany falls on Sun).
function baptismOfTheLord(year) {
  const jan6 = dateOnly(year, 0, 6);
  // If Jan 6 itself is Sunday, Baptism is Monday Jan 7 in some calendars; the
  // US calendar moves Epiphany to the Sun between Jan 2-8 and Baptism to the
  // following Sunday (or Mon Jan 9 if Epiphany is Jan 7-8).  Simplify by
  // returning the next Sunday strictly after Jan 6.
  let d = addDays(jan6, 1);
  while (d.getUTCDay() !== 0) d = addDays(d, 1);
  return d;
}

// Sunday of Epiphany — the Sunday between Jan 2 and Jan 8 (US calendar).
function epiphany(year) {
  const jan2 = dateOnly(year, 0, 2);
  let d = jan2;
  while (d.getUTCDay() !== 0) d = addDays(d, 1);
  return d;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Fixed solemnities that displace Sunday or that the parish prints.
function fixedFeast(date) {
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const key = m * 100 + d;
  const map = {
     101: 'Solemnity of Mary, Mother of God',
     106: 'The Epiphany of the Lord',
     202: 'The Presentation of the Lord',
     225: 'The Chair of St. Peter',
     319: 'St. Joseph, Husband of the Blessed Virgin Mary',
     325: 'The Annunciation of the Lord',
     624: 'The Nativity of St. John the Baptist',
     629: 'Sts. Peter and Paul, Apostles',
     806: 'The Transfiguration of the Lord',
     815: 'The Assumption of the Blessed Virgin Mary',
     914: 'The Exaltation of the Holy Cross',
    1101: 'All Saints',
    1102: 'The Commemoration of All the Faithful Departed',
    1209: 'The Immaculate Conception of the Blessed Virgin Mary',
    1208: 'The Immaculate Conception of the Blessed Virgin Mary',
    1212: 'Our Lady of Guadalupe',
    1224: 'Christmas Eve',
    1225: 'The Nativity of the Lord (Christmas)',
    1226: 'St. Stephen, the First Martyr',
    1228: 'The Holy Innocents',
    1231: 'The Seventh Day of the Octave of Christmas'
  };
  return map[key] || null;
}

// Sundays of Advent / Lent / Easter — by week index from a reference Sunday.
function nthSundayOfRange(date, firstSunday, season) {
  if (date.getUTCDay() !== 0) return null;
  const weeks = Math.round(diffDays(date, firstSunday) / 7);
  const labels = {
    advent: ['First Sunday of Advent', 'Second Sunday of Advent', 'Third Sunday of Advent', 'Fourth Sunday of Advent'],
    lent:   ['First Sunday of Lent', 'Second Sunday of Lent', 'Third Sunday of Lent', 'Fourth Sunday of Lent', 'Fifth Sunday of Lent'],
    easter: ['Easter Sunday of the Resurrection of the Lord', 'Second Sunday of Easter (Sunday of Divine Mercy)', 'Third Sunday of Easter', 'Fourth Sunday of Easter', 'Fifth Sunday of Easter', 'Sixth Sunday of Easter']
  };
  const arr = labels[season];
  if (!arr) return null;
  return arr[weeks] || null;
}

// Christ the King — last Sunday of Ordinary Time (Sunday before First Advent).
function christTheKing(year) {
  return addDays(firstSundayOfAdvent(year), -7);
}

// Feast of the Holy Family — Sunday in the Octave of Christmas (Dec 26-31).
// If no Sunday falls between Dec 26 and Dec 31, the feast is on Dec 30.
function holyFamily(year) {
  for (let day = 26; day <= 31; day++) {
    const d = dateOnly(year, 11, day);
    if (d.getUTCDay() === 0) return d;
  }
  return dateOnly(year, 11, 30);
}

// Trinity Sunday = Easter + 56 days; Corpus Christi (US) = Sunday after Trinity;
// Sacred Heart = Friday after Corpus Christi octave (Easter + 68 days).
function paschalDate(easter, offset) { return addDays(easter, offset); }

// Returns a season from a date — tightened version of the rule already in
// server.js.  Treats Ash Wednesday → Holy Saturday as Lent, Easter Sunday →
// Pentecost as Easter, etc.
function detectSeason(date) {
  const year = date.getUTCFullYear();
  const easter = computeEaster(year);
  const ashWed = addDays(easter, -46);
  const pentecost = addDays(easter, 49);
  const adventStart = firstSundayOfAdvent(year);
  const dec25 = dateOnly(year, 11, 25);
  const baptism = baptismOfTheLord(year);

  if (date >= ashWed && date < easter) return 'lent';
  if (date >= easter && date <= pentecost) return 'easter';
  if (date >= adventStart && date < dec25) return 'advent';
  if (date >= dec25) return 'christmas';
  if (date <= baptism) return 'christmas';
  return 'ordinary';
}

// Feast/Sunday name. Strategy:
//   1. If the date is a known fixed solemnity, return that name.
//   2. If the date is in a movable cycle (Ash Wed, Palm Sun, Triduum, etc.),
//      return that title.
//   3. Otherwise label by season (Advent/Lent/Easter Sundays) or by Ordinary
//      Time week number.
function detectFeastName(date) {
  const fixed = fixedFeast(date);
  if (fixed) return fixed;

  const year = date.getUTCFullYear();
  const easter = computeEaster(year);

  // Movable around Easter
  const ashWed       = addDays(easter, -46);
  const palmSunday   = addDays(easter, -7);
  const holyThursday = addDays(easter, -3);
  const goodFriday   = addDays(easter, -2);
  const holySaturday = addDays(easter, -1);
  const divineMercy  = addDays(easter,  7);
  const ascensionThu = addDays(easter, 39);   // Thursday of 6th week of Easter
  const pentecost    = addDays(easter, 49);
  const trinity      = addDays(easter, 56);
  const corpusChristi = addDays(easter, 63);  // US: Sun after Trinity
  const sacredHeart  = addDays(easter, 68);   // Friday after Corpus Christi week

  if (sameDay(date, ashWed))         return 'Ash Wednesday';
  if (sameDay(date, palmSunday))     return 'Palm Sunday of the Passion of the Lord';
  if (sameDay(date, holyThursday))   return 'Holy Thursday — Mass of the Lord’s Supper';
  if (sameDay(date, goodFriday))     return 'Good Friday of the Passion of the Lord';
  if (sameDay(date, holySaturday))   return 'Holy Saturday — Easter Vigil';
  if (sameDay(date, easter))         return 'Easter Sunday of the Resurrection of the Lord';
  if (sameDay(date, divineMercy))    return 'Second Sunday of Easter (Sunday of Divine Mercy)';
  if (sameDay(date, ascensionThu))   return 'The Ascension of the Lord';
  if (sameDay(date, pentecost))      return 'Pentecost Sunday';
  if (sameDay(date, trinity))        return 'The Most Holy Trinity';
  if (sameDay(date, corpusChristi))  return 'The Most Holy Body and Blood of Christ (Corpus Christi)';
  if (sameDay(date, sacredHeart))    return 'The Most Sacred Heart of Jesus';
  if (sameDay(date, christTheKing(year))) return 'Our Lord Jesus Christ, King of the Universe';
  if (sameDay(date, holyFamily(year)))    return 'The Holy Family of Jesus, Mary and Joseph';
  if (sameDay(date, baptismOfTheLord(year))) return 'The Baptism of the Lord';
  if (sameDay(date, epiphany(year))) return 'The Epiphany of the Lord';

  // Sundays of Advent
  const advent1 = firstSundayOfAdvent(year);
  if (date >= advent1 && date < dateOnly(year, 11, 25)) {
    const named = nthSundayOfRange(date, advent1, 'advent');
    if (named) return named;
  }

  // Sundays of Lent (Ash Wed → Palm Sun)
  if (date >= ashWed && date < palmSunday) {
    // First Sunday of Lent = Sunday after Ash Wed
    let firstSundayLent = addDays(ashWed, 7 - ashWed.getUTCDay());
    if (firstSundayLent.getUTCDay() !== 0) {
      // ensure Sunday
      while (firstSundayLent.getUTCDay() !== 0) firstSundayLent = addDays(firstSundayLent, 1);
    }
    const named = nthSundayOfRange(date, firstSundayLent, 'lent');
    if (named) return named;
  }

  // Sundays of Easter season (Easter Sunday → Pentecost). Easter Sunday is
  // already labeled above; this catches the 2nd-7th Sundays.
  if (date > easter && date <= pentecost) {
    const named = nthSundayOfRange(date, easter, 'easter');
    if (named) return named;
    // Sunday between Ascension and Pentecost
    if (date.getUTCDay() === 0 && date > ascensionThu && date < pentecost) {
      return 'Seventh Sunday of Easter';
    }
  }

  // Sundays in Ordinary Time
  if (date.getUTCDay() === 0) {
    // OT week 1 starts the day after Baptism of the Lord; the *Sunday* of
    // the n-th week of OT (the way the Lectionary numbers it) is the n-th
    // Sunday after Baptism — except the OT cycle is interrupted by Lent and
    // Easter, then resumes the Monday after Pentecost using the week count
    // that makes the *34th* Sunday land on Christ the King.
    const baptism = baptismOfTheLord(year);

    if (date > baptism && date < ashWed) {
      // 2nd Sunday of OT is the Sunday after Baptism (OT week 1 has no Sunday).
      const weeks = Math.round(diffDays(date, baptism) / 7);
      const n = weeks + 1; // baptism+7 days = 2nd Sunday OT
      if (n >= 2 && n <= 9) return ordinal(n) + ' Sunday in Ordinary Time';
    }

    const ctk = christTheKing(year);
    if (date > pentecost && date <= ctk) {
      // Christ the King is OT week 34; count backwards to figure out which
      // Sunday this is.
      const weeksToCtk = Math.round(diffDays(ctk, date) / 7);
      const n = 34 - weeksToCtk;
      if (n >= 1 && n <= 34) return ordinal(n) + ' Sunday in Ordinary Time';
    }
  }

  // Generic fallback: return weekday name + season
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const monthDay = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return weekday + ', ' + monthDay;
}

// Convenience: return both the season + the feast name for a given date.
function getLiturgicalInfo(yyyyMmDd) {
  const date = parseDate(yyyyMmDd);
  if (!date) return null;
  return {
    date: yyyyMmDd,
    liturgicalSeason: detectSeason(date),
    feastName: detectFeastName(date)
  };
}

module.exports = {
  parseDate,
  detectSeason,
  detectFeastName,
  getLiturgicalInfo,
  // exposed for tests
  _internal: {
    computeEaster, firstSundayOfAdvent, baptismOfTheLord, christTheKing,
    holyFamily, epiphany, addDays, dateOnly
  }
};
