// JSON Schema for worship aid input validation
'use strict';

const inputSchema = {
  type: 'object',
  required: ['occasionName', 'occasionDate', 'massTimes', 'firstReading', 'responsorialPsalm', 'gospel'],
  properties: {
    occasionName: { type: 'string', minLength: 1 },
    occasionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    massTimes: { type: 'array', items: { type: 'string' }, minItems: 1 },

    // Introductory Rites
    organPrelude: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        composer: { type: 'string' }
      }
    },
    entranceAntiphon: {
      type: 'object',
      properties: {
        imagePath: { type: 'string' },
        citation: { type: 'string' },
        composerCredit: { type: 'string' }
      }
    },
    penitentialAct: { type: 'string', default: 'default' },
    kyrieSettings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          massTime: { type: 'string' },
          settingName: { type: 'string' },
          imagePath: { type: 'string' }
        }
      }
    },
    gloria: { type: 'boolean', default: true },
    collect: { type: 'string' },

    // Liturgy of the Word
    firstReading: {
      type: 'object',
      required: ['citation', 'text'],
      properties: {
        citation: { type: 'string' },
        text: { type: 'string' }
      }
    },
    responsorialPsalm: {
      type: 'object',
      required: ['citation'],
      properties: {
        citation: { type: 'string' },
        imagePath: { type: 'string' },
        response: { type: 'string' },
        verses: { type: 'array', items: { type: 'string' } }
      }
    },
    secondReading: {
      type: 'object',
      properties: {
        citation: { type: 'string' },
        text: { type: 'string' }
      }
    },
    gospelAcclamation: {
      type: 'object',
      properties: {
        citation: { type: 'string' },
        imagePath: { type: 'string' },
        verse: { type: 'string' },
        lenten: { type: 'boolean', default: false }
      }
    },
    gospel: {
      type: 'object',
      required: ['citation', 'text'],
      properties: {
        citation: { type: 'string' },
        text: { type: 'string' }
      }
    },
    creedType: { type: 'string', enum: ['apostles', 'nicene'], default: 'nicene' },
    prayerOfTheFaithful: { type: 'string' },
    announcements: { type: 'string' },

    // Liturgy of the Eucharist
    offertoryAnthems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          massTime: { type: 'string' },
          title: { type: 'string' },
          composer: { type: 'string' }
        }
      }
    },
    holySanctus: {
      type: 'object',
      properties: {
        settingName: { type: 'string' },
        imagePath: { type: 'string' }
      }
    },
    mysteryOfFaith: {
      type: 'object',
      properties: {
        settingName: { type: 'string' },
        option: { type: 'string', enum: ['A', 'B', 'C'] },
        imagePath: { type: 'string' }
      }
    },

    // Communion Rite
    agnus: {
      type: 'object',
      properties: {
        settingName: { type: 'string' },
        imagePath: { type: 'string' }
      }
    },
    communionAntiphon: {
      type: 'object',
      properties: {
        imagePath: { type: 'string' },
        composerCredit: { type: 'string' }
      }
    },
    communionHymns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          massTime: { type: 'string' },
          title: { type: 'string' },
          composer: { type: 'string' }
        }
      }
    },

    // Concluding Rites
    hymnThanksgiving: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        imagePath: { type: 'string' },
        yearAStanza: { type: 'string' }
      }
    },
    choralAnthems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          massTime: { type: 'string' },
          title: { type: 'string' },
          composer: { type: 'string' }
        }
      }
    },
    prayerAfterCommunion: { type: 'string' },

    // Back Cover / Branding
    logoImagePath: { type: 'string' },
    qrCodes: {
      type: 'object',
      properties: {
        give: { type: 'string' },
        join: { type: 'string' },
        bulletin: { type: 'string' }
      }
    },
    socialHandles: {
      type: 'object',
      properties: {
        instagram: { type: 'string' },
        facebook: { type: 'string' },
        youtube: { type: 'string' }
      }
    },
    copyrightBlock: { type: 'string' },

    // Options
    compact: { type: 'boolean', default: false }
  },
  additionalProperties: false
};

module.exports = { inputSchema };
