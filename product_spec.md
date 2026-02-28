# Worship Aid Generator — Product Specification

**Version:** 1.0.0
**Last Updated:** February 28, 2026
**Status:** Feature-Complete (v1.0)

---

## Overview

A Node.js web application that automates weekly creation of 8-page Catholic Mass worship booklet PDFs (5.5" x 8.5" half-letter, saddle-stitched). Staff enters readings + music selections via a web form, the app validates layout constraints, and generates a print-ready PDF — reducing a multi-hour manual process to under 30 minutes.

---

## Architecture

| Layer | Technology | Notes |
|---|---|---|
| Server | Express 5.2 on Node.js | Single-process, serves API + SPA |
| PDF Engine | PDFKit 0.17.2 | Direct page layout control, no headless browser needed |
| Validation | AJV 8.18 | JSON Schema input validation |
| Persistence | File-based (JSON on disk) | `data/drafts/`, `data/settings/`, `data/exports/` |
| Frontend | Vanilla JS + HTML/CSS (embedded SPA) | No build step, no framework dependencies |
| Fonts | Google Fonts CDN | EB Garamond (body), Cinzel (headers), Inter (UI) |
| Testing | Node.js built-in test runner | `node --test`, assert/strict |
| CLI | `src/cli.js` | Headless generation from JSON input |

**Deployment:** Local Node.js server or Netlify Functions (serverless). KV storage abstraction (`kv.js`) auto-selects filesystem (local) or Netlify Blobs (production).

---

## Project Structure

```
src/
  server.js               Express server + embedded SPA (~720 lines)
  template-renderer.js    HTML booklet renderer for live preview (~540 lines)
  pdf-generator.js        PDFKit-based PDF generator (~476 lines)
  validator.js            AJV validation + overflow detection
  schema.js               JSON Schema for worship aid input
  music-formatter.js      Per-mass-time music consolidation logic
  cli.js                  Command-line interface
  config/
    seasons.js            Liturgical season auto-rules engine
    defaults.js           Default parish settings
  store/
    kv.js                 KV storage abstraction (filesystem or Netlify Blobs)
    file-store.js         Async persistence (drafts, settings)
    user-store.js         User management, sessions, role-based access
  assets/
    logo/jerusalem-cross.svg
    text/creeds.js        Nicene & Apostles' Creed
    text/mass-texts.js    Confiteor, Lord's Prayer, rubrics, etc.
    text/copyright.js     Default copyright boilerplate
  tests/
    validator.test.js     14 tests — schema, overflow, line estimation
    seasons.test.js       8 tests — 5 seasons + applySeasonDefaults
    template-renderer.test.js  28 tests — 8 pages, seasons, creed, readings, music
    pdf-generator.test.js      9 tests — filename, file creation, headers, creed, settings
    server.test.js        14 tests — API endpoints, drafts CRUD, settings
data/
  drafts/                 Saved worship aid drafts (UUID.json)
  settings/               parish-settings.json
  exports/                Generated PDFs and HTML
sample/
  second-sunday-lent.json Complete example input (Lent)
```

---

## Core Features (Implemented)

### 1. Web UI — Three-Page SPA

- **Editor:** Structured form with collapsible sections matching the order of the booklet. Side-by-side live preview pane. Overflow warnings displayed above preview.
- **History:** List of saved drafts with open/duplicate/delete actions. Shows feast name, date, season, status, last updated.
- **Settings (Admin):** Parish information, cover page info blocks (Connect, Nursery, Restrooms, Prayer), copyright/licensing fields. Saved to `data/settings/parish-settings.json`.

### 2. Input Form Sections

| Section | Fields |
|---|---|
| Liturgical Date & Season | Feast name, date picker, season selector (5 seasons) |
| Seasonal Settings | Gloria toggle, creed type, entrance type, Holy Holy / Mystery of Faith / Lamb of God settings, penitential act |
| Readings | First Reading (citation + text), Psalm (citation + refrain + verses), Second Reading (citation + text, with "No Second Reading" toggle), Gospel Acclamation (reference + verse), Gospel (citation + text) |
| Music (x3 mass times) | 8 fields each: Organ Prelude, Processional/Entrance, Kyrie, Offertory, Communion, Thanksgiving, Postlude, Choral Anthem — each with title + composer |
| Children's Liturgy | Enable toggle, mass time, music title + composer |
| Announcements & Notes | Free text areas (optional) |

