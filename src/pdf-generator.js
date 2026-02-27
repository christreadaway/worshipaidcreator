// PDF generation using PDFKit — creates print-ready 8-page worship aid
'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { APOSTLES_CREED, NICENE_CREED } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_STANDARD, LORDS_PRAYER } = require('./assets/text/mass-texts');
const { DEFAULT_COPYRIGHT } = require('./assets/text/copyright');

const PAGE_WIDTH = 612;   // 8.5in
const PAGE_HEIGHT = 792;  // 11in
const MARGIN = 54;        // 0.75in
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const COLORS = {
  primary: '#8B0000',
  text: '#1a1a1a',
  muted: '#555555',
  light: '#777777',
  border: '#cccccc'
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

class WorshipAidPdfGenerator {
  constructor(data, options = {}) {
    this.data = data;
    this.options = options;
    this.warnings = [];
    this.compact = data.compact || options.compact || false;
    this.bodySize = this.compact ? 9 : 10;
    this.isLenten = data.gospelAcclamation?.lenten || false;
  }

  generate(outputPath) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        bufferPages: true,
        info: {
          Title: `Worship Aid — ${this.data.occasionName}`,
          Author: 'Worship Aid Generator',
          Subject: this.data.occasionName,
          CreationDate: new Date()
        }
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      this.doc = doc;
      this.y = MARGIN;

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
    this.y = MARGIN;
  }

  addPageNumber(num) {
    this.doc.fontSize(8).fillColor(COLORS.light)
      .text(String(num), 0, PAGE_HEIGHT - 36, { width: PAGE_WIDTH, align: 'center' });
  }

  sectionTitle(text) {
    this.doc.fontSize(16).fillColor(COLORS.primary)
      .text(text, MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center', characterSpacing: 1 });
    this.y = this.doc.y + 8;
  }

  heading(text) {
    this.doc.fontSize(11).fillColor('#333333').font('Helvetica-Oblique')
      .text(text, MARGIN, this.y, { width: CONTENT_WIDTH });
    this.y = this.doc.y + 3;
    this.doc.font('Helvetica');
  }

  rubric(text) {
    this.doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica-Oblique')
      .text(text, MARGIN, this.y, { width: CONTENT_WIDTH });
    this.y = this.doc.y + 3;
    this.doc.font('Helvetica');
  }

  bodyText(text, opts = {}) {
    this.doc.fontSize(opts.size || this.bodySize)
      .fillColor(opts.color || COLORS.text)
      .font(opts.bold ? 'Helvetica-Bold' : opts.italic ? 'Helvetica-Oblique' : 'Helvetica')
      .text(text, opts.x || MARGIN, this.y, {
        width: opts.width || CONTENT_WIDTH,
        align: opts.align || 'left',
        lineGap: 2
      });
    this.y = this.doc.y + (opts.gap || 4);
    this.doc.font('Helvetica');
  }

  citation(text) {
    this.bodyText(text, { bold: true, color: '#333333', gap: 2 });
  }

  musicItem(title, composer, massTime) {
    let text = '';
    if (massTime) text += `(${massTime}) `;
    text += title;
    if (composer) text += ` — ${composer}`;
    this.doc.fontSize(this.bodySize).fillColor(COLORS.text).font('Helvetica-Oblique')
      .text(text, MARGIN, this.y, { width: CONTENT_WIDTH });
    this.y = this.doc.y + 3;
    this.doc.font('Helvetica');
  }

  renderPerMassItems(items) {
    if (!items || items.length === 0) return;
    const allSame = items.length === 1 || items.every(i => i.title === items[0].title);
    if (allSame) {
      this.musicItem(items[0].title, items[0].composer);
    } else {
      for (const item of items) {
        this.musicItem(item.title, item.composer, item.massTime);
      }
    }
  }

  addImage(imgPath, label) {
    if (!imgPath) {
      this.warnings.push(`Missing image for: ${label}`);
      this.renderPlaceholder(label);
      return;
    }
    const absPath = path.resolve(imgPath);
    if (!fs.existsSync(absPath)) {
      this.warnings.push(`Image file not found: ${imgPath} (for ${label})`);
      this.renderPlaceholder(label);
      return;
    }
    try {
      const img = this.doc.openImage(absPath);
      let w = Math.min(img.width, CONTENT_WIDTH);
      let h = (w / img.width) * img.height;
      if (h > 200) { h = 200; w = (h / img.height) * img.width; }
      const x = MARGIN + (CONTENT_WIDTH - w) / 2;
      this.doc.image(absPath, x, this.y, { width: w, height: h });
      this.y += h + 6;
    } catch {
      this.warnings.push(`Failed to load image: ${imgPath} (for ${label})`);
      this.renderPlaceholder(label);
    }
  }

  renderPlaceholder(label) {
    const h = 50;
    this.doc.save()
      .rect(MARGIN + 20, this.y, CONTENT_WIDTH - 40, h)
      .dash(3, { space: 3 })
      .strokeColor('#999999').stroke()
      .undash()
      .fontSize(10).fillColor('#666666').font('Helvetica-Oblique')
      .text(`[NOTATION: ${label}]`, MARGIN + 20, this.y + 16, {
        width: CONTENT_WIDTH - 40, align: 'center'
      })
      .restore();
    this.y += h + 8;
    this.doc.font('Helvetica');
  }

  drawBorder() {
    this.doc.save()
      .rect(MARGIN - 10, MARGIN - 10, CONTENT_WIDTH + 20, PAGE_HEIGHT - 2 * MARGIN + 20)
      .lineWidth(2)
      .strokeColor(COLORS.primary)
      .stroke()
      .restore();
  }

  // --- PAGE RENDERERS ---

  renderPage1Cover() {
    this.drawBorder();

    // Logo
    const logoPath = path.join(__dirname, 'assets', 'logo', 'jerusalem-cross.svg');
    // SVG not supported by PDFKit, draw a symbolic cross
    const cx = PAGE_WIDTH / 2;
    let cy = 200;
    this.doc.save().lineWidth(6).strokeColor(COLORS.primary);
    // Vertical
    this.doc.moveTo(cx, cy - 40).lineTo(cx, cy + 40).stroke();
    // Horizontal
    this.doc.moveTo(cx - 40, cy).lineTo(cx + 40, cy).stroke();
    // Small crosses
    const offsets = [[-25, -25], [25, -25], [-25, 25], [25, 25]];
    this.doc.lineWidth(2);
    for (const [ox, oy] of offsets) {
      this.doc.moveTo(cx + ox, cy + oy - 8).lineTo(cx + ox, cy + oy + 8).stroke();
      this.doc.moveTo(cx + ox - 8, cy + oy).lineTo(cx + ox + 8, cy + oy).stroke();
    }
    this.doc.restore();

    // Title
    this.y = 280;
    this.doc.fontSize(26).fillColor(COLORS.primary)
      .text(this.data.occasionName, MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 });
    this.y = this.doc.y + 8;

    // Date
    this.doc.fontSize(14).fillColor(COLORS.muted)
      .text(formatDate(this.data.occasionDate), MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 8;

    // Mass times
    this.doc.fontSize(11).fillColor(COLORS.muted)
      .text((this.data.massTimes || []).join('  •  '), MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 30;

    // Welcome
    this.doc.fontSize(11).fillColor('#333333').font('Helvetica-Oblique')
      .text('Welcome to our parish community.\nWe are glad you are here to worship with us today.',
        MARGIN + 40, this.y, { width: CONTENT_WIDTH - 80, align: 'center', lineGap: 4 });
    this.doc.font('Helvetica');
  }

  renderPage2IntroductoryRites() {
    this.newPage();
    this.sectionTitle('The Introductory Rites');

    if (this.data.organPrelude) {
      this.heading('Organ Prelude');
      this.musicItem(this.data.organPrelude.title, this.data.organPrelude.composer);
    }

    this.rubric(RUBRICS.stand);

    this.heading('Entrance Antiphon');
    if (this.data.entranceAntiphon?.citation) this.citation(this.data.entranceAntiphon.citation);
    if (this.data.entranceAntiphon?.imagePath) this.addImage(this.data.entranceAntiphon.imagePath, 'Entrance Antiphon');

    this.heading('Penitential Act');
    const penitentialText = (this.data.penitentialAct === 'default' || !this.data.penitentialAct) ? CONFITEOR : this.data.penitentialAct;
    this.bodyText(penitentialText, { size: this.compact ? 8 : 9 });

    this.heading('Kyrie');
    if (this.data.kyrieSettings && this.data.kyrieSettings.length > 0) {
      for (const k of this.data.kyrieSettings) {
        if (this.data.kyrieSettings.length > 1 && k.massTime) {
          this.musicItem(k.settingName || 'Kyrie', null, k.massTime);
        } else {
          this.musicItem(k.settingName || 'Kyrie');
        }
        if (k.imagePath) this.addImage(k.imagePath, k.settingName || 'Kyrie');
      }
    } else {
      this.musicItem('Kyrie eleison');
    }

    if (!this.isLenten && this.data.gloria !== false) {
      this.heading('Gloria');
      this.bodyText('Glory to God in the highest,\nand on earth peace to people of good will.', { size: 9 });
    }

    if (this.data.collect) {
      this.heading('Collect');
      this.bodyText(this.data.collect);
    }

    this.addPageNumber(2);
  }

  renderPage3LiturgyOfWord() {
    this.newPage();
    this.sectionTitle('The Liturgy of the Word');
    this.rubric(RUBRICS.sit);

    this.heading('First Reading');
    this.citation(this.data.firstReading.citation);
    this.bodyText(this.data.firstReading.text);

    this.heading('Responsorial Psalm');
    this.citation(this.data.responsorialPsalm.citation);
    if (this.data.responsorialPsalm.response) {
      this.bodyText(`R. ${this.data.responsorialPsalm.response}`, { bold: true });
    }
    if (this.data.responsorialPsalm.imagePath) {
      this.addImage(this.data.responsorialPsalm.imagePath, 'Responsorial Psalm');
    }
    if (this.data.responsorialPsalm.verses) {
      for (const v of this.data.responsorialPsalm.verses) {
        this.bodyText(v, { x: MARGIN + 20, width: CONTENT_WIDTH - 20 });
      }
    }

    if (this.data.secondReading) {
      this.heading('Second Reading');
      this.citation(this.data.secondReading.citation);
      this.bodyText(this.data.secondReading.text);
    }

    this.rubric(RUBRICS.stand);

    this.heading('Gospel Acclamation');
    const accText = this.isLenten ? GOSPEL_ACCLAMATION_LENTEN : GOSPEL_ACCLAMATION_STANDARD;
    this.bodyText(accText, { bold: true });
    if (this.data.gospelAcclamation?.verse) {
      this.bodyText(this.data.gospelAcclamation.verse);
    }
    if (this.data.gospelAcclamation?.imagePath) {
      this.addImage(this.data.gospelAcclamation.imagePath, 'Gospel Acclamation');
    }

    this.addPageNumber(3);
  }

  renderPage4GospelCreed() {
    this.newPage();

    this.heading('Gospel');
    this.citation(this.data.gospel.citation);
    this.bodyText(this.data.gospel.text);

    this.heading('Homily');
    this.rubric(RUBRICS.sit);
    this.y += 6;
    this.rubric(RUBRICS.stand);

    const creedTitle = this.data.creedType === 'apostles' ? "Apostles' Creed" : 'Nicene Creed';
    const creedText = this.data.creedType === 'apostles' ? APOSTLES_CREED : NICENE_CREED;
    this.heading(creedTitle);
    this.bodyText(creedText, { size: this.compact ? 7.5 : 8.5 });

    this.heading('Prayer of the Faithful');
    if (this.data.prayerOfTheFaithful) {
      this.bodyText(this.data.prayerOfTheFaithful);
    } else {
      this.rubric('Intentions are read; the assembly responds.');
    }

    if (this.data.announcements) {
      this.heading('Announcements');
      this.bodyText(this.data.announcements, { size: 9 });
    }

    this.addPageNumber(4);
  }

  renderPage5LiturgyEucharist() {
    this.newPage();
    this.sectionTitle('The Liturgy of the Eucharist');
    this.rubric(RUBRICS.sit);

    this.heading('Offertory');
    this.renderPerMassItems(this.data.offertoryAnthems);

    this.rubric(RUBRICS.stand);

    this.heading('Invitation to Prayer');
    this.bodyText(`Priest: ${INVITATION_TO_PRAYER.priest}`, { bold: true, size: 9 });
    this.bodyText(`All: ${INVITATION_TO_PRAYER.all}`, { bold: true, size: 9 });

    this.heading('Holy, Holy, Holy');
    if (this.data.holySanctus?.settingName) this.musicItem(this.data.holySanctus.settingName);
    if (this.data.holySanctus?.imagePath) this.addImage(this.data.holySanctus.imagePath, this.data.holySanctus?.settingName || 'Sanctus');

    this.rubric(RUBRICS.kneel);

    this.heading('Mystery of Faith');
    if (this.data.mysteryOfFaith?.settingName) this.musicItem(this.data.mysteryOfFaith.settingName);
    if (this.data.mysteryOfFaith?.imagePath) this.addImage(this.data.mysteryOfFaith.imagePath, this.data.mysteryOfFaith?.settingName || 'Mystery of Faith');

    this.addPageNumber(5);
  }

  renderPage6CommunionRite() {
    this.newPage();
    this.sectionTitle('The Communion Rite');

    this.heading("The Lord's Prayer");
    this.rubric(RUBRICS.stand);
    this.bodyText(LORDS_PRAYER, { size: 9 });

    this.heading('Lamb of God');
    if (this.data.agnus?.settingName) this.musicItem(this.data.agnus.settingName);
    if (this.data.agnus?.imagePath) this.addImage(this.data.agnus.imagePath, this.data.agnus?.settingName || 'Agnus Dei');

    this.rubric(RUBRICS.kneel);

    this.heading('Communion Antiphon');
    if (this.data.communionAntiphon?.imagePath) this.addImage(this.data.communionAntiphon.imagePath, 'Communion Antiphon');

    this.heading('Communion Hymn');
    this.renderPerMassItems(this.data.communionHymns);

    this.addPageNumber(6);
  }

  renderPage7ConcludingRites() {
    this.newPage();
    this.sectionTitle('The Concluding Rites');

    this.heading('Hymn of Thanksgiving');
    if (this.data.hymnThanksgiving?.title) this.musicItem(this.data.hymnThanksgiving.title);
    if (this.data.hymnThanksgiving?.imagePath) this.addImage(this.data.hymnThanksgiving.imagePath, this.data.hymnThanksgiving?.title || 'Thanksgiving Hymn');
    if (this.data.hymnThanksgiving?.yearAStanza) {
      this.bodyText(`Year A Stanza: ${this.data.hymnThanksgiving.yearAStanza}`, { size: 9 });
    }

    this.heading('Choral Anthem');
    this.renderPerMassItems(this.data.choralAnthems);

    this.rubric(RUBRICS.stand);

    if (this.data.prayerAfterCommunion) {
      this.heading('Prayer after Communion');
      this.bodyText(this.data.prayerAfterCommunion);
    }

    this.heading('Blessing & Dismissal');
    this.bodyText('Priest: The Lord be with you.\nAll: And with your spirit.', { bold: true, size: 9 });
    this.bodyText('Priest: May almighty God bless you, the Father, and the Son, \u2720 and the Holy Spirit.\nAll: Amen.', { size: 9 });
    this.bodyText('Deacon: Go forth, the Mass is ended.\nAll: Thanks be to God.', { size: 9 });

    this.addPageNumber(7);
  }

  renderPage8BackCover() {
    this.newPage();

    // Logo
    const cx = PAGE_WIDTH / 2;
    this.y = 150;
    this.doc.save().lineWidth(4).strokeColor(COLORS.primary);
    this.doc.moveTo(cx, this.y - 30).lineTo(cx, this.y + 30).stroke();
    this.doc.moveTo(cx - 30, this.y).lineTo(cx + 30, this.y).stroke();
    this.doc.lineWidth(1.5);
    const offsets = [[-18, -18], [18, -18], [-18, 18], [18, 18]];
    for (const [ox, oy] of offsets) {
      this.doc.moveTo(cx + ox, this.y + oy - 6).lineTo(cx + ox, this.y + oy + 6).stroke();
      this.doc.moveTo(cx + ox - 6, this.y + oy).lineTo(cx + ox + 6, this.y + oy).stroke();
    }
    this.doc.restore();

    this.y += 50;
    this.doc.fontSize(14).fillColor(COLORS.primary)
      .text(this.data.occasionName, MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 4;
    this.doc.fontSize(10).fillColor(COLORS.muted)
      .text(formatDate(this.data.occasionDate), MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + 30;

    // QR placeholders
    if (this.data.qrCodes) {
      const labels = [];
      if (this.data.qrCodes.give) labels.push('Give Online');
      if (this.data.qrCodes.join) labels.push('Join Us');
      if (this.data.qrCodes.bulletin) labels.push('Bulletin');
      const totalWidth = labels.length * 100;
      let startX = (PAGE_WIDTH - totalWidth) / 2;
      for (const label of labels) {
        this.doc.save()
          .rect(startX, this.y, 70, 70)
          .dash(2, { space: 2 }).strokeColor('#999999').stroke()
          .undash().restore();
        this.doc.fontSize(8).fillColor(COLORS.muted)
          .text(label, startX, this.y + 75, { width: 70, align: 'center' });
        startX += 100;
      }
      this.y += 100;
    }

    // Social handles
    if (this.data.socialHandles) {
      const parts = [];
      if (this.data.socialHandles.instagram) parts.push(`@${this.data.socialHandles.instagram}`);
      if (this.data.socialHandles.facebook) parts.push(this.data.socialHandles.facebook);
      if (this.data.socialHandles.youtube) parts.push(this.data.socialHandles.youtube);
      this.doc.fontSize(10).fillColor(COLORS.muted)
        .text(parts.join('   |   '), MARGIN, this.y, { width: CONTENT_WIDTH, align: 'center' });
      this.y = this.doc.y + 20;
    }

    // Copyright
    const copyright = this.data.copyrightBlock || DEFAULT_COPYRIGHT;
    this.doc.fontSize(7.5).fillColor(COLORS.light)
      .text(copyright, MARGIN, PAGE_HEIGHT - MARGIN - 80, {
        width: CONTENT_WIDTH, align: 'center', lineGap: 2
      });
  }
}

async function generatePdf(data, outputPath, options = {}) {
  const generator = new WorshipAidPdfGenerator(data, options);
  return generator.generate(outputPath);
}

module.exports = { generatePdf, WorshipAidPdfGenerator };
