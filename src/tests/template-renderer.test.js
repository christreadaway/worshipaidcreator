// Tests for HTML template renderer (new 5.5x8.5 booklet)
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderBookletHtml, escapeHtml, nl2br, formatDate } = require('../template-renderer');

const sampleData = {
  feastName: 'Second Sunday of Lent',
  liturgicalDate: '2026-03-01',
  liturgicalSeason: 'lent',
  seasonalSettings: {
    gloria: false,
    creedType: 'apostles',
    entranceType: 'antiphon',
    holyHolySetting: 'Vatican Edition XVIII',
    mysteryOfFaithSetting: 'Vatican Edition XVIII',
    lambOfGodSetting: 'Agnus Dei, Vatican Edition XVIII',
    penitentialAct: 'confiteor'
  },
  readings: {
    firstReadingCitation: 'Genesis 15:5-12',
    firstReadingText: 'The Lord took Abram outside...',
    psalmCitation: 'Psalm 27',
    psalmRefrain: 'The Lord is my light.',
    psalmVerses: 'Verse 1\n\nVerse 2',
    secondReadingCitation: 'Philippians 3:17',
    secondReadingText: 'Join with others...',
    gospelAcclamationReference: 'Mt 17:5',
    gospelAcclamationVerse: 'This is my beloved Son.',
    gospelCitation: 'Luke 9:28b-36',
    gospelText: 'Jesus took Peter, John, and James...'
  },
  musicSat5pm: { organPrelude: 'O Sacred Head', organPreludeComposer: 'Bach', offertoryAnthem: 'Hymn A', offertoryAnthemComposer: 'Comp A' },
  musicSun9am: { organPrelude: 'O Sacred Head', organPreludeComposer: 'Bach', offertoryAnthem: 'Hymn A', offertoryAnthemComposer: 'Comp A' },
  musicSun11am: { organPrelude: 'O Sacred Head', organPreludeComposer: 'Bach', offertoryAnthem: 'Hymn B', offertoryAnthemComposer: 'Comp B' },
  childrenLiturgyEnabled: true,
  childrenLiturgyMassTime: 'Sun 9:00 AM',
  announcements: 'Fish Fry Friday'
};

describe('escapeHtml', () => {
  it('should escape special characters', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  });
  it('should handle null/empty', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(''), '');
  });
});

describe('nl2br', () => {
  it('should convert newlines to <br>', () => {
    assert.ok(nl2br('a\nb').includes('<br>'));
  });
});

describe('formatDate', () => {
  it('should format ISO date', () => {
    const result = formatDate('2026-03-01');
    assert.ok(result.includes('March'));
    assert.ok(result.includes('2026'));
  });
  it('should handle empty', () => {
    assert.equal(formatDate(''), '');
  });
});

describe('renderBookletHtml', () => {
  it('should return html and warnings', () => {
    const result = renderBookletHtml(sampleData);
    assert.ok(result.html);
    assert.ok(Array.isArray(result.warnings));
  });

  it('should render all 8 pages', () => {
    const { html } = renderBookletHtml(sampleData);
    for (let i = 1; i <= 8; i++) {
      assert.ok(html.includes('id="page-' + i + '"'), 'Missing page ' + i);
    }
  });

  it('should use 5.5in x 8.5in page size', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('5.5in'));
    assert.ok(html.includes('8.5in'));
  });

  it('should include feast name and date', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Second Sunday of Lent'));
  });

  it('should suppress Gloria in Lent', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(!html.includes('Glory to God in the highest'));
  });

  it('should show Gloria in Ordinary Time', () => {
    const ordinaryData = { ...sampleData, liturgicalSeason: 'ordinary', seasonalSettings: { ...sampleData.seasonalSettings, gloria: true } };
    const { html } = renderBookletHtml(ordinaryData);
    assert.ok(html.includes('Glory to God in the highest'));
  });

  it('should use Lenten acclamation in Lent', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Praise to you, Lord Jesus Christ'));
  });

  it('should use Alleluia in Ordinary Time', () => {
    const ordinaryData = { ...sampleData, liturgicalSeason: 'ordinary' };
    const { html } = renderBookletHtml(ordinaryData);
    assert.ok(html.includes('Alleluia'));
  });

  it('should include Apostles Creed when set', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes("Apostles' Creed") || html.includes("Apostles"));
    assert.ok(html.includes('Creator of heaven and earth'));
  });

  it('should include parish info block on cover', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Connect'));
    assert.ok(html.includes('Nursery'));
    assert.ok(html.includes('Restrooms'));
    assert.ok(html.includes('Prayer'));
  });

  it('should include readings', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Genesis 15:5-12'));
    assert.ok(html.includes('Luke 9:28b-36'));
  });

  it('should include psalm refrain', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('The Lord is my light'));
  });

  it('should include Confiteor', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('I confess to almighty God'));
  });

  it('should include Lords Prayer', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Our Father'));
  });

  it('should include blessing and dismissal', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Go forth, the Mass is ended'));
  });

  it('should render Children Liturgy when enabled', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes("Children"));
    assert.ok(html.includes("Sun 9:00 AM"));
  });

  it('should include announcements', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Fish Fry Friday'));
  });

  it('should show Entrance Antiphon in Lent', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Entrance Antiphon'));
  });

  it('should show Processional Hymn in Ordinary Time', () => {
    const ordinaryData = { ...sampleData, liturgicalSeason: 'ordinary', seasonalSettings: { ...sampleData.seasonalSettings, entranceType: 'processional' } };
    const { html } = renderBookletHtml(ordinaryData);
    assert.ok(html.includes('Processional Hymn'));
  });

  it('should include seasonal music settings', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Vatican Edition XVIII'));
  });

  it('should display per-mass music correctly when same', () => {
    const { html } = renderBookletHtml(sampleData);
    // organPrelude is same for all 3 → should show once without time labels
    assert.ok(html.includes('O Sacred Head'));
  });

  it('should show copyright on page 7', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('copyright-short'));
  });

  it('should show full copyright on page 8', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('copyright-full'));
  });

  it('should include Organ Postlude section on page 7', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Organ Postlude'));
  });

  it('should include Sign of Peace section', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Sign of Peace'));
  });

  it('should include Great Amen section', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Great Amen'));
  });
});
