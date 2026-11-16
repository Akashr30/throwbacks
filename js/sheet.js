// sheet.js — the sheet: a spreadsheet-looking grid of what you worked on,
// one row per task (log.js sheetRows), for a week or a month, grouped two
// ways (Group by, remembered):
//   - Date: each day a band across the sheet (its date, ≈time, first–last,
//     tasks, Open day), its folders as sub-heads (the folder, its apps, its
//     ≈time), then the numbered tasks — # · Task · App · ≈Time, a chat's app
//     and ≈time on its first line; each week's total (and, on a month, its
//     summary) after its days;
//   - Folder: each folder once for the whole week or month, busiest first,
//     the day on its first row down the left — Day · # · Task · App · ≈Time.
// Every row is a whole row (no merged cells): merged ones read as rows left open.
// A day's summary lines and the rows you added are editable in place
// (Enter or leaving the cell saves, Esc puts it back, an emptied cell is
// removed); a chat not summarized yet shows as its title. Selecting cells
// and copying pastes into any spreadsheet. Cell text is only ever read and
// written as text. A line is saved by the text it showed, so an edit after
// rows moved finds its line.

import { icon } from './icons.js';
import { fmtDuration } from './time.js';
import { sheetRows } from './log.js';
import { appOf, folderGroups } from './plans.js';
import { h, appMark, fmtWd, fmtDM, fmtClock, plural, todayKey, recapView } from './ui.js';

const DAY_COLS = [['#', 'c-n'], ['Task', 'c-task'], ['App', 'c-app'], ['≈Time', 'c-dur']];
const FOLDER_COLS = [['Day', 'c-day'], ...DAY_COLS];
const OTHER = '\u0000other';  // summary lines of chats from an app that isn't loaded now
const MINE = '\u0000mine';    // rows you added

/** A row's group: its chat's folder ('' for none), a chat not loaded now, or yours. */
const groupOf = (r) => (r.manual ? MINE : r.item ? r.item.project || '' : OTHER);

/** A group's name, icon and what hovering it says (a folder's full path). */
function groupLabel(g, path) {
  if (g === MINE) return { name: 'Added by you', ico: 'plus', title: 'Rows you added' };
  if (g === OTHER) return { name: 'Chats not loaded now', ico: 'message', title: 'Summary lines of chats from an app that isn’t loaded' };
  if (!g) return { name: 'No folder', ico: 'message', title: 'Chats that didn’t start in a folder' };
  return { name: g, ico: 'folder', title: path || g };
}

/** A day's folders: name ('' for none) → {ms: their ≈time together, folder: the full path}. */
const foldersOf = (app, row) => new Map(folderGroups(app.view, row).map((g) => [g.items[0].project || '', g]));

function head(cols) {
  return [h('colgroup', null, cols.map(([, cls]) => h('col', { class: cls }))),
    h('thead', null, h('tr', null, cols.map(([name, cls]) => h('th', { class: cls, scope: 'col' }, name))))];
}

/**
 * @param {object} app the journal's app() view
 * @param {Array<{key, row}>} days  in order; `row` null on a day without chats
 * @param {object} opts {saved: key → saved day (filtered for the screen), group: 'day' | 'folder',
 *   weekRecap: monday → text|null, weekOf: key → monday, showEmpty: list days without chats too,
 *   total: the folder grouping's last row ('Week total', 'Month total')}
 */
export function sheetGrid(app, days, opts) {
  const table = opts.group === 'folder' ? folderTable(app, days, opts) : dayTable(app, days, opts);
  return h('div', { class: 'sheet-wrap', role: 'region', 'aria-label': 'Sheet', tabindex: '0' }, table);
}

