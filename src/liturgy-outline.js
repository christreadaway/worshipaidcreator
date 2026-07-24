// Shared liturgy outline — the SINGLE source of truth for the order, section
// names, posture wording, section set, two-column choices, announcements
// placement, and QR footer of a worship aid. Both media (the PDFKit export
// and the HTML preview) and both designs (reimagined + classic) consume the
// SAME outline, so a change to the liturgy structure or a formatting rule is
// made in exactly one place instead of the four renderer copies that used to
// drift apart (the recurring "we already told it that" proof feedback).
//
// The outline is a list of BLOCKS. Each block is one atomic unit for the PDF
// flow paginator and, in the HTML preview, a run of markup placed on a fixed
// page (block.htmlPage). A block carries an ordered list of OPS — typed
// drawing instructions (a section title, a music heading, a reading, a
// rubric, ...). The per-medium adapters (`pdf-generator.js`,
// `template-renderer.js`) translate each op to their own primitives; this
// module owns WHAT appears and in WHAT ORDER, never HOW it is drawn.
'use strict';

const { APOSTLES_CREED, NICENE_CREED, RENEWAL_OF_BAPTISMAL_VOWS } = require('./assets/text/creeds');
const {
  CONFITEOR, INVITATION_TO_PRAYER, RUBRICS, RUBRICS_CLASSIC,
  GOSPEL_ACCLAMATION_LENTEN, GOSPEL_ACCLAMATION_LENTEN_ALT,
  GOSPEL_ACCLAMATION_STANDARD, getHolyHolyHolyText
} = require('./assets/text/mass-texts');
const { formatMusicSlot } = require('./music-formatter');
const { resolveChildrenLiturgyTimes } = require('./render-shared');

const GLORIA_TEXT = 'Glory to God in the highest, and on earth peace to people of good will.';

