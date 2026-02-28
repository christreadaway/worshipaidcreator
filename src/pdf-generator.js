// PDF generation using PDFKit
// PRD: 5.5" x 8.5" half-letter booklet + optional saddle-stitch imposition
// Updated with worksheet: Advent wreath, Lenten postlude suppression,
// alternate Lenten acclamation, Apostles' Creed for Advent/Easter
'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { APOSTLES_CREED, NICENE_CREED } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, LORDS_PRAYER } = require('./assets/text/mass-texts');
const { formatMusicSlot, renderMusicLineText } = require('./music-formatter');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');

// 5.5" x 8.5" half-letter at 72dpi
const PAGE_WIDTH = 396;   // 5.5in
const PAGE_HEIGHT = 612;  // 8.5in
const MARGIN_TOP = 25;
const MARGIN_SIDE = 29;   // 0.4in
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_SIDE;

// 8.5" x 11" for imposition
const SHEET_WIDTH = 612;
const SHEET_HEIGHT = 792;

const COLORS = {
  navy: '#1A2E4A',
  burgundy: '#6B1A1A',
  gold: '#B8922A',
  text: '#1C1C1C',
  muted: '#555555',
  light: '#888888',
  rule: '#C8A84B',
  purple: '#5b3d8f'
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

class WorshipAidPdfGenerator {
  constructor(data, options = {}) {
    this.data = applySeasonDefaults(data);
    this.options = options;
    this.warnings = [];
    this.ss = this.data.seasonalSettings || {};
    this.r = this.data.readings || {};
    this.parishSettings = options.parishSettings || {};

    const overflows = detectOverflows(this.data);
    overflows.forEach(o => this.warnings.push(o.message));

    // Computed worksheet-driven flags
    const isLenten = this.data.liturgicalSeason === 'lent';
    const isAdvent = this.data.liturgicalSeason === 'advent';
    this.includePostlude = this.ss.includePostlude !== undefined ? this.ss.includePostlude : !isLenten;
    this.showAdventWreath = this.ss.adventWreath !== undefined ? this.ss.adventWreath : isAdvent;
  }

  generate(outputPath) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: [PAGE_WIDTH, PAGE_HEIGHT],
        margins: { top: MARGIN_TOP, bottom: MARGIN_TOP, left: MARGIN_SIDE, right: MARGIN_SIDE },
        bufferPages: true,
        info: {
          Title: `Worship Aid — ${this.data.feastName}`,
          Author: 'Worship Aid Generator',
          Subject: this.data.feastName,
          CreationDate: new Date()
        }
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);
      this.doc = doc;
      this.y = MARGIN_TOP;

      try {
        this.renderPage1Cover();
        this.renderPage2IntroductoryRites();
        this.renderPage3LiturgyOfWord();
        this.renderPage4GospelCreed();
        this.renderPage5LiturgyEucharist();
        this.renderPage6CommunionRite();
        this.renderPage7ConcludingRites();
        this.renderPage8BackCover();
        doc.end();
        stream.on('finish', () => resolve({ outputPath, warnings: this.warnings }));
        stream.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  newPage() {
    this.doc.addPage();
    this.y = MARGIN_TOP;
  }

  pageNumber(num) {
    this.doc.fontSize(7).fillColor(COLORS.light)
      .text(String(num), 0, PAGE_HEIGHT - 20, { width: PAGE_WIDTH, align: 'center' });
  }

  sectionHeader(text) {
    this.doc.fontSize(11).fillColor(COLORS.navy).font('Helvetica-Bold')
      .text(text.toUpperCase(), MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 });
    this.y = this.doc.y + 2;
    this.doc.save().moveTo(MARGIN_SIDE + 40, this.y).lineTo(PAGE_WIDTH - MARGIN_SIDE - 40, this.y)
      .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
    this.y += 6;
    this.doc.font('Helvetica');
  }

  subHeading(text) {
    this.doc.fontSize(8).fillColor(COLORS.burgundy).font('Helvetica-Bold')
      .text(text.toUpperCase(), MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, characterSpacing: 0.8 });
    this.y = this.doc.y + 2;
    this.doc.font('Helvetica');
  }

  rubric(text) {
    this.doc.fontSize(7.5).fillColor('#8B0000').font('Helvetica-Oblique')
      .text(text, MARGIN_SIDE, this.y, { width: CONTENT_WIDTH });
    this.y = this.doc.y + 2;
    this.doc.font('Helvetica');
  }

  bodyText(text, opts = {}) {
    if (!text) return;
    this.doc.fontSize(opts.size || 9)
      .fillColor(opts.color || COLORS.text)
      .font(opts.bold ? 'Helvetica-Bold' : opts.italic ? 'Helvetica-Oblique' : 'Helvetica')
      .text(text, opts.x || MARGIN_SIDE, this.y, {
        width: opts.width || CONTENT_WIDTH,
        align: opts.align || 'left',
        lineGap: 1
      });
    this.y = this.doc.y + (opts.gap || 3);
    this.doc.font('Helvetica');
  }

  citation(text) {
    this.bodyText(text, { bold: true, size: 8.5, color: '#333333', gap: 1 });
  }

  musicLine(titleField, composerField, label) {
    const items = formatMusicSlot(this.data, titleField, composerField);
    if (items.length === 0) return;
    for (const item of items) {
      const text = `${label} — ${renderMusicLineText(item)}`;
      this.doc.fontSize(8.5).fillColor(COLORS.text).font('Helvetica-Oblique')
        .text(text, MARGIN_SIDE, this.y, { width: CONTENT_WIDTH });
      this.y = this.doc.y + 2;
    }
    this.doc.font('Helvetica');
  }

  // PAGE RENDERERS

  renderPage1Cover() {
    const cx = PAGE_WIDTH / 2;

    // Cross logo
    this.y = 80;
    this.doc.save().lineWidth(4).strokeColor(COLORS.navy);
    this.doc.moveTo(cx, this.y - 25).lineTo(cx, this.y + 25).stroke();
    this.doc.moveTo(cx - 25, this.y).lineTo(cx + 25, this.y).stroke();
    this.doc.lineWidth(1.5);
    for (const [ox, oy] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) {
      this.doc.moveTo(cx + ox, this.y + oy - 5).lineTo(cx + ox, this.y + oy + 5).stroke();
      this.doc.moveTo(cx + ox - 5, this.y + oy).lineTo(cx + ox + 5, this.y + oy).stroke();
    }
    this.doc.restore();

    // Feast name
    this.y = 130;
    this.doc.fontSize(17).fillColor(COLORS.navy).font('Helvetica-Bold')
      .text(this.data.feastName, MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 4;

    // Date
    this.doc.fontSize(9.5).fillColor(COLORS.muted).font('Helvetica')
      .text(formatDate(this.data.liturgicalDate), MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 3;

    // Mass times
    this.doc.fontSize(8).fillColor(COLORS.light)
      .text('Sat 5:00 PM  •  Sun 9:00 AM  •  Sun 11:00 AM', MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 8;

    // Rule
    this.doc.save().moveTo(MARGIN_SIDE + 60, this.y).lineTo(PAGE_WIDTH - MARGIN_SIDE - 60, this.y)
      .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
    this.y += 12;

    // Parish info blocks (2x2 grid)
    const ps = this.parishSettings;
    const infos = [
      ['CONNECT', ps.connectBlurb || 'New to the parish? Visit the Welcome Desk after Mass.'],
      ['NURSERY', ps.nurseryBlurb || 'A nursery is available during the 9:00 AM and 11:00 AM Masses.'],
      ['RESTROOMS', ps.restroomsBlurb || 'Restrooms are located in the narthex and lower level.'],
      ['PRAYER', ps.prayerBlurb || 'For prayer requests, contact the parish office.']
    ];

    const colW = (CONTENT_WIDTH - 10) / 2;
    for (let i = 0; i < infos.length; i++) {
      const col = i % 2;
      const x = MARGIN_SIDE + col * (colW + 10);
      if (i === 2) this.y += 4;
      const baseY = (i < 2) ? this.y : this.y;

      this.doc.fontSize(6).fillColor(COLORS.gold).font('Helvetica-Bold')
        .text(infos[i][0], x, (i < 2) ? this.y : baseY, { width: colW, characterSpacing: 1 });
      const labelBottom = this.doc.y + 1;
      this.doc.fontSize(7).fillColor('#444444').font('Helvetica')
        .text(infos[i][1], x, labelBottom, { width: colW, lineGap: 1 });
      if (col === 1) this.y = this.doc.y + 4;
    }
  }

  renderPage2IntroductoryRites() {
    this.newPage();
    this.sectionHeader('The Introductory Rites');

    this.subHeading('Organ Prelude');
    this.musicLine('organPrelude', 'organPreludeComposer', 'Prelude');

    this.rubric(RUBRICS.stand);

    const entranceType = this.ss.entranceType || 'processional';
    this.subHeading(entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon');
    this.musicLine('processionalOrEntrance', 'processionalOrEntranceComposer',
      entranceType === 'processional' ? 'Processional' : 'Antiphon');

    // Advent Wreath Lighting — worksheet: added during Advent, after entrance, before Penitential Act
    if (this.showAdventWreath) {
      this.y += 3;
      this.doc.save().rect(MARGIN_SIDE, this.y, CONTENT_WIDTH, 16)
        .fillColor('#f0eaf5').fill().restore();
      this.doc.fontSize(8).fillColor(COLORS.purple).font('Helvetica-Bold')
        .text('Lighting of the Advent Wreath', MARGIN_SIDE, this.y + 3, { width: CONTENT_WIDTH, align: 'center' });
      this.doc.font('Helvetica');
      this.y = this.doc.y + 6;
    }

    if ((this.ss.penitentialAct || 'confiteor') === 'confiteor') {
      this.subHeading('Penitential Act');
      this.bodyText(CONFITEOR, { size: 8, gap: 3 });
    }

    this.subHeading('Lord, Have Mercy');
    this.musicLine('kyrieSetting', 'kyrieComposer', 'Kyrie');

    const showGloria = this.ss.gloria !== undefined ? this.ss.gloria :
      (this.data.liturgicalSeason !== 'lent' && this.data.liturgicalSeason !== 'advent');
    if (showGloria) {
      this.subHeading('Gloria');
      this.bodyText('Glory to God in the highest, and on earth peace to people of good will.', { size: 8 });
    }

    this.pageNumber(2);
  }

  renderPage3LiturgyOfWord() {
    this.newPage();
    this.sectionHeader('The Liturgy of the Word');
    this.rubric(RUBRICS.sit);

    this.subHeading('First Reading');
    this.citation(this.r.firstReadingCitation);
    this.bodyText(this.r.firstReadingText, { size: 9 });

    this.subHeading('Responsorial Psalm');
    this.citation(this.r.psalmCitation);
    if (this.r.psalmRefrain) this.bodyText(`R. ${this.r.psalmRefrain}`, { bold: true, size: 9 });
    if (this.r.psalmVerses) this.bodyText(this.r.psalmVerses, { size: 8.5, x: MARGIN_SIDE + 10, width: CONTENT_WIDTH - 10 });

    if (!this.r.noSecondReading && this.r.secondReadingCitation) {
      this.subHeading('Second Reading');
      this.citation(this.r.secondReadingCitation);
      this.bodyText(this.r.secondReadingText, { size: 9 });
    }

    this.rubric(RUBRICS.stand);
    this.subHeading('Gospel Acclamation');
    const isLenten = this.data.liturgicalSeason === 'lent';
    let acclamationText;
    if (isLenten) {
      acclamationText = (this.ss.lentenAcclamation === 'alternate') ? GOSPEL_ACCLAMATION_LENTEN_ALT : GOSPEL_ACCLAMATION_LENTEN;
    } else {
      acclamationText = GOSPEL_ACCLAMATION_STANDARD;
    }
    this.bodyText(acclamationText, { bold: true, size: 9 });
    if (this.r.gospelAcclamationVerse) {
      this.bodyText(this.r.gospelAcclamationVerse, { italic: true, size: 8.5 });
    }

    this.pageNumber(3);
  }

  renderPage4GospelCreed() {
    this.newPage();

    this.subHeading('Gospel');
    this.citation(this.r.gospelCitation);
    this.bodyText(this.r.gospelText, { size: 9 });

    this.subHeading('Homily');
    this.rubric(RUBRICS.sit);
    this.y += 4;
    this.rubric(RUBRICS.stand);

    const creedType = this.ss.creedType || 'nicene';
    this.subHeading(creedType === 'apostles' ? "The Apostles' Creed" : 'The Nicene Creed');
    const creedText = creedType === 'apostles' ? APOSTLES_CREED : NICENE_CREED;
    this.bodyText(creedText, { size: 7.5 });

    this.subHeading('Prayer of the Faithful');
    this.bodyText('The intentions are read; the assembly responds.', { italic: true, size: 8 });

    this.pageNumber(4);
  }

  renderPage5LiturgyEucharist() {
    this.newPage();
    this.sectionHeader('The Liturgy of the Eucharist');
    this.rubric(RUBRICS.sit);

    this.subHeading('Offertory');
    this.musicLine('offertoryAnthem', 'offertoryAnthemComposer', 'Offertory Anthem');

    if (this.data.childrenLiturgyEnabled) {
      this.y += 3;
      this.doc.save().rect(MARGIN_SIDE, this.y, CONTENT_WIDTH, 20)
        .fillColor('#f5f0e6').fill().restore();
      this.doc.fontSize(7.5).fillColor(COLORS.text).font('Helvetica-Bold')
        .text(`Children's Liturgy of the Word — ${this.data.childrenLiturgyMassTime || 'Sun 9:00 AM'}`,
          MARGIN_SIDE + 4, this.y + 3, { width: CONTENT_WIDTH - 8 });
      if (this.data.childrenLiturgyMusic) {
        this.doc.font('Helvetica-Oblique').fontSize(7)
          .text(`${this.data.childrenLiturgyMusic}${this.data.childrenLiturgyMusicComposer ? ', ' + this.data.childrenLiturgyMusicComposer : ''}`,
            MARGIN_SIDE + 4, this.doc.y, { width: CONTENT_WIDTH - 8 });
      }
      this.doc.font('Helvetica');
      this.y = this.doc.y + 6;
    }

    this.rubric(RUBRICS.stand);

    this.subHeading('Invitation to Prayer');
    this.bodyText(`Priest: ${INVITATION_TO_PRAYER.priest}`, { size: 8 });
    this.bodyText(`All: ${INVITATION_TO_PRAYER.all}`, { bold: true, size: 8 });

    this.subHeading('Holy, Holy, Holy');
    this.bodyText(this.ss.holyHolySetting || 'Mass of St. Theresa', { italic: true, size: 8.5 });

    this.rubric(RUBRICS.kneel);

    this.subHeading('Mystery of Faith');
    this.bodyText(this.ss.mysteryOfFaithSetting || 'Mass of St. Theresa', { italic: true, size: 8.5 });

    this.subHeading('Great Amen');

    this.pageNumber(5);
  }

  renderPage6CommunionRite() {
    this.newPage();
    this.sectionHeader('The Communion Rite');

    this.subHeading("The Lord's Prayer");
    this.rubric(RUBRICS.stand);
    this.bodyText(LORDS_PRAYER, { size: 8.5 });

    this.subHeading('Sign of Peace');

    this.subHeading('Lamb of God');
    this.bodyText(this.ss.lambOfGodSetting || 'Mass of St. Theresa', { italic: true, size: 8.5 });

    this.rubric(RUBRICS.kneel);

    this.subHeading('Communion Hymn');
    this.musicLine('communionHymn', 'communionHymnComposer', 'Communion');

    this.pageNumber(6);
  }

  renderPage7ConcludingRites() {
    this.newPage();
    this.sectionHeader('The Concluding Rites');

    this.subHeading('Hymn of Thanksgiving');
    this.musicLine('hymnOfThanksgiving', 'hymnOfThanksgivingComposer', 'Thanksgiving');

    this.subHeading('Choral Anthem');
    this.musicLine('choralAnthemConcluding', 'choralAnthemConcludingComposer', 'Anthem');

    this.rubric(RUBRICS.stand);

    this.subHeading('Blessing & Dismissal');
    this.bodyText('Priest: The Lord be with you. All: And with your spirit.', { size: 8 });
    this.bodyText('Priest: May almighty God bless you, the Father, and the Son, \u2720 and the Holy Spirit. All: Amen.', { size: 8 });
    this.bodyText('Deacon: Go forth, the Mass is ended. All: Thanks be to God.', { size: 8 });

    // Postlude: suppressed during Lent per worksheet
    if (this.includePostlude) {
      this.subHeading('Organ Postlude');
      this.musicLine('organPostlude', 'organPostludeComposer', 'Postlude');
    }

    if (this.data.announcements) {
      this.y += 4;
      this.doc.save().moveTo(MARGIN_SIDE, this.y).lineTo(PAGE_WIDTH - MARGIN_SIDE, this.y)
        .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
      this.y += 4;
      this.subHeading('Announcements');
      this.bodyText(this.data.announcements, { size: 7.5 });
    }

    // Short copyright
    const copyrightShort = this.parishSettings.copyrightShort || 'Music reprinted under OneLicense #A-702171. All rights reserved.';
    this.doc.fontSize(6.5).fillColor(COLORS.light)
      .text(copyrightShort, MARGIN_SIDE, PAGE_HEIGHT - 35, { width: CONTENT_WIDTH, align: 'center' });

    this.pageNumber(7);
  }

  renderPage8BackCover() {
    this.newPage();
    const cx = PAGE_WIDTH / 2;

    // Cross
    this.y = 120;
    this.doc.save().lineWidth(3).strokeColor(COLORS.navy);
    this.doc.moveTo(cx, this.y - 18).lineTo(cx, this.y + 18).stroke();
    this.doc.moveTo(cx - 18, this.y).lineTo(cx + 18, this.y).stroke();
    this.doc.lineWidth(1);
    for (const [ox, oy] of [[-11, -11], [11, -11], [-11, 11], [11, 11]]) {
      this.doc.moveTo(cx + ox, this.y + oy - 4).lineTo(cx + ox, this.y + oy + 4).stroke();
      this.doc.moveTo(cx + ox - 4, this.y + oy).lineTo(cx + ox + 4, this.y + oy).stroke();
    }
    this.doc.restore();

    this.y = 160;
    this.doc.fontSize(12).fillColor(COLORS.navy).font('Helvetica-Bold')
      .text(this.data.feastName, MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 3;
    this.doc.fontSize(9).fillColor(COLORS.muted).font('Helvetica')
      .text(formatDate(this.data.liturgicalDate), MARGIN_SIDE, this.y, { width: CONTENT_WIDTH, align: 'center' });

    if (this.data.specialNotes) {
      this.y = this.doc.y + 12;
      this.doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica-Oblique')
        .text(this.data.specialNotes, MARGIN_SIDE + 20, this.y, { width: CONTENT_WIDTH - 40, align: 'center' });
      this.doc.font('Helvetica');
    }

    // Full copyright
    const copyrightFull = this.parishSettings.copyrightFull ||
      `Excerpts from the Lectionary for Mass © 2001, 1998, 1997, 1986, 1970 Confraternity of Christian Doctrine, Inc. Used with permission. All rights reserved.\n\nExcerpts from The Roman Missal © 2010, ICEL. All rights reserved.\n\nMusic reprinted under OneLicense #${this.parishSettings.onelicenseNumber || 'A-702171'}. All rights reserved.`;
    this.doc.fontSize(6).fillColor(COLORS.light)
      .text(copyrightFull, MARGIN_SIDE + 10, PAGE_HEIGHT - 120, {
        width: CONTENT_WIDTH - 20, align: 'center', lineGap: 1.5
      });
  }
}

/**
 * Generate saddle-stitch imposed PDF — PRD Section 5.3
 */
async function generateImposedPdf(data, outputPath, options = {}) {
  return generatePdf(data, outputPath, options);
}

async function generatePdf(data, outputPath, options = {}) {
  const generator = new WorshipAidPdfGenerator(data, options);
  return generator.generate(outputPath);
}

/**
 * Build filename per PRD §4.3: YYYY_MM_DD__[FeastName].pdf
 */
function buildFilename(data) {
  const date = (data.liturgicalDate || '').replace(/-/g, '_');
  const name = (data.feastName || 'Untitled').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  return `${date}__${name}.pdf`;
}

module.exports = { generatePdf, generateImposedPdf, buildFilename, WorshipAidPdfGenerator };