/** Group by Date: each day a band, its folders as sub-heads, then its tasks. */
function dayTable(app, days, { saved, weekRecap = () => null, weekOf, showEmpty = true }) {
  const table = h('table', { class: 'sheet is-days' }, head(DAY_COLS));
  let week = null;
  let weekMs = 0;
  let weekTasks = 0;
  let weekDays = 0;
  let shown = [];  // the week's days on this sheet (a month cuts its first and last week)
  const closeWeek = () => {
    if (!week || !weekDays) return;  // a week with no chats gets no footer
    const recap = weekRecap(week);
    const whole = shown.length >= 7;
    table.append(h('tbody', { class: 'sheet-week-foot' },
      recap ? h('tr', { class: 'is-recap' }, h('td', { colspan: '4' }, h('span', { class: 'recap-label' }, 'Week recap'), recapView(recap, '', { headings: false }))) : null,
      h('tr', { class: 'is-total' },
        h('td', { colspan: '3', title: whole ? null : 'Only the days of this week that are in this month' },
          `${whole ? 'Week total' : `${fmtDM(shown[0])}–${fmtDM(shown[shown.length - 1])}`} · ${plural(weekDays, 'day')} · ${plural(weekTasks, 'task')}`),
        h('td', { class: 'c-dur' }, fmtDuration(weekMs)))));
  };
  for (const { key, row } of days) {
    const wk = weekOf(key);
    if (wk !== week) {
      closeWeek();
      week = wk;
      weekMs = 0;
      weekTasks = 0;
      weekDays = 0;
      shown = [];
    }
    shown.push(key);
    if (!row) {
      if (showEmpty) table.append(h('tbody', { class: 'sheet-day is-empty' }, dayBand(app, key, null, 0)));
      continue;
    }
    const rows = sheetRows(row, saved(key));
    weekDays += 1;
    weekMs += row.totalMs;
    weekTasks += rows.length;
    const folders = foldersOf(app, row);
    const body = h('tbody', { class: `sheet-day${key === todayKey() ? ' is-today' : ''}` }, dayBand(app, key, row, rows.length));
    let group;
    rows.forEach((r, i) => {
      const g = groupOf(r);
      if (g !== group) {
        group = g;
        body.append(foldRow(g, folders.get(g), rows.filter((x) => groupOf(x) === g)));
      }
      body.append(taskRow(app, key, r, r.n));
    });
    body.append(addRow(app, key));
    table.append(body);
  }
  closeWeek();
  return table;
}

/** A day's band: its date, ≈time, first–last and tasks, and Open day. */
function dayBand(app, key, row, tasks) {
  return h('tr', { class: 'sheet-dayrow' }, h('th', { colspan: '4', scope: 'rowgroup' }, h('div', { class: 'sheet-band' },
    h('span', { class: 'sheet-date' }, h('b', null, fmtWd(key)), ` ${fmtDM(key)}`),
    key === todayKey() ? h('span', { class: 'tag is-new' }, 'Today') : null,
    h('span', { class: 'band-meta' }, row ? `${fmtDuration(row.totalMs)} · ${fmtClock(row.from)}–${fmtClock(row.to)} · ${plural(tasks, 'task')}` : 'No chats'),
    row ? h('button', { type: 'button', class: 'sheet-link band-end', title: 'Open this day', onclick: () => app.go(`#/day/${key}`) },
      h('span', null, 'Open day'), icon('arrow-right', 13)) : null)));
}

/** A folder's sub-head inside a day: the folder, the apps of its chats, their ≈time together. */
function foldRow(g, folder, rows) {
  const { name, ico, title } = groupLabel(g, folder && folder.folder);
  const sources = [...new Set(rows.filter((r) => r.item).map((r) => r.item.source))];
  return h('tr', { class: 'sheet-fold' },
    h('td', { colspan: '3' }, h('span', { class: 'fold', title }, icon(ico, 15), h('span', { class: 'fold-name' }, name),
      sources.length ? h('span', { class: 'marks' }, sources.map((s) => appMark(s))) : null)),
    h('td', { class: 'c-dur' }, folder ? fmtDuration(folder.ms) : ''));
}

/**
 * One task: its number and text; on a chat's first line its app (opens the
 * chat) and ≈time — its other lines leave those cells empty. `lead` starts
 * the row (the folder grouping's day cell).
 */
function taskRow(app, key, r, n, lead = null) {
  const it = r.chatFirst ? r.item : null;
  return h('tr', { class: [r.pending && 'is-pending', r.manual && 'is-manual'].filter(Boolean).join(' ') || null },
    lead,
    h('td', { class: 'c-n' }, String(n)),
    r.edit ? editableTask(app, key, r)
      : h('td', { class: 'c-task is-muted', title: 'Not in the summary yet — summarize the day to write its lines' },
        r.item ? r.item.title : r.text, h('span', { class: 'sheet-pending' }, ' · not summarized yet')),
    h('td', { class: 'c-app' }, it ? h('button', {
      type: 'button', class: 'sheet-link', title: `Open “${it.title}”`,
      onclick: () => app.openSession(it.sessionId, { day: key, part: 'day' }),
    }, appMark(it.source), h('span', { class: 'app-short' }, appOf(it.source).short)) : ''),
    h('td', { class: 'c-dur' }, it ? fmtDuration(it.ms) : ''));
}

