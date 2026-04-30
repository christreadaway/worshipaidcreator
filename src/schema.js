// JSON Schema for worship aid input — matches PRD Section 6.1
// Updated with worksheet fields: advent wreath, postlude toggle, acclamation choice, image paths
'use strict';

const musicBlockSchema = {
  type: 'object',
  properties: {
    organPrelude: { type: 'string' },
    organPreludeComposer: { type: 'string' },
    processionalOrEntrance: { type: 'string' },
    processionalOrEntranceComposer: { type: 'string' },
    // Hymnal + number for the processional hymn — drives OneLicense lookup.
    processionalOrEntranceHymnal: { type: 'string' },
    processionalOrEntranceHymnNumber: { type: 'string' },
    kyrieSetting: { type: 'string' },
    kyrieComposer: { type: 'string' },
    // Responsorial Psalm setting (the music behind the psalm refrain).
    // Optional — the refrain prints regardless from readings.psalmRefrain.
    responsorialPsalmSetting: { type: 'string' },
    responsorialPsalmSettingComposer: { type: 'string' },
    offertoryAnthem: { type: 'string' },
    offertoryAnthemComposer: { type: 'string' },
    communionHymn: { type: 'string' },
    communionHymnComposer: { type: 'string' },
    communionHymnHymnal: { type: 'string' },
    communionHymnHymnNumber: { type: 'string' },
    hymnOfThanksgiving: { type: 'string' },
    hymnOfThanksgivingComposer: { type: 'string' },
    hymnOfThanksgivingHymnal: { type: 'string' },
    hymnOfThanksgivingHymnNumber: { type: 'string' },
    organPostlude: { type: 'string' },
    organPostludeComposer: { type: 'string' },
    choralAnthemConcluding: { type: 'string' },
    choralAnthemConcludingComposer: { type: 'string' }
  }
};

const inputSchema = {
  type: 'object',
  required: ['feastName', 'liturgicalDate', 'liturgicalSeason'],
  properties: {
    // Metadata
    id: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'review', 'approved', 'finalized', 'exported'] },
    feastName: { type: 'string', minLength: 1 },
    liturgicalDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    liturgicalSeason: { type: 'string', enum: ['ordinary', 'advent', 'christmas', 'lent', 'easter'] },

    // Workflow: who last edited, assigned to
    lastEditedBy: { type: 'string' },
    assignedTo: { type: 'string' },

    // Readings — PRD Section 4.1
    readings: {
      type: 'object',
      properties: {
        firstReadingCitation: { type: 'string' },
        firstReadingText: { type: 'string' },
        psalmCitation: { type: 'string' },
        psalmRefrain: { type: 'string' },
        psalmVerses: { type: 'string' },
        secondReadingCitation: { type: 'string' },
        secondReadingText: { type: 'string' },
        noSecondReading: { type: 'boolean' },
        gospelAcclamationVerse: { type: 'string' },
        gospelAcclamationReference: { type: 'string' },
        gospelCitation: { type: 'string' },
        gospelText: { type: 'string' }
      }
    },

    // Seasonal Settings — PRD Section 4.1, 5.1
    seasonalSettings: {
      type: 'object',
      properties: {
        gloria: { type: 'boolean' },
        creedType: { type: 'string', enum: ['nicene', 'apostles', 'baptismal_vows'] },
        entranceType: { type: 'string', enum: ['processional', 'antiphon'] },
        holyHolySetting: { type: 'string' },
        // 'english' or 'latin' — defaults to english
        holyHolyLanguage: { type: 'string', enum: ['english', 'latin'] },
        mysteryOfFaithSetting: { type: 'string' },
        lambOfGodSetting: { type: 'string' },
        penitentialAct: { type: 'string', enum: ['confiteor', 'kyrie_only'] },
        includePostlude: { type: 'boolean' },
        adventWreath: { type: 'boolean' },
        lentenAcclamation: { type: 'string', enum: ['standard', 'alternate'] }
      }
    },

    // Three per-mass-time music blocks — PRD Section 4.1, 6.1
    musicSat5pm: musicBlockSchema,
    musicSun9am: musicBlockSchema,
    musicSun11am: musicBlockSchema,

    // Children's Liturgy — PRD Section 4.1
    childrenLiturgyEnabled: { type: 'boolean' },
    // Multiple-mass-time list. Children's Liturgy can run at any subset
    // of the parish's Masses (not just one). Each entry is a free-text
    // label ("Sat 5:00 PM", "Sun 9:00 AM", etc.) so it survives a parish
    // changing its Mass schedule. The legacy single-string field below
    // is preserved for old saved drafts and migrated on load.
    childrenLiturgyMassTimes: { type: 'array', items: { type: 'string' } },
    childrenLiturgyMassTime: { type: 'string' },  // legacy, back-compat
    childrenLiturgyMusic: { type: 'string' },
    childrenLiturgyMusicComposer: { type: 'string' },
    childrenLiturgyLeader: { type: 'string' },
    childrenLiturgyNotes: { type: 'string' },

    // Optional content
    announcements: { type: 'string' },
    specialNotes: { type: 'string' },

    // Images
    coverImagePath: { type: 'string' },
    notationImages: {
      type: 'object',
      additionalProperties: { type: 'string' }
    },

    // Attachments referenced by id (for preludes, postludes, anthems, etc.).
    // The actual file metadata + binaries live in the attachments store.
    attachmentRefs: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

module.exports = { inputSchema, musicBlockSchema };
