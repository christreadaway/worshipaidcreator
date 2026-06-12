# Session Notes — Worship Aid Generator

**Session Date:** February 27–28, 2026
**Branch:** `claude/build-feature-complete-YlLEn`

---

## What Was Done

### Session 1 (Feb 27): Initial Build + PRD Alignment

**Starting point:** Repository had an initial commit with uploaded reference files — the PRD (`worship_aid_generator_PRD.md`), a questionnaire HTML mockup (`FULLworship_aid_questionnaire.html`), and a Word doc spec (`WorshipAidGenerator_ProductSpec.docx`). No application code existed.

**Completed:**
1. **Built the full application from scratch** to match PRD requirements:
   - Express web server with embedded single-page application
   - 8-page HTML template renderer (5.5" x 8.5" booklet pages)
   - PDFKit-based PDF generator (same 8-page layout)
   - AJV input validation with JSON Schema
   - Overflow detection engine for pages 3 and 4
   - Liturgical season auto-rules engine (all 5 seasons)
   - Music display logic with per-mass-time consolidation
   - File-based persistence for drafts and parish settings
   - CLI tool for headless PDF generation

2. **Created comprehensive test suite** — 82 tests across 5 files covering all modules

3. **Added data directory structure** with `.gitignore` for runtime artifacts (PDFs, logs)

4. **Created sample data** (`sample/second-sunday-lent.json`) for testing and demo

### Session 2 (Feb 28): Documentation + Test Verification

- Ran full test suite — **82/82 tests passing, 0 failures**
- Created `product_spec.md` documenting the as-built application
- Created `session_notes.md` (this file)

---

## Git History

```
33a2b4f Add data directory structure with .gitignore for runtime artifacts
c1d7673 Rebuild Worship Aid Generator to match new PRD requirements
6a42611 Add files via upload
cb5f528 Merge pull request #1
7a1a36e Add files via upload
e3443d0 Implement feature-complete Worship Aid Generator with web UI
3282487 Add files via upload
136f57c Initial commit
```

---

## Key Design Decisions

1. **PDFKit instead of Puppeteer** — Puppeteer-core is listed as a dependency but not used for PDF generation. PDFKit gives direct page layout control without needing a headless browser, which simplifies deployment. Trade-off: font rendering uses Helvetica (PDF built-in) instead of EB Garamond. HTML preview uses Google Fonts for accurate rendering.

2. **Embedded SPA instead of React** — The entire frontend is a single HTML string served by Express (`getAppHtml()` in server.js). No build step, no framework dependencies, no bundler configuration. Trade-off: ~700-line function, harder to maintain long-term, but zero deployment complexity.

3. **File-based persistence instead of Firebase** — PRD specified Firebase Firestore, but for local/dev use, JSON files in `data/` are simpler. The store API (`file-store.js`) has the same interface a database adapter would need, making migration straightforward.

4. **Parallel HTML + PDF renderers** — Two separate renderers produce the same 8-page layout: `template-renderer.js` (HTML for preview) and `pdf-generator.js` (PDFKit for export). This avoids Puppeteer but means layout logic is duplicated. Both consume the same data model and season rules.

5. **Overflow detection is estimation-based** — Uses character count / 65 chars-per-line heuristic rather than actual rendered line measurement. Accurate enough for early warnings; the HTML preview provides visual confirmation.

---

## Test Results (Feb 28, 2026)

```
# tests 113
# suites 23
# pass 113
# fail 0
# cancelled 0
# skipped 0
# duration_ms ~1300ms
```

Breakdown:
- validator.test.js: 14 pass (schema, estimateLines, detectOverflows)
- seasons.test.js: 16 pass (5 season defaults, applySeasonDefaults, music formatter)
- template-renderer.test.js: 30 pass (8 pages, seasons, creed, readings, music, parish info, copyright)
- pdf-generator.test.js: 9 pass (filename, file creation, headers, creed, settings)
- server.test.js: 23 pass (API endpoints, drafts CRUD, settings, auth, approval workflow)
- user-store.test.js: 15 pass (user CRUD, auth beta mode, sessions, exclusive login, permissions, labels)
- Utilities (escapeHtml, nl2br, formatDate): 5 pass included in template-renderer suite

---

## PRD Coverage Assessment

| PRD Requirement | Status | Notes |
|---|---|---|
| 4.1 Weekly Input Form | Done | All fields from PRD implemented in SPA |
| 4.2 Live Preview | Done | Side-by-side HTML preview with overflow warnings |
| 4.3 PDF Export | Done | PDFKit-based, correct filename convention |
| 4.4 Draft Saving and History | Done | Auto-save (30s), manual save, list, duplicate, delete |
| 4.5 Template & Static Content | Done | Admin settings page, parish info editable |
| 5.1 Season Auto-Rules | Done | All 5 seasons with correct defaults per PRD table |
| 5.2 Overflow Prevention | Done | Pages 3 & 4 tracked, specific block + line count in warnings |
| 5.3 Print Format | Partial | Sequential 8-page PDF (5.5x8.5). Saddle-stitch imposition deferred. |
| 5.4 Music Display Logic | Done | Same-music consolidation, time qualifiers when different |
| 5.5 Readings Sourcing | Done (v1) | Manual entry only, as specified for v1.0 |
| 5.6 Copyright Block | Done | Short (Page 7) + full (Page 8), OneLicense admin-editable |
| 6.1 Data Model | Done | Full schema matching PRD data structure |
| 6.2 Settings Data | Done | All fields from PRD, with defaults |
| 7 Integrations | Deferred | Firebase, Google Auth, Cloud Functions not implemented |

---

## Known Limitations

1. **No authentication** — Anyone with network access can use the app. PRD specified Google Auth.
2. **No saddle-stitch imposition** — PDF exports pages 1-8 sequentially. The `generateImposedPdf` function exists as a stub that falls back to sequential output.
3. **PDF uses Helvetica** — PDFKit uses built-in Helvetica family instead of EB Garamond / Cinzel. HTML preview matches the intended design; PDF is functionally correct but typographically different.
4. **No cover image support** — Schema has `coverImagePath` field but no upload handling or rendering.
5. **Overflow detection is heuristic** — Character-count-based line estimation may not match actual rendered output for unusual text (many short lines, very long words, etc.).
6. **Single-process server** — No clustering, no graceful shutdown handling. Fine for single-parish use.

---

### Session 3 (Feb 28): Multi-User Workflow + Netlify Deployment

**Completed:**
1. **Multi-user role-based access** — Four roles (admin, music_director, pastor, staff) with per-role permissions, session management, exclusive login per role
2. **Pastor approval workflow** — Draft → Review → Approved pipeline, with optional requirePastorApproval setting to gate PDF export
3. **Google OAuth integration** — Google Identity Services login (frontend) + tokeninfo verification (backend), linked to user accounts via email
4. **Netlify deployment refactoring** — Async KV storage abstraction (`kv.js`) supporting both local filesystem and Netlify Blobs, serverless-http wrapping, build pipeline for SPA extraction
5. **Image uploads** — Cover images and music notation uploads with Netlify Blobs storage in production
6. **Default seed users** — jd (admin), morris & vincent (music_director), frlarry (pastor), kari & donna (staff)

### Session 4 (Feb 28): Beta Testing Configuration

**Completed:**
1. **Disabled password authentication for beta testing** — Login now requires username only, no password. Password infrastructure is commented out, not deleted — marked with TODO comments for production reinstatement.
2. **Simplified login UI** — Password field replaced with hidden input, label changed to "Your Name", Enter key submits directly.
3. **Updated tests** — Password rejection tests updated to reflect beta mode behavior.
4. **Rebuilt SPA** for deployment with password-less login.

---

## PRODUCTION READINESS CHECKLIST

**Before going to production, the following MUST be re-enabled:**

- [ ] **Password authentication** — Un-comment the password hash check in `src/store/user-store.js` line ~101 (`authenticateUser` function). Search for "Beta mode" TODO comments.
- [ ] **Google Sign-On** — Verify Google OAuth client ID is configured in environment variables and the Google Identity Services integration is active. Update authorized redirect URIs in Google Cloud Console for the production domain.
- [ ] **Restore password UI** — Replace the hidden password field in the login form (in `src/server.js` `getAppHtml()`) with the actual password input field.
- [ ] **Restore password test** — Update the "should allow login regardless of password in beta mode" tests back to "should reject incorrect password" in both `user-store.test.js` and `server.test.js`.
- [ ] **Set strong default passwords** — Change the seed user passwords from simple beta passwords (worship2026, music2026, etc.) to strong defaults or require password setup on first login.

### Session 5 (Feb 28): Login Fix — Name Matching, Error Messages, Netlify Reliability

**Problem:** Users could not log in on the deployed Netlify site. The generic "Invalid credentials" error gave no debugging information.

**Root causes identified:**
1. Login required exact username (e.g. `jd`) — typing display names like "J.D." or "Morris" or "Larry" failed silently
2. Error messages were hidden due to a CSS `display:none` bug — the JS set `display=''` which fell back to the CSS rule
3. User seeding ran at module load time with `.catch()` swallowing errors — on Netlify serverless cold starts, seed could fail silently, leaving zero users in the blob store
4. No debug logging — impossible to diagnose failures from the deployed site

**Completed:**
1. **Flexible name matching** — Login now accepts username, display name, partial name, any case. Four fallback levels:
   - Case-insensitive username match (`JD` → `jd`)
   - Strip dots/spaces and match username (`Fr. Larry` → `frlarry`)
   - Match against full display name before parenthetical (`Morris` → `Morris (Music Director)`)
   - Match against any individual word in display name (`Larry` → `Fr. Larry (Pastor)`)
2. **Helpful error messages** — Failed logins now show: `No account found for "bob". Try: donna, frlarry, jd, kari, morris, vincent`
3. **Resilient seeding for Netlify** — If initial seed fails (cold start timing), login route retries on-demand with `ensureSeeded()`
4. **Server-side `[LOGIN]` debug logging** — Every login attempt logs what was tried, what matched, and what's available
5. **CSS/JS error display fix** — Login errors now correctly show with `display='block'`
6. **Cleaned up 36 stale test user files** from data directory

**Test results:** 115 tests passing, 23 name input variants verified via HTTP endpoint.

---

## What's Next (Recommended)

1. **Beta user testing** — Have the liturgy team log in by name and run through a real week's worship aid.
2. **Font embedding in PDF** — Embed EB Garamond / Cinzel in PDFKit for typographic parity with HTML preview.
3. **Saddle-stitch imposition** — Implement the booklet page ordering for direct-to-printer output.
4. **Deploy to Netlify** — Connect repo, configure custom domain (worshipaid.modernizecatholic.com), set up GoDaddy CNAME.
5. **Puppeteer integration** — For pixel-perfect PDF output matching the HTML preview exactly.
6. **Re-enable security for production** — See Production Readiness Checklist above.