### 3. Liturgical Season Auto-Rules (PRD §5.1)

| Setting | Ordinary | Advent | Christmas | Lent | Easter |
|---|---|---|---|---|---|
| Gloria | YES | NO | YES | NO | YES |
| Creed | Nicene | Nicene | Nicene | Apostles' | Nicene |
| Entrance | Processional | Antiphon | Processional | Antiphon | Processional |
| Holy Holy | Mass of St. Theresa | Mass of St. Theresa | Mass of St. Theresa | Vatican XVIII | Mass of St. Theresa |
| Lamb of God | Mass of St. Theresa | Mass of St. Theresa | Mass of St. Theresa | Agnus Dei, Vatican XVIII | Mass of St. Theresa |
| Gospel Accl. | Alleluia | Alleluia | Alleluia | Lenten | Alleluia |
| Children's | Optional | No | No | YES (9AM) | Optional |

All defaults are user-overridable.

### 4. Music Display Logic (PRD §5.4)

- **Same music across all 3 Mass times:** Displayed once, no time qualifier.
  - Format: *Title*, Composer
- **Different music:** Grouped by unique selection with times in parentheses.
  - Format: *Title A*, Composer (Sat, 5 PM & Sun, 11 AM) / *Title B*, Composer (Sun, 9 AM)

### 5. Overflow Detection (PRD §5.2)

