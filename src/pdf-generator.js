// PDF generation using PDFKit
// Supports two finished booklet sizes:
//   - half-letter:  5.5" x 8.5"  (printed 8.5x11 folded saddle-stitch)
//   - tabloid:      8.5" x 11"   (printed 11x17 folded saddle-stitch)
// Both use 1" margins and scale fonts/spacing proportionally so layouts
// stay visually consistent. Imposition for saddle-stitch is left to the
// printer driver (Acrobat / PDF reader booklet print mode).
'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { APOSTLES_CREED, NICENE_CREED, RENEWAL_OF_BAPTISMAL_VOWS } = require('./assets/text/creeds');
const { CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT, GOSPEL_ACCLAMATION_STANDARD, LORDS_PRAYER } = require('./assets/text/mass-texts');
const { formatMusicSlot, renderMusicLineText } = require('./music-formatter');
const { applySeasonDefaults } = require('./config/seasons');
const { detectOverflows } = require('./validator');

// 72pt = 1 inch
const PT = 72;

// Layouts. All values in PDF points (72 = 1 inch).
// Tabloid uses 1" margins (page is large enough that this still leaves a
// comfortable 6.5"×9" content rectangle). Half-letter would be too tight at
// 1" (3.5"×6.5"), so we use 0.5" there to keep the standard 8-page Mass
// booklet from overflowing onto extra pages.
const LAYOUTS = {
  'half-letter': {
    pageWidth:  5.5 * PT,
    pageHeight: 8.5 * PT,
    margin:     0.5 * PT,
    scale:      1.0
  },
  tabloid: {
    pageWidth:  8.5 * PT,
    pageHeight: 11.0 * PT,
    margin:     1.0 * PT,
    // Scale fonts and spacing proportionally to page height so larger
    // booklets feel similar in density. 8.5*11 / 5.5*8.5 in linear height.
    scale:      11.0 / 8.5  // ≈ 1.294
  }
};

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

function resolveLayout(bookletSize) {
  return LAYOUTS[bookletSize] || LAYOUTS['half-letter'];
}

class WorshipAidPdfGenerator {
  constructor(data, options = {}) {
    this.data = applySeasonDefaults(data);
    this.options = options;
    this.warnings = [];
    this.ss = this.data.seasonalSettings || {};
    this.r = this.data.readings || {};
    this.parishSettings = options.parishSettings || {};

    this.bookletSize = options.bookletSize || 'half-letter';
    const L = resolveLayout(this.bookletSize);
    this.PAGE_WIDTH    = L.pageWidth;
    this.PAGE_HEIGHT   = L.pageHeight;
    this.MARGIN        = L.margin;
    this.MARGIN_TOP    = L.margin;
    this.MARGIN_SIDE   = L.margin;
    this.CONTENT_WIDTH = this.PAGE_WIDTH - 2 * this.MARGIN;
    this.scale         = L.scale;

    const overflows = detectOverflows(this.data);
    overflows.forEach(o => this.warnings.push(o.message));

    const isLenten = this.data.liturgicalSeason === 'lent';
    const isAdvent = this.data.liturgicalSeason === 'advent';
    this.includePostlude = this.ss.includePostlude !== undefined ? this.ss.includePostlude : !isLenten;
    this.showAdventWreath = this.ss.adventWreath !== undefined ? this.ss.adventWreath : isAdvent;

    // Page-level state used by tests and bounds tracking
    this._maxYReached = 0;
    this.pageEvents = [];
  }

  // Scale a base font/spacing value by the layout's scale factor.
  s(n) { return n * this.scale; }

  generate(outputPath) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: [this.PAGE_WIDTH, this.PAGE_HEIGHT],
        margins: { top: this.MARGIN_TOP, bottom: this.MARGIN_TOP, left: this.MARGIN_SIDE, right: this.MARGIN_SIDE },
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
      this.y = this.MARGIN_TOP;