---

## Session 3 (April 29, 2026): Publisher-Replacement Pass

**Branch:** `claude/document-run-instructions-gIv6n`

**Context:** Microsoft is discontinuing Publisher in fall 2026. This session expanded the app to replace it: USCCB integration, additional booklet size, parish branding, hymn library, and a long list of captured future requirements.

### Shipped (committed and pushed)

Commits on this branch:
- `9d6f4a8` Add USCCB readings auto-fetch with Bible translation dropdown
- `f09e0bf` Auto-defaults for liturgical date, season, Children's Liturgy + cover image suggestions
- `d29febe` Add tabloid booklet size, parish branding, hymn library, notation auto-crop, third creed option

Feature summary:
1. **USCCB readings auto-fetch** — `src/readings-fetcher.js` scrapes `bible.usccb.org/bible/readings/MMDDYY.cfm` and parses first/second readings, psalm (refrain split from verses), gospel acclamation verse, and gospel. `/api/readings?date&translation` endpoint. "Fetch from USCCB" button in the Readings section.
2. **Bible translation dropdown** — NABRE (default), Douay-Rheims, KJV, World English Bible, Bible in Basic English, ASV. Non-NABRE picks re-fetch citations from bible-api.com but keep Lectionary-only items intact.
3. **Liturgical date / season automation** — Date defaults to next Sunday on load; changing the date detects season via Computus-based Easter calculator and applies seasonal defaults.
4. **Children's Liturgy auto-defaults** — ON during the school year; OFF for summer (Jun–Aug), school Christmas break (Dec 22–Jan 6), and Christmas/Easter seasons. Manual toggle is a sticky override; saved drafts respect stored value.
5. **Cover image suggestions** — Tone dropdown (reverent / joyful / solemn / hopeful / contemplative / triumphant) returns four seasonal concept ideas with copy-ready image-generation prompts and stock-search links (Unsplash, Pexels, Wikimedia Commons).
6. **Tabloid booklet size** — `/api/generate-pdf` now accepts `bookletSize`. Half-letter (5.5×8.5, 0.5" margins) and tabloid (8.5×11, 1" margins, fonts scaled 1.294×). Tabloid prints on 11×17 saddle-stitched. Imposition is delegated to printer driver booklet-print mode.
7. **PDF generator refactor** — Layout values are now instance properties keyed off `bookletSize`. Generator returns `pageMaxY[]` and `pageCount` for layout introspection.
8. **PDF layout test suite** — `src/tests/pdf-layout.test.js` (12 tests) verifies page count, dimensions, content bounds, and long-content stress for both sizes.
9. **`.fg-row` alignment fix** — Wrapped labels (e.g. "Choral Anthem (Concluding)") no longer push the right-column input out of line.
10. **Persistent cover branding** — Parish logo upload (admin only) replaces default cross on every cover. Cover tagline appears under parish name. Settings are persisted as part of parish settings (`logoPath`, `coverTagline`).
11. **Hymn library v1** — Parish-managed catalog (`src/store/hymn-library.js`) seeded with 20 English Catholic hymns. Fields: title, tune, composer, key, meter, source, language. `/api/hymns`, `/api/hymns/search`, `PUT /api/hymns`. Title fields in every Music block carry a typeahead surfacing tune name and key signature so the user can pick the right arrangement; selecting auto-fills composer when blank. Editable as JSON in Settings.
12. **Notation auto-crop** — Sharp-based `src/image-utils.js` trims whitespace from uploaded notation scans. Wired into `/api/upload/notation` for both local and Netlify Blobs storage paths.
13. **Renewal of Baptismal Vows** — Third creed option for Easter Vigil and Easter Sunday. Schema enum, UI dropdown, and PDF generator updated.
14. **OneLicense investigation** — Confirmed no public API exists (Cloudflare-blocked, no developer portal, no GitHub integrations). Recommended path captured in `product_spec.md` Future Build Requirements: Hymnary.org client + arrangements table + OneLicense reporting CSV exporter.
15. **Documentation** — `product_spec.md` and `worship_aid_generator_PRD.md` bumped to v1.1. New "Future Build Requirements" section captures every backlog item that surfaced.

### Test status at end of session
- 127 total tests, 126 passing.
- The single failing test (`user-store.test.js > "should authenticate by display name first word"`) is a **pre-existing flaky timestamp collision** between consecutive runs. Not related to this session's changes. Worth fixing — likely needs a unique-id generator that doesn't rely on `Date.now()`.

### Outstanding work (NOT shipped — pick up here in next chat)

The following were requested in this session but **not implemented**. They should be the first work in the next session.

1. **Expand hymn library to 50 pre-1962 entries with lyrics** — Put the seed catalog in `src/assets/hymns/seed.json`. Each entry: `title`, `tune`, `composer`, `lyricist`, `year`, `key`, `meter`, `source`, `tradition` (Latin chant / Lutheran / Anglican / American / Irish / etc.), `language: 'en'`, `lyrics` (at least the first verse, public domain), `referenceUrls` (Hymnary.org, CPDL, OpenHymnal links). Update `src/store/hymn-library.js` to load this JSON instead of the hardcoded 20-entry array. **All entries must be composed before 1962.**

2. **Make hymn search instant** — Replace the debounced server-call autocomplete (`initHymnAutocomplete` / `runHymnSearch` in `src/server.js`) with a one-time `/api/hymns` fetch on page load that caches the entire library client-side, then filter in-memory on every keystroke (no debounce, zero network latency). User reported the current 150ms debounce isn't responsive enough.

3. **Hymnary fetch script for local caching** — `scripts/fetch-hymns.js` that reads the seed library, calls Hymnary.org's `data_api` (free, no auth) for each `tune` and `title`, enriches entries with metadata Hymnary returns (meter, scripture references, hymnal instances), and writes a cached `data/hymn-library-local.json`. Add `npm run fetch-hymns` to `package.json`. Respect ≤1 req/sec rate limit and Hymnary attribution.

4. **Hymn usage stats page (clickable for ALL users)** — New `/api/stats/hymns` endpoint that walks every saved draft in `data/drafts/` and aggregates how often each hymn title appears across the calendar year, by month, and by liturgical season. Add a "Stats" nav link visible to **all roles** (no permission gate) plus a `#page-stats` view in the SPA showing the frequency table.

### Future Build Requirements captured in `product_spec.md` (also untouched)

These are documented in the Future Build Requirements section of `product_spec.md` but not implemented:

- **Wedding/funeral/memorial booklet variants** — parish-defined option lists for hymns and readings, cover photo of the deceased, back-page obituary, **ritual-book introductions** (general introduction to the rite, etc., from the Order of Christian Funerals / Order of Celebrating Matrimony with editable fill-in blocks), **communion etiquette note for non-Catholic attendees**.
- **Proofing/review round-trip workflow** — richer than current draft → approve. Marked-up comments and revisions before finalization. Worth a design session.
- **OneLicense version-picker UI** — when OneLicense or Hymnary returns multiple versions of the same song (different keys, arrangements), surface them in a comparison panel showing key + hymnal + page so the user can choose.
- **True saddle-stitch imposition built in** — currently delegated to printer driver.
- **Longer-hymn overflow handling** — auto-split or auto-scale when a hymn's notation is too long for one page.
- **Auto-fit to multiples of 4 pages** — when content overflows 8 pages, push to 12 or 16 (multiples of 4 for saddle stitch).
- **Email delivery to printer**.
- **Multi-parish support** with per-parish settings, libraries, logos.
- **Mobile-optimized form**, **React + Tailwind rebuild**, **Puppeteer-based HTML-to-PDF**.

### Branch state for next session

- Branch: `claude/document-run-instructions-gIv6n`
- HEAD: `d29febe`
- Pushed: yes (origin matches)
- Working tree: clean (verified before writing this note)

---

## Session 4 (April 29, 2026): Login Restore + Pick-Up Pass

**Branch:** `claude/restore-login-finish-work-pOnWv`

**Context:** Deployed Netlify site rendered blank — user could not see the
login screen. Picked up the outstanding work captured at the end of the
prior session, kept it in small commits so each piece could ship
independently, and ran a comprehensive bug sweep against every API
endpoint.

### Critical fix shipped first

**Login was broken site-wide** because of a single escaping bug. Inside
`getAppHtml()`'s backtick template literal, the cover-suggestions HTML
used `toast(\'Prompt copied\', \'success\')` — but template literals
collapse `\'` to `'`, leaving an unescaped quote inside a single-quoted
JS string in the rendered page. That parse error halted every script at
the bottom of the page, including `checkAuth()`, so every page div
(login, editor, history, admin) stayed `display:none` and the site
appeared to render nothing. Fix: switch to `\\'` (which the template
literal preserves as `\'`), matching the convention used by every other
onclick handler in the file. Commit: `300abdc`.

Verified by smoke test (curl POST /api/auth/login for jd, Morris,
Fr. Larry — all return 200 with valid tokens).

### Features shipped (one commit each)

- `300abdc` **Fix login parse error** + clean up user-store test leakage
  (after-hook deletes tracked test users; uniqueName generator removes
  the Date.now() collision flake from the prior session).
- `861fcd4` **Instant hymn search** — fetches `/api/hymns` once at
  startup, caches client-side, filters synchronously on every keystroke
  (no debounce, zero network latency). Cache invalidated when admin
  saves the library from Settings.
- `48a6130` **Hymn usage stats page** — `GET /api/stats/hymns`
  aggregates hymn-title usage across saved drafts (total, by month, by
  liturgical season), counted once per draft. New "Stats" nav link
  visible to **all roles** with a sortable table view.
- `3b46838` **Hymnary fetch script** (`npm run fetch-hymns`) — reads
  `src/assets/hymns/seed.json`, calls Hymnary.org's free search
  endpoint per entry (tune lookup first, falls back to title), writes
  enriched cache to `data/hymn-library-local.json`. Rate-limited at
  ~1 req/sec; defensive against network failures.

### Bugs found in comprehensive sweep + fixed

- `ecb683f` **Hymn search: curly-vs-straight apostrophe miss** — seed
  uses typographic `'` (e.g. "On Eagle's Wings"), users type `'`.
  Both server and client now lowercase + collapse smart quotes
  before matching.
- `555140e` **Invalid season returned 200** — `GET /api/season-defaults/<bad>`
  silently returned ordinary defaults. Now returns 400 with the list
  of valid seasons.

### Tests / endpoints verified

- 127/127 tests passing (no regressions; the prior session's flaky
  display-name-first-word test is now stable).
