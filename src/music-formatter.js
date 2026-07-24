// Music display logic — PRD Section 5.4
// Formats per-mass-time music selections for display
'use strict';

const MASS_TIMES = ['Sat 5:00 PM', 'Sun 9:00 AM', 'Sun 11:00 AM'];
const MASS_TIME_KEYS = ['musicSat5pm', 'musicSun9am', 'musicSun11am'];

/**
 * Given a music field name, extracts that field from all three MusicBlocks
 * and returns formatted display string(s) per PRD §5.4:
 *
 * - If all three have the SAME title → single line, no time qualifier
 *   Format: "*Title*, Composer"
 *
 * - If different → grouped by unique selection with times in parentheses
 *   Format: "*Title A*, Composer (Sat, 5 PM & Sun, 9 AM) / *Title B*, Composer (Sun, 11 AM)"
 *
 * If the hymn has paired hymnal + number fields (e.g. processionalOrEntrance
 * → processionalOrEntranceHymnal / processionalOrEntranceHymnNumber), those
 * are included in the output so the printed booklet can show
 * "Title (Hymnal #N), Composer".  Pass the field-name pair via opts.hymnalField
 * and opts.hymnNumberField, or convention is `${titleField}Hymnal` and
 * `${titleField}HymnNumber` and we derive them automatically.
 */
function formatMusicSlot(data, titleField, composerField, opts = {}) {
  const hymnalField = opts.hymnalField || titleField + 'Hymnal';
  const hymnNumberField = opts.hymnNumberField || titleField + 'HymnNumber';
  const entries = MASS_TIME_KEYS.map((key, i) => ({
    time: MASS_TIMES[i],
    title: (data[key] && data[key][titleField]) || '',
    composer: (data[key] && data[key][composerField]) || '',
    hymnal: (data[key] && data[key][hymnalField]) || '',
    hymnNumber: (data[key] && data[key][hymnNumberField]) || ''
  })).filter(e => e.title);

  if (entries.length === 0) return [];

  // Group by unique title+composer+hymnal+hymnNumber
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.title}|||${entry.composer}|||${entry.hymnal}|||${entry.hymnNumber}`;
    if (!groups.has(key)) {
      groups.set(key, { title: entry.title, composer: entry.composer, hymnal: entry.hymnal, hymnNumber: entry.hymnNumber, times: [] });
    }
    groups.get(key).times.push(entry.time);
  }

  const groupList = Array.from(groups.values());

  // If only one group AND every Mass has the slot filled, omit the time
  // qualifier. A hymn entered for only a subset of Masses must keep its
  // time label — printing it bare would imply it is sung at all Masses.
  if (groupList.length === 1 && entries.length === MASS_TIME_KEYS.length) {
    const g = groupList[0];
    return [{ title: g.title, composer: g.composer, hymnal: g.hymnal, hymnNumber: g.hymnNumber, timeLabel: '' }];
  }

  // Multiple groups — add time qualifiers
  return groupList.map(g => ({
    title: g.title,
    composer: g.composer,
    hymnal: g.hymnal,
    hymnNumber: g.hymnNumber,
    timeLabel: formatTimeLabel(g.times)
  }));
}

function formatTimeLabel(times) {
  return times.map(t => {
    // Shorten: "Sat 5:00 PM" → "Sat, 5 PM", "Sun 9:00 AM" → "Sun, 9 AM"
    return t.replace(/(\w+)\s(\d+):00\s(AM|PM)/, '$1, $2 $3');
  }).join(' & ');
}

function formatHymnalCitation(item) {
  const parts = [];
  if (item.hymnal) parts.push(item.hymnal);
  if (item.hymnNumber) parts.push('#' + item.hymnNumber);
  return parts.join(' ');
}

/**
 * Renders a full music line as HTML. The piece's title is italic; the
 * composer's name is NEVER italicized (director of liturgy) — it is wrapped
 * in a .composer span so no italic container can restyle it.
 */
function renderMusicLineHtml(item) {
  let html = `<em>${escHtml(item.title)}</em>`;
  const cite = formatHymnalCitation(item);
  if (cite) html += ` <span class="hymnal-cite">[${escHtml(cite)}]</span>`;
  if (item.composer) html += `<span class="composer">, ${escHtml(item.composer)}</span>`;
  if (item.timeLabel) html += ` <span class="mass-time-label">(${escHtml(item.timeLabel)})</span>`;
  return html;
}

/**
 * The same music line as mixed-style runs for the PDF generator:
 * [{ text, italic }] — title italic, everything else (hymnal citation,
 * composer, Mass-time label) roman. "Never italicize the name of a
 * composer" — director of liturgy, 17th Sunday OT proof.
 */
function renderMusicLineRuns(item) {
  const runs = [{ text: String(item.title || ''), italic: true }];
  const cite = formatHymnalCitation(item);
  if (cite) runs.push({ text: ` [${cite}]`, italic: false });
  if (item.composer) runs.push({ text: `, ${item.composer}`, italic: false });
  if (item.timeLabel) runs.push({ text: ` (${item.timeLabel})`, italic: false });
  return runs;
}

/**
 * Renders a full music line as plain text
 */
function renderMusicLineText(item) {
  let text = item.title;
  const cite = formatHymnalCitation(item);
  if (cite) text += ` [${cite}]`;
  if (item.composer) text += `, ${item.composer}`;
  if (item.timeLabel) text += ` (${item.timeLabel})`;
  return text;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { formatMusicSlot, renderMusicLineHtml, renderMusicLineText, renderMusicLineRuns, formatTimeLabel, MASS_TIMES, MASS_TIME_KEYS };
