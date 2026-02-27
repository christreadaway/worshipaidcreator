# Worship Aid Generator — Product Requirements Document

**Version:** 1.0  
**Date:** February 27, 2026  
**Owner:** COO, [Parish Name]  
**Status:** Ready for Development

---

## 1. What This Is

A web application that automates the weekly creation of an 8-page printable worship aid (Mass program) for [Parish Name]. The app takes the week's liturgical inputs — readings, music selections, seasonal settings — and produces a pixel-perfect, print-ready PDF that matches the parish's established design, with zero text overruns and no manual layout work.

---

## 2. Who It's For

**Primary user:** The staff member (liturgy coordinator or administrative staff) who currently creates the worship aid each week. Non-technical. Accustomed to working in Word or InDesign. Goal is to reduce a multi-hour task to under 30 minutes.

**Secondary users:** Music director (provides music selections), pastor (reviews before printing), printer vendor (receives final PDF).

---

## 3. User Stories / Jobs to Be Done

- As a liturgy coordinator, I want to enter this week's readings and music once and get a finished PDF — so I don't spend hours manually laying out and error-checking a document.
- As a liturgy coordinator, I want the app to automatically apply seasonal variations (Lent vs. Ordinary Time) — so I don't have to remember which creed, Gloria, or music settings apply.
- As a music director, I want to enter different music selections per Mass time (Sat 5PM, Sun 9AM, Sun 11AM) — so each service's worship aid reflects its actual music.
- As a staff member, I want to see a live preview before exporting — so I can catch errors before sending to the printer.
- As a COO, I want the output to be identical in quality to what we produce manually today — so there is no regression in the worship experience.
- As a staff member, I want to save a draft and return to it — so I don't lose work mid-week.

---

## 4. Core Features

### 4.1 Weekly Input Form
A structured form with clearly labeled sections for all variable content. Organized to match the order it appears in the bulletin. Sections:

- **Liturgical Date Block** — Date picker, feast/Sunday name (text), liturgical season selector (Ordinary Time / Advent / Christmas / Lent / Easter)
- **Readings Entry**
  - First Reading: citation field + full text area
  - Responsorial Psalm: citation + verse text (supports 3–5 stanzas) + refrain text
  - Second Reading: citation + full text area (toggle "No Second Reading" for some feasts)
  - Gospel Acclamation verse: text field + scripture reference
  - Gospel: citation + full text area
- **Music Selections** — Three sub-forms, one per Mass time (Sat 5PM, Sun 9AM, Sun 11AM):
  - Organ Prelude (title, composer)
  - Processional Hymn OR Entrance Antiphon (toggle by season)
  - Lord Have Mercy / Kyrie setting (text + composer)
  - Offertory Anthem (title + composer)
  - Communion Hymn / Choral Anthem (title + composer)
  - Hymn of Thanksgiving (title)
  - Organ Postlude (title + composer)
  - Choral Anthem at Concluding Rites (title + composer, optional)
- **Seasonal Overrides** — Auto-populated based on season selector, but editable:
  - Gloria: Yes / No
  - Creed type: Nicene / Apostles'
  - Holy Holy setting: "Mass of St. Theresa" / "Vatican Edition XVIII" / custom
  - Mystery of Faith setting: same options
  - Lamb of God setting: same options
  - Penitential Act: Confiteor (I confess) / Kyrie only
- **Children's Liturgy Block** — Toggle on/off; if on: Mass time (defaults to Sun 9AM), music title + composer
- **Announcements** — Rich text area (optional)
- **Special Notes** — Free text for any one-off variations (optional)

### 4.2 Live Preview
- Side-by-side or tabbed preview of all 8 pages as the form is completed
- Renders the actual layout at correct proportions (5.5" × 8.5" booklet page)
- Text overflow warnings: if any page exceeds its content area, flag it visually with a red border and a specific error message identifying which content block is causing the overflow
- Page count indicator confirming exactly 8 pages

### 4.3 PDF Export
- Export to print-ready PDF, properly sized for the printing format (see Section 5.3)
- Two export modes:
  - **Full 8-page PDF** (standard output sent to printer)
  - **Preview PDF** (single-sided 8.5"×11" pages, for internal review)