- Every page route (`/`, `/login`, `/admin`, `/history`, `/users`,
  `/stats`) returns 200.
- Every read-only API endpoint returns 200; protected endpoints return
  401 unauthenticated and 403 with insufficient permissions.
- PDF generation works for both half-letter and tabloid booklets and
  for all three creed types (nicene, apostles, baptismal_vows).
- Cover-suggestion endpoint handles empty body gracefully.
- Login error UI uses `textContent` (not `innerHTML`) — XSS safe.

### Outstanding work (NOT shipped — pick up here next time)

- **Expand hymn library to 40 pre-1962 entries with lyrics** in
  `src/assets/hymns/seed.json` and refactor `src/store/hymn-library.js`
  to load it. Decided to ship the rest of the features first; the
  current library remains the 20-entry hardcoded `STARTER_LIBRARY`.
  Note: user revised target from 50 to 40 to "as many as we have"
  (which today is 20). The seed.json work is queued for when there's
  bandwidth to compose first-verse PD lyrics for each entry.

### Branch state for next session

- Branch: `claude/restore-login-finish-work-pOnWv`
- HEAD: `555140e`
- Pushed: yes (origin matches)
- Working tree: clean

---

## Session 5 (April 30, 2026): Attachments Library, Sanctus Toggle, Feast Auto-Detect

**Branch:** `claude/add-file-uploads-yxr13`

**Context:** Liturgist needed (1) a place to upload audio / PDF / score
files that get reused across worship aids (preludes, postludes, mass
settings, anthems), (2) a Sanctus English/Latin language toggle, (3)
genuine date-driven auto-fill for the "Feast / Sunday Name" field
because the previous attempt only filled the season, (4) parish
settings for mass times + clergy + standing welcome/closing text, and
(5) several UI cleanups (Bible Translation dropdown wider, hymn
autocomplete restricted to actual hymn slots).

### Shipped (committed and pushed)

Commits on this branch:
- `03db65d` Attachments library, parish settings, Sanctus toggle, feast auto-detect
- `<NEXT>`  Bug-sweep follow-ups + tests + docs

Feature summary:

1. **Generic attachments library** — `src/store/attachments.js` defines
   16 kinds (prelude, postlude, processional, kyrie, gloria, sanctus,
   mystery_of_faith, agnus_dei, psalm, gospel_acclamation,
   offertory_anthem, communion, thanksgiving, choral_anthem,
   mass_setting, general). Multer-backed upload (≤50 MB) accepts
   audio, PDF, image, MusicXML, MIDI, doc/text. Files are stored on
   disk locally (`data/uploads/attachments/`) and in Netlify Blobs
   (`uploads-attachments` namespace) in production.
   - `GET    /api/attachments` (filterable by `kind`, `kinds`, `q`)
   - `POST   /api/attachments` (manage_settings)
   - `PUT    /api/attachments/:id` (manage_settings)
   - `DELETE /api/attachments/:id` (manage_settings) — cleans up both
     metadata and the on-disk binary (the namespaces don't line up
     between multer's diskStorage and the kv adapter, so the route
     does the unlink itself).
   - `GET    /api/uploads/attachments/:filename` (serves bytes)

2. **Per-music-slot quick-pick dropdowns** — Non-hymn slots (prelude,
   postlude, kyrie, offertory anthem, choral anthem) carry a small
   "pick from library" select wired to the matching kind. Picking an
   entry copies title + composer into the music block AND attaches
   the file to the worship aid's reference list. Hymn slots
   (processional, communion, thanksgiving) keep the hymn-library
   typeahead.

3. **Hymn autocomplete scoping fix** — `data-hymn-search="title"` is
   now only emitted on actual hymn fields. Preludes / postludes / mass
   settings no longer search the hymn catalog.

4. **Sanctus / Holy, Holy, Holy English-vs-Latin toggle** — New
   `seasonalSettings.holyHolyLanguage` ('english' | 'latin'). Renderer
   resolves the precedence per-aid override > parish default > English.
   Latin block uses the Roman Missal text ("Sanctus, Sanctus, Sanctus
   Dominus Deus Sabaoth..."). Heading switches between
   "Holy, Holy, Holy" and "Sanctus".

5. **Liturgical calendar module** — `src/liturgical-calendar.js`
   computes feast/Sunday names using the General Roman Calendar (US):
   - Sundays of Advent / Lent / Easter (numbered) including Divine
     Mercy and the Sunday in the Octave
   - Triduum (Palm Sunday, Holy Thursday, Good Friday, Holy Saturday)
   - Movable solemnities (Easter, Ascension, Pentecost, Trinity, Corpus
     Christi, Sacred Heart, Christ the King, Holy Family, Baptism of
     the Lord, Epiphany)
   - Fixed feasts (Christmas, Annunciation, Assumption, All Saints,
     Immaculate Conception, etc.)
   - Numbered Sundays in Ordinary Time (anchored to Christ the King =
     34th Sunday)
   - `GET /api/liturgical-info?date=YYYY-MM-DD` returns
     `{date, liturgicalSeason, feastName}`.
   - Editor's `onLiturgicalDateChange` now calls this endpoint and
     fills the Feast / Sunday Name input whenever it's empty (manually
     typed names are preserved).

6. **Parish settings expansion** — `DEFAULT_PARISH_SETTINGS` adds
   `massTimes` (multi-line cover schedule), `pastor`, `pastorTitle`,
   `associates`, `deacons`, `musicDirector`, `welcomeMessage`,
   `closingMessage`, `defaultSanctusLanguage`. Settings page UI gets a
   new Clergy & Staff section, Mass Times textarea, Standing Worship-Aid
   Text section, and Liturgical Defaults section.

7. **Cover-page rendering** — Mass times line on cover is sourced from
   `settings.massTimes` (one entry per line). Clergy lines render
   under the times. Welcome message renders inside the cover; closing
   message renders on the back cover.

8. **Children's Liturgy expansion** — Schema/UI/template add
   `childrenLiturgyLeader` and `childrenLiturgyNotes` so the parish
   can name the catechist and add a one-liner like "Children rejoin
   parents at the Offertory."

9. **Bible Translation dropdown layout fix** — Replaced the cramped
   `1fr 1fr auto` row with a dedicated `.readings-toolbar` grid
   (`minmax(180px, 1.6fr) auto 1fr`) so the full "NABRE (Lectionary,
   USCCB)" label fits without truncation. Added an explicit section
   note clarifying that USCCB is the default source.

### Bugs found in comprehensive sweep + fixed

- **HIGH — Local attachment binary leaked on delete.** `kv.del('uploads-attachments', ...)` resolves to a different path than multer's `diskStorage` destination. The DELETE route now does `fs.unlinkSync` against the multer path before clearing metadata. Regression test asserts the file is gone from disk after delete.
- **MEDIUM — Feast-name `userSet` flag was permanent.** Replaced the
  flag with a simpler "fill only when empty" rule. Loading a saved
  draft preserves whatever's in the field; clearing the field then
  changing the date re-fills it.
- **MEDIUM — Sanctus parish-default fallback never fired.**
  `applySeasonDefaults` was setting `holyHolyLanguage='english'` before
  the renderer's fallback chain could consult `settings.defaultSanctusLanguage`. Removed the eager default; the renderer now resolves
  per-aid > parish > English correctly. Covered by a regression test.
- **LOW — Picker silently no-op'd duplicates.** Adding a file already
  attached now toasts "That file is already attached" instead of
  swallowing the action.

### Tests / endpoints verified

- **168 / 168 tests passing** (147 prior + 21 new in
  `attachments-and-calendar.test.js` and `liturgical-calendar.test.js`).
- Smoke-tested via curl on the running server:
  - `POST /api/auth/login` with jd/worship2026 and morris/music2026 →
    200 + valid token
  - `GET  /api/auth/me` → 200 with user payload
  - `GET  /api/liturgical-info?date=2026-04-05` →
    "Easter Sunday of the Resurrection of the Lord", season=easter
  - `GET  /api/liturgical-info?date=2026-12-25` →
    "The Nativity of the Lord (Christmas)", season=christmas
  - `GET  /api/liturgical-info?date=2026-02-18` → "Ash Wednesday",
    season=lent
  - `POST /api/attachments` (multipart) → 200 + metadata
  - `GET  /api/attachments` → list with the new entry
  - `GET  /uploads/attachments/<file>` → file bytes
  - `DELETE /api/attachments/:id` → 200; metadata gone, disk file gone
  - `GET  /api/settings` returns all new fields with defaults
  - `PUT  /api/settings` persists `pastor`, `associates`, `massTimes`,
    etc.
  - `POST /api/preview` with `holyHolyLanguage=latin` returns HTML
    containing "Sanctus, Sanctus, Sanctus" + "Pleni sunt"
  - `GET  /` (editor HTML) carries IDs `holyHolyLanguage`,
    `attachmentPicker`, `s_massTimes`, `s_pastor`,
    `childrenLiturgyLeader`, `attachmentFileInput`

### Files added

- `src/liturgical-calendar.js`
- `src/store/attachments.js`
- `src/tests/liturgical-calendar.test.js`
- `src/tests/attachments-and-calendar.test.js`

### Files modified

- `src/server.js` (attachments routes, liturgical-info route,
  attachments UI, parish-settings UI, Sanctus toggle UI, feast-name
  auto-fill, hymn-autocomplete scoping, music-block field rewrite,
  Bible Translation toolbar layout)
- `src/template-renderer.js` (cover renders mass times + clergy +
  welcome message; back cover renders closing message; Sanctus block
  renders text in chosen language; Children's Liturgy block adds
  leader + notes)
- `src/schema.js` (`holyHolyLanguage`, `childrenLiturgyLeader`,
  `childrenLiturgyNotes`, `attachmentRefs`)
- `src/config/defaults.js` (mass times, clergy, welcome/closing,
  defaultSanctusLanguage)
- `src/config/seasons.js` (don't pre-set holyHolyLanguage; let
  renderer resolve fallback)
- `src/assets/text/mass-texts.js` (HOLY_HOLY_HOLY_LATIN,
  getHolyHolyHolyText)

### Branch state at end of session

- Branch: `claude/add-file-uploads-yxr13`
- Pushed: yes (origin matches)
- Working tree: clean
- Tests: 170/170 passing

### Session 5 follow-up commits (April 30, 2026, same branch)

After the initial session shipped, two follow-up issues surfaced and
were fixed in `claude/add-file-uploads-yxr13`:

1. **Readings panel layout collapse.** The 3-column toolbar grid
   (translation / button / status) overflowed the 380px sidebar and
   crushed every reading input below it into a 1-character vertical
   strip on the right edge. Restructured as a 2-column grid
   (`minmax(0, 1fr) auto`) for translation + button, with the status
   message on its own line below. Regression test in
   `attachments-and-calendar.test.js` asserts the new markup.

2. **Liturgical season didn't track the date when loading a saved
   draft.** The date-change handler already auto-detected the season,
   but loading a draft via `populateForm()` set the season directly
   from saved data and never reconciled it against the date.
   Introduced `reconcileSeasonAndFeastFromDate({ feastFillIfEmpty })`,
   which fetches `/api/liturgical-info` and forces the season selector
   to match the date — without clobbering the saved seasonal
   sub-settings (Gloria, creed, music settings) because we only run
   `onSeasonChange()` when the season actually changes. Called from
   both `populateForm` (after a draft loads) and the date-change
   handler. Regression test asserts the function is wired up.

Manual smoke test against a fresh server boot:
- All six default users (`jd`, `morris`, `vincent`, `frlarry`, `kari`,
  `donna`) authenticate.
- 20 calendar dates from Christmas 2025 through Immaculate Conception
  2026 return the correct feast name + season (Christmas, Mary Mother
  of God, Epiphany, Ash Wednesday, every Sunday of Lent, Triduum,
  Easter, Divine Mercy, Pentecost, Trinity, Corpus Christi,
  Assumption, All Saints, Christ the King, First Sunday of Advent,
  Immaculate Conception).
- Attachments full CRUD round-trip (upload → list → download →
  update → delete) with disk file removed.
- Preview rendering with parish default `defaultSanctusLanguage=latin`
  + per-aid override `holyHolyLanguage=english` correctly produces
  English Sanctus (per-aid > parish precedence verified).

### Session 5 follow-up #3: Children's Liturgy at multiple Mass times

**User feedback:** "childrens liturgy can happen at any masses... not
just one."  The original implementation locked the worship aid to a
single Mass time (free-text input).

**Shipped:**

- Schema gains `childrenLiturgyMassTimes: string[]`. The legacy
  single-string `childrenLiturgyMassTime` field stays in the schema
  for back-compat and is migrated on draft load.
- Editor replaces the single text input with three checkboxes for the
  parish's standard times (Sat 5:00 PM, Sun 9:00 AM, Sun 11:00 AM)
  plus a free-form "Other Mass times, comma-separated" field for
  ad-hoc entries (e.g. holy day vigil, daily Mass).
- `collectChildrenLiturgyTimes()` walks the checkboxes + the "Other"
  string into a deduped array on save.
- `applyChildrenLiturgyTimes(times)` ticks the right boxes and routes
  unknown labels into the "Other" field on draft load.  Migration:
  if a saved draft only carries `childrenLiturgyMassTime` (singular),
  it's wrapped into a one-element array before applying.
- Template renderer joins all selected times with " & "
  (e.g. "Sat 5:00 PM & Sun 9:00 AM & Sun 11:00 AM").  Falls back to
  the legacy single string and finally "Sun 9:00 AM" if nothing
  configured.
- PDF generator follows the same fallback chain.

**Tests added (7 new):**

