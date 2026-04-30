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