// Build the ordered block list for a worship aid.
//   data: the (season-defaulted) aid data
//   ctx:  { design, seasonalSettings, readings, parishSettings }
// Returns { blocks: [ { htmlPage, keepNext?, anchorBottom?, penitential?, ops } ] }.
function buildLiturgyOutline(data, ctx = {}) {
  const design = ctx.design === 'classic' ? 'classic' : 'reimagined';
  const classic = design === 'classic';
  const ss = ctx.seasonalSettings || data.seasonalSettings || {};
  const r = ctx.readings || data.readings || {};
  const R = classic ? RUBRICS_CLASSIC : RUBRICS;

  const isLenten = data.liturgicalSeason === 'lent';
  const isAdvent = data.liturgicalSeason === 'advent';
  const entranceType = ss.entranceType || 'processional';
  const penitentialConfiteor = (ss.penitentialAct || 'confiteor') === 'confiteor';
  const showGloria = ss.gloria !== undefined ? ss.gloria : (!isLenten && !isAdvent);
  const showAdventWreath = ss.adventWreath !== undefined ? ss.adventWreath : isAdvent;
  const includePostlude = ss.includePostlude !== undefined ? ss.includePostlude : !isLenten;

  const creedType = ss.creedType || 'nicene';
  const creedHeading = {
    apostles: "The Apostles' Creed", baptismal_vows: 'Renewal of Baptismal Vows', nicene: 'The Nicene Creed'
  }[creedType] || 'The Nicene Creed';
  const creedText = {
    apostles: APOSTLES_CREED, baptismal_vows: RENEWAL_OF_BAPTISMAL_VOWS, nicene: NICENE_CREED
  }[creedType] || NICENE_CREED;
  // Classic always sets the creed in two columns; reimagined only when asked.
  // Baptismal vows are too short to benefit either way.
  const creedTwoColumn = creedType !== 'baptismal_vows' && (classic || !!ss.twoColumnCreed);

  const holyHolyLanguage = ss.holyHolyLanguage || (ctx.parishSettings || {}).defaultSanctusLanguage || 'english';
  const sanctusHeading = holyHolyLanguage === 'latin' ? 'Sanctus' : 'Holy, Holy, Holy';
  const sanctusText = getHolyHolyHolyText(holyHolyLanguage);

  const acclText = isLenten
    ? (ss.lentenAcclamation === 'alternate' ? GOSPEL_ACCLAMATION_LENTEN_ALT : GOSPEL_ACCLAMATION_LENTEN)
    : GOSPEL_ACCLAMATION_STANDARD;
  const acclHeading = isLenten ? 'Gospel Acclamation' : (classic ? 'Gospel Alleluia' : 'Gospel Acclamation');

  const setting = (v, dflt) => (v !== undefined && v !== null && v !== '') ? v : dflt;

  const blocks = [];
  const B = (htmlPage, ops, extra) => blocks.push({ htmlPage, ops: ops.filter(Boolean), ...(extra || {}) });

  // Op factories — thin typed records the medium adapters know how to draw.
  const section = (title) => ({ op: 'section', title });
  const music = (heading, titleField, composerField, opts = {}) =>
    ({ op: 'music', heading, titleField, composerField, right: opts.right });
  const hymnSpace = (slot) => ({ op: 'hymnSpace', slot });
  const ordinarySpace = (slot, label) => ({ op: 'ordinarySpace', slot, label });
  const settingLine = (heading, value, slot, label, opts = {}) =>
    ({ op: 'setting', heading, setting: value, slot, label, mode: opts.mode || 'musicOrText', text: opts.text, right: opts.right });
  const subheading = (heading, opts = {}) =>
    ({ op: 'subheading', heading, inline: opts.inline, citation: opts.citation, right: opts.right });
  const reading = (heading, citation, text, size) => ({ op: 'reading', heading, citation, text, size });
  const rubric = (text) => ({ op: 'rubric', text });
  const psalmVerse = (text) => ({ op: 'psalmVerse', text });
  const creed = () => ({ op: 'creed', heading: creedHeading, text: creedText, twoColumn: creedTwoColumn, right: R.stand });
  const invitationText = () => ({ op: 'invitationText', priest: INVITATION_TO_PRAYER.priest, all: INVITATION_TO_PRAYER.all });
  const childrenBox = () => ({ op: 'childrenBox' });
  const childrenReturn = () => ({ op: 'childrenReturn', text: `Children return from Children's Liturgy of the Word (${resolveChildrenLiturgyTimes(data).join(classic ? ' & ' : ' & ')})` });
  const adventWreath = () => ({ op: 'adventWreath' });

  // ---- The Introductory Rites (page 2) ----
  if (classic) {
    // In-house layout: the prelude line sits ABOVE the section title, which
    // must not strand at a page foot away from the hymn it introduces.
    B(2, [music('Organ Prelude', 'organPrelude', 'organPreludeComposer'), section('The Introductory Rites')], { keepNext: true });
  } else {
    B(2, [section('The Introductory Rites'), music('Organ Prelude', 'organPrelude', 'organPreludeComposer')]);
  }

  B(2, [
    music(entranceType === 'processional' ? 'Processional Hymn' : 'Entrance Antiphon',
      'processionalOrEntrance', 'processionalOrEntranceComposer', { right: R.stand }),
    entranceType === 'processional' ? hymnSpace('processional') : null
  ]);

  if (showAdventWreath) B(2, [adventWreath()]);
  if (classic) B(2, [subheading('Invocation')]);

  if (penitentialConfiteor) {
    // Director: the Penitential Act must share the page with the entrance
    // hymn (classic: + Invocation) — never spill. The PDF adapter turns this
    // into a fit block (full text -> two columns -> heading only).
    B(2, [{ op: 'penitential', text: CONFITEOR, size: classic ? 9 : 8 }], { penitential: true });
  }

  // Lord Have Mercy + Glory to God + Collect are one atomic page group.
  B(2, [
    music(classic ? 'Lord Have Mercy' : 'Lord, Have Mercy', 'kyrieSetting', 'kyrieComposer'),
    ordinarySpace('kyrie', 'Kyrie — music notation'),
    showGloria ? settingLine(classic ? 'Glory to God' : 'Gloria', ss.gloriaSetting, 'gloria', 'Gloria — music notation', { mode: 'musicOrText', text: GLORIA_TEXT }) : null,
    subheading('Collect')
  ], { keepNext: true });

  if (data.childrenLiturgyEnabled) B(2, [childrenBox()], { keepNext: true });

  // ---- The Liturgy of the Word (page 3) ----
  // "Please be seated" + section title + First Reading open the page together
  // (the sit rubric must sit immediately before the section title).
  B(3, [rubric(R.sit), section('The Liturgy of the Word'),
    reading('First Reading', r.firstReadingCitation, r.firstReadingText, 9)]);

  // Responsorial Psalm — reimagined stacks indented verses; classic sets the
  // strophes in two columns. Either way each strophe is cued back with "R.".
  const strophes = String(r.psalmVerses || '').split(/\n\s*\n/).map(v => v.trim()).filter(Boolean)
    .map(v => (/(?:^|\s)R\.?\s*$/.test(v) ? v : `${v} R.`));
  if (classic) {
    B(3, [{ op: 'psalm', citation: r.psalmCitation, refrain: r.psalmRefrain, slot: 'psalmRefrain', strophes, twoColumn: true }]);
  } else {
    B(3, [{ op: 'psalm', citation: r.psalmCitation, refrain: r.psalmRefrain, slot: 'psalmRefrain', strophes: [], twoColumn: false }]);
    for (const v of strophes) B(3, [psalmVerse(v)]);
  }

  if (!r.noSecondReading && r.secondReadingCitation) {
    B(3, [reading('Second Reading', r.secondReadingCitation, r.secondReadingText, 9)]);
  }

  B(3, [{
    op: 'gospelAccl', heading: acclHeading, reference: r.gospelAcclamationReference,
    slot: 'gospelAcclamation', text: acclText, verse: r.gospelAcclamationVerse,
    verseStyle: classic ? 'hanging' : 'italic', right: R.stand
  }]);

  // ---- Gospel, Homily, Creed (page 4) ----
  B(4, [reading('Gospel', r.gospelCitation, r.gospelText, classic ? 9 : 9.5)]);
  B(4, [subheading('Homily', { right: R.sit })]);
  B(4, [creed()]);
  B(4, [subheading('Prayer of the Faithful')]);
  // Classic prints announcements here (with the readings); reimagined defers
  // them to the back matter on page 8.
  if (classic && data.announcements) {
    B(4, [{ op: 'announcements', text: data.announcements, size: 8.5, right: R.sit }]);
  }

  // ---- The Liturgy of the Eucharist (page 5) ----
  B(5, [
    rubric(R.sit), section('The Liturgy of the Eucharist'),
    music(classic ? 'Offertory Hymn' : 'Offertory', 'offertoryAnthem', 'offertoryAnthemComposer'),
    data.childrenLiturgyEnabled ? childrenReturn() : null
  ]);

  if (classic) {
    B(5, [subheading('Invitation to Prayer', { right: R.stand })]);
    B(5, [subheading('Prayer over the Offerings')]);
  } else {
    B(5, [subheading('Invitation to Prayer', { right: R.stand }), invitationText()]);
  }

  // Sanctus. Classic adds the combined kneel/sit direction right after it;
  // reimagined carries its kneel into the Mystery of Faith block.
  B(5, [
    settingLine(sanctusHeading, setting(ss.holyHolySetting, 'Mass of St. Theresa'), 'sanctus', 'Holy, Holy, Holy — music notation', { mode: 'musicOrText', text: sanctusText }),
    classic ? rubric(R.kneelOrSit) : null
  ]);

  B(5, [
    classic ? null : rubric(R.kneel),
    settingLine('Mystery of Faith', setting(ss.mysteryOfFaithSetting, 'Mass of St. Theresa'), 'mysteryOfFaith', 'Mystery of Faith — music notation', { mode: 'musicOnly' })
  ]);

  B(5, [subheading('Great Amen', classic ? { inline: 'chant' } : {})]);

  // ---- The Communion Rite (page 6) ----
  B(6, [rubric(R.stand), section('The Communion Rite'), subheading("The Lord's Prayer")]);
  B(6, [subheading('Sign of Peace')]);
  B(6, [
    settingLine('Lamb of God', setting(ss.lambOfGodSetting, 'Mass of St. Theresa'), 'lambOfGod', 'Lamb of God — music notation', { mode: 'musicOnly' }),
    rubric(R.kneel)
  ]);
  B(6, [music('Communion Hymn', 'communionHymn', 'communionHymnComposer'), hymnSpace('communion')]);

  // Choral anthem: reimagined always prints the heading; classic omits it
  // when nothing is scheduled.
  const hasChoral = formatMusicSlot(data, 'choralAnthemConcluding', 'choralAnthemConcludingComposer').length > 0;
  if (!classic || hasChoral) {
    B(6, [music('Choral Anthem', 'choralAnthemConcluding', 'choralAnthemConcludingComposer')]);
  }
  B(6, [rubric(R.stand), subheading('Prayer after Communion')]);

  // ---- The Concluding Rites (page 7) ----
  B(7, [
    section('The Concluding Rites'),
    music('Hymn of Thanksgiving', 'hymnOfThanksgiving', 'hymnOfThanksgivingComposer'),
    hymnSpace('thanksgiving')
  ]);

  const backPage = classic ? 7 : 8;
  B(backPage, [subheading(classic ? 'Blessing and Dismissal' : 'Blessing & Dismissal')]);
  if (includePostlude) B(backPage, [music('Organ Postlude', 'organPostlude', 'organPostludeComposer')]);

  // Reimagined announcements live in the back matter (page 8).
  if (!classic && data.announcements) {
    B(8, [{ op: 'announcements', text: data.announcements, size: 7.5, rule: true }]);
  }
  if (data.specialNotes) B(backPage, [{ op: 'notes', text: data.specialNotes }]);
  if ((ctx.parishSettings || {}).closingMessage) B(backPage, [{ op: 'closing', text: ctx.parishSettings.closingMessage }]);

  // Licensing / footer — reimagined a centered copyright block on page 8;
  // classic the QR + licensing footer anchored to the foot of the last page.
  if (classic) {
    B(8, [{ op: 'classicFooter' }], { anchorBottom: true });
  } else {
    B(8, [{ op: 'copyright' }]);
  }

  return { blocks, meta: { design, creedTwoColumn, holyHolyLanguage, includePostlude } };
}

module.exports = { buildLiturgyOutline, GLORIA_TEXT };