/** Group by Folder: each folder once for the week or month, busiest first, its days down the left. */
function folderTable(app, days, { saved, total = 'Week total' }) {
  const table = h('table', { class: 'sheet is-folders' }, head(FOLDER_COLS));
  const groups = new Map();  // group → {g, ms, tasks, path, days: [{key, rows}]}
  let allMs = 0;
  let allTasks = 0;
  let active = 0;
  for (const { key, row } of days) {
    if (!row) continue;
    const rows = sheetRows(row, saved(key));
    const folders = foldersOf(app, row);
    active += 1;
    allMs += row.totalMs;
    allTasks += rows.length;
    for (const r of rows) {
      const g = groupOf(r);
      if (!groups.has(g)) groups.set(g, { g, ms: 0, tasks: 0, path: null, days: [] });
      const e = groups.get(g);
      if (!e.days.length || e.days[e.days.length - 1].key !== key) {
        e.days.push({ key, rows: [] });
        const f = folders.get(g);
        if (f && g !== OTHER && g !== MINE) {
          e.ms += f.ms;
          e.path = e.path || f.folder;
        }
      }
      e.days[e.days.length - 1].rows.push(r);
      e.tasks += 1;
    }
  }
  const rank = (e) => (e.g === MINE ? 3 : e.g === OTHER ? 2 : e.g === '' ? 1 : 0);
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.ms - a.ms);
  if (!list.length) {
    table.append(h('tbody', { class: 'sheet-none' }, h('tr', null, h('td', { colspan: '5', class: 'is-muted' }, 'No chats'))));
    return table;
  }
  for (const e of list) {
    const { name, ico, title } = groupLabel(e.g, e.path);
    const body = h('tbody', { class: 'sheet-proj' }, h('tr', { class: 'sheet-projrow' }, h('th', { colspan: '5', scope: 'rowgroup' }, h('div', { class: 'sheet-band' },
      h('span', { class: 'proj-name', title }, icon(ico, 18), h('span', { class: 'fold-name' }, name)),
      h('span', { class: 'band-meta' }, `${plural(e.days.length, 'day')} · ${plural(e.tasks, 'task')}`),
      e.ms ? h('span', { class: 'band-end proj-total' }, fmtDuration(e.ms)) : null))));
    let n = 1;
    e.days.forEach(({ key, rows }, d) => {
      const today = key === todayKey();
      rows.forEach((r, i) => {
        const day = h('td', { class: `c-day${today ? ' is-today' : ''}` }, i ? null : h('button', {
          type: 'button', class: 'sheet-link', title: 'Open this day', onclick: () => app.go(`#/day/${key}`),
        }, h('b', null, fmtWd(key)), h('span', null, fmtDM(key))));
        const tr = taskRow(app, key, r, n++, day);
        if (d && !i) tr.classList.add('is-daystart');  // a new day inside the folder
        body.append(tr);
      });
    });
    table.append(body);
  }
  table.append(h('tbody', { class: 'sheet-week-foot' }, h('tr', { class: 'is-total' },
    h('td', { colspan: '4' }, `${total} · ${plural(active, 'day')} · ${plural(allTasks, 'task')}`),
    h('td', { class: 'c-dur' }, fmtDuration(allMs)))));
  return table;
}

/** Group by: Date (each day, then its folders) or Folder (each folder, then its days). Remembered.
 *  "Date", not "Day": the top bar's Day already means the day's page. */
export function sheetGroupSwitch(app) {
  const group = app.state.prefs.sheetGroup;
  return h('div', { class: 'sheet-tools' },
    h('span', { class: 'seg-label' }, 'Group by'),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Group the sheet by' },
      [['day', 'Date'], ['folder', 'Folder']].map(([id, label]) => h('button', {
        type: 'button', class: `seg-btn${group === id ? ' is-on' : ''}`, 'aria-pressed': String(group === id),
        'data-focus': `sheet-group-${id}`, onclick: () => app.setSheetGroup(id),
      }, label))));
}