- Single-time render hits the right block (and uses a precise regex
  so it doesn't false-match the cover-page Mass times).
- All-three-Masses render contains every label.
- Back-compat: legacy single-string field still renders.
- Empty array falls back to default.
- `childrenLiturgyEnabled=false` suppresses the block entirely.
- Editor UI exposes the checkboxes + "Other" input.
- Editor exposes `collectChildrenLiturgyTimes` and
  `applyChildrenLiturgyTimes` helper functions.

End-to-end smoke run:

```
POST /api/preview {childrenLiturgyMassTimes: ["Sat 5:00 PM","Sun 9:00 AM","Sun 11:00 AM"]}
  → "Children's Liturgy of the Word — Sat 5:00 PM & Sun 9:00 AM & Sun 11:00 AM"
POST /api/preview {childrenLiturgyMassTimes: ["Sat 5:00 PM"]}
  → "Children's Liturgy of the Word — Sat 5:00 PM"
POST /api/preview {childrenLiturgyMassTime: "Sun 9:00 AM"}      # legacy field
  → "Children's Liturgy of the Word — Sun 9:00 AM"
POST /api/generate-pdf {childrenLiturgyMassTimes: ["Sat 5:00 PM","Sun 9:00 AM"]}
  → success, both labels printed in the booklet box
```

**Tests now: 177/177 passing.**

### Session 5 follow-up #4: Library top-nav, contrast fix, default size

After Session 5 went live, three more issues surfaced:

1. **Nobody could find the upload UI.** It was buried in Settings (admin-only by visibility), and the API routes were also gated by `manage_settings`, which meant music directors couldn't upload mass settings or anthems even though they're the primary user of the feature.
2. **Nav buttons ("Load Sample", "Save Draft", "Logout") had bad contrast** against the dark navy nav — gold/gray-on-dark made them nearly invisible.
3. **Default booklet size should be 8.5"×11"** (tabloid), not 5.5"×8.5".

**Shipped:**

- New `manage_attachments` permission, granted to `admin`,
  `music_director`, and `staff` (server-side `ROLE_PERMISSIONS` and
  client-side `rolePerms` both updated). All three attachment write
  routes (`POST`, `PUT`, `DELETE /api/attachments[/:id]`) now use
  this permission instead of `manage_settings`.
- **Library is a top-nav item.** New `Library` link between
  `History` and `Stats`, gated by `hasRole('manage_attachments')`.
  Routes: `GET /library` serves the SPA shell; the SPA's
  `showPage('library')` triggers `loadAttachmentList()` to populate
  the page view.
- **Music & Document Library moved out of Settings** entirely.  The
  upload widget, Title/Composer/Kind/Tags inputs, kind filter, and
  attachment list now live on the Library page.  Settings keeps the
  hymn-library JSON editor and parish-info forms.
- **Default booklet size is tabloid (8.5"×11").** The nav dropdown
  defaults to `<option value="tabloid" selected>` and the server
  fallback in `/api/generate-pdf` is now `'tabloid'`.
- **Nav-context outline buttons get a light variant.**  Added
  `nav .btn-outline { color: rgba(255,255,255,0.92); ... }` and a
  matching `:hover`. Removed the inline `style="color:rgba(...,0.5)"`
  on the Logout button so it picks up the new style.

**Tests added (7 new; suite is now 184/184 passing):**

- Pastor (no `manage_attachments` perm) gets 403 on upload.
- Music director uploads succeed (200).
- Staff uploads succeed (200).
- `Library` is present in the top nav (`data-page="library"`)
  and the `page-library` view exists.
- The Settings page no longer hosts the Music & Document Library
  section.
- `GET /library` returns the SPA shell.
- Default booklet option in the nav is `<option value="tabloid" selected>`.
- `nav .btn-outline` carries the light-text override; the inline
  half-opacity logout color is gone.

**Smoke test on a clean server boot:**
- `/library` returns 200; library nav element present (hidden until
  user has the perm).
- Music director (`morris`) login → upload (200) → list contains
  the new file → delete (200, file gone from disk).
- Pastor (`frlarry`) login → upload → 403.
- PDF generation for a no-`bookletSize` request still succeeds
  (now defaults to tabloid).

### Session 5 follow-up #5: Music restructure + UI cleanups

User feedback batch:
1. "The masses will share the same hymns, not be different per mass."
2. "There may be different anthems performed at different masses."
3. "Lighting of the advent wreath should only be made possible during advent."
4. "Not sure why there's a 'fetch from USCCB' button. that should be
   happening by default. if fetching another type of bible, that would
   fetch from the appropriate source. So maybe that button should be
   labeled differently."
5. "I didn't say to turn childrens liturgy of the word OFF for easter
   season. It's just not happening on Christmas and Easter those days
   themselves. It also doesn't happen during summer when kids are out
   of town."
6. "Stock search links are worthless."

**Shipped:**

- **Music section restructured.** New `Shared Hymns` section
  (processional, communion, thanksgiving) in the editor — entered
  ONCE because the assembly sings the same hymn at every Mass.  The
  three per-Mass blocks now show only the slots that legitimately
  vary per Mass (Organ Prelude, Kyrie, Offertory Anthem, Organ
  Postlude, Choral Anthem).  Saved-draft data shape is unchanged —
  `buildMusicBlock` copies the shared hymn values into every per-Mass
  block at save time, so the renderer's consolidation logic keeps
  producing one hymn line and per-Mass anthem lines as before.
  Loading a legacy draft pulls the shared values from whichever
  per-Mass block has them filled (prefers `musicSat5pm`).
  - Hymn-library typeahead now fires only on the shared-hymn inputs.
  - Each per-Mass block still gets its own attachments quick-pick
    for prelude/kyrie/offertory/postlude/choral so anthems can
    differ per Mass without the hymn library getting in the way.

- **Advent Wreath checkbox hidden outside Advent.** The
  `adventWreathRow` element is created with `display:none`;
  `updateSeasonUI()` toggles visibility on every season change and
  also resets the checkbox when leaving Advent so a stale check
  can't sneak into the booklet.

- **"Fetch from USCCB" → "Refresh readings".** Auto-fetch already
  fires on every date change, so a manual button labeled with the
  source was confusing.  The button now just refreshes whatever
  translation is selected.  Translation `<select>` got an
  `onchange="fetchReadingsFromUsccb()"` handler so switching
  translations re-fetches automatically.  Section copy clarifies
  the dual-source behavior: NABRE comes from USCCB, the other
  translations come from `bible-api.com` using the same citations.

- **Children's Liturgy auto-rule fixed.**  No more "off during the
  whole Easter season" — Easter Sunday itself is computed from the
  date (via `computeEaster(year)`) and only that day suppresses
  Children's Liturgy.  Christmas Day is similarly explicit.  The
  summer-break (June–August) and school-Christmas-break
  (Dec 22–Jan 6) rules are unchanged.

- **Cover-suggestion search links swapped to art sources.**
  Unsplash and Pexels are gone.  Replaced with Catholic-friendly
  collections that have substantial sacred-art holdings:
  `Wikimedia Commons`, `Web Gallery of Art`,
  `The Met (Open Access)`, and `Vatican Museums`.

**Tests added (13 new; suite is now 197/197 passing):**

- Editor exposes shared-hymn inputs (processional, communion,
  thanksgiving + composers).
- Per-Mass blocks contain no hymn inputs.
- Per-Mass blocks still contain prelude/kyrie/offertory/postlude/
  choral.
- Hymn-search typeahead is wired only to shared-hymn fields.
- `adventWreathRow` defaults to `display:none`.
- `updateSeasonUI` sets row visibility based on season===advent.
- "Refresh readings" button label; old "Fetch from USCCB" gone.
- Section copy mentions both `bible.usccb.org` and `bible-api.com`.
- Translation `<select>` triggers re-fetch on change.
- Children's Liturgy: explicit Easter-Sunday and Christmas-Day
  off-rules; whole-season off-rules removed.
- Children's Liturgy: summer-break and Christmas-break rules
  preserved.
- Cover-suggestions API returns Wikimedia/WGA/Met/Vatican links
  (no Unsplash/Pexels).
- SPA renders the new Catholic-friendly source labels.

**Smoke test on a clean server boot:**
- jd login OK.
- Editor markup: Shared Hymns section present, per-Mass
  processional inputs absent, advent wreath row hidden,
  "Refresh readings" button visible.
- `POST /api/cover-suggestions` returns Wikimedia + WGA + Met +
  Vatican links.
- Saved-draft round-trip: same processional hymn across three
  Masses renders ONCE on the booklet; three different offertory
  anthems all render on their respective Mass-time lines.

### Session 5 follow-up #6: Music expert correction

Music director feedback after seeing the previous restructure:
"The only items that differ are the offertory anthem and the choral
anthem.  Also, the choral anthem happens at Communion, not 'Concluding.'"

**Shipped:**

- **Shared Music** now covers everything except the two anthems:
  Organ Prelude, Processional / Entrance Hymn, Kyrie setting,
  Communion Hymn, Hymn of Thanksgiving, and Organ Postlude.  Entered
  ONCE because they're identical at every Mass.
- **Per-Mass blocks** now contain only Offertory Anthem and Choral
  Anthem at Communion — the two slots a music director may schedule
  differently per Mass (different choirs / ensembles).
- **Choral Anthem moved from page 7 (Concluding Rites) to page 6
  (Communion Rite).** Both the HTML template and the PDFKit
  generator now render it after the Communion Hymn, where the music
  director says it actually happens liturgically.  The PRD's old
  layout (anthem on page 7) was wrong.
- Schema field name `choralAnthemConcluding` is preserved for back-
  compat with saved drafts; only the rendering position and label
  changed.  UI label is now "Choral Anthem (Communion)".
- buildMusicBlock copies all six shared values (prelude / processional
  / kyrie / communion / thanksgiving / postlude) into every per-Mass
  block at save time, so the renderer's same-across-Masses
  consolidation keeps producing one line per shared slot.
  populateSharedMusic does the inverse on draft load.

**Tests updated (4 in this round; suite still 197/197 passing):**

- "Shared Music" section exposes inputs for prelude/processional/
  kyrie/communion/thanksgiving/postlude.
- Per-Mass blocks contain ONLY offertory + choral; prelude/kyrie/
  postlude/processional/communion/thanksgiving are absent from
  per-Mass blocks.
- Hymn typeahead is wired to processional/communion/thanksgiving
  shared inputs, not to the organ/kyrie shared inputs.
- Choral Anthem renders on page 6 (Communion Rite), NOT on page 7.

Smoke verified on a clean server boot:
- POST /api/preview with a draft where the same prelude/Kyrie/
  postlude play at all three Masses renders each ONCE; three
  different offertory anthems each render on their own Mass-time
  lines; the choral anthem appears in the Communion Rite page (6).

---

## Session 6 (April 30, 2026): Colleague Pilot Feedback Pass

**Branch:** `claude/reformat-readings-layout-vPijN`
**Tests:** 240/240 passing (was 210/210 at start of session — +30 net new)

Pilot feedback after a music director and admin tested the editor:

> Readings: it pulled the right ones but they're in lectionary
> sense-line layout, not paragraphs.  Psalm refrain needs to be in
> the music search.  Music: it didn't pull anything (no login?), and
> hymnal+number would be more useful than title+composer for OneLicense.
> File uploads in Editor and Library kept saying "Not authenticated."
> Settings I filled out didn't carry over to other drafts.  Preview
> doesn't match the document format.

**Shipped (one item per piece of feedback, plus tests):**

1. **Readings paragraph reflow** — `src/readings-fetcher.js#reflowAsParagraphs`
   collapses single line breaks within a paragraph into spaces while
   preserving paragraph breaks (double newlines).  Applied to first /
   second / gospel readings and the gospel-acclamation verse.  Psalm
   verses keep their original stanza structure.  Also runs over
   `bible-api.com` output for non-NABRE translations.

2. **Hymnal + number on hymn library entries** — `src/store/hymn-library.js`
   now persists `hymnal` (e.g. "Worship IV") and `hymnNumber` (e.g. "612").
   Search ranks exact-number matches highest (90 points) and hymnal-name
   matches at 60 points so a user typing "612" or "worship" lands on the
   right entry.  `oneLicenseSearchUrl(entry)` helper builds the right URL
   with hymnal+number precedence over title+composer.

3. **OneLicense search buttons** in the editor's three shared hymn slots
   (processional, communion, thanksgiving). Click → opens
   `https://www.onelicense.net/search?text=<hymnal+#number>` in a new tab.
   `openOneLicenseSearch()` in the SPA.

4. **Responsorial Psalm music slot** — new shared slot with title +
   composer + a "Search OneLicense by refrain" button.  Renderer prints
   it on page 3 between the citation and the refrain.  When readings
   are fetched, the refrain text is auto-prefilled into the slot's
   title input as a search starting point.

5. **Hymnal citation in rendered output** — music-formatter now carries
   `hymnal` + `hymnNumber` per item and renders them as
   `Title [Hymnal #N], Composer` in both HTML and PDFKit output, so the
   printed booklet shows what to look up in the pew rack.  CSS class
   `.hymnal-cite`.

6. **Stateless HMAC session tokens** — replaces the prior server-stored
   sessions which were the root cause of the "Not authenticated" upload
   failure on Netlify when the in-memory blob fallback dropped state
   between Lambda invocations.  Token format: `<userId>.<issuedAtMs>.<sig>`,
   signed with `SESSION_SECRET` env var.  30-day expiry.  Logout writes
   to a small revocation list (capped at 500 most-recent entries).
   Exclusive-login-per-role policy preserved via per-user `revokedBefore`
   timestamp.  **Set `SESSION_SECRET` in production** — there's a default
   dev secret for local use only.

7. **Frontend 401 recovery** — every upload (notation, attachment, logo,
   cover) now (a) checks `_sessionToken` before sending and (b) treats a
   401 response as "session expired", clears the cached token, and
   redirects to login instead of silently failing.

8. **Per-user preferences** — `GET/PUT /api/user-prefs` (auth required),
   stored on `user.prefs`.  Currently persists `bookletSize`; the Editor
   nav-bar selector saves the user's choice on change and restores it on
   next sign-in.  Distinct from parish-wide `/api/settings`.

9. **Preview matches selected booklet size** — template-renderer now
   accepts a `bookletSize` option and emits the matching `@page` size,
   page width/height, and proportional fonts.  The Editor's preview
   iframe width is set from the server-reported `pageWidth`, so the
   preview is true-scale to the export PDF.  Default is tabloid (8.5×11)
   to match the export default.

10. **`GET /api/health` endpoint** — reports the actual KV backend
    (`filesystem` / `netlify-blobs` / `in-memory`).  Lets ops verify a
    Netlify deploy is using Blobs (and not the lossy in-memory fallback)
    without grepping logs.

**Tests added (30 total):**
- `src/tests/readings-fetcher.test.js` — 13 tests on reflow + USCCB
  parser + psalm/acclamation splitters.  Also locks in "psalm verses
  must NOT be reflowed" to prevent future regressions.
- `src/tests/feedback-fixes.test.js` — 17 tests across 9 suites:
  hymnal/number on hymn entries, OneLicense URL helper,
  music-formatter hymnal rendering, Responsorial Psalm slot in
  HTML+SPA, OneLicense buttons, stateless HMAC tokens (survive
  store wipe + tampering + logout-revocation), per-user prefs API
  (auth gate + merge semantics), `/api/health` shape, preview
  pageWidth/pageHeight per booklet size, settings round-trip.

**Smoke-verified end-to-end (PORT=4055 local server):**
- Login as `morris` (music_director) → token issued, validates against
  `/api/auth/me`.
- POST `/api/attachments` as music_director with multipart upload →
  200, file saved.  This was the original failure mode the colleague
  reported.
- POST `/api/preview` with `bookletSize: 'tabloid'` → returns
  `pageWidth: '8.5in'`, `pageHeight: '11in'`.
- PUT `/api/user-prefs` with `{ bookletSize: 'half-letter' }` →
  GET returns the same value.
- GET `/api/health` → `environment: local, persistence: filesystem`.

**Files touched:**
- `src/readings-fetcher.js` — reflow function + apply to first/second/
  gospel + accl. verse.
- `src/store/hymn-library.js` — hymnal/hymnNumber fields + search +
  OneLicense URL helper.
- `src/music-formatter.js` — carry hymnal/hymnNumber through formatMusicSlot
  + render `[Hymnal #N]` in HTML and text output.
- `src/template-renderer.js` — page geometry per booklet size; psalm
  setting on page 3; expose `pageWidth`/`pageHeight`/`bookletSize`.
- `src/pdf-generator.js` — render psalm setting on page 3.
- `src/schema.js` — new music-block fields (hymnal, hymnNumber,
  responsorialPsalmSetting + composer).
- `src/store/user-store.js` — stateless HMAC tokens, per-user prefs,
  exclusive-login enforcement via revokedBefore.
- `src/server.js` — preview accepts bookletSize, OneLicense JS helpers,
  user-prefs routes, health route, frontend 401 handling for uploads,
  hymnal+number inputs in shared hymn slots, psalm slot, prefill on
  fetch readings, save bookletSize to prefs on selector change.
- `product_spec.md`, `worship_aid_generator_PRD.md` — documented v1.3.

**Known followups (deferred):**
- Hymn library starter entries don't carry hymnal/hymnNumber yet.  When
  the parish stocks the library, the music director can fill those in.
- Add a server-side rate limit on `/api/auth/login` (no abuse vector
  today, but stateless tokens make a brute-force attempt plausible
  given enough users).
- Consider a similar 401-recovery in the editor's draft-save path
  (currently the auto-save endpoint doesn't require auth).


---

## Session 7 (June 9, 2026): Hymn Paste Areas, Hard 8-Page Guarantee, Full Code Review

**Branch:** `claude/youthful-mayer-sxg6du`
**Tests:** 290/290 passing (was 240 at start; serialized with a shared-state lock)

### Decision: programmatic OneLicense integration dropped

User direction: automating music from OneLicense isn't worth the effort.
The app now builds everything EXCEPT the hymn notation. Each congregational
hymn slot (processional, communion, thanksgiving) reserves a dashed blank
paste area (~2.2" half-letter / ~2.9" tabloid) in both the HTML preview and
the PDF; the user pastes licensed notation in by hand after export. New
top-level `reserveHymnSpace` flag (default true) with a checkbox in the
Shared Music section; round-trips through drafts. The OneLicense *search*
buttons remain as manual-workflow helpers. The OneLicense automation roadmap
(Hymnary client, arrangements table, version picker) was removed from
`product_spec.md` Future Build Requirements.

### Hard 8-page guarantee (user requirement: "limited to 8 pages at all times")

The PDF can no longer exceed 8 pages. Fitting order per user direction —
margins first, type later, legibility floor:
1. Relax side + bottom margins to 0.5" (no-op on half-letter; tabloid grows
   to a 7.5"x10" content area — absorbs a full Sunday lectionary at normal
   type with zero warnings).
2. Relax the top margin to 0.5" (top last).
3. Shrink body text, never below 75% of normal.
4. Truncate with an ellipsis + per-page warning.
Implementation: every text primitive measures (dry-run) before writing and
clamps to the page bottom; `_fitPageText` wraps pages 3, 4, 7; cover blurbs,
back-cover notes, and custom copyright blocks are clamped too. Also fixed the
historical phantom-page bug: folios and the page-7 copyright line were
written inside the bottom margin band and made PDFKit auto-add a near-blank
page after every section (a "16-page" export is now 8). Layout tests assert
`pageCount === 8` unconditionally, including long-content stress cases.

### Full code review (4 parallel review passes) — all low→critical findings fixed

**Security (critical/high):**
- Path-traversal WRITE via draft id (`POST /api/drafts {"id":"../../x"}`)
  — KV keys now validated at the storage boundary; unsafe ids → 400.
- Path-traversal READ via encoded slashes in upload-serving routes
  (`/api/uploads/attachments/..%2f..%2f...`) — basename + safe-key check.
- Draft routes, `PUT /api/settings` (manage_settings), and
  `POST /api/generate-pdf` (export_pdf) now require auth; the
  pastor-approval gate can no longer be bypassed by exporting unsaved
  content. SPA sends tokens on all those calls with 401 recovery.
- Settings saves merge instead of full-replace (logoPath no longer reset).
- SVG uploads served with sandbox CSP + nosniff (stored-XSS hardening).
- Loud startup error when SESSION_SECRET is missing in production.
- Exclusive-login race: same-millisecond logins could leave the displaced
  session alive; issue timestamps are now strictly monotonic.

**Renderer parity (HTML preview vs PDF now produce the same booklet):**
- Season defaults (gloria/creedType/entranceType) were written to the top
  level where neither renderer read them — Advent/Lent/Easter drafts created
  via API silently got the Nicene Creed and wrong entrance heading. Fixed;
  `applySeasonDefaults` also no longer mutates the caller's draft.
- PDF now renders: Sanctus language + congregational text, parish mass
  times, clergy lines, welcome + closing messages, gospel-acclamation
  reference, children's-liturgy leader/notes. HTML preview now uses the
  uploaded parish logo and drops the '[Parish Name]' placeholder; the
  baptismal-vows creed renders in the preview (was Nicene).
- Shared single-source default copyright text; double-escaping fixed;
  page-7 copyright clamped to one line (folio overlap).
- Hymns entered for only some Masses now carry their time qualifier.
- bookletSize added to schema; both renderers share the tabloid default.

**Liturgical calendar (all hand-verified):**
- Sunday feasts no longer lose to minor fixed feasts: Holy Family on
  Dec 26/28/31, 4th Sunday of Advent on Dec 24.
- Epiphany on Jan 7/8 → Baptism of the Lord the following Monday.
- Immaculate Conception transfers to Dec 9 when Dec 8 is an Advent Sunday.
- Ascension defaults to the Sunday transfer (most US provinces); Thursday
  available via `ascensionOnThursday` option. Chair of St. Peter Feb 22.

**Readings/utilities:**
- Psalm verses no longer paragraph-reflowed for non-NABRE translations
  (stanzas were being collapsed); citations normalized for bible-api.com
  ("Cf.", verse letters, em-dashes); translation label only set on success;
  USCCB parse failures surface as errors instead of silently-empty readings.
- Entity decoding order + hex entities; redirect caps; EXIF rotation before
  notation auto-crop; CLI arg parsing (-o value no longer eaten as input);
  fetch-hymns relative-redirect fix; Dockerfile npm ci lockfile fix.
- 'Copy prompt' button in cover suggestions was dead (quote escaping);
  Netlify upload listings returned 'unknown' filenames; corrupt KV records
  no longer break every list() caller (one bad user file used to break all
  logins).

### Deliberately NOT changed
- Beta passwordless login + username-list error message (intentional beta
  features; production checklist still applies).
- Read access to GET /api/settings and POST /api/preview remains open (the
  editor uses them pre-auth-free; no sensitive data).
- Known-limitation race conditions on Netlify Blobs read-modify-write
  (single-parish write volume; documented).

### Branch state at end of session
- Branch: `claude/youthful-mayer-sxg6du`, pushed.
- Docs updated: `product_spec.md` (v1.4), `worship_aid_generator_PRD.md`
  (v1.4), this file.

---

## Session 8 (June 9, 2026) — v1.5: Next-Version Improvements

**Branch:** `claude/youthful-mayer-sxg6du`
**Starting test count:** 290/290

### Changes Made

#### 1. PDF Encoding Fix (Item 1)
- Replaced Helvetica (WinAnsi, 256-char limit) with embedded Liberation Sans TTF
  (`/usr/share/fonts/truetype/liberation/LiberationSans-*.ttf`) in all four
  weights (Regular, Bold, Italic, BoldItalic). Full Unicode Latin coverage
  eliminates the character-rendering problems seen in the v1.4 PDF sample.
- Added `_normalizeText()` to map decorative liturgical cross symbols (☩ ✝ ✠)
  to the dagger (†) which Liberation Sans includes.
- `_textBlock()` now calls `_normalizeText()` before every draw.

#### 2. Single Consistent Font Size (Item 2)
- `bodyText()` always uses 9 pt regardless of any `opts.size` passed by the
  caller. Body text (readings, creed, prayers, rubrics) is now a uniform 9 pt.
- `musicLine()` updated from 8.5 pt to 9 pt for consistency.
- `citation()` and heading methods keep their separate sizing (these are
  structural, not body copy).

#### 3. More Room for Hymns / Better Page Fill (Item 3)
- Ordinary-music paste areas (Kyrie, Holy Holy Holy, Lamb of God) freed the
  previous per-element `size` noise that was squeezing pages; uniform 9 pt
  body means `_fitPageText` has more room before shrinking type.
- Page 6 `reserveBelow` reduced 70 → 50 pt (choral anthem is just one
  heading + line).
- Page 2: `reserveBelow` made dynamic: 150 pt normally, +75 pt when
  Children's Liturgy dismissal box is enabled (since the box is now on p. 2).

#### 4. Kyrie / Holy Holy Holy / Lamb of God Music (Item 4)
- Added `ordinaryMusicSpace(label)` method (PDF) and `.ordinary-music-space`
  CSS class (HTML): 0.6 in tall dashed box, also gated by `reserveHymnSpace`.
- Called after: Kyrie (page 2), Holy Holy Holy (page 5), Lamb of God (page 6).
- Allows parish to paste weekly Mass ordinary notation in these fixed slots.

#### 5. Conditional Hymn Paste Area (Item 5)
- Processional hymn paste area now only renders when `entranceType ===
  'processional'`. No paste area is shown when the antiphon mode is active
  (the antiphon has no separate notation to paste).
- HTML: new `processionalHymnSpaceHtml` variable replaces `hymnSpaceHtml` on
  page 2.
- PDF: `if (entranceType === 'processional') hymnMusicSpace(...)`.

#### 6. Rubric Alignment (Item 6)
- New `seasonalSettings.rubricAlignment` field (enum: `left` | `center` |
  `right`; default `left`).
- Schema: added to `seasonalSettings` definition.
- PDF: `rubric(text, align)` takes override; falls back to `ss.rubricAlignment`.
- HTML: all `<p class="rubric">` lines use `RP` helper variable = `<p
  class="rubric" style="text-align:${rubricAlign}>`.
- Editor: `<select id="rubricAlignment">` added to Seasonal Settings section.
- `buildData()` and `populateForm()` include the new field.

#### 7. Two-Column Creed (Item 7)
- New `seasonalSettings.twoColumnCreed` boolean (default false).
- Schema: added.
- PDF: `_renderCreedTwoColumn()` splits lines at mid-point and renders two
  side-by-side columns using PDFKit direct coordinates. Skipped for
  `baptismal_vows` (too short to benefit).
- HTML: `.creed-text.two-column` CSS rule uses `columns: 2; column-gap: 14pt`.
  Class added when `ss.twoColumnCreed && creedType !== 'baptismal_vows'`.
- Editor: checkbox added to Seasonal Settings.

#### 8. Children's Liturgy Placement (Item 8)
- **Before:** Children's Liturgy block rendered on page 5 (Liturgy of the
  Eucharist), at the Offertory — liturgically incorrect.