- PDF is generated server-side using a headless renderer (Puppeteer or WeasyPrint); not a browser print
- Output filename: `YYYY_MM_DD__[FeastName].pdf` matching existing naming convention

### 4.4 Draft Saving and History
- Auto-save drafts every 30 seconds while form is active
- Manual "Save Draft" button
- History view: list of all past worship aids with date, feast name, and export status
- Ability to duplicate a prior week as a starting point for the current week
- Ability to re-export a past week without re-entering data

### 4.5 Template & Static Content Management
- Static content (parish info block, creed texts, copyright block) stored as editable template fields in app settings
- Admin can update parish phone, URL, staff names, license numbers without touching code
- Seasonal static blocks (Confiteor text, Nicene Creed, Apostles' Creed, Invitation to Prayer dialogue) stored as locked templates — editable only in admin settings, not in the weekly form

---

## 5. Business Rules and Logic

### 5.1 Liturgical Season Auto-Rules
When the user selects a liturgical season, the following defaults apply automatically. User can override any of them:

| Setting | Ordinary Time | Advent | Christmas | Lent | Easter |
|---|---|---|---|---|---|
| Gloria | YES | NO | YES | NO | YES |
| Creed | Nicene | Nicene | Nicene | Apostles' | Nicene |
| Entrance type | Processional Hymn | Entrance Antiphon | Processional Hymn | Entrance Antiphon | Processional Hymn |
| Holy Holy setting | Mass of St. Theresa | Mass of St. Theresa | Mass of St. Theresa | Vatican Edition XVIII | Mass of St. Theresa |
| Lamb of God | Mass of St. Theresa | Mass of St. Theresa | Mass of St. Theresa | Vatican Edition XVIII | Mass of St. Theresa |
| Children's Liturgy | Optional | No | No | YES (Sun 9AM default) | Optional |

### 5.2 Page Overflow Prevention
The HARDEST constraint: content must fit in exactly 8 pages. Rules:

- Each page has a fixed content area. The app tracks character/line estimates per block.
- **If a page overflows:** The app will NOT auto-shrink text below a minimum font size (set in template settings, default 9pt body). Instead, it surfaces a specific overflow warning: "Page 3 overflow: First Reading text is approximately 8 lines over capacity. Consider shortening or reformatting."
- Long readings are the most common overflow risk (especially Ordinary Time, when the Gospel can be very long). The app must warn early — before export — which content is causing the issue.
- The two pages most at risk of overflow: **Page 3** (readings-heavy) and **Page 4** (Gospel + Creed). Both must have explicit capacity indicators in the preview.
- The app does NOT automatically reflow content between pages. Pages have fixed roles. The coordinator must resolve overflows manually in the form.

### 5.3 Print Format Specification
Based on analysis of existing worship aids (952×1260px JPEG renders = 5.5"×8.5" at ~173dpi):

- **Final booklet page size:** 5.5" × 8.5" (half-letter)
- **Print format:** 8-page saddle-stitched booklet — 2 sheets of 8.5"×11" paper, printed duplex, folded and stapled at spine
- **Printer-ready PDF impositioned page order:**
  - Sheet 1, Side A: Page 8 (left) + Page 1 (right)
  - Sheet 1, Side B: Page 2 (left) + Page 7 (right)
  - Sheet 2, Side A: Page 6 (left) + Page 3 (right)
  - Sheet 2, Side B: Page 4 (left) + Page 5 (right)
- **Alternate export:** Sequential 8-page PDF (pages in reading order 1–8) for digital review

### 5.4 Music Display Logic
- If all three Mass times have the SAME music selection for a given slot, display once with no time qualifier (e.g., "Offertory Anthem — O Sun of Justice, [composer]")
- If Mass times differ, display each with its qualifier (e.g., "Offertory Anthem — Title A, composer (Sat, 5 PM & Sun, 11 AM) / Title B, composer (Sun, 9 AM)")
- Formatting matches current pattern exactly: Title first (italics), then composer, then Mass times in parentheses

### 5.5 Readings Sourcing
- v1.0: Manual entry only — coordinator pastes readings from USCCB website or lectionary
- v1.1 (future): Auto-populate readings from USCCB lectionary API or internal readings database keyed by date

### 5.6 Copyright Block
- Short copyright (Page 7): static template, never changes
- Full copyright block (Page 8): static template, updated once per year when license renews. Admin-editable in settings.
- OneLicense number must be prominently stored and editable in settings without touching code

---

## 6. Data Requirements

### 6.1 Stored Per Weekly Record
```
worship_aid {
  id: UUID
  created_at: timestamp
  updated_at: timestamp
  status: draft | finalized | exported
  liturgical_date: date
  feast_name: string
  liturgical_season: enum(ordinary | advent | christmas | lent | easter)
  
  readings {
    first_reading_citation: string
    first_reading_text: string
    psalm_citation: string
    psalm_verses: string
    psalm_refrain: string
    second_reading_citation: string (nullable)
    second_reading_text: string (nullable)
    gospel_acclamation_verse: string
    gospel_acclamation_reference: string
    gospel_citation: string
    gospel_text: string
  }
  
  seasonal_settings {
    gloria: boolean
    creed_type: nicene | apostles
    entrance_type: processional | antiphon
    holy_holy_setting: string
    mystery_of_faith_setting: string
    lamb_of_god_setting: string
    penitential_act: confiteor | kyrie_only
  }
  
  music_sat_5pm: MusicBlock
  music_sun_9am: MusicBlock
  music_sun_11am: MusicBlock
  
  children_liturgy_enabled: boolean
  children_liturgy_mass_time: string
  children_liturgy_music: string
  
  announcements: string (nullable)
  special_notes: string (nullable)
  
  exported_pdf_url: string (nullable)
  export_timestamp: timestamp (nullable)
}

MusicBlock {
  organ_prelude: string
  processional_or_entrance: string
  kyrie_setting: string
  offertory_anthem: string
  communion_hymn: string
  hymn_of_thanksgiving: string
  organ_postlude: string
  choral_anthem_concluding: string (nullable)
}
```

### 6.2 Template/Settings Data (stored once, admin-managed)
```
parish_settings {
  parish_name: string
  parish_address: string
  parish_phone: string
  parish_url: string
  parish_prayer_url: string
  nursery_blurb: string
  connect_blurb: string
  restrooms_blurb: string
  prayer_blurb: string
  onelicense_number: string
  copyright_short: string
  copyright_full: string
  
  min_font_size_pt: number (default: 9)
  body_font: string (default: as specified in design system)
  header_font: string
}
```

---

## 7. Integrations and Dependencies

| Component | Tool / Service | Notes |
|---|---|---|
| Authentication | Google Auth | Single parish Google Workspace domain, OAuth 2.0 |
| Database | Firebase Firestore | One document per weekly worship aid |
| File Storage | Firebase Storage | Draft PDFs and finalized exports |
| PDF Generation | Puppeteer (headless Chrome) | Server-side rendering to PDF from HTML template |
| Deployment | Firebase Hosting + Cloud Functions | Cloud Function handles PDF generation job |
| Frontend | React + Tailwind | Single-page app, form + preview |
| Fonts | Google Fonts CDN | Loaded in PDF template at render time |

---

## 8. Out of Scope (v1.0)

- Auto-populating readings from an external API (v1.1)
- Mobile app or mobile-optimized input form
- Multi-parish support
- Role-based permissions (editor vs. admin) — all authenticated users have full access in v1.0
- Email delivery to printer
- Integration with parish management system
- Bilingual (English/Spanish) output
- Special liturgies (weddings, funerals, Holy Week, RCIA)
- Bulletin content beyond the worship aid (announcements pages, separate weekly bulletin)
- InDesign template export

---

## 9. Open Questions

1. **Who has admin access?** (To change template settings, parish info, copyright block) — COO only, or does the liturgy coordinator also get access?
2. **Readings source in v1.1** — Does the parish want to license a third-party lectionary API, or build an internal readings database from USCCB public text?
3. **Music selection UI** — Is free-text entry sufficient for music fields, or does the music director want a searchable dropdown of titles they've used previously?
4. **Imposition preference** — Does the printer want the PDF pre-imposed (booklet order), or do they prefer sequential pages and handle imposition themselves? (Most commercial printers prefer sequential.)
5. **Print bleed/margins** — Does the current design include a bleed for full-bleed elements? The cover image/header appears to extend to edge — need to confirm whether printer requires bleed marks and 0.125" bleed extension.
6. **Page 1 image** — The cover page sometimes includes a liturgical image (e.g., Christmas Eve had a nativity image). Is this manually uploaded per week or drawn from a library?

---

## 10. Success Criteria

| Criteria | Measure |
|---|---|
| Time to produce finished PDF | Under 30 minutes start-to-finish (vs. current multi-hour manual process) |
| Output quality | Indistinguishable from manually produced version — no text overruns, correct pagination, correct design |
| Page count constraint | App NEVER exports a PDF that is not exactly 8 pages |
| Error detection | 100% of text overflow conditions surfaced before export, with specific page + block identified |
| Reliability | Draft saves successfully on every use; export produces a valid print-ready PDF |
| Seasonal accuracy | Seasonal settings (creed, Gloria, music defaults) are correct for the selected liturgical season 100% of the time |
| Adoption | Staff is using the app for weekly production within 4 weeks of launch, without reverting to manual process |

---

## Appendix A: 8-Page Layout Map

Based on analysis of 10 existing worship aids (Christmas Eve 2025 through 2nd Sunday of Lent 2026):

| Page | Role | Variable Content | Static Content |
|---|---|---|---|
| 1 | Cover (front of booklet) | Feast title, date, cover image (optional) | Parish info block (CONNECT, NURSERY, RESTROOMS, PRAYER) |
| 2 | Introductory Rites | Organ prelude, entrance hymn/antiphon, Kyrie setting | Section header, Penitential Act text (if Confiteor), Gloria (conditional) |
| 3 | Liturgy of the Word | First Reading (full text), Psalm (verses + refrain), Second Reading (full text), Gospel Acclamation verse | Section header, reading labels, psalm refrain label |
| 4 | Gospel + Creed | Gospel (full text), Creed (full text) | Homily cue, Prayer of the Faithful cue, Creed text (from template) |
| 5 | Liturgy of the Eucharist | Offertory anthem (per mass time), Holy Holy setting | Section header, Invitation to Prayer dialogue (fixed), Mystery of Faith cue, Great Amen cue |
| 6 | Communion Rite | Communion hymn, Lamb of God setting | Section header, Lord's Prayer cue, Sign of Peace cue, Communion Antiphon cue |
| 7 | Concluding Rites | Hymn of Thanksgiving, Choral Anthem (optional), Organ Postlude | Blessing & Dismissal cue, short copyright block |
| 8 | Back Cover | (sometimes hymn lyrics for Christmas) | Full copyright block |

---

## Appendix B: Seasonal Variation Reference

Sourced from 10 existing worship aids:

| Season | Creed | Gloria | Entrance | Holy Holy | Lamb of God |
|---|---|---|---|---|---|
| Christmas | Nicene (with genuflect note) | Yes | Processional Hymn | Mass of St. Theresa | Mass of St. Theresa |
| Ordinary Time | Nicene (with bow note) | Yes | Processional Hymn | Mass of St. Theresa | Mass of St. Theresa |
| Lent | Apostles' | No | Entrance Antiphon (Marc Cerisier) | Vatican Edition XVIII | Agnus Dei, Vatican Edition XVIII |

---

## Appendix C: Logging Infrastructure

All server-side operations must emit structured logs to Firebase/Cloud Logging:

```javascript
// Log schema for every significant event
{
  timestamp: ISO8601,
  event_type: 'draft_save' | 'pdf_generate' | 'pdf_export' | 'overflow_detected' | 'error',
  worship_aid_id: UUID,
  liturgical_date: 'YYYY-MM-DD',
  user_email: string,
  status: 'success' | 'failure',
  error_code: string | null,
  error_message: string | null,
  details: {
    // For overflow_detected:
    page_number: number,
    block_name: string,
    overflow_lines: number,
    // For pdf_generate:
    duration_ms: number,
    file_size_bytes: number,
    // For error:
    stack_trace: string
  }
}
```

**Error surfacing for debugging:**
- All logs tagged with `worship_aid_id` for easy filtering
- PDF generation errors include the full Puppeteer error + the rendered HTML snapshot
- Overflow detection errors include the exact block name, estimated line count, and page capacity
- Console output on all Cloud Functions is structured JSON (not plain text) for Cloud Logging query compatibility
- Error messages formatted for copy-paste into Claude Code debugging: include error type, file, line number, and reproduction steps where possible
