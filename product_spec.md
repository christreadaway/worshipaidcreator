# Worship Aid Generator — Product Specification

**Version:** 1.9.1
**Last Updated:** June 24, 2026

> **v1.9.1 — session-restore fix + first browser E2E layer.** The editor kept restoring the last session (mistakes and all), even as a different user and after logout, because the snapshot used one global localStorage key, auto-restored on every load, was never cleared on logout, and re-saved the pristine auto-derived form on every navigation. Fixes: per-user key (`wa_editor_snapshot:<userId>`, legacy global key purged on load), no silent auto-restore (explicit **Restore**/**Discard** buttons), cleared on logout, a dirty-flag (real `event.isTrusted` edits only) so a fresh form is never snapshotted, and a confirm on **Load Sample**. Added Playwright E2E (`npm run test:e2e`, `e2e/session-restore.spec.js`, 5 tests) — the browser-only path the Node suite can't reach, which is how this shipped green. Suites: 365 unit + 5 E2E, all passing.
**Status:** Active development — replacing Microsoft Publisher in fall 2026

> **Pick-up note for next session:** v1.9 is the **director-of-liturgy proof pass** (13th Sunday in Ordinary Time proof, June 2026). **Pushed** on `claude/youthful-goldberg-0kvf8t`. Every layout/wording correction from the marked-up proof was applied to BOTH renderers (PDF `pdf-generator.js` and HTML preview `template-renderer.js`): posture directions lose the cross symbol + period and ride right-justified on the heading they govern; music pieces drop the restating label and put title+composer on the sub-heading line; scripture citations move onto the reading heading line; a Collect heading follows the Gloria; "Please be seated"/"Please stand" sit before their section titles; the intentions line, Lord's Prayer body, and Blessing & Dismissal dialogue are removed; psalm verses end with "R."; the OneLicense permission prints once at the end (not per page); all notation prints 5–5.5in wide and is pushed to the next page rather than shrunk. Full suite green (364 tests; new `src/tests/proof-fixes.test.js`). **Still open:** the auto title-crop heuristic left titles/residual marks on a few uploaded scans — stripping happens at upload, so those images need re-uploading (or share samples to tune `TITLE_CROP`).

> **Decision (June 2026): no programmatic hymn-music *licensing* integration.** OneLicense has no public API. Instead each congregational hymn slot (processional, communion, thanksgiving) and each sung Mass part reserves a music area. **As of v1.6 the user can fill that area digitally**: upload the licensed notation image (TIFF straight from OneLicense works — it's converted to PNG and auto-cropped) and it prints inside the area in both the preview and the exported PDF. With no image attached, the dashed paste-guide box renders instead for hand paste-up. The OneLicense *search* buttons remain as a convenience. Controlled per-aid by `reserveHymnSpace` (default on).

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

**Deployment:** Local Node.js server or Netlify Functions (serverless). KV storage abstraction (`kv.js`) auto-selects filesystem (local) or Netlify Blobs (production). KV namespaces are created on first write — v1.7 adds `notation-hash-index` and `export-log` with no provisioning required.

---

## Project Structure

```
src/
  server.js                  Express server + embedded SPA
  template-renderer.js       HTML booklet renderer for live preview
  pdf-generator.js           PDFKit-based PDF generator (half-letter + tabloid)
  readings-fetcher.js        USCCB scraping + bible-api.com translation client
  liturgical-calendar.js     Date → feast/Sunday name + season (US calendar)
  image-utils.js             Sharp-based notation auto-crop
  validator.js               AJV validation + overflow detection
  schema.js                  JSON Schema for worship aid input
  music-formatter.js         Per-mass-time music consolidation logic
  cli.js                     Command-line interface
  config/
    seasons.js               Liturgical season auto-rules engine
    defaults.js              Default parish settings (mass times, clergy, …)
  store/
    kv.js                    KV storage abstraction (filesystem or Netlify Blobs)
    file-store.js            Async persistence (drafts, settings)
    user-store.js            User management, sessions, role-based access
    hymn-library.js          Parish-managed hymn catalog (English-only)
    attachments.js           Generic media library (audio, PDF, score, etc.)
  assets/
    logo/jerusalem-cross.svg
    text/creeds.js           Nicene, Apostles' Creed, Renewal of Baptismal Vows
    text/mass-texts.js       Confiteor, Sanctus (English + Latin), Lord's Prayer, rubrics
    text/copyright.js        Default copyright boilerplate
  tests/
    validator.test.js        Schema, overflow, line estimation
    seasons.test.js          5 seasons + applySeasonDefaults + music formatter
    template-renderer.test.js  8-page rendering, seasons, creed, readings, music
    pdf-generator.test.js    Filename, file creation, headers, creed, settings
    pdf-layout.test.js       Layout for half-letter and tabloid booklet sizes
    server.test.js           API endpoints, drafts CRUD, settings, auth
    user-store.test.js       User CRUD, sessions, name matching
    liturgical-calendar.test.js  Easter computus, season + feast detection
    attachments-and-calendar.test.js  /api/liturgical-info, attachments CRUD,
                                       Sanctus toggle, parish cover settings,
                                       login regression, editor HTML smoke
data/
  drafts/                    Saved worship aid drafts (UUID.json)
  settings/                  parish.json
  attachments/               Attachment metadata (UUID.json)
  uploads/
    notation/                Notation scans
    covers/                  Cover images + parish logo
    attachments/             Audio / PDF / score binaries
  exports/                   Generated PDFs and HTML
sample/
  second-sunday-lent.json    Complete example input (Lent)
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
| Liturgical Date & Season | Feast name (auto-fills from date when empty), date picker (auto-detects season + feast), season selector (5 seasons) |
| Seasonal Settings | Gloria toggle, creed type, entrance type, Holy Holy setting + **language toggle (English / Latin)**, Mystery of Faith setting, Lamb of God setting, penitential act, postlude toggle, Advent wreath toggle, Lenten acclamation choice |
| Readings | Bible Translation dropdown (defaults to NABRE/USCCB), Fetch-from-USCCB button, First Reading (citation + text), Psalm (citation + refrain + verses), Second Reading (citation + text, with "No Second Reading" toggle), Gospel Acclamation (reference + verse), Gospel (citation + text). Auto-fetched from USCCB the moment a date is set. |
| **Shared Music** (single set; every slot that's the same at every Mass) | Organ Prelude, Processional / Entrance Hymn, Kyrie setting, Communion Hymn, Hymn of Thanksgiving, Organ Postlude — title + composer. Hymn-library typeahead on the three congregational hymns; attachments-library quick-pick on the organ pieces and the Kyrie setting. |
| **Music — per Mass** (x3 mass times) | Offertory Anthem and Choral Anthem (at Communion) — title + composer.  These are the only two slots a music director may schedule differently per Mass (different choirs / ensembles).  Each gets its own attachments-library quick-pick. |
| Files Referenced | Editor-side picker for the parish attachments library; per-music-slot quick-pick dropdowns auto-add the chosen file. |
| Children's Liturgy | Enable toggle, **Mass times (checkboxes — any subset of Sat 5:00 PM / Sun 9:00 AM / Sun 11:00 AM, plus free-form "Other" comma list)**, leader name (optional), music title + composer, notes (printed under the entry) |
| Notation Images | Upload music notation scans (auto-cropped on upload). |
| Cover Image | Optional cover image with tone-driven concept suggestions (Unsplash / Pexels / Wikimedia search links). |
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

- A piece's **title + composer ride on the same line as its sub-heading** (v1.9, director request). The old restating slot label ("Prelude —", "Processional —", "Kyrie —", "Communion —", "Setting —", "Postlude —", etc.) is dropped — the heading already says what the piece is. Mass-ordinary setting names (Gloria, Holy Holy Holy, Mystery of Faith, Lamb of God) sit inline on their headings too.
- **Same music across all 3 Mass times:** Displayed once, no time qualifier.
  - Format on the heading line: *Title*, Composer
- **Different music:** the heading stands alone and each unique selection is listed on its own line below, with the Mass-time qualifier.
  - Format: *Title A*, Composer (Sat, 5 PM & Sun, 11 AM) / *Title B*, Composer (Sun, 9 AM)
- The **Responsorial Psalm** has no piece title: only its scripture reference rides on the heading line — no setting/composer line (v1.9).

### 5. Overflow Detection (PRD §5.2)

Per-page capacity analysis on the two highest-risk pages:
- **Page 3** (Liturgy of the Word): 85-line capacity. Tracks First Reading + Psalm + Second Reading + Gospel Acclamation.
- **Page 4** (Gospel + Creed): 75-line capacity. Tracks Gospel text + Creed (Nicene=32 lines, Apostles'=18 lines).

Line estimation: character count / 65 chars per line. Overflow warnings identify the specific block causing the issue and how many lines over capacity.

### 6. 8-Page Booklet Layout

| Page | Role | Key Content |
|---|---|---|
| 1 | Cover | Jerusalem cross, feast name, date, Mass times, 2x2 parish info grid |
| 2 | Introductory Rites | Organ Prelude, Processional/Antiphon **+ hymn paste area**, Confiteor (conditional), Kyrie, Gloria (conditional), **Collect** |
| 3 | Liturgy of the Word | First Reading, Psalm, Second Reading, Gospel Acclamation |
| 4 | Gospel + Creed | Gospel text, Homily cue, Creed (Nicene / Apostles' / Baptismal Vows), Prayer of the Faithful (heading only) |
| 5 | Liturgy of the Eucharist | Offertory, Children's Liturgy (conditional), Invitation to Prayer, Holy Holy (English/Latin), Mystery of Faith, Great Amen |
| 6 | Communion Rite | Lord's Prayer (heading only), Sign of Peace, Lamb of God, Communion Hymn **+ hymn paste area**, **Choral Anthem (per-Mass)** |
| 7 | (flow) | Determined by content height |
| 8 | (flow) | Determined by content height; padded blank if content ends early |

> **v1.8 flow layout (June 2026 feedback):** pages 2–8 are NO LONGER fixed
> section slots. The PDF renders the liturgy as a sequence of atomic
> blocks (a heading + its prayer text, a hymn line + its notation image,
> one paragraph of a reading) and packs them in order, breaking to a new
> page whenever the next block's measured height doesn't fit — the layout
> is conditional on the vertical height of the actual hymns, prayers, and
> readings. The decorative back cover is retired; page 8 is working
> space. Hard rules: **the booklet is always exactly 8 pages** (short
> content pads with blank pages; oversize content scales text AND images
> down together, floor 75%, then truncates the tail on page 8 WITH a
> warning); **a block is never split** (music and its heading stay
> together — no more sections printing between the halves of a hymn);
> **nothing is dropped silently** (every compromise is a warning the
> editor shows at export). The OneLicense permission prints **once**, in
> the full copyright block that is the final flow block — it is NOT
> repeated in a per-page footer (v1.9, director request). The HTML preview
> keeps the legacy fixed-section pages and flags clipping pages with a
> banner pointing to the export.

> **v1.9 heading/posture rules (director-of-liturgy proof pass):**
> - Posture directions read "Please stand" / "Please be seated" / "Please
>   kneel" — no cross symbol, no trailing period.
> - A posture direction is **right-justified on the heading it governs**:
>   Processional Hymn (stand), Gospel Acclamation (stand), Homily (be
>   seated), the Creed (stand), Invitation to Prayer (stand).
> - Major-section transitions place the direction **before the section
>   title**: "Please be seated" before *The Liturgy of the Word* (after a
>   new **Collect** heading that follows the Gloria) and before *The
>   Liturgy of the Eucharist*; "Please stand" between *Great Amen* and
>   *The Communion Rite*. The two kneels and the dismissal "Please stand"
>   stay on their own lines (cleaned of symbol/period).
> - **Scripture citations** ride on the reading heading line (First /
>   Second Reading, Gospel, Gospel Acclamation).
> - Texts removed as unnecessary: the Prayer of the Faithful "intentions
>   are read…" line, the Lord's Prayer body, the Blessing & Dismissal
>   Priest/Deacon dialogue (headings kept).
> - **Psalm verses** each end with "R." and are separated by a blank space.
> The table rows above describe the canonical *order* of content, not
> fixed page assignments.

#### Hymn-Music Paste Areas (v1.4)

Under each congregational hymn slot (Processional/Entrance, Communion Hymn,
Hymn of Thanksgiving) the booklet reserves a dashed blank box — ~2.2" tall on
half-letter, ~2.9" on tabloid — where the parish pastes the licensed notation
by hand after export. The guide box and its faint label disappear once an
image is pasted over them. Both the HTML preview and the PDF render the
areas. Per-aid toggle: `reserveHymnSpace` (boolean, default `true`; checkbox
in the editor's Shared Music section). In the PDF the box height clamps to
the space remaining on the page; if a page is too full for a usable area, the
box is skipped with a warning.

#### Hard 8-Page Guarantee (v1.4)

The PDF is **always exactly 8 pages**. When a page's content won't fit, the
generator applies, in order:
1. relax side + bottom margins to 0.5" (no-op on half-letter, which already
   uses 0.5"; tabloid gains a 7.5"×10" content area),
2. relax the top margin to 0.5" (top last, so the page keeps its visual anchor),
3. shrink body text — never below **75% of normal**, so type stays legible,
4. truncate with an ellipsis and emit a per-page warning
   (`Page N: content was truncated…`) surfaced in the editor and export
   response.

Page folios and copyright lines are written with margin suppression so they
can never trigger PDFKit's auto-page-add (the historical cause of 16-page
exports with blank folio pages).

### 7. PDF Export

- **Trim sizes (default: tabloid 8.5×11):**
  - `tabloid` *(default)* — 8.5" × 11" (612×792pt). 1" margins (6.5×9 content). Print on 11×17, saddle-stitched. Fonts and spacing scale by 1.294× for readability at the larger trim.
  - `half-letter` — 5.5" × 8.5" (396×612pt). 0.5" margins (3.5×7.5 content). Print on letter (8.5×11), saddle-stitched.
- **Imposition:** Output is the finished booklet pages in reading order. Saddle-stitch imposition is delegated to the printer driver's "booklet print" / "fold booklet" mode (Acrobat, macOS Print, modern Windows print dialogs handle this natively).
- **Engine:** PDFKit (direct page construction, no headless browser).
- **Filename convention:** `YYYY_MM_DD__Feast_Name.pdf`.
- **Metadata:** Title, Author, Subject, CreationDate embedded in PDF info dict.
- **Typography:** Liberation Sans (4 weights, **vendored in `src/assets/fonts/` and embedded** — full Latin Unicode coverage; ships with the Netlify function via `included_files`, fixing the v1.5 `ENOENT Helvetica.afm` export crash on Lambda). Navy/burgundy/gold color scheme.
- **Persistent cover branding:** Parish logo (uploaded under Settings) replaces the default cross on every cover; parish name and tagline appear above the feast name.

### 8. HTML Preview

- Parallel renderer producing identical 8-page layout in HTML/CSS
- EB Garamond + Cinzel via Google Fonts
- **Page geometry tracks the selected booklet size (v1.3):** when the Editor's booklet-size selector is `tabloid`, the preview renders at 8.5"×11" with proportionally larger fonts; when `half-letter`, at 5.5"×8.5". The preview iframe width and `@page` size adjust on every preview generation, so the preview is a true-scale rendering of what'll print.
- Red border + error banner on overflow pages
- Displayed in sandboxed iframe in the editor — `frame.style.width` is set to the server-reported `pageWidth` so the iframe is the correct trim.

### 9. Draft Persistence

- File-based JSON storage in `data/drafts/` (UUID filenames)
- CRUD operations: save, load, list, delete, duplicate
- Auto-save every 30 seconds while form is active
- Duplicate action appends "(copy)" to feast name
- List sorted by updatedAt descending
- **Editor session snapshot & restore (v1.7):** every edit (debounced
  1.5 s) and `beforeunload` write `buildData()` to
  `localStorage('wa_editor_snapshot')`. On login, a snapshot under 24 h
  old restores automatically (with a toast); one 24 h–7 d old surfaces
  a "⟲ Restore last session" nav button (`id=btn-restore`); older
  snapshots are ignored. Restoring suppresses the new-draft carryover
  defaults so the restored work isn't overwritten.

### 10. Parish Settings

Admin-editable fields stored in `data/settings/parish-settings.json`:
- Parish name, address, phone, URL
- Cover persistent branding: logo (PNG/JPG upload), cover tagline
- 4 info blurbs (Connect, Nursery, Restrooms, Prayer)
- OneLicense number
- Short copyright and full copyright. As of v1.9 only the **full** copyright block is printed (once, at the end of the booklet); the short per-page license line was removed at the director's request. The `copyrightShort` field is retained in settings for back-compat but is no longer rendered.
- Font and minimum font size preferences

### 11. USCCB Readings Auto-Fetch

- `/api/readings?date=YYYY-MM-DD&translation=NABRE` scrapes `bible.usccb.org/bible/readings/MMDDYY.cfm` and returns parsed first/second readings, psalm (refrain split from verses), gospel acclamation verse, and gospel.
- Bible translation dropdown: NABRE (Lectionary, default, from USCCB), Douay-Rheims, KJV, World English Bible, Bible in Basic English, ASV. Non-NABRE picks re-fetch the citations from bible-api.com but keep Lectionary-only items (psalm refrain, acclamation verse) intact.
- "Fetch from USCCB" button populates all reading fields from the liturgical date in one click.
- **Paragraph reflow (v1.3):** USCCB serves Lectionary text in sense-line layout (each clause on its own line, for lectors). The fetcher now flattens single line breaks within a paragraph into spaces while keeping paragraph breaks intact, so worship-aid readings print as flowing paragraphs. Applied to first/second/gospel readings and the gospel-acclamation verse. Psalm verses keep their stanza structure. `src/readings-fetcher.js#reflowAsParagraphs`.

### 12. Liturgical Calendar Automation

- Date input defaults to the next upcoming Sunday on page load.
- Changing the date auto-detects the season using a Computus-based Easter calculator and Lent/Easter/Advent/Christmas/Ordinary windows; seasonal defaults are then applied automatically.
- Children's Liturgy of the Word: ON during the school year, OFF for summer (Jun–Aug), school Christmas break (Dec 22–Jan 6), and the Christmas/Easter seasons themselves. Manual toggle becomes a sticky override; loading a saved draft respects the stored value.

### 13. Cover Image Suggestions

- Tone dropdown (reverent, joyful, solemn, hopeful, contemplative, triumphant) plus a "Suggest covers" button.
- Returns four seasonal concept ideas with copy-ready image-generation prompts and links to stock searches (Unsplash, Pexels, Wikimedia Commons).

### 14. Hymn Library (English Only)

- Parish-managed catalog stored in KV (`hymn-library/parish-default`). Fields per entry: title, tune name, composer, key, meter, source/hymnal, **hymnal name (e.g. "Worship IV")**, **hymnNumber (e.g. "612")**, notes, language (defaults to `en`).
- Seeded with 20 common English Catholic hymns covering Public Domain + GIA/OCP/Hope etc. Editable as JSON in the Settings page.
- Title fields in every Music block carry a typeahead that searches the library and shows tune name, key signature, and **`[Hymnal #N]`** inline so the user can pick the arrangement that fits the parish. Selecting an entry auto-fills the composer, hymnal, and hymn-number fields if blank.
- **Hymnal + number search (v1.3):** typing the number alone (e.g. "612") ranks the matching hymnal entry highest. Hymnal name matches (e.g. "worship") also score. Music directors normally search OneLicense by hymnal + number, not title.
- **Instant in-memory search**: the full library is fetched once on first keystroke (or admin save), cached client-side, and filtered synchronously for every keystroke after that. No debounce, no per-keystroke network round-trip. Server-side `/api/hymns/search` is preserved for non-browser callers.
- **Curly/straight quote normalization**: both server and client lowercase + collapse smart quotes (`'`, `'`, `"`, `"`) to ASCII before matching, so users typing a straight `'` still match seed entries that use typographic apostrophes (e.g. "On Eagle's Wings").
- API: `GET /api/hymns/search?q=…` (English by default; pass `includeNonEnglish=1` to include other languages), `GET /api/hymns`, `PUT /api/hymns` (admin only).
- `oneLicenseSearchUrl(entry)` helper builds a OneLicense search URL: prefers hymnal + number, falls back to title + composer.
- **Hymnal citation in rendered output:** the printed booklet shows `Title [Hymnal #N], Composer` whenever the hymn entry has a hymnal+number, so congregations can find the song in the pews. CSS class `.hymnal-cite`.
- **Local enrichment script**: `npm run fetch-hymns` reads `src/assets/hymns/seed.json`, calls Hymnary.org's free search endpoint per entry (~1 req/sec), and writes `data/hymn-library-local.json` with meter / scripture refs / hymnal-count metadata Hymnary returns. Defensive against network failures.

### 14a. Responsorial Psalm Setting (v1.3)

- New shared-music slot: **Responsorial Psalm Setting** (and composer).
- **v1.9:** the editor still captures a psalm setting + composer, but the booklet no longer prints a "Setting — composer" line. Per the director, the Responsorial Psalm has no piece title — only the scripture reference rides on the heading line, and the refrain notation (or paste box) carries the music.
- **Auto-prefill from USCCB:** when readings are fetched, the refrain text is copied into the psalm-setting title input as a starting point — the music director can then search OneLicense for a matching setting.
- **OneLicense search-by-refrain button** opens the OneLicense search with the refrain text as the query.
- Persisted via the `responsorialPsalmSetting` / `responsorialPsalmSettingComposer` fields on each music block; populates from any block (Sat/Sun9/Sun11) so legacy drafts open cleanly.

### 14b. OneLicense Search Helpers (v1.3)

- Each shared hymn slot (processional, communion, thanksgiving) gets a **OneLicense** button next to its hymnal/#number inputs.  Click → opens `https://www.onelicense.net/search?text=<query>` in a new tab.
- Query precedence: `hymnal #number` > `hymnal` alone > `#number` alone > `title + composer`.
- Responsorial Psalm has its own button that searches by refrain text.
- No automated OneLicense scraping (the site is Cloudflare-protected and returns 403 to non-browser requests). Helpers keep humans in the loop.
- **v1.4 role:** these buttons now serve the manual paste workflow — find the music on OneLicense, download/copy the notation, and paste it into the reserved hymn-space area in the exported booklet. Programmatic embedding was dropped by decision (see header note).

### 15. Notation Upload Pipeline (v1.6)

- Accepted: PNG, JPG, **TIFF** (what OneLicense supplies), BMP, GIF, WebP, SVG.
- Every upload is normalized at the door (`normalizeNotationImage`): EXIF rotation, white-margin trim, and conversion of non-embeddable formats to PNG — so every stored notation file displays in the browser and embeds in the PDF.
- Rejected types and oversized files return descriptive errors (the hosted site's ~4.5 MB serverless payload cap is stated in the message; the SPA also pre-checks size client-side).
- **Automatic title-header removal (v1.6.4, default-everywhere + adaptive in v1.7.1).** Licensed notation usually arrives with a large title block (title / composer / tune) above the first staff; the booklet already prints the title line, so the header only wastes music space. `src/image-utils.js` (`detectTitleCropY` + `stripTitleHeader` + the `TITLE_CROP` constants) builds a row-darkness profile at a 480 px analysis width, treats a row with ≥35% ink as a staff line, finds the first staff system, walks up past anything hugging the staff (tempo/composer lines), and crops at the first white gap — ONLY when real header content exists above the gap and the crop removes ≤50% of the image. The separator-gap and breathing-room thresholds are **height-adaptive** (v1.7.1): `gap = clamp(H × 0.035, 5, 12)` and `pad = clamp(H × 0.02, 3, 10)` analysis rows — a fixed 12-row gap was unreachable on wide-but-short scans (a single psalm-refrain staff), which is why headers like "Psalm 100: …" used to survive. Idempotent; lyrics between staves and the bottom copyright line always survive. **Stripping is the default on every image path**: `/api/upload/notation` AND `/api/attachments` (image attachments can print in the booklet) both strip unless the request explicitly sends `stripTitle=0`; the editor checkbox `stripTitleHeaders` (default ON) is an opt-out, and a missing checkbox can no longer silently disable stripping (the client only sends `0` on an explicit uncheck). Safe for non-music images — no staff detected means no crop. **Open item (v1.9 proof):** the director found a few scans where the title survived or left residual marks ("2 dots") above the staff. Stripping happens at **upload**, so images already stored keep their baked-in result — they must be re-uploaded to re-run the cropper. Tuning `TITLE_CROP` further needs the actual problem scans (the heuristic is deliberately conservative because over-cropping removes real notation, which is worse than a stray title).
- **Content-hash de-dupe (v1.7).** The sha256 of the processed buffer is indexed in the `notation-hash-index` KV namespace; re-uploading identical content reuses the already-stored file (response `deduped: true`, toast "Already uploaded — reusing the existing image") instead of stacking copies in the list.

#### Per-Slot Notation Images (v1.6)

`data.notationImages` maps a slot name to an uploaded image URL. Slots: `processional`, `communion`, `thanksgiving` (hymn areas), `kyrie`, `gloria`, `sanctus`, `mysteryOfFaith`, `lambOfGod` (ordinary parts), `psalmRefrain`, `gospelAcclamation` (sung responses). Precedence everywhere: **uploaded image > reserved paste box > plain text**. Three ways to fill a slot (v1.6.1): the per-slot *Attach notation* control; the **Notation Images list**, where every uploaded image carries a "Print in:" dropdown (upload everything, then assign — matches the music department's batch workflow); or the per-slot picker's **Library** group (image attachments, kind-matched first). The PDF route pre-resolves the URLs — notation uploads *or* library attachments — to buffers (`src/notation-resolver.js`) and embeds them scaled to the content width.

**Missing-file fallback (v1.6.2):** `/api/preview` checks every `notationImages` reference against storage (`findMissingNotationSlots`, `src/notation-resolver.js`) and strips references whose file no longer exists, so the preview falls back to the dashed paste box exactly like the PDF — with a named warning (`The notation image attached to "<slot>" no longer exists on the server — showing the blank paste area instead. Re-upload and re-attach it.`). The editor renders preview `warnings` as visible banners above the preview, not just a status-bar count. Root cause of the original "the processional hymn has no placeholder" report: a dead `<img>` inside the sandboxed preview iframe renders as an invisible blank, so the slot looked empty while the PDF (which pre-resolves buffers) correctly showed the paste box.

**Image sizing (v1.9, director spec):** ALL music notation prints **5–5.5in wide** on the tabloid trim (`NOTATION_WIDTH_IN = 5.5`, scaled proportionally on the half-letter trim, clamped to the content width) — service music used to be 6in ("too large"). Width is the priority: an image keeps its spec width and natural height, and a block that doesn't fit the room left on the page is **pushed whole to the next page** by the flow paginator rather than shrunk to fit the scrap below (the Gloria that rendered "too small" because a height cap squeezed its width). Height is bounded only by a full content page; an image genuinely taller than one page shrinks proportionally so it stays complete. Everything is **centered** (`object-position: center top` in HTML; centered `drawX` in the PDF's `_notationImage`). When the whole booklet is scaled to honor the 8-page guarantee, notation scales with the text (floor 75%). Verified against the PDF content-stream image transforms.

#### Notation Images List (v1.6.1, overhauled v1.7)

The upload-everything-then-assign list is the music department's primary workflow surface:

- **Hover-zoom** floating preview (`#notation-zoom`) on list thumbnails *and* per-slot thumbs; click opens the full-size image. Thumbnails enlarged to 72 px (list) / 40 px (per-slot).
- Rows are **de-duped by URL** defensively.
- **Per-row Delete** — new `DELETE /api/uploads/notation/:filename` (auth + `upload_images`). Drafts that still reference a deleted file keep the reference; preview and PDF fall back to the paste box per v1.6.2.
- The **"Print in" select is sticky**: it shows the image's current spot. Picking a different spot MOVES the single assignment; picking the blank entry removes it; an image printed in multiple spots keeps its pills instead. Assigned rows get a gold border.
- **"Last printed in" history (v1.7):** `GET /api/notation-usage` (auth) walks drafts newest-first into `{byUrl: {url: {slot, liturgicalDate, feastName}}}`; rows show "last printed in \<spot\> (\<date\>)" with a one-click **Use again** button when the image isn't currently assigned there.

#### PDF Spread Bridging for Music Images (v1.7 — RETIRED in v1.7.1)

Bridging (an even-page music image continuing onto the facing odd page as a lossless clipped two-part drawing) shipped in v1.7 and was **retired and fully removed in v1.8** after June 2026 parish feedback: in practice the sections that follow the image in render order printed *between* the two halves (processional split around the Penitential Act; communion hymn split around the Choral Anthem), breaking blocks the assembly reads as one piece. The mechanism (`_notationImage`'s `bridge` option, `_carryNotation`, `_drawCarriedNotation`) was deleted when the flow engine replaced the fixed page renderers. Current hard rules: **music blocks stay whole on one page** — a too-tall image shrinks proportionally (complete, never cut) — and **nothing is ever dropped silently**: every content page runs through `_fitPageText` shrink-to-fit, and anything that still cannot fit is truncated *with a warning that is surfaced to the user at export* (JSON `warnings` locally; `X-Export-Warnings` response header on Netlify; both rendered as banners in the editor).

> **Serverless binary responses (v1.6.1):** `serverless-http` must be configured with an explicit `binary` content-type list (`netlify/functions/api.js`). Its default list is empty, which UTF-8-mangled every PDF and image response on Netlify — exported booklets opened as blank pages even though the PDF content was correct. Any new binary content type served by the API must be added to that list.

#### Service Music Carryover (v1.6)

A new draft defaults to **carrying the service music over from the most recent draft** — settings names (Kyrie, Gloria, Holy Holy Holy, Mystery of Faith, Lamb of God), Sanctus language, penitential act, and the ordinary-part notation images. A checked "Same service music as last week" box collapses the individual fields; unchecking opens them for per-part editing. Stored per-draft as `serviceMusicCarryover`.

**v1.7:** carryover now copies the **entire `notationImages` map** from the latest draft (not just the ordinary parts) — every image defaults to the spot it printed in last week, and swapping one is a single "Print in" dropdown pick. Restoring an editor session snapshot (see § 9) suppresses these carryover defaults so restored work isn't overwritten.

#### Anthems (v1.6)

One **Anthems** section replaces the three per-Mass dropdown blocks: an Offertory list (two rows by default) and a Choral (Communion) list, each row = title + composer + checkboxes for Sat 5 PM / Sun 9 AM / Sun 11 AM, plus an **Add anthem** button. Saved as structured `anthems.{offertory,choral}[]` AND denormalized into the per-Mass music blocks at save time so the renderers' consolidation logic (and legacy drafts) work unchanged. No library pulls — anthems, preludes, and postludes are typed in directly per the music department's request.

### 16. Creed — Three Options

- Nicene Creed (default, Ordinary/Christmas)
- Apostles' Creed (Advent, Lent, Easter Season per parish worksheet)
- Renewal of Baptismal Vows (Easter Vigil and Easter Sunday Mass — full priest/all dialogue text)

### 17. Hymn Usage Stats

- **Visible to all roles** (no permission gate) under the "Stats" nav link.
- **Stats measure what was actually PRINTED (v1.7).** `POST /api/generate-pdf`
  writes one record per `liturgicalDate` to the new `export-log` KV namespace
  (feast, season, the three per-Mass music blocks, who exported, when). The
  last export of a week overwrites — re-exports don't double-count.
- `GET /api/stats/hymns` aggregates the `export-log` records (it previously
  walked every saved draft, which over-counted revisions and drafts that
  never shipped): total count, by month (`YYYY-MM`), and by liturgical
  season. Each title is counted at most once per exported week regardless
  of how many mass times list it.
- The view is a sortable table: hymn / total / by-season / by-month, with
  copy stating how many **exported weeks** were analyzed. Useful for
  OneLicense reporting and for the music director when planning rotation
  across the year.

### 18. Generic Attachments Library

- Parish-managed library of audio / PDF / image / MusicXML / MIDI / doc
  files that aren't congregational hymns (preludes, postludes, mass
  settings, anthems, recordings, scores).
- Each entry carries: `title`, `composer`, `kind` (16 options — see
  `src/store/attachments.js`), `tags`, `notes`, mime, size, upload
  metadata, and a stable URL.
- Storage: Multer disk on local (`data/uploads/attachments/`) and
  Netlify Blobs (`uploads-attachments`) in production. Metadata lives
  in the `attachments` namespace. File size cap: 50 MB.
- API: `GET /api/attachments` (filterable by `kind`, `kinds`, `q`),
  `POST /api/attachments` (multipart, **`manage_attachments`** perm),
  `PUT /api/attachments/:id`, `DELETE /api/attachments/:id` (cleans
  up on-disk binary even though the kv namespace path doesn't line up
  with multer's diskStorage path), `GET /api/uploads/attachments/:filename`.
- **Permission model:** the `manage_attachments` role permission is
  granted to `admin`, `music_director`, and `staff` (the people who
  actually pick music). `pastor` does not have it.
- **UI: dedicated `Library` top-nav page.** Upload widget, kind
  selector, tags input, and the kind-filterable list of all
  attachments live on this page. The nav link is hidden for users
  without `manage_attachments`. Editor side: per-music-slot
  "pick from library" dropdowns scoped to the slot's kind, plus a
  general "Files Referenced" section showing the attachments wired
  into the current worship aid.

### 19. Liturgical Calendar Auto-Detect (Feast / Sunday Name)

- `src/liturgical-calendar.js` derives feast / Sunday name + season
  from any `YYYY-MM-DD` date. Coverage:
  - Sundays of Advent, Lent, and Easter (numbered), Divine Mercy
    Sunday, the Sunday in the Octave of Christmas (Holy Family).
  - Triduum (Palm Sunday, Holy Thursday, Good Friday, Holy Saturday)
    and Easter Sunday.
  - Movable solemnities: Ascension, Pentecost, Trinity Sunday,
    Corpus Christi, Sacred Heart, Christ the King, Holy Family,
    Baptism of the Lord, Epiphany.
  - Fixed feasts: Christmas, Annunciation, Assumption, All Saints,
    All Souls, Immaculate Conception, Our Lady of Guadalupe, etc.
  - Numbered Sundays in Ordinary Time (anchored so Christ the King
    = 34th Sunday).
  - Fallback: weekday + month/day if no rule matches.
- `GET /api/liturgical-info?date=YYYY-MM-DD` returns
  `{date, liturgicalSeason, feastName}`.
- **Liturgical season ALWAYS tracks the date.** When the user changes
  the date — and when a saved draft loads — the season selector is
  set to the date-derived value. Manual overrides of the seasonal
  sub-settings (Gloria, creed, Holy Holy setting, etc.) are preserved
  because `onSeasonChange()` only runs when the season actually
  changes. The reconciliation helper is `reconcileSeasonAndFeastFromDate({ feastFillIfEmpty })` in `src/server.js`.
- **Feast / Sunday Name TRACKS the date (v1.7).** Changing the date
  updates the field. (The old fill-only-when-empty rule never fired
  again once the startup auto-fill or a loaded draft had filled the
  field, so the name silently went stale.) Manually typing a name sets
  `dataset.userSet` (via `oninput`) and is preserved until the field is
  cleared — clearing re-enables tracking; `populateForm` clears the
  flag so a loaded draft updates on the next date change.

### 20. Sanctus / Holy, Holy, Holy Language Toggle

- Per-aid: `seasonalSettings.holyHolyLanguage` ∈ `{english, latin}`.
- Parish-wide default: `parishSettings.defaultSanctusLanguage`.
- Renderer precedence: per-aid override > parish default > English.
- Heading switches between "Holy, Holy, Holy" and "Sanctus"; the
  block prints the matching Roman Missal text (English or the
  Vulgate "Sanctus, Sanctus, Sanctus Dominus Deus Sabaoth …").

### 21a. Per-User Preferences (v1.3)

Distinct from parish-wide `/api/settings`, which apply to every user. Per-user prefs are tied to the authenticated user and persist across drafts and devices.

- Stored as `user.prefs` on the user record (`kv` namespace `users`).
- API: `GET /api/user-prefs`, `PUT /api/user-prefs` (auth required). PUT performs a shallow merge.
- Currently persisted: `bookletSize` (last-selected trim — tabloid or half-letter). The Editor's nav bar selector saves to prefs on change and restores on next sign-in.
- Designed to grow: future candidates include `defaultSanctusLanguage` override, preferred hymnal name, preferred Bible translation, last-used cover tone.

### 21b. Health Endpoint (v1.3)

`GET /api/health` reports the KV backend that's actually being used so deployment issues are observable. Response:

```json
{
  "ok": true,
  "timestamp": "...",
  "environment": "local" | "netlify",
  "persistence": "filesystem" | "netlify-blobs" | "in-memory",
  "persistsAcrossInvocations": true | false,
  "warning": "..."   // present iff persistence === "in-memory"
}
```

If persistence reports `in-memory` on Netlify, sessions/settings/uploads will not survive Lambda cold starts — Netlify Blobs needs to be enabled for the site.

### 21. Cover & Parish Settings Expansion

- `parishSettings.massTimes` (multi-line) renders on the cover.
- Clergy block on the cover lines up `pastor` + `pastorTitle`,
  `associates` (one per line), `deacons` (one per line),
  `musicDirector`.
- `welcomeMessage` prints inside the cover; `closingMessage` on the
  back cover.
- Editor's Settings page exposes all of the above plus the existing
  parish info, info-block blurbs, copyright fields, hymn library, and
  workflow toggles.

---

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serve SPA |
| GET | `/history` | Serve SPA (history view) |
| GET | `/admin` | Serve SPA (settings view) |
| GET | `/library` | Serve SPA (Music & Document Library view) |
| GET | `/stats` | Serve SPA (hymn usage stats view) |
| GET | `/api/season-defaults/:season` | Season auto-rules (400 on unknown season) |
| GET | `/api/lenten-acclamations` | Lenten acclamation options |
| GET | `/api/bible-translations` | Translations for the readings dropdown |
| GET | `/api/readings?date&translation` | USCCB readings auto-fetch |
| GET | `/api/liturgical-info?date` | Feast / Sunday name + season for the given date |
| POST | `/api/cover-suggestions` | Cover image concept ideas + search links |
| POST | `/api/validate` | Validate input + return overflow warnings |
| POST | `/api/preview` | Generate HTML preview |
| POST | `/api/generate-pdf` | Generate PDF (accepts `bookletSize`), return download URL; logs the export per liturgical week (`export-log`) |
| POST | `/api/drafts` | Save draft |
| GET | `/api/drafts` | List all drafts |
| GET | `/api/drafts/:id` | Load draft by ID |
| DELETE | `/api/drafts/:id` | Delete draft |
| POST | `/api/drafts/:id/duplicate` | Duplicate draft |
| POST | `/api/drafts/:id/submit-for-review` | Move draft to `review` |
| POST | `/api/drafts/:id/approve` | Pastor approval |
| POST | `/api/drafts/:id/request-changes` | Pastor requests changes |
| GET | `/api/settings` | Load parish settings (parish-wide) |
| PUT | `/api/settings` | Save parish settings (parish-wide) |
| GET | `/api/user-prefs` | Load per-user preferences (auth required) |
| PUT | `/api/user-prefs` | Merge per-user preferences (auth required) |
| GET | `/api/health` | KV backend status (filesystem / netlify-blobs / in-memory) |
| POST | `/api/upload/notation` | Upload notation scan (normalized; title-header strip via `stripTitle`; content-hash deduped) |
| DELETE | `/api/uploads/notation/:filename` | Remove an uploaded notation image (`upload_images`) |
| GET | `/api/notation-usage` | Per-image "last printed in" history from drafts (auth) |
| POST | `/api/upload/cover` | Upload cover image |
| POST | `/api/upload/logo` | Upload parish logo (admin only) |
| GET | `/api/hymns` | Get hymn library |
| GET | `/api/hymns/search?q&limit&includeNonEnglish` | Typeahead search (smart-quote normalized) |
| PUT | `/api/hymns` | Save hymn library (admin only) |
| GET | `/api/stats/hymns` | Hymn usage frequency across exported weeks (`export-log`) |
| GET | `/api/attachments` | List attachments (filter `kind`, `kinds`, `q`) |
| POST | `/api/attachments` | Upload attachment (multipart, manage_settings) |
| PUT | `/api/attachments/:id` | Update attachment metadata (manage_settings) |
| DELETE | `/api/attachments/:id` | Remove attachment + on-disk binary (manage_settings) |
| GET | `/api/uploads/attachments/:filename` | Serve attachment binary |
| GET | `/api/sample` | Load sample data |
| GET | `/exports/:filename` | Static file serving for exported PDFs |

---

## Test Coverage

**365 unit/integration tests across 17 files** (run `npm test` for the exact
count). Test files run serialized (`--test-concurrency=1`) and the suites that
share the on-disk `data/` store take a cross-process lock
(`src/tests/_shared-state-lock.js`), so runs are deterministic. v1.9 adds
`proof-fixes.test.js` (director-of-liturgy layout rules).

> **Browser end-to-end (v1.9.1, Playwright):** `npm run test:e2e` boots the
> real app and drives Chromium against it. This layer exists because the Node
> suite **cannot reach the browser-only code** — `localStorage`, multi-user
> state, the page-load lifecycle — which is exactly where the session-restore
> bug lived (it kept restoring the last session, even as a different user,
> even after logout, with a fully green unit suite). `e2e/session-restore.spec.js`
> reproduces that bug's paths and pins the fix: no silent auto-restore,
> per-user keying, cleared on logout, explicit Restore/Discard, and a
> dirty-flag so a pristine auto-derived form is never snapshotted. The config
> resolves a Chromium binary from `PLAYWRIGHT_BROWSERS_PATH` (or
> `npx playwright install chromium` on a normal dev box) and starts the server
> via Playwright's `webServer`.

| Suite | What It Covers |
|---|---|
| Validator | Schema validation, required fields, season enums, overflow detection (pages 3 & 4), line estimation |
| Seasons | All 5 season defaults, season application, user override preservation, music formatter |
| Template Renderer | 8-page rendering, seasonal variations (Gloria, Creed, Acclamation), parish info, readings, music display, copyright, Sign of Peace, Great Amen |
| PDF Generator | Filename format, file creation, PDF headers, creed selection, parish settings integration |
| PDF Layout | Layout correctness for half-letter and tabloid booklets |
| Server API | API endpoints, drafts CRUD, settings, auth login, approval workflow |
| User Store | User CRUD, authentication (beta mode), case-insensitive login, display name matching, sessions, exclusive login, role permissions, role labels |
| Liturgical Calendar | Easter computus accuracy, season detection, feast/Sunday name detection across cycle |
| Attachments + Calendar + Sanctus | `/api/liturgical-info` endpoint, attachments CRUD (with disk-cleanup regression test), Sanctus toggle precedence chain (per-aid > parish > English), parish-cover rendering, login regression, editor-HTML smoke |
| **Readings Fetcher** | Paragraph reflow correctness (collapse single line breaks, preserve paragraph breaks), HTML parsing, splitPsalm refrain extraction, splitGospelAcclamation R-line stripping, USCCB date format |
| **Feedback Fixes** | Hymnal+number on hymn entries, OneLicense URL helper, music-formatter hymnal rendering, Responsorial Psalm slot, OneLicense buttons, stateless HMAC tokens (survive store wipe + tampering), per-user prefs API merge semantics, health endpoint, preview matches selected booklet size, settings round-trip |
| **Hymn Space (v1.4)** | Paste areas render on pages 2/6/7 in both renderers, geometry per trim size, `reserveHymnSpace:false` opt-out, page-bounds safety, long-announcements interaction |
| **Security regressions (v1.4)** | 401/403 on unauthenticated or under-permissioned draft/settings/export routes, path-traversal draft ids and filenames rejected, approval-gate unsaved-export block, settings merge-on-save |
| **UAT Fixes (v1.6–v1.6.4)** | Notation embedding + reserved music areas, carryover, anthems, missing-file preview fallback + named warning (v1.6.2), full-width/centered images + raised caps (v1.6.3), title-header auto-crop incl. idempotence and lyrics/copyright survival (v1.6.4) |
| **UAT Fixes 2 (v1.6.1)** | Serverless binary responses, assignable Notation Images list, library attachments in per-slot pickers |
| **Notation Resolver (v1.6.1)** | URL→buffer pre-resolution for notation uploads and library attachments, `findMissingNotationSlots` existence checks |
| Utilities | escapeHtml, nl2br, formatDate (folded into renderer suite) |

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
| admin | Director of Liturgy | Full access: edit all, manage users, manage settings, manage attachments, approve, export |
| music_director | Music Director | Edit music, seasonal settings, upload images, **manage attachments**, export PDF |
| pastor | Pastor | Edit readings, approve drafts, edit announcements |
| staff | Staff | Edit readings, music, announcements, seasonal settings, **manage attachments**, export PDF |

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

- **Stateless HMAC-signed tokens (v1.3):** tokens are self-contained `<userId>.<issuedAtMs>.<sig>`, signed with `SESSION_SECRET` (env var). Verification only requires the secret + user record — no per-session storage. This eliminates the "Not authenticated" upload failures that occurred on Netlify when the in-memory blob fallback dropped state between Lambda cold starts.
- **30-day expiry** (`SESSION_MAX_AGE_MS`).
- **Logout (`destroySession`)** persists the token to a small revocation list (`sessions/_revoked`) so it stops validating immediately. List capped at 500 most-recent entries; older tokens self-expire.
- **Exclusive login per role:** when a new user of the same role logs in, every same-role user gets a fresh `revokedBefore` timestamp; tokens issued before that timestamp no longer validate.
- **Frontend 401 handling:** every upload (notation, attachment, logo, cover) checks `_sessionToken` before sending and recognises a 401 response as "session expired" — clears the cached token and redirects to login instead of silently failing.
- Token transmitted via `x-session-token` header on every protected request.
- Google OAuth supported (linked via `googleEmail` field on user record).
- **Set `SESSION_SECRET` in production.** The default dev secret is fine for local use but should NEVER be relied on in deployment.

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

1. **Expand hymn library to ~40 pre-1962 entries with lyrics** — write `src/assets/hymns/seed.json` with hymns composed before 1962. Per entry: `title`, `tune`, `composer`, `lyricist`, `year`, `key`, `meter`, `source`, `tradition` (Latin chant / Lutheran / Anglican / American / Irish / etc.), `language: 'en'`, `lyrics` (≥ first verse, public domain), `referenceUrls` (Hymnary / CPDL / OpenHymnal). Update `src/store/hymn-library.js` to load this JSON in place of the hardcoded 20-entry array.
2. **Stock the attachments library** with the parish's existing prelude / postlude / mass-setting files so the per-music-slot dropdowns are useful out of the box.

### Music & Licensing
> **Dropped (June 2026):** the previously planned OneLicense automation track
> (Hymnary.org client, arrangements table, version picker, reporting CSV) is
> abandoned by decision. The app builds everything *except* the hymn music
> itself; the booklet reserves a paste area per hymn slot and the parish
> drops the licensed notation in by hand. The OneLicense search buttons
> remain as manual-workflow helpers.
- **OneLicense reporting CSV exporter** (small, still worthwhile) — list every hymn used in published booklets, ready for upload into OneLicense's reporting tool.

### PDF Output
- ~~Auto-fit / page-count handling~~ — **shipped in v1.4** as a hard 8-page guarantee: side + bottom margins relax to 0.5" first, then the top margin, then body text scales down (floor 75%); anything still too long is truncated with a per-page warning. The PDF can never exceed 8 pages.
- **True booklet imposition** built into the app (4-up sheets in saddle-stitch order) so the file is print-ready without a printer-driver "fold booklet" step. Currently delegated to print dialog.
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
