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

    // Finished booklet size for preview/export (defaults to tabloid).
    bookletSize: { type: 'string', enum: ['half-letter', 'tabloid'] },

    // Output design: the app's original look, or a serif emulation of the
    // parish's in-house aid (defaults to reimagined).
    design: { type: 'string', enum: ['reimagined', 'classic'] },

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
        // Which musical setting the Gloria is sung from (e.g. "Mass of
        // Creation") — printed under the Gloria heading.
        gloriaSetting: { type: 'string' },
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
        lentenAcclamation: { type: 'string', enum: ['standard', 'alternate'] },
        rubricAlignment: { type: 'string', enum: ['left', 'center', 'right'] },
        twoColumnCreed: { type: 'boolean' }
      }
    },

    // Three per-mass-time music blocks — PRD Section 4.1, 6.1
    musicSat5pm: musicBlockSchema,
    musicSun9am: musicBlockSchema,
    musicSun11am: musicBlockSchema,

    // Anthem list (UAT June 2026): one Offertory list + one Choral list,
    // each anthem tagged with the Masses where it is sung. This is the
    // editing shape; at save time the titles are also denormalized into the
    // per-Mass music blocks above so the renderers' consolidation logic
    // keeps working unchanged.
    anthems: {
      type: 'object',
      properties: {
        offertory: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              composer: { type: 'string' },
              masses: { type: 'array', items: { type: 'string', enum: ['sat5pm', 'sun9am', 'sun11am'] } }
            }
          }
        },
        choral: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              composer: { type: 'string' },
              masses: { type: 'array', items: { type: 'string', enum: ['sat5pm', 'sun9am', 'sun11am'] } }
            }
          }
        }
      }
    },

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

    // Reserve a blank paste area under each congregational hymn slot
    // (processional, communion, thanksgiving). OneLicense has no public
    // API, so instead of embedding hymn notation programmatically the
    // booklet leaves space for the parish to paste licensed music in by
    // hand after export. Defaults to true when absent.
    reserveHymnSpace: { type: 'boolean' },

    // Service music carryover (UAT June 2026): when true, the service music
    // (Kyrie, Gloria, Sanctus, Mystery of Faith, Lamb of God settings and
    // their notation images) was carried over wholesale from the previous
    // week's draft. Unchecking in the editor exposes the per-part fields.
    serviceMusicCarryover: { type: 'boolean' },

    // Images
    coverImagePath: { type: 'string' },
    // Per-slot notation images, keyed by slot name. Recognized slots:
    //   processional, communion, thanksgiving          (hymn paste areas)
    //   kyrie, gloria, sanctus, mysteryOfFaith, lambOfGod (ordinary parts)
    //   psalmRefrain, gospelAcclamation                (sung responses)
    // Values are upload URLs (/uploads/notation/... or /api/uploads/notation/...).
    // When present the image renders inside the reserved music area in both
    // the HTML preview and the exported PDF.
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
