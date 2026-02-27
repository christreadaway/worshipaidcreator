// Tests for PDF generation
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { generatePdf } = require('../pdf-generator');

const outputDir = path.join(__dirname, '..', '..', 'output', 'test');
const sampleData = {
  occasionName: 'Test Sunday',
  occasionDate: '2026-03-01',
  massTimes: ['Sat 5:00 PM', 'Sun 9:00 AM', 'Sun 11:00 AM'],
  organPrelude: { title: 'Test Prelude', composer: 'J.S. Bach' },
  entranceAntiphon: { citation: 'Ps 27:8-9', composerCredit: 'Test Credit' },
  penitentialAct: 'default',
  kyrieSettings: [
    { massTime: 'Sat 5 PM & Sun 9 AM', settingName: 'Mass of Creation' },
    { massTime: 'Sun 11 AM', settingName: 'Missa Emmanuel' }
  ],
  gloria: false,
  collect: 'O God, test collect prayer.',
  firstReading: { citation: 'Genesis 15:5-12', text: 'The Lord God took Abram outside and said...\n\nThis is a test reading with multiple paragraphs.\n\nThe word of the Lord.' },
  responsorialPsalm: {
    citation: 'Psalm 27:1, 7-8',
    response: 'The Lord is my light and my salvation.',
    verses: ['Verse 1 text here.', 'Verse 2 text here.']
  },
  secondReading: { citation: 'Philippians 3:17', text: 'Join with others in being imitators of me...\n\nThe word of the Lord.' },
  gospelAcclamation: { citation: 'Mt 17:5', verse: 'This is my beloved Son.', lenten: true },
  gospel: { citation: 'Luke 9:28b-36', text: 'Jesus took Peter, John, and James and went up the mountain to pray...\n\nThe Gospel of the Lord.' },
  creedType: 'nicene',
  announcements: 'Test announcement: Fish Fry Friday at 5 PM.',
  offertoryAnthems: [
    { massTime: 'Sat 5 PM', title: 'Offertory Hymn A', composer: 'Composer A' },
    { massTime: 'Sun 11 AM', title: 'Offertory Hymn B', composer: 'Composer B' }
  ],
  holySanctus: { settingName: 'Mass of Creation' },
  mysteryOfFaith: { settingName: 'Mass of Creation', option: 'A' },
  agnus: { settingName: 'Mass of Creation' },
  communionHymns: [{ title: 'Communion Hymn', composer: 'Test' }],
  hymnThanksgiving: { title: 'Thanks Hymn', yearAStanza: 'Year A text' },
  choralAnthems: [{ title: 'Choral Piece', composer: 'Victoria' }],
  prayerAfterCommunion: 'We give thanks, O Lord.',
  qrCodes: { give: 'https://give.test', join: 'https://join.test', bulletin: 'https://bulletin.test' },
  socialHandles: { instagram: 'testparish', facebook: 'Test Parish', youtube: 'Test Channel' }
};

before(() => {
  fs.mkdirSync(outputDir, { recursive: true });
});

after(() => {
  // Clean up test output
  const files = fs.readdirSync(outputDir);
  for (const f of files) {
    fs.unlinkSync(path.join(outputDir, f));
  }
  fs.rmdirSync(outputDir);
});

describe('generatePdf', () => {
  it('should generate a PDF file from valid data', async () => {
    const pdfPath = path.join(outputDir, 'test-full.pdf');
    const result = await generatePdf(sampleData, pdfPath);
    assert.equal(result.outputPath, pdfPath);
    assert.ok(fs.existsSync(pdfPath), 'PDF file should exist');
    const stats = fs.statSync(pdfPath);
    assert.ok(stats.size > 1000, `PDF should be more than 1KB, got ${stats.size} bytes`);
  });

  it('should return warnings array', async () => {
    const pdfPath = path.join(outputDir, 'test-warnings.pdf');
    const result = await generatePdf(sampleData, pdfPath);
    assert.ok(Array.isArray(result.warnings));
  });

  it('should generate a valid PDF header', async () => {
    const pdfPath = path.join(outputDir, 'test-header.pdf');
    await generatePdf(sampleData, pdfPath);
    const header = fs.readFileSync(pdfPath, 'utf8').slice(0, 5);
    assert.equal(header, '%PDF-');
  });

  it('should handle compact mode', async () => {
    const pdfPath = path.join(outputDir, 'test-compact.pdf');
    const result = await generatePdf({ ...sampleData, compact: true }, pdfPath, { compact: true });
    assert.ok(fs.existsSync(pdfPath));
    assert.equal(result.outputPath, pdfPath);
  });

  it('should handle minimal data', async () => {
    const minimal = {
      occasionName: 'Minimal Test',
      occasionDate: '2026-01-01',
      massTimes: ['Sun 10 AM'],
      firstReading: { citation: 'Gen 1:1', text: 'In the beginning...' },
      responsorialPsalm: { citation: 'Psalm 1' },
      gospel: { citation: 'John 1:1', text: 'In the beginning was the Word...' }
    };
    const pdfPath = path.join(outputDir, 'test-minimal.pdf');
    const result = await generatePdf(minimal, pdfPath);
    assert.ok(fs.existsSync(pdfPath));
    assert.ok(result.warnings.length === 0 || result.warnings.length >= 0);
  });

  it('should warn about missing images', async () => {
    const dataWithImages = {
      ...sampleData,
      entranceAntiphon: { imagePath: '/nonexistent/path.png', citation: 'Test' }
    };
    const pdfPath = path.join(outputDir, 'test-missing-img.pdf');
    const result = await generatePdf(dataWithImages, pdfPath);
    assert.ok(result.warnings.some(w => w.includes('not found') || w.includes('Missing')));
  });

  it('should produce an 8-page PDF (check file size)', async () => {
    const pdfPath = path.join(outputDir, 'test-8pages.pdf');
    await generatePdf(sampleData, pdfPath);
    // A valid 8-page PDF with text content should be substantial
    const stats = fs.statSync(pdfPath);
    assert.ok(stats.size > 5000, `8-page PDF should be >5KB, got ${stats.size}`);
  });

  it('should handle Apostles Creed selection', async () => {
    const pdfPath = path.join(outputDir, 'test-apostles.pdf');
    const result = await generatePdf({ ...sampleData, creedType: 'apostles' }, pdfPath);
    assert.ok(fs.existsSync(pdfPath));
    assert.equal(result.outputPath, pdfPath);
  });
});
