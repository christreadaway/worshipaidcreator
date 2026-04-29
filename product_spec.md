# Worship Aid Generator — Product Specification

**Version:** 1.1.0
**Last Updated:** April 29, 2026
**Status:** Active development — replacing Microsoft Publisher in fall 2026

> **Pick-up note for next session:** see `session_notes.md` § "Session 3 (April 29, 2026)" for the full list of what shipped and what's open. The four items requested at end-of-session and **not yet implemented** are: (1) expand hymn library to 50 pre-1962 entries with lyrics in `src/assets/hymns/seed.json`, (2) make hymn-title autocomplete instant (preload + in-memory filter), (3) `scripts/fetch-hymns.js` Hymnary cache builder + `npm run fetch-hymns`, (4) `/api/stats/hymns` + Stats nav page visible to all users. Branch `claude/document-run-instructions-gIv6n`, HEAD `d29febe`.

---

## Overview

A Node.js web application that automates weekly creation of Catholic Mass worship booklet PDFs at two trim sizes (5.5" × 8.5" half-letter or 8.5" × 11" tabloid-folded), saddle-stitched. Staff enters readings + music selections via a web form, the app validates layout constraints, auto-fetches Sunday and daily readings from USCCB, applies seasonal defaults, and generates a print-ready PDF — replacing the previous Microsoft Publisher workflow.

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
  server.js               Express server + embedded SPA
  template-renderer.js    HTML booklet renderer for live preview
  pdf-generator.js        PDFKit-based PDF generator (half-letter + tabloid)
  readings-fetcher.js     USCCB scraping + bible-api.com translation client
  image-utils.js          Sharp-based notation auto-crop
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
    hymn-library.js       Parish-managed hymn catalog (English-only by default)
  assets/
    logo/jerusalem-cross.svg
    text/creeds.js        Nicene, Apostles' Creed, Renewal of Baptismal Vows
    text/mass-texts.js    Confiteor, Lord's Prayer, rubrics, etc.
    text/copyright.js     Default copyright boilerplate
  tests/
    validator.test.js     14 tests — schema, overflow, line estimation
    seasons.test.js       8 tests — 5 seasons + applySeasonDefaults
    template-renderer.test.js  28 tests — 8 pages, seasons, creed, readings, music
    pdf-generator.test.js      9 tests — filename, file creation, headers, creed, settings
    pdf-layout.test.js         12 tests — layout correctness for both booklet sizes
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

- **Trim sizes:**
  - `half-letter` — 5.5" × 8.5" (396×612pt). 0.5" margins (3.5×7.5 content). Print on letter (8.5×11), saddle-stitched.
  - `tabloid` — 8.5" × 11" (612×792pt). 1" margins (6.5×9 content). Print on 11×17, saddle-stitched. Fonts and spacing scale by 1.294× for readability at the larger trim.
- **Imposition:** Output is the finished booklet pages in reading order. Saddle-stitch imposition is delegated to the printer driver's "booklet print" / "fold booklet" mode (Acrobat, macOS Print, modern Windows print dialogs handle this natively).
- **Engine:** PDFKit (direct page construction, no headless browser).
- **Filename convention:** `YYYY_MM_DD__Feast_Name.pdf`.
- **Metadata:** Title, Author, Subject, CreationDate embedded in PDF info dict.
- **Typography:** Helvetica family (PDF-native), navy/burgundy/gold color scheme.
- **Persistent cover branding:** Parish logo (uploaded under Settings) replaces the default cross on every cover; parish name and tagline appear above the feast name.

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
- Cover persistent branding: logo (PNG/JPG upload), cover tagline
- 4 info blurbs (Connect, Nursery, Restrooms, Prayer)
- OneLicense number
- Short copyright (Page 7) and full copyright (Page 8)
- Font and minimum font size preferences

### 11. USCCB Readings Auto-Fetch

- `/api/readings?date=YYYY-MM-DD&translation=NABRE` scrapes `bible.usccb.org/bible/readings/MMDDYY.cfm` and returns parsed first/second readings, psalm (refrain split from verses), gospel acclamation verse, and gospel.
- Bible translation dropdown: NABRE (Lectionary, default, from USCCB), Douay-Rheims, KJV, World English Bible, Bible in Basic English, ASV. Non-NABRE picks re-fetch the citations from bible-api.com but keep Lectionary-only items (psalm refrain, acclamation verse) intact.
- "Fetch from USCCB" button populates all reading fields from the liturgical date in one click.

### 12. Liturgical Calendar Automation

- Date input defaults to the next upcoming Sunday on page load.
- Changing the date auto-detects the season using a Computus-based Easter calculator and Lent/Easter/Advent/Christmas/Ordinary windows; seasonal defaults are then applied automatically.
- Children's Liturgy of the Word: ON during the school year, OFF for summer (Jun–Aug), school Christmas break (Dec 22–Jan 6), and the Christmas/Easter seasons themselves. Manual toggle becomes a sticky override; loading a saved draft respects the stored value.