- **After:** Dismissal box on page 2 (end of Introductory Rites, after Gloria
  / Opening Prayer, before First Reading). Return note on page 5 at Offertory
  (single rubric line, not a full box).
- PDF and HTML renderers both updated.
- Default dismissal note: "Children are dismissed after the Opening Prayer and
  will rejoin during the Offertory." (customizable via `childrenLiturgyNotes`).

### Tests
- Updated `hymn-space.test.js` to reflect conditional processional paste area
  and new ordinary-music paste areas (added `processionalSample` fixture with
  `entranceType: 'processional'`).
- 8 new tests; all 298 pass.

### Deliberately NOT changed
- Beta passwordless login (same as before).
- `reserveHymnSpace` checkbox in editor still controls all paste areas
  (hymn + ordinary).

---

## Session 9 (June 12, 2026) — v1.6: June 12 UAT Fix Pass

**Branch:** `claude/jolly-newton-tzp0aj`
**Input:** `26.6.12 WA Generator Notes.docx` (music department UAT, follow-up
to the June 9 notes)
**Tests:** 318/318 passing (was 298 at start; 15 new in `uat-fixes.test.js`,
5 net new/updated elsewhere)

### Root cause found: Netlify Blobs was never connected

Every "other issue" in the UAT traced to one production bug: under the
Lambda-compatibility function signature, `@netlify/blobs`' `getStore()`
throws unless the per-request context is wired up with `connectLambda(event)`
— which the handler never did. Every request silently fell back to
**per-instance in-memory storage**, so:

- **"Your session expired — please log in again" loops** — seed users get
  random UUIDs per instance, and tokens embed the user id; a request routed
  to a different Lambda instance couldn't find the token's user → 401. Worst
  during parallel uploads (extra instances spin up).
- **"After re-login the upload list showed only the newest file"** — each
  instance had its own in-memory attachments list.
- **"Saved settings never showed up in Preview / new drafts blank"** —
  settings saved to one instance's memory, read from another's.
- **Export PDF "Error: Not authenticated"** — same cross-instance 401.

**Fixes:**
1. `netlify/functions/api.js` calls `kv.connectBlobsFromLambdaEvent(event)`
   on every request (new kv.js helper; resets the availability cache when a
   context appears). Explicit `NETLIFY_BLOBS_SITE_ID` / `NETLIFY_BLOBS_TOKEN`
   env-var config supported as a fallback.
2. Blobs availability check now retries every 30 s after a failure instead
   of stranding the instance in memory mode forever.
3. **Seed users use deterministic ids (= username)** so tokens survive any
   future re-seed.
4. **Storage-health banner** in the SPA: after login it checks `/api/health`
   and shows a red warning bar when persistence is `in-memory`, so silent
   data loss can never masquerade as user error again.
5. `SESSION_SECRET` documented in `.env.example` (set it in Netlify env).

### Export PDF crash: `ENOENT .../data/Helvetica.afm`

`new PDFDocument()` loads built-in Helvetica's `.afm` metrics by default, and
the v1.5 Liberation fonts pointed at `/usr/share/fonts/...` which doesn't
exist on Lambda. Fixed by **vendoring Liberation Sans (4 weights, SIL OFL +
license file) into `src/assets/fonts/`**, resolving the font dir across
local/Lambda/system layouts, passing `font: null` to the PDFDocument
constructor (Helvetica metrics never load), and adding
`src/assets/fonts/**` + pdfkit's `.afm` files to `included_files` in
`netlify.toml`. `/api/sample` got the same path-candidates treatment.

### UAT items shipped

1. **TIFFs accepted everywhere** (notation, attachments; `accept` attrs +
   multer filters) and **converted to PNG** at upload (sharp; EXIF rotate +
   white-margin crop). Rejected types/oversize now return descriptive
   errors; the SPA pre-checks the hosted ~4.5 MB serverless payload cap.
2. **Uploaded music now actually prints.** New per-slot notation images
   (`data.notationImages`): every hymn area and ordinary part has an
   *Attach notation* control (upload new or pick an uploaded image). The
   image renders inside the reserved area in the HTML preview and is
   embedded in the PDF (`src/notation-resolver.js` + dimension-aware
   scaling). Precedence: image > paste box > text.
3. **Reserved spaces added** for Gloria, Responsorial Psalm refrain, Gospel
   Acclamation, and Mystery of Faith; when a music area is shown, the sung
   text (Gloria first line, refrain text, acclamation, Sanctus text) is
   replaced by the music — exactly the "providing text instead of music
   file" complaint. `reserveHymnSpace: false` restores the text behavior.
4. **Gloria setting line** — new `seasonalSettings.gloriaSetting` prints
   under the Gloria heading (both renderers; editor input included).
5. **Kyrie moved into "Service Music & Seasonal Settings"** (same
   `shared_kyrie` field, so saved drafts are unaffected).
6. **Service-music carryover**: new drafts default to "Same service music
   as last week" — checked = full carryover from the most recent draft
   (settings names, Sanctus language, penitential act, ordinary-part
   notation images) with fields collapsed; unchecked = per-part editing.
7. **Anthems restructured**: one section, Offertory list (2 rows default) +
   Choral (Communion) list, each anthem = title + composer + per-Mass
   checkboxes + "Add anthem". Stored as `anthems.{offertory,choral}[]` and
   denormalized into the per-Mass blocks for renderer/legacy compatibility.
8. **No more library pulls** on organ prelude, postlude, or anthems — typed
   in directly. (Psalm setting keeps its library pick + OneLicense-by-refrain
   search.)
9. **Settings saves surface failures** — `saveAdminSettings` (and draft
   save, export, attachment delete) check the response, handle 401 with a
   clear "session expired" message + login redirect, and sync
   `_parishSettings` from the server's merged response.
10. **Library page** copy + accept list now lead with images (PNG/JPG/TIFF).

### Files added
- `src/notation-resolver.js`, `src/assets/fonts/` (Liberation Sans + LICENSE),
  `src/tests/uat-fixes.test.js`

### Files modified
- `netlify/functions/api.js`, `netlify.toml`, `.env.example`
- `src/store/kv.js`, `src/store/user-store.js`
- `src/image-utils.js` (normalizeNotationImage, getImageDimensions)
- `src/pdf-generator.js`, `src/template-renderer.js`, `src/schema.js`
- `src/server.js` (routes + SPA)
- `src/tests/attachments-and-calendar.test.js`,
  `src/tests/template-renderer.test.js` (updated to the new
  music-replaces-text contract)
- `product_spec.md` (v1.6)

### Deploy checklist for this release
- [ ] Set `SESSION_SECRET` in Netlify environment variables.
- [ ] After deploy, open `/api/health` — `persistence` must be
      `netlify-blobs`. If it says `in-memory`, set
      `NETLIFY_BLOBS_SITE_ID` + `NETLIFY_BLOBS_TOKEN` env vars.
- [ ] Export a PDF from the deployed site (verifies fonts shipped).
- [ ] Upload a TIFF in the Library (verifies sharp native module bundled
      correctly; if conversion fails the error message will say so).

### Session 9 addendum (June 12, 2026, evening) — live-site verification round

Morris's follow-up test on the deployed v1.6 surfaced two issues. Both were
diagnosed **against the live site** (logged in as `kari`/staff, exported the
real draft via the API, dissected the bytes):