      try {
        this.renderPage1Cover();
        this.renderPage2IntroductoryRites();
        this.renderPage3LiturgyOfWord();
        this.renderPage4GospelCreed();
        this.renderPage5LiturgyEucharist();
        this.renderPage6CommunionRite();
        this.renderPage7ConcludingRites();
        this.renderPage8BackCover();
        // Capture the final page's maxY for layout introspection.
        this.pageEvents.push({ maxY: this._maxYReached });
        const bufferedPageCount = doc.bufferedPageRange().count;
        doc.end();
        const pageMaxY = this.pageEvents.map(p => p.maxY);
        stream.on('finish', () => resolve({
          outputPath,
          warnings: this.warnings,
          bookletSize: this.bookletSize,
          pageWidth: this.PAGE_WIDTH,
          pageHeight: this.PAGE_HEIGHT,
          margin: this.MARGIN,
          pageMaxY,
          pageCount: bufferedPageCount
        }));
        stream.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Track the lowest Y coordinate written on the current page so tests can
  // verify no content has run past the bottom margin.
  _trackY() {
    if (this.doc.y > this._maxYReached) this._maxYReached = this.doc.y;
    if (this.y > this._maxYReached)     this._maxYReached = this.y;
  }

  newPage() {
    this.pageEvents.push({ maxY: this._maxYReached });
    this._maxYReached = 0;
    this.doc.addPage();
    this.y = this.MARGIN_TOP;
  }

  pageNumber(num) {
    this.doc.fontSize(this.s(7)).fillColor(COLORS.light)
      .text(String(num), 0, this.PAGE_HEIGHT - this.MARGIN * 0.6, { width: this.PAGE_WIDTH, align: 'center' });
  }

  sectionHeader(text) {
    this.doc.fontSize(this.s(11)).fillColor(COLORS.navy).font('Helvetica-Bold')
      .text(text.toUpperCase(), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 });
    this.y = this.doc.y + this.s(2);
    this.doc.save()
      .moveTo(this.MARGIN_SIDE + this.s(40), this.y)
      .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE - this.s(40), this.y)
      .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
    this.y += this.s(6);
    this.doc.font('Helvetica');
    this._trackY();
  }

  subHeading(text) {
    this.doc.fontSize(this.s(8)).fillColor(COLORS.burgundy).font('Helvetica-Bold')
      .text(text.toUpperCase(), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, characterSpacing: 0.8 });
    this.y = this.doc.y + this.s(2);
    this.doc.font('Helvetica');
    this._trackY();
  }

  rubric(text) {
    this.doc.fontSize(this.s(7.5)).fillColor('#8B0000').font('Helvetica-Oblique')
      .text(text, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH });
    this.y = this.doc.y + this.s(2);
    this.doc.font('Helvetica');
    this._trackY();
  }

  bodyText(text, opts = {}) {
    if (!text) return;
    const baseSize = opts.size || 9;
    this.doc.fontSize(this.s(baseSize))
      .fillColor(opts.color || COLORS.text)
      .font(opts.bold ? 'Helvetica-Bold' : opts.italic ? 'Helvetica-Oblique' : 'Helvetica');
    const x = opts.x !== undefined ? opts.x : this.MARGIN_SIDE;
    const width = opts.width !== undefined ? opts.width : this.CONTENT_WIDTH;
    this.doc.text(text, x, this.y, {
      width,
      align: opts.align || 'left',
      lineGap: this.s(1)
    });
    this.y = this.doc.y + this.s(opts.gap !== undefined ? opts.gap : 3);
    this.doc.font('Helvetica');
    this._trackY();
  }

  citation(text) {
    this.bodyText(text, { bold: true, size: 8.5, color: '#333333', gap: 1 });
  }

  musicLine(titleField, composerField, label) {
    const items = formatMusicSlot(this.data, titleField, composerField);
    if (items.length === 0) return;
    for (const item of items) {
      const text = `${label} — ${renderMusicLineText(item)}`;
      this.doc.fontSize(this.s(8.5)).fillColor(COLORS.text).font('Helvetica-Oblique')
        .text(text, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH });
      this.y = this.doc.y + this.s(2);
      this._trackY();
    }
    this.doc.font('Helvetica');
  }

  // Resolve a parish-supplied logo path to a filesystem path PDFKit can read.
  // Accepts a /uploads/... URL relative to the data dir, an absolute path,
  // or returns null if no logo is configured / the file is missing.
  _resolveLogoPath() {
    const raw = this.parishSettings.logoPath;
    if (!raw) return null;
    if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
    const stripped = raw.replace(/^\/+/, '');
    const candidates = [
      path.join(__dirname, '..', 'data', stripped),
      path.join(__dirname, '..', stripped),
      path.join(process.cwd(), stripped),
      path.join(process.cwd(), 'data', stripped)
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  _drawDefaultCross(cx, y) {
    const armLen = this.s(25);
    this.doc.save().lineWidth(this.s(4)).strokeColor(COLORS.navy);
    this.doc.moveTo(cx, y - armLen).lineTo(cx, y + armLen).stroke();
    this.doc.moveTo(cx - armLen, y).lineTo(cx + armLen, y).stroke();
    this.doc.lineWidth(this.s(1.5));
    const corner = this.s(15), tick = this.s(5);
    for (const [ox, oy] of [[-corner, -corner], [corner, -corner], [-corner, corner], [corner, corner]]) {
      this.doc.moveTo(cx + ox, y + oy - tick).lineTo(cx + ox, y + oy + tick).stroke();
      this.doc.moveTo(cx + ox - tick, y + oy).lineTo(cx + ox + tick, y + oy).stroke();
    }
    this.doc.restore();
  }

  // PAGE RENDERERS ============================================

  renderPage1Cover() {
    const cx = this.PAGE_WIDTH / 2;
    const usableTop = this.MARGIN_TOP;

    // Logo: parish-uploaded image when present, otherwise the default cross.
    this.y = usableTop + this.s(40);
    const logoPath = this._resolveLogoPath();
    if (logoPath) {
      const targetH = this.s(60);
      try {
        this.doc.image(logoPath, cx - this.s(60), usableTop + this.s(10), {
          fit: [this.s(120), targetH], align: 'center', valign: 'top'
        });
      } catch (e) {
        // Fall back to the default cross if the image can't be loaded.
        this._drawDefaultCross(cx, this.y);
        this.warnings.push(`Cover logo could not be loaded: ${e.message}`);
      }
    } else {
      this._drawDefaultCross(cx, this.y);
    }

    // Parish name (if persistent branding is configured)
    let nameY = usableTop + this.s(95);
    if (this.parishSettings.parishName) {
      this.doc.fontSize(this.s(11)).fillColor(COLORS.gold).font('Helvetica-Bold')
        .text(this.parishSettings.parishName.toUpperCase(), this.MARGIN_SIDE, nameY,
          { width: this.CONTENT_WIDTH, align: 'center', characterSpacing: 1.5 });
      nameY = this.doc.y + this.s(2);
      if (this.parishSettings.coverTagline) {
        this.doc.fontSize(this.s(8)).fillColor(COLORS.muted).font('Helvetica-Oblique')
          .text(this.parishSettings.coverTagline, this.MARGIN_SIDE, nameY,
            { width: this.CONTENT_WIDTH, align: 'center' });
        nameY = this.doc.y + this.s(4);
      }
      nameY += this.s(4);
    }

    // Feast name
    this.y = nameY;
    this.doc.fontSize(this.s(20)).fillColor(COLORS.navy).font('Helvetica-Bold')
      .text(this.data.feastName, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(6);

    this.doc.fontSize(this.s(11)).fillColor(COLORS.muted).font('Helvetica')
      .text(formatDate(this.data.liturgicalDate), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(3);

    this.doc.fontSize(this.s(9)).fillColor(COLORS.light)
      .text('Sat 5:00 PM  •  Sun 9:00 AM  •  Sun 11:00 AM', this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(10);

    this.doc.save()
      .moveTo(this.MARGIN_SIDE + this.s(60), this.y)
      .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE - this.s(60), this.y)
      .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
    this.y += this.s(14);

    // Parish info blocks (2x2 grid)
    const ps = this.parishSettings;
    const infos = [
      ['CONNECT', ps.connectBlurb || 'New to the parish? Visit the Welcome Desk after Mass.'],
      ['NURSERY', ps.nurseryBlurb || 'A nursery is available during the 9:00 AM and 11:00 AM Masses.'],
      ['RESTROOMS', ps.restroomsBlurb || 'Restrooms are located in the narthex and lower level.'],
      ['PRAYER', ps.prayerBlurb || 'For prayer requests, contact the parish office.']
    ];

    const gridGap = this.s(12);
    const colW = (this.CONTENT_WIDTH - gridGap) / 2;
    let rowY = this.y;
    for (let i = 0; i < infos.length; i++) {
      const col = i % 2;
      const x = this.MARGIN_SIDE + col * (colW + gridGap);

      this.doc.fontSize(this.s(7)).fillColor(COLORS.gold).font('Helvetica-Bold')
        .text(infos[i][0], x, rowY, { width: colW, characterSpacing: 1 });
      const labelBottom = this.doc.y + this.s(1);
      this.doc.fontSize(this.s(8)).fillColor('#444444').font('Helvetica')
        .text(infos[i][1], x, labelBottom, { width: colW, lineGap: this.s(1) });
      if (col === 1) {
        rowY = this.doc.y + this.s(6);
      }
    }
    this.y = rowY;
    this._trackY();
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

    if (this.showAdventWreath) {
      this.y += this.s(3);
      this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, this.s(18))
        .fillColor('#f0eaf5').fill().restore();
      this.doc.fontSize(this.s(9)).fillColor(COLORS.purple).font('Helvetica-Bold')
        .text('Lighting of the Advent Wreath', this.MARGIN_SIDE, this.y + this.s(4), { width: this.CONTENT_WIDTH, align: 'center' });
      this.doc.font('Helvetica');
      this.y = this.doc.y + this.s(8);
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
    this.musicLine('responsorialPsalmSetting', 'responsorialPsalmSettingComposer', 'Setting');
    if (this.r.psalmRefrain) this.bodyText(`R. ${this.r.psalmRefrain}`, { bold: true, size: 9 });
    if (this.r.psalmVerses) this.bodyText(this.r.psalmVerses, { size: 8.5, x: this.MARGIN_SIDE + this.s(10), width: this.CONTENT_WIDTH - this.s(10) });

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
    this.bodyText(this.r.gospelText, { size: 9.5 });

    this.subHeading('Homily');
    this.rubric(RUBRICS.sit);
    this.y += this.s(4);
    this.rubric(RUBRICS.stand);

    const creedType = this.ss.creedType || 'nicene';
    const creedHeading = {
      apostles:       "The Apostles' Creed",
      baptismal_vows: 'Renewal of Baptismal Vows',
      nicene:         'The Nicene Creed'
    }[creedType] || 'The Nicene Creed';
    const creedText = {
      apostles:       APOSTLES_CREED,
      baptismal_vows: RENEWAL_OF_BAPTISMAL_VOWS,
      nicene:         NICENE_CREED
    }[creedType] || NICENE_CREED;
    this.subHeading(creedHeading);
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
      this.y += this.s(3);
      const boxH = this.s(22);
      this.doc.save().rect(this.MARGIN_SIDE, this.y, this.CONTENT_WIDTH, boxH)
        .fillColor('#f5f0e6').fill().restore();
      // Children's Liturgy can run at any subset of Masses — render every
      // selected time, joined by " & " (or fall back to the legacy single
      // string field for old saved drafts).
      const _clTimes = (Array.isArray(this.data.childrenLiturgyMassTimes) && this.data.childrenLiturgyMassTimes.length)
        ? this.data.childrenLiturgyMassTimes
        : (this.data.childrenLiturgyMassTime ? [this.data.childrenLiturgyMassTime] : ['Sun 9:00 AM']);
      this.doc.fontSize(this.s(8)).fillColor(COLORS.text).font('Helvetica-Bold')
        .text(`Children's Liturgy of the Word — ${_clTimes.join(' & ')}`,
          this.MARGIN_SIDE + this.s(4), this.y + this.s(4), { width: this.CONTENT_WIDTH - this.s(8) });
      if (this.data.childrenLiturgyMusic) {
        this.doc.font('Helvetica-Oblique').fontSize(this.s(7.5))
          .text(`${this.data.childrenLiturgyMusic}${this.data.childrenLiturgyMusicComposer ? ', ' + this.data.childrenLiturgyMusicComposer : ''}`,
            this.MARGIN_SIDE + this.s(4), this.doc.y, { width: this.CONTENT_WIDTH - this.s(8) });
      }
      this.doc.font('Helvetica');
      this.y = Math.max(this.doc.y, this.y + boxH) + this.s(6);
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

    this.subHeading('Choral Anthem');
    this.musicLine('choralAnthemConcluding', 'choralAnthemConcludingComposer', 'Anthem');

    this.pageNumber(6);
  }

  renderPage7ConcludingRites() {
    this.newPage();
    this.sectionHeader('The Concluding Rites');

    this.subHeading('Hymn of Thanksgiving');
    this.musicLine('hymnOfThanksgiving', 'hymnOfThanksgivingComposer', 'Thanksgiving');

    this.rubric(RUBRICS.stand);

    this.subHeading('Blessing & Dismissal');
    this.bodyText('Priest: The Lord be with you. All: And with your spirit.', { size: 8 });
    this.bodyText('Priest: May almighty God bless you, the Father, and the Son, ✠ and the Holy Spirit. All: Amen.', { size: 8 });
    this.bodyText('Deacon: Go forth, the Mass is ended. All: Thanks be to God.', { size: 8 });

    if (this.includePostlude) {
      this.subHeading('Organ Postlude');
      this.musicLine('organPostlude', 'organPostludeComposer', 'Postlude');
    }

    if (this.data.announcements) {
      this.y += this.s(4);
      this.doc.save()
        .moveTo(this.MARGIN_SIDE, this.y)
        .lineTo(this.PAGE_WIDTH - this.MARGIN_SIDE, this.y)
        .lineWidth(0.5).strokeColor(COLORS.gold).stroke().restore();
      this.y += this.s(4);
      this.subHeading('Announcements');
      this.bodyText(this.data.announcements, { size: 7.5 });
    }

    const copyrightShort = this.parishSettings.copyrightShort || 'Music reprinted under OneLicense #A-702171. All rights reserved.';
    this.doc.fontSize(this.s(7)).fillColor(COLORS.light)
      .text(copyrightShort, this.MARGIN_SIDE, this.PAGE_HEIGHT - this.MARGIN * 0.85, { width: this.CONTENT_WIDTH, align: 'center' });

    this.pageNumber(7);
  }

  renderPage8BackCover() {
    this.newPage();
    const cx = this.PAGE_WIDTH / 2;

    this.y = this.MARGIN_TOP + this.s(80);
    const armLen = this.s(18);
    this.doc.save().lineWidth(this.s(3)).strokeColor(COLORS.navy);
    this.doc.moveTo(cx, this.y - armLen).lineTo(cx, this.y + armLen).stroke();
    this.doc.moveTo(cx - armLen, this.y).lineTo(cx + armLen, this.y).stroke();
    this.doc.lineWidth(this.s(1));
    const corner = this.s(11), tick = this.s(4);
    for (const [ox, oy] of [[-corner, -corner], [corner, -corner], [-corner, corner], [corner, corner]]) {
      this.doc.moveTo(cx + ox, this.y + oy - tick).lineTo(cx + ox, this.y + oy + tick).stroke();
      this.doc.moveTo(cx + ox - tick, this.y + oy).lineTo(cx + ox + tick, this.y + oy).stroke();
    }
    this.doc.restore();

    this.y = this.MARGIN_TOP + this.s(120);
    this.doc.fontSize(this.s(13)).fillColor(COLORS.navy).font('Helvetica-Bold')
      .text(this.data.feastName, this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });
    this.y = this.doc.y + this.s(3);
    this.doc.fontSize(this.s(10)).fillColor(COLORS.muted).font('Helvetica')
      .text(formatDate(this.data.liturgicalDate), this.MARGIN_SIDE, this.y, { width: this.CONTENT_WIDTH, align: 'center' });

    if (this.data.specialNotes) {
      this.y = this.doc.y + this.s(14);
      this.doc.fontSize(this.s(9)).fillColor(COLORS.muted).font('Helvetica-Oblique')
        .text(this.data.specialNotes, this.MARGIN_SIDE + this.s(20), this.y, { width: this.CONTENT_WIDTH - this.s(40), align: 'center' });
      this.doc.font('Helvetica');
    }

    const copyrightFull = this.parishSettings.copyrightFull ||
      `Excerpts from the Lectionary for Mass © 2001, 1998, 1997, 1986, 1970 Confraternity of Christian Doctrine, Inc. Used with permission. All rights reserved.\n\nExcerpts from The Roman Missal © 2010, ICEL. All rights reserved.\n\nMusic reprinted under OneLicense #${this.parishSettings.onelicenseNumber || 'A-702171'}. All rights reserved.`;
    // Anchor copyright above the bottom margin so it never crosses it.
    const copyrightBlockHeight = this.s(90);
    const copyrightY = this.PAGE_HEIGHT - this.MARGIN - copyrightBlockHeight;
    this.doc.fontSize(this.s(6.5)).fillColor(COLORS.light)
      .text(copyrightFull, this.MARGIN_SIDE + this.s(10), copyrightY, {
        width: this.CONTENT_WIDTH - this.s(20), align: 'center', lineGap: this.s(1.5)
      });
  }
}

async function generatePdf(data, outputPath, options = {}) {
  const generator = new WorshipAidPdfGenerator(data, options);
  return generator.generate(outputPath);
}

// Backwards-compat alias.
async function generateImposedPdf(data, outputPath, options = {}) {
  return generatePdf(data, outputPath, options);
}

function buildFilename(data) {
  const date = (data.liturgicalDate || '').replace(/-/g, '_');
  const name = (data.feastName || 'Untitled').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  return `${date}__${name}.pdf`;
}

module.exports = {
  generatePdf,
  generateImposedPdf,
  buildFilename,
  WorshipAidPdfGenerator,
  LAYOUTS
};