### 13. Cover Image Suggestions

- Tone dropdown (reverent, joyful, solemn, hopeful, contemplative, triumphant) plus a "Suggest covers" button.
- Returns four seasonal concept ideas with copy-ready image-generation prompts and links to stock searches (Unsplash, Pexels, Wikimedia Commons).

### 14. Hymn Library (English Only)

- Parish-managed catalog stored in KV (`hymn-library/parish-default`). Fields per entry: title, tune name, composer, key, meter, source/hymnal, notes, language (defaults to `en`).
- Seeded with 20 common English Catholic hymns covering Public Domain + GIA/OCP/Hope etc. Editable as JSON in the Settings page.
- Title fields in every Music block carry a typeahead that searches the library and shows tune name and key signature inline so the user can pick the arrangement that fits the parish. Selecting an entry auto-fills the composer field if blank.
- API: `GET /api/hymns/search?q=…` (English by default; pass `includeNonEnglish=1` to include other languages), `GET /api/hymns`, `PUT /api/hymns` (admin only).

### 15. Notation Auto-Crop

- Uploaded notation scans (PNG/JPG) are automatically trimmed of surrounding white space using Sharp's `.trim()` so the rendered booklet stays tight around the music.
- SVGs and any image Sharp cannot process are passed through unchanged.

### 16. Creed — Three Options

- Nicene Creed (default, Ordinary/Christmas)
- Apostles' Creed (Advent, Lent, Easter Season per parish worksheet)
- Renewal of Baptismal Vows (Easter Vigil and Easter Sunday Mass — full priest/all dialogue text)

---

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serve SPA |
| GET | `/history` | Serve SPA (history view) |
| GET | `/admin` | Serve SPA (settings view) |
| GET | `/api/season-defaults/:season` | Season auto-rules |
| GET | `/api/lenten-acclamations` | Lenten acclamation options |
| GET | `/api/bible-translations` | Translations for the readings dropdown |
| GET | `/api/readings?date&translation` | USCCB readings auto-fetch |
| POST | `/api/cover-suggestions` | Cover image concept ideas + search links |
| POST | `/api/validate` | Validate input + return overflow warnings |
| POST | `/api/preview` | Generate HTML preview |
| POST | `/api/generate-pdf` | Generate PDF (accepts `bookletSize`), return download URL |
| POST | `/api/drafts` | Save draft |
| GET | `/api/drafts` | List all drafts |
| GET | `/api/drafts/:id` | Load draft by ID |
| DELETE | `/api/drafts/:id` | Delete draft |
| POST | `/api/drafts/:id/duplicate` | Duplicate draft |
| POST | `/api/drafts/:id/submit-for-review` | Move draft to `review` |
| POST | `/api/drafts/:id/approve` | Pastor approval |
| POST | `/api/drafts/:id/request-changes` | Pastor requests changes |
| GET | `/api/settings` | Load parish settings |
| PUT | `/api/settings` | Save parish settings |
| POST | `/api/upload/notation` | Upload notation scan (auto-cropped) |
| POST | `/api/upload/cover` | Upload cover image |
| POST | `/api/upload/logo` | Upload parish logo (admin only) |
| GET | `/api/hymns` | Get hymn library |
| GET | `/api/hymns/search?q&limit&includeNonEnglish` | Typeahead search |
| PUT | `/api/hymns` | Save hymn library (admin only) |
| GET | `/api/sample` | Load sample data |
| GET | `/exports/:filename` | Static file serving for exported PDFs |

---

## Test Coverage

**127 tests across 7 test files. All passing (one pre-existing user-store flaky timestamp test occasionally collides between consecutive runs).**

| Suite | Tests | What It Covers |
|---|---|---|
| Validator | 14 | Schema validation, required fields, season enums, overflow detection (pages 3 & 4), line estimation |
| Seasons | 16 | All 5 season defaults, season application, user override preservation, music formatter |
| Template Renderer | 30 | 8-page rendering, seasonal variations (Gloria, Creed, Acclamation), parish info, readings, music display, copyright, Sign of Peace, Great Amen |
| PDF Generator | 9 | Filename format, file creation, PDF headers, creed selection, parish settings integration |
| Server API | 23 | All API endpoints, drafts CRUD, settings, auth login, approval workflow |
| User Store | 17 | User CRUD, authentication (beta mode), case-insensitive login, display name matching, sessions, exclusive login, role permissions, role labels |
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

### Flexible Login Name Matching

Users can log in by typing any recognizable form of their name. The system tries four fallback levels:

1. **Exact username** (case-insensitive): `jd`, `JD`, `frlarry`, `FRLARRY`
2. **Stripped dots/spaces → username**: `J.D.` → `jd`, `Fr. Larry` → `frlarry`
3. **Full display name** (before parenthetical): `Morris` matches `Morris (Music Director)`
4. **Any word in display name**: `Larry` matches `Fr. Larry (Pastor)`