Per-page capacity analysis on the two highest-risk pages:
- **Page 3** (Liturgy of the Word): 85-line capacity. Tracks First Reading + Psalm + Second Reading + Gospel Acclamation.
- **Page 4** (Gospel + Creed): 75-line capacity. Tracks Gospel text + Creed (Nicene=32 lines, Apostles'=18 lines).

Line estimation: character count / 65 chars per line. Overflow warnings identify the specific block causing the issue and how many lines over capacity.

### 6. 8-Page Booklet Layout

| Page | Role | Key Content |
|---|---|---|
| 1 | Cover | Jerusalem cross, feast name, date, Mass times, 2x2 parish info grid |
| 2 | Introductory Rites | Organ Prelude, Processional/Antiphon, Confiteor (conditional), Kyrie, Gloria (conditional) |
| 3 | Liturgy of the Word | First Reading, Psalm, Second Reading, Gospel Acclamation |
| 4 | Gospel + Creed | Gospel text, Homily cue, Creed (Nicene or Apostles'), Prayer of the Faithful |
| 5 | Liturgy of the Eucharist | Offertory, Children's Liturgy (conditional), Invitation to Prayer, Holy Holy, Mystery of Faith, Great Amen |
| 6 | Communion Rite | Lord's Prayer, Sign of Peace, Lamb of God, Communion Hymn |
| 7 | Concluding Rites | Thanksgiving, Choral Anthem, Blessing & Dismissal, Postlude, Announcements (conditional), short copyright |
| 8 | Back Cover | Cross, feast name, date, special notes (optional), full copyright block |

### 7. PDF Export

- **Format:** 5.5" x 8.5" half-letter (396x612pt)
- **Engine:** PDFKit (direct page construction, no headless browser)
- **Filename convention:** `YYYY_MM_DD__Feast_Name.pdf`
- **Metadata:** Title, Author, Subject, CreationDate embedded in PDF info dict
- **Typography:** Helvetica family (PDF-native), navy/burgundy/gold color scheme

### 8. HTML Preview

- Parallel renderer producing identical 8-page layout in HTML/CSS
- EB Garamond + Cinzel via Google Fonts
- `@page: 5.5in 8.5in` print CSS
- Red border + error banner on overflow pages
- Displayed in sandboxed iframe in the editor

### 9. Draft Persistence

- File-based JSON storage in `data/drafts/` (UUID filenames)
- CRUD operations: save, load, list, delete, duplicate
- Auto-save every 30 seconds while form is active
- Duplicate action appends "(copy)" to feast name
- List sorted by updatedAt descending

### 10. Parish Settings

Admin-editable fields stored in `data/settings/parish-settings.json`:
- Parish name, address, phone, URL
- 4 info blurbs (Connect, Nursery, Restrooms, Prayer)
- OneLicense number
- Short copyright (Page 7) and full copyright (Page 8)
- Font and minimum font size preferences

---

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serve SPA |
| GET | `/history` | Serve SPA (history view) |
| GET | `/admin` | Serve SPA (settings view) |
| GET | `/api/season-defaults/:season` | Season auto-rules |
| POST | `/api/validate` | Validate input + return overflow warnings |
| POST | `/api/preview` | Generate HTML preview |
| POST | `/api/generate-pdf` | Generate PDF, return download URL |
| POST | `/api/drafts` | Save draft |
| GET | `/api/drafts` | List all drafts |
| GET | `/api/drafts/:id` | Load draft by ID |
| DELETE | `/api/drafts/:id` | Delete draft |
| POST | `/api/drafts/:id/duplicate` | Duplicate draft |
| GET | `/api/settings` | Load parish settings |
| PUT | `/api/settings` | Save parish settings |
| GET | `/api/sample` | Load sample data |
| GET | `/exports/:filename` | Static file serving for exported PDFs |

---

## Test Coverage

**113 tests across 6 test files. All passing.**

| Suite | Tests | What It Covers |
|---|---|---|
| Validator | 14 | Schema validation, required fields, season enums, overflow detection (pages 3 & 4), line estimation |
| Seasons | 16 | All 5 season defaults, season application, user override preservation, music formatter |
| Template Renderer | 30 | 8-page rendering, seasonal variations (Gloria, Creed, Acclamation), parish info, readings, music display, copyright, Sign of Peace, Great Amen |
| PDF Generator | 9 | Filename format, file creation, PDF headers, creed selection, parish settings integration |
| Server API | 23 | All API endpoints, drafts CRUD, settings, auth login, approval workflow |
| User Store | 15 | User CRUD, authentication (beta mode), sessions, exclusive login, role permissions, role labels |
| Utilities | 5 | escapeHtml, nl2br, formatDate |

---

## Running the Application

```bash
# Install dependencies
npm install

# Start web server (http://localhost:3000)
npm start

# Generate PDF from command line
npm run generate -- sample/second-sunday-lent.json

# Run tests
npm test
```

---

## Authentication & User Management

### Roles & Permissions

| Role | Label | Key Permissions |
|---|---|---|
| admin | Director of Liturgy | Full access: edit all, manage users, manage settings, approve, export |
| music_director | Music Director | Edit music, seasonal settings, upload images, export PDF |
| pastor | Pastor | Edit readings, approve drafts, edit announcements |
| staff | Staff | Edit readings, music, announcements, seasonal settings, export PDF |

### Default Seed Users

| Username | Role | Notes |
|---|---|---|
| jd | admin | Director of Liturgy |
| morris | music_director | Music Director |
| vincent | music_director | Music Director |
| frlarry | pastor | Pastor |
| kari | staff | Staff |
| donna | staff | Staff |

### Session Management

- Token-based sessions (`x-session-token` header)
- Exclusive login per role: when a new user of the same role logs in, the previous session is invalidated
- Google OAuth supported (linked via `googleEmail` field on user record)

### BETA MODE — Temporary Password Bypass

**Current status: Passwords are DISABLED for beta testing.**

- Login requires username only — no password check is performed
- The password hash comparison is commented out in `src/store/user-store.js` (`authenticateUser` function)
- The login UI shows only a "Your Name" field with no password input
- All code changes are marked with `// Beta mode` and `// TODO: re-enable` comments
- Tests have been updated to reflect beta behavior

**BEFORE PRODUCTION:** Password authentication and Google Sign-On must be re-enabled. See `session_notes.md` Production Readiness Checklist for full details.

### Pastor Approval Workflow

- Drafts follow a status pipeline: `draft` → `review` → `approved`
- Any user can submit a draft for review
- Only users with `approve` permission (pastor, admin) can approve or request changes
- When `requirePastorApproval` is enabled in settings, PDF export is blocked until a draft is approved
- Request-changes action reverts draft to `draft` status with a change note

---

## Not Yet Implemented (Deferred to v1.1+)

- Saddle-stitch PDF imposition (booklet page ordering for printer)
- Puppeteer-based HTML-to-PDF rendering (for pixel-perfect font matching)
- Auto-populate readings from USCCB lectionary API
- React + Tailwind frontend rebuild
- Mobile-optimized input form
- Multi-parish support
- Email delivery to printer
- Bilingual output (English/Spanish)
- Special liturgies (Holy Week, weddings, funerals)