/** The text of an editable cell, tidied to one line. */
const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const originals = new WeakMap();  // editable text → what it held when you clicked into it

/**
 * A task cell you can type in: saves on Enter or leaving it; Esc puts it
 * back. The text is its own editable span, so the row's buttons stay out
 * of the editing. `id` names the cell so a redraw can put you back in it.
 */
function editCell(text, onSave, { placeholder = '', id, extra = null } = {}) {
  const field = h('span', { class: 'sheet-text', contenteditable: 'plaintext-only', spellcheck: 'true', role: 'textbox',
    'data-placeholder': placeholder, 'data-cell': id, 'aria-label': placeholder || 'Task' });
  field.textContent = text;
  originals.set(field, text);
  field.addEventListener('focus', () => originals.set(field, field.textContent));
  field.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;  // Enter picks a word in an input method; it doesn't save
    if (e.key === 'Enter') { e.preventDefault(); field.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();  // only the edit is undone; nothing else closes
      field.textContent = originals.get(field);
      field.blur();
    }
  });
  field.addEventListener('paste', plainPaste);
  field.addEventListener('blur', () => {
    const now = tidy(field.textContent);
    if (now !== tidy(originals.get(field))) onSave(now, field);
  });
  return h('td', { class: 'c-task is-edit' }, field, extra);
}

/** Paste only text, on one line (the sheet's cells). */
export function plainPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
}

/** Is this an editable cell you clicked into but haven't changed? */
export function cellUnchanged(el) {
  return !!(el && el.dataset && el.dataset.cell && originals.has(el) && tidy(el.textContent) === tidy(originals.get(el)));
}

/** Put the caret back in the cell `id` (at its end) after a redraw. */
export function focusCell(root, id) {
  const field = root && [...root.querySelectorAll('[data-cell]')].find((el) => el.dataset.cell === id);
  if (!field) return;
  field.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function editableTask(app, key, r) {
  let edit = r.edit;  // follows the saved text, so a later edit finds its line
  const save = async (text, field) => {
    if (!text && !window.confirm('Remove this row?')) {
      field.textContent = edit.kind === 'line' ? edit.text : r.text;
      return;
    }
    const ok = await app.editSheetRow(key, edit, text);
    if (ok && text && edit.kind === 'line') edit = { ...edit, text };
    if (ok) originals.set(field, field.textContent);
  };
  const del = h('button', { type: 'button', class: 'sheet-del', 'aria-label': 'Remove this row', title: 'Remove this row',
    onmousedown: (e) => e.preventDefault(),
    onclick: async () => { if (window.confirm('Remove this row?')) await app.editSheetRow(key, edit, ''); } }, icon('x', 13));
  const id = edit.kind === 'line' ? `${key}|l|${edit.chatId}|${edit.text}` : `${key}|m|${edit.id}`;
  return editCell(r.text, save, { id, extra: del });
}

/** The last row of a day: type a task of your own. */
function addRow(app, key) {
  const cell = editCell('', async (text, field) => {
    if (!text) return;
    const ok = await app.addSheetRow(key, text);
    // Saved: empty again (until the redraw shows the new row), so it's never added twice.
    if (ok && tidy(field.textContent) === text) {
      field.textContent = '';
      originals.set(field, '');
    }
  }, { placeholder: 'Add a row…', id: `${key}|add` });
  return h('tr', { class: 'is-add' }, h('td', { class: 'c-n' }, icon('plus', 12)), cell, h('td', { class: 'c-app' }), h('td', { class: 'c-dur' }));
}

/** The note under the sheet: what's editable, and where edits go. */
export function sheetNote(group = 'day') {
  return h('p', { class: 'sheet-note' }, icon('info', 14), h('span', null,
    group === 'folder'
      ? 'Each folder once, busiest first, with the days you worked in it. Click a task to edit it, as by Date; to add a row of your own, group by Date. '
        + 'Copy rows and CSV give the day-by-day rows either way.'
      : 'Click a task to edit it — Enter or click away saves, Esc undoes, an empty cell is removed. Your edits and rows are saved with the day, '
        + 'kept by Add new, and a Rewrite keeps the version it replaces on the Summaries page. Select cells and copy to paste into any spreadsheet.'));
}