Failed logins show available usernames instead of a generic error.

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

## Future Build Requirements (Backlog)

Captured during the Publisher-replacement pass; not yet implemented.

### Open Tasks — Next Session (Top Priority)

These four were requested at the end of Session 3 and should be the first work in the next chat:

1. **Expand hymn library to 50 pre-1962 entries with lyrics** — write `src/assets/hymns/seed.json` with 50 hymns composed before 1962. Per entry: `title`, `tune`, `composer`, `lyricist`, `year`, `key`, `meter`, `source`, `tradition` (Latin chant / Lutheran / Anglican / American / Irish / etc.), `language: 'en'`, `lyrics` (≥ first verse, public domain), `referenceUrls` (Hymnary / CPDL / OpenHymnal). Update `src/store/hymn-library.js` to load this JSON in place of the hardcoded 20-entry array.
2. **Instant hymn-title search** — replace the debounced server-call autocomplete (`initHymnAutocomplete` / `runHymnSearch` in `src/server.js`) with a one-time `/api/hymns` fetch on page load that caches the entire library client-side, then filter in-memory on every keystroke (no debounce).
3. **Hymnary fetch script** — `scripts/fetch-hymns.js` that reads the seed library, calls `hymnary.org/data_api` for each tune/title, enriches with returned metadata (meter, scripture refs, hymnal instances), and writes a cached `data/hymn-library-local.json`. Wire as `npm run fetch-hymns`. Respect ≤ 1 req/sec and Hymnary attribution.
4. **Hymn usage stats page** — `/api/stats/hymns` walks every draft in `data/drafts/` and aggregates per-hymn frequency by month and by liturgical season. Add a "Stats" nav link visible to **all roles** (no permission gate) plus a `#page-stats` view in the SPA showing the frequency table.

### Music & Licensing
- **OneLicense automation** — OneLicense.net publishes no public API and the site is Cloudflare-protected (returns 403 to any non-browser request). Recommended path:
  1. Build a **Hymnary.org client** (free public API at `hymnary.org/data_api`, no auth, JSON; returns title, tune, meter, composer, scripture refs, hymnal instances). Cache aggressively; respect attribution.
  2. Extend the local hymn library to a parish-managed `arrangements` table (per-tune × hymnal × key × accompaniment file) so the user can pick a specific arrangement.
  3. Generate a **OneLicense reporting CSV exporter** that lists every hymn used in a published booklet, ready for upload into OneLicense's reporting tool.
- **Version picker** — when OneLicense or Hymnary returns multiple versions of the same song (different keys, arrangements, accompaniments), surface them in a comparison panel showing key, hymnal, page number, and any notes so the user can choose the one to use.
- **Longer hymns overflow handling** — when a hymn's notation is too long to fit a single page, automatically split across pages or auto-scale.
- **Per-arrangement key display** — already shown in v1 hymn library; needs to integrate with OneLicense/Hymnary lookup once those land.

### PDF Output
- **True booklet imposition** built into the app (4-up sheets in saddle-stitch order) so the file is print-ready without a printer-driver "fold booklet" step. Currently delegated to print dialog.
- **Auto-fit** — when content overflows the standard 8 pages, automatically push to 12 or 16 pages (multiples of 4 for saddle stitch) rather than letting PDFKit add unnumbered pages.
- **Side-by-side Publisher comparison** to verify pixel parity for parishes migrating from Publisher.

### Wedding / Funeral / Memorial Variants
- Distinct booklet template with these features:
  - Parish-defined option lists for hymns and readings (couple/family chooses from approved menus).
  - Cover photo of the deceased / couple.
  - Back-page obituary or biography.
  - **Ritual-book introductions** — text from the Order of Christian Funerals / Order of Celebrating Matrimony (general introduction to the rite, etc.) with editable fill-in blocks for the lead to add context about what's happening in the Mass.
  - **Communion etiquette note** for non-Catholic attendees (what to do at communion, when to come forward for a blessing, posture cues, etc.) — boilerplate parish text editable per booklet.

### Workflow
- **Proofing/review process** — currently a draft is "approved or not." Need a richer round-trip where the proof is shared, marked up with comments, and revised before finalization. Worth a design session.
- **Pastor approval round-trip** comments / changelog (already partial via `request-changes` endpoint).
- **Email delivery to printer**.
- **Multi-parish support** with per-parish settings, libraries, logos.

### Internationalization (Deferred)
- App is English-only for v1. Spanish hymns and readings are out of scope; the hymn library filters to `language === 'en'` by default.

### Other Backlog
- Saddle-stitch imposition built-in.
- Puppeteer-based HTML-to-PDF for pixel-perfect font matching.
- React + Tailwind frontend rebuild.
- Mobile-optimized input form.
