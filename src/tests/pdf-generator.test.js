// Tests for PDF generation (5.5x8.5 booklet)
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { generatePdf, buildFilename } = require('../pdf-generator');

const outputDir = path.join(__dirname, '..', '..', 'output', 'test');

const sampleData = {
  feastName: 'Test Sunday',
  liturgicalDate: '2026-03-01',
  liturgicalSeason: 'lent',
  seasonalSettings: {
    gloria: false, creedType: 'apostles', entranceType: 'antiphon',
    holyHolySetting: 'Vatican XVIII', mysteryOfFaithSetting: 'Vatican XVIII',
    lambOfGodSetting: 'Agnus Dei XVIII', penitentialAct: 'confiteor'
  },
  readings: {
    firstReadingCitation: 'Gen 15:5-12',
    firstReadingText: 'The Lord God took Abram outside...\n\nThe word of the Lord.',
    psalmCitation: 'Psalm 27',
    psalmRefrain: 'The Lord is my light.',
    psalmVerses: 'Verse 1\n\nVerse 2',
    secondReadingCitation: 'Phil 3:17',
    secondReadingText: 'Join with others...\n\nThe word of the Lord.',
    gospelAcclamationReference: 'Mt 17:5',
    gospelAcclamationVerse: 'This is my beloved Son.',
    gospelCitation: 'Luke 9:28b-36',
    gospelText: 'Jesus took Peter...\n\nThe Gospel of the Lord.'
  },
  musicSat5pm: { organPrelude: 'Prelude', organPreludeComposer: 'Bach', offertoryAnthem: 'Offertory A', communionHymn: 'Communion', organPostlude: 'Postlude' },
  musicSun9am: { organPrelude: 'Prelude', organPreludeComposer: 'Bach', offertoryAnthem: 'Offertory A', communionHymn: 'Communion' },
  musicSun11am: { organPrelude: 'Prelude', organPreludeComposer: 'Bach', offertoryAnthem: 'Offertory B', communionHymn: 'Communion' },
  childrenLiturgyEnabled: true,
  childrenLiturgyMassTime: 'Sun 9:00 AM',
  childrenLiturgyMusic: 'Test Music',
  announcements: 'Test announcement.'
};

before(() => { fs.mkdirSync(outputDir, { recursive: true }); });
after(() => {
  const files = fs.readdirSync(outputDir);
  for (const f of files) fs.unlinkSync(path.join(outputDir, f));
  fs.rmdirSync(outputDir);
});

describe('buildFilename', () => {
  it('should produce YYYY_MM_DD__FeastName.pdf format', () => {
    const name = buildFilename({ liturgicalDate: '2026-03-01', feastName: 'Second Sunday of Lent' });
    assert.equal(name, '2026_03_01__Second_Sunday_of_Lent.pdf');
  });

  it('should handle missing date', () => {
    const name = buildFilename({ feastName: 'Test' });
    assert.ok(name.includes('Test'));
    assert.ok(name.endsWith('.pdf'));
  });
});

describe('generatePdf', () => {
  it('should create a PDF file', async () => {
    const pdfPath = path.join(outputDir, 'test-full.pdf');
    const result = await generatePdf(sampleData, pdfPath);
    assert.ok(fs.existsSync(pdfPath));
    assert.equal(result.outputPath, pdfPath);
  });

  it('should produce a valid PDF header', async () => {
    const pdfPath = path.join(outputDir, 'test-header.pdf');
    await generatePdf(sampleData, pdfPath);
    const header = fs.readFileSync(pdfPath, 'utf8').slice(0, 5);
    assert.equal(header, '%PDF-');
  });

  it('should return warnings array', async () => {
    const pdfPath = path.join(outputDir, 'test-warn.pdf');
    const result = await generatePdf(sampleData, pdfPath);
    assert.ok(Array.isArray(result.warnings));
  });

  it('should handle minimal data', async () => {
    const minimal = { feastName: 'Minimal', liturgicalDate: '2026-01-01', liturgicalSeason: 'ordinary', readings: { gospelCitation: 'John 1', gospelText: 'Word' } };
    const pdfPath = path.join(outputDir, 'test-min.pdf');
    const result = await generatePdf(minimal, pdfPath);
    assert.ok(fs.existsSync(pdfPath));
  });

  it('should produce 8-page PDF (substantial file size)', async () => {
    const pdfPath = path.join(outputDir, 'test-8p.pdf');
    await generatePdf(sampleData, pdfPath);
    const stats = fs.statSync(pdfPath);
    assert.ok(stats.size > 5000, `PDF should be >5KB, got ${stats.size}`);
  });

  it('should handle Nicene Creed selection', async () => {
    const data = { ...sampleData, seasonalSettings: { ...sampleData.seasonalSettings, creedType: 'nicene' } };
    const pdfPath = path.join(outputDir, 'test-nicene.pdf');
    const result = await generatePdf(data, pdfPath);
    assert.ok(fs.existsSync(pdfPath));
  });

  it('should accept parish settings', async () => {
    const pdfPath = path.join(outputDir, 'test-settings.pdf');
    const result = await generatePdf(sampleData, pdfPath, { parishSettings: { parishName: 'Test Parish', onelicenseNumber: 'A-123' } });
    assert.ok(fs.existsSync(pdfPath));
  });
});