1. **Exported PDF opened as blank pages.** The PDF was structurally valid —
   8 pages, Liberation Sans subsets embedded, all text present — but every
   flate stream was corrupt (`Bad FCHECK`). Served images had the same
   signature: bytes ≥ 0x80 replaced by `EF BF BD` (UTF-8 replacement char).
   Root cause: `serverless-http`'s default binary content-type list is
   EMPTY, so binary responses (PDF, images, audio) were stringified as
   UTF-8 on the way out of the Lambda. v1.5 never hit this because export
   crashed on fonts before ever returning a PDF. **Fix:** pass
   `{ binary: [...] }` to `serverless()` in `netlify/functions/api.js`
   (PDF, image/*, audio/*, video/*, font/*, octet-stream, zip, msword,
   rtf, vnd.*). Verified against serverless-http's `is-binary` logic.
   NOTE: stored uploads were never corrupted (request bodies arrive
   base64) — nothing needs re-uploading.

2. **Uploaded JPGs not printing in the booklet.** The live draft's
   `notationImages` was `{}` — the tester uploads everything through the
   generic Notation Images box / Library and never uses the per-slot
   Attach buttons. Bridged his workflow instead of retraining him:
   - The **Notation Images list is now actionable**: every uploaded image
     row carries a "Print in:" dropdown (Processional, Communion,
     Thanksgiving, Kyrie, Gloria, Sanctus, Mystery of Faith, Lamb of God,
     Psalm Refrain, Gospel Acclamation) plus pills showing where it
     already prints. Upload everything, then assign from the list.
   - Per-slot pickers also list **Library image attachments**
     (kind-matched first), and `notation-resolver` now resolves
     attachment URLs (`uploads-attachments` namespace / local dir) so
     those choices embed in the PDF too.
   - **Upload-list lag** ("I'd upload one but not see all of them"):
     Netlify Blobs `list()` is eventually consistent. The SPA now keeps a
     client-side file cache — new uploads appear in the list instantly —
     plus a Refresh button.

PDF-engine question (raised by the user): evaluated and **no engine change
needed** — PDFKit's output was byte-perfect locally and on Lambda; the
corruption was purely in the HTTP transport layer (fix #1 above).

---

## Session 10 (June 12, 2026) — v1.6.2–v1.7

**Branch:** `claude/jolly-newton-tzp0aj` (same branch; v1.6/v1.6.1 merged
earlier via PR #21, then the branch continued)
**Pushed this session:** `70798a8` (v1.6.2), `74df1d6` (v1.6.3),
`8a4f14d` (v1.6.4)
**Uncommitted at handoff:** the v1.7 batch — see "State at handoff" below.

### v1.6.2 (pushed `70798a8`): preview falls back to paste box when a notation file is missing

**Root cause of "the processional hymn has no placeholder":** the draft
referenced a notation file that no longer existed in storage. The PDF route
pre-resolves URLs to buffers, so it correctly fell back to the dashed paste
box — but the preview just emitted the `<img>`, and a dead `<img>` inside
the sandboxed preview iframe renders as an **invisible blank** (no broken-
image icon, no border). Preview and PDF disagreed and the slot looked
silently empty.

**Fix:** `/api/preview` now runs the same existence check the PDF does —
`findMissingNotationSlots` (`src/notation-resolver.js`) verifies every
`notationImages` reference against storage; missing references are stripped
(on a copy of the data) so the preview falls back to the dashed paste box
exactly like the PDF, and a named warning is emitted: `The notation image
attached to "<slot>" no longer exists on the server — showing the blank
paste area instead. Re-upload and re-attach it.` Editor side: preview
`warnings` now render as **visible banners above the preview** (same
treatment as overflow warnings) — a count in the status bar was too easy
to miss.

### v1.6.3 (pushed `74df1d6`): full-width notation images; capped images centered

- Notation images now scale to the **full proportional content width**.
- An image that hits its height cap is **CENTERED** horizontally — was
  left-pinned. HTML: `object-position: center top`; PDF: centered `drawX`
  in `_notationImage`.
- Ordinary-part image caps raised from 1.4 in / 100 pt to **2.4 in
  (half-letter) / 3 in (tabloid)** — `PAGE_GEOMETRY.ordinaryImageMax` in
  `src/template-renderer.js` — and **170 base units** in the PDF (scaled
  per trim).
- Verified by decompressing the exported PDF's content streams and checking
  the image transform matrices (position + scale), not just eyeballing.

### v1.6.4 (pushed `8a4f14d`): automatic title-header removal on notation uploads

**Why:** licensed notation (OneLicense downloads, hymnal scans) arrives with
a big title block — title, composer, tune name — above the first staff. The
booklet already prints the title line, so the header just eats music space.

**How** (`src/image-utils.js`: `detectTitleCropY` + `stripTitleHeader` +
the `TITLE_CROP` constants):
- Build a row-darkness profile at a **360 px analysis width**; a row with
  **≥35% of pixels inked** is a staff line.
- Find the first staff system, **walk up past anything hugging the staff**
  (tempo markings, composer line sitting right on the music), and crop at
  the first **white gap of ≥12 analysis rows**.
- Crop happens ONLY when real header content exists above the gap and the
  crop removes **≤50% of the image** — no confident header, no crop.
- **PAD = 10 analysis rows** of breathing room kept above the music
  (downscale antialiasing makes faint ink register a few rows late).
- **Idempotent** — re-running on an already-cropped image finds no header.
  Lyrics between staves and the bottom copyright line always survive (they
  hug their staves / sit below the last system).

**Wiring:** editor checkbox `id=stripTitleHeaders` (**default ON**, with
opt-out copy) sends `stripTitle=0/1` on both upload paths; the
`/api/upload/notation` route passes `{stripTitle}` to
`normalizeNotationImage`; the response carries `titleCropped`; toasts
announce "— title header removed".

### v1.7 (UNCOMMITTED at handoff) — workflow batch

1. **Feast / Sunday name now TRACKS date changes.** Root cause: Session 5's
   "fill only when empty" rule never fired again once the startup auto-fill
   (or a loaded draft) had filled the field — change the date and last
   week's feast name stayed. Now the field tracks the date. Manual typing
   sets `dataset.userSet` via `oninput` and is preserved until the field is
   cleared (clearing re-enables tracking); `populateForm` clears the flag so
   loaded drafts update on the next date change.

2. **Notation Images list overhaul.** Hover-zoom floating preview
   (`#notation-zoom` — works on list thumbnails and per-slot thumbs; click
   opens full size), bigger thumbnails (72 px list / 40 px slot), rows
   de-duped by URL defensively, **per-row Delete** (new
   `DELETE /api/uploads/notation/:filename`, auth + `upload_images`;
   drafts still referencing the file keep the reference and fall back to
   the paste box per v1.6.2), **STICKY "Print in" select** that shows the
   image's current spot — picking another spot MOVES the single
   assignment, blank removes it, multi-spot images keep their pills — and
   a gold border on assigned rows.

3. **Content-hash de-dupe on notation upload.** sha256 of the processed
   buffer, indexed in the new **`notation-hash-index`** KV namespace;
   re-uploading identical content reuses the stored file (response
   `deduped: true`, toast "Already uploaded — reusing the existing image").

4. **"Last printed in" history.** New `GET /api/notation-usage` (auth)
   walks drafts newest-first →
   `{byUrl: {url: {slot, liturgicalDate, feastName}}}`; list rows show
   "last printed in \<spot\> (\<date\>)" with a one-click **Use again**
   button when the image isn't currently assigned there.

5. **Carryover copies the ENTIRE `notationImages` map** from the latest
   draft — every image defaults to the spot it printed in last week;
   swapping a hymn is one "Print in" dropdown pick.

6. **Session snapshot/restore.** Every edit (debounced 1.5 s) +
   `beforeunload` writes `buildData()` to
   `localStorage('wa_editor_snapshot')`. On login: snapshots <24 h
   auto-restore (toast); 24 h–7 d show a "⟲ Restore last session" nav
   button (`id=btn-restore`); >7 d ignored. Restoring suppresses the
   carryover defaults (`offerSnapshotRestore()` returning true skips
   `applyServiceMusicCarryover`).

7. **Hymn stats now measure what was PRINTED.** `/api/generate-pdf` writes
   a per-`liturgicalDate` record to the new **`export-log`** KV namespace
   (feast, season, the three music blocks, who/when). The last export of a
   week overwrites — re-exports don't double-count. `/api/stats/hymns`
   aggregates `export-log` instead of all drafts (which over-counted
   revisions and never-shipped drafts); Stats page copy updated
   ("exported weeks analyzed").

8. **IN PROGRESS at handoff — PDF "spread bridging" for music images**
   (main thread was implementing while this note was written). A music
   image that doesn't fit its page may continue onto the FACING page when
   flowing even→odd (2→3, 6→7 — one open spread, never a page turn
   mid-piece). Lossless clipped two-part drawing in `pdf-generator.js`:
   `_notationImage` `bridge` option, `_carryNotation`,
   `_drawCarriedNotation` at the top of pages 3/7, `_fitPageText` respects
   a carried-content start Y. Odd-page images shrink losslessly instead.
   Hard rule: **music must NEVER be cut off or partially lost.** Plus a
   preview-side overflow detector warning that the PDF will flow/shrink.

### Files added / modified

- **v1.6.2:** `src/notation-resolver.js` (`findMissingNotationSlots`),
  `src/server.js` (preview strip + named warning + banner rendering),
  `src/tests/uat-fixes.test.js`
- **v1.6.3:** `src/pdf-generator.js`, `src/template-renderer.js`,
  `src/tests/uat-fixes.test.js`
- **v1.6.4:** `src/image-utils.js` (+140 lines), `src/server.js`,
  `src/tests/uat-fixes.test.js`
- **v1.7 (uncommitted):** `src/server.js` (routes + SPA: items 1–7);
  `src/pdf-generator.js`, `src/template-renderer.js`, and
  `src/tests/uat-fixes.test.js` (item 8 — bridging + preview detector,
  in flight). No new source files; the two new KV namespaces
  (`notation-hash-index`, `export-log`) are created on first write.
- Docs: `product_spec.md` bumped to v1.7.0; this file.

### Deploy checklist (v1.7)

**Nothing new required** beyond the standing v1.6 items:
- [ ] `SESSION_SECRET` set in Netlify env.
- [ ] `/api/health` reports `persistence: netlify-blobs` after deploy.
- The new KV namespaces (`notation-hash-index`, `export-log`) are plain
  Blobs stores that **appear automatically on first write** — no
  provisioning, no env vars.
- Optional post-deploy sanity: upload the same image twice → "Already
  uploaded — reusing the existing image" toast; export a PDF → the week
  shows up in Stats.

### State at handoff (read this first next session)

- **Branch:** `claude/jolly-newton-tzp0aj`, tracking origin.
  **HEAD = `8a4f14d` (v1.6.4)** — `70798a8`/`74df1d6`/`8a4f14d` are pushed
  and documented above.
- **Working tree is DIRTY (intentionally):** the v1.7 batch is uncommitted —
  `src/server.js` (~330+ lines: items 1–7 above) plus the spread-bridging
  work (item 8) landing in `src/pdf-generator.js`,
  `src/template-renderer.js` (preview-side flow/shrink detector), and
  `src/tests/uat-fixes.test.js`, which was still being implemented at the
  time of writing. Do NOT discard; review `git diff --stat` before
  anything else.
- **Tests:** 318/318 at v1.6; the v1.6.2–v1.6.4 commits and the v1.7 batch
  add cases — **expect ~340+ passing** once the bridging tests land. Run
  `npm test` first thing.
- **Next steps, in order:**
  1. Finish the spread-bridging implementation + tests if not already done
     (check `_carryNotation` / `_drawCarriedNotation` / `bridge` in
     `pdf-generator.js`; carried draw at the top of pages 3/7;
     `_fitPageText` start-Y; odd-page lossless shrink; the preview-side
     flow/shrink warning) — music must never be lost.
  2. Run the full suite (~340+ expected), commit the v1.7 batch, push.
  3. Merge the PR for `claude/jolly-newton-tzp0aj`.
  4. Deploy checks per the v1.7 checklist above (nothing new beyond
     `SESSION_SECRET` + Blobs; new KV namespaces appear automatically).

### Session 10 addendum (same session, after the docs pass)

Landed after the documentation agent ran — all tested, 345/345 passing:

1. **Spread bridging SHIPPED** (was "in progress"): `_notationImage` bridge
   option + `_carryNotation`/`_drawCarriedNotation` (pages 3/7 tops),
   `_fitPageText` starts below carried content. Music images on even pages
   (2/6) that don't fit flow lossless onto the facing odd page as two
   clipped, pixel-aligned draws (+ "(continued)" marker); odd pages shrink
   losslessly; never across a page turn. Verified: gloria 2→3 and
   communion 6→7 bridge with warnings, sanctus (page 5) never bridges,
   always exactly 8 pages.
2. **Music image width spec** (user): service music prints 6in wide,
   hymns + responsorial psalm refrain 5in, all centered. PDF:
   `NOTATION_WIDTHS_IN` + `_notationTargetWidth` (inches exact on tabloid,
   proportional on other trims, clamped to content width). HTML:
   `.notation-image.ordinary { width: 6in }`, `.hymn`/`.w5 { width: 5in }`,
   `margin: 3pt auto`.
3. **Title-strip detector hardened**: a staff is now a GROUP of >=3 thin
   (<=3-row) near-full-width lines with small gaps (`LINE_MAX_ROWS`,
   `LINE_GAP_MAX`, `LINES_REQUIRED` in `TITLE_CROP`) — a bold display
   title/banner can no longer spoof the staff test. Deterministic test
   fixture (mulberry32; solid-density ink).
4. **Library integration**: `POST /api/attachments/from-notation` promotes
   an uploaded notation image into the Library ("+ Library" button on
   notation rows; prompts for title/composer). Library image attachments
   merge into the editor's Notation Images list with a purple "Library"
   pill (same Print-in dropdown; delete/promote hidden — managed on the
   Library page). Library page rows now show image thumbnails (hover-zoom
   works there too) and an Edit button (title/composer via PUT).
5. **History FINAL vs draft**: every export lands in History (unsaved
   exports auto-save with status `exported`); `export-log` records carry
   `draftId`; `GET /api/drafts` flags `isFinal` (the draft whose export is
   the week's last). History shows a gold FINAL badge; superseded exports
   read "exported (superseded)"; page copy explains it.
6. **Preview overflow detector**: after each preview render the editor
   measures every `.page` in the iframe and warns which pages clip,
   explaining that the exported PDF flows music onto the facing page or
   shrinks it — nothing is lost in print.
7. **Bug-hunt agent findings fixed**: zoom panel hidden on list re-render
   (was sticking open), duplicate render call removed, `jsq()` JS-string
   escaping for inline onclick URL embeds, stale `notation-hash-index`
   entry cleared on notation delete.

**Handoff state: branch `claude/jolly-newton-tzp0aj`, all of the above
committed and pushed as v1.7; 345/345 tests; merge the PR and deploy.
No new env vars needed.**

### Session 10 addendum 2: manual FINAL override
`POST /api/drafts/:id/mark-final` (any signed-in user) writes the week's
`export-log` record (`manual: true`, `draftId`) so the chosen History
version becomes the FINAL of record — the previous FINAL reverts to a
superseded draft and hymn stats follow the override. History rows show a
gold-outlined "Mark FINAL" button on non-final entries (confirm dialog).
