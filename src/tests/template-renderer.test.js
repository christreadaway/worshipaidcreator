// Tests for HTML template renderer
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderBookletHtml, escapeHtml, nl2br, formatDate } = require('../template-renderer');

const sampleData = {
  occasionName: 'Second Sunday of Lent',
  occasionDate: '2026-03-01',
  massTimes: ['Sat 5:00 PM', 'Sun 9:00 AM'],
  firstReading: { citation: 'Genesis 15:5-12', text: 'The Lord took Abram outside...' },
  responsorialPsalm: { citation: 'Psalm 27', response: 'The Lord is my light.' },
  gospel: { citation: 'Luke 9:28b-36', text: 'Jesus took Peter, John, and James...' },
  creedType: 'nicene',
  gloria: false,
  gospelAcclamation: { lenten: true, verse: 'Test verse', citation: 'Mt 17:5' }
};

describe('escapeHtml', () => {
  it('should escape HTML special characters', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should handle empty/null input', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('nl2br', () => {
  it('should convert newlines to <br>', () => {
    assert.equal(nl2br('line1\nline2'), 'line1<br>line2');
  });

  it('should also escape HTML', () => {
    assert.equal(nl2br('<b>bold</b>\nnewline'), '&lt;b&gt;bold&lt;/b&gt;<br>newline');
  });
});

describe('formatDate', () => {
  it('should format ISO date to readable string', () => {
    const result = formatDate('2026-03-01');
    assert.ok(result.includes('2026'));
    assert.ok(result.includes('March'));
  });

  it('should handle empty input', () => {
    assert.equal(formatDate(''), '');
    assert.equal(formatDate(null), '');
  });
});

describe('renderBookletHtml', () => {
  it('should return html and warnings', () => {
    const result = renderBookletHtml(sampleData);
    assert.ok(result.html);
    assert.ok(Array.isArray(result.warnings));
  });

  it('should include all 8 pages', () => {
    const { html } = renderBookletHtml(sampleData);
    for (let i = 1; i <= 8; i++) {
      assert.ok(html.includes(`id="page-${i}"`), `Missing page ${i}`);
    }
  });

  it('should include occasion name and date', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Second Sunday of Lent'));
    assert.ok(html.includes('2026'));
  });

  it('should include mass times', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Sat 5:00 PM'));
    assert.ok(html.includes('Sun 9:00 AM'));
  });

  it('should include readings', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Genesis 15:5-12'));
    assert.ok(html.includes('Luke 9:28b-36'));
  });

  it('should suppress Gloria when data.gloria is false', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(!html.includes('Glory to God in the highest'));
  });

  it('should include Gloria when gloria is true', () => {
    const data = { ...sampleData, gloria: true, gospelAcclamation: { lenten: false } };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('Glory to God in the highest'));
  });

  it('should use Lenten acclamation when lenten is true', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Praise to you, Lord Jesus Christ'));
    assert.ok(!html.includes('Alleluia, alleluia'));
  });

  it('should use Alleluia when not lenten', () => {
    const data = { ...sampleData, gospelAcclamation: { lenten: false } };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('Alleluia, alleluia'));
  });

  it('should include Nicene Creed by default', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Nicene Creed'));
    assert.ok(html.includes('consubstantial'));
  });

  it('should include Apostles Creed when specified', () => {
    const data = { ...sampleData, creedType: 'apostles' };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes("Apostles' Creed") || html.includes('Apostles\\&#039; Creed') || html.includes('Apostles'));
    assert.ok(html.includes('Creator of heaven and earth'));
  });

  it('should include Confiteor text', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('I confess to almighty God'));
  });

  it('should include Lord\'s Prayer', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Our Father'));
  });

  it('should include blessing and dismissal', () => {
    const { html } = renderBookletHtml(sampleData);
    assert.ok(html.includes('Go forth, the Mass is ended'));
  });

  it('should render per-mass items with labels when different', () => {
    const data = {
      ...sampleData,
      offertoryAnthems: [
        { massTime: 'Sat 5 PM', title: 'Hymn A', composer: 'Comp A' },
        { massTime: 'Sun 9 AM', title: 'Hymn B', composer: 'Comp B' }
      ]
    };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('Sat 5 PM'));
    assert.ok(html.includes('Hymn A'));
    assert.ok(html.includes('Hymn B'));
  });

  it('should render per-mass items without labels when all same', () => {
    const data = {
      ...sampleData,
      offertoryAnthems: [
        { massTime: 'All', title: 'Same Hymn', composer: 'Same Comp' }
      ]
    };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('Same Hymn'));
  });

  it('should generate placeholder for missing images', () => {
    const data = {
      ...sampleData,
      entranceAntiphon: { imagePath: '/nonexistent/image.png', citation: 'test' }
    };
    const { html, warnings } = renderBookletHtml(data);
    assert.ok(html.includes('[NOTATION:'));
    assert.ok(warnings.length > 0);
  });

  it('should include announcements when provided', () => {
    const data = { ...sampleData, announcements: 'Fish Fry Friday' };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('Fish Fry Friday'));
  });

  it('should include social handles on back cover', () => {
    const data = {
      ...sampleData,
      socialHandles: { instagram: 'ourparish', facebook: 'Our Parish' }
    };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('ourparish'));
  });

  it('should use compact font size when compact is true', () => {
    const data = { ...sampleData, compact: true };
    const { html } = renderBookletHtml(data);
    assert.ok(html.includes('font-size: 9pt'));
  });
});
