// log.js — the sheet of what you worked on each day: every active day (its
// ≈time, from–to, and every chat that day, in the order they started),
// grouped into Monday-first weeks, built from the loaded chats alone; the
// sheet's rows (one per task, by folder — a day's summary lines, the rows
// you added, or its chats until it's summarized); editing those rows; the bookkeeping
// for the AI summaries (what a day's saved summary covers, what's new
// since, folding new lines in, the version a Rewrite replaces); and the
// text behind Copy rows (tab-separated) and the CSV. Pure, no DOM, no
// network — the AI calls are in summarize.js, the files in logstore.js.

import { dateKey, keyToDate, fmtDayMed, fmtTime, sourceLabel } from './util.js';
import { fmtDuration } from './time.js';

/** The Monday of a day's week, as a day key. */
export function weekOf(key) {
  const d = keyToDate(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateKey(d.getTime());
}

/** [start, end) of a local day in ms (a day is 23 or 25 h when clocks change). */
function dayBounds(key) {
  const start = keyToDate(key);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

/** One chat's part of a day: when it was active, for how long, and what was asked first. */
function itemFor(session, key) {
  const [dayStart, dayEnd] = dayBounds(key);
  const msgs = session.messages.filter((m) => m.day === key);
  // Activity blocks include tool work between your messages; clip them to the day.
  let from = Infinity;
  let to = -Infinity;
  for (const b of session.blocks) {
    if (b.end <= dayStart || b.start >= dayEnd) continue;
    from = Math.min(from, Math.max(b.start, dayStart));
    to = Math.max(to, Math.min(b.end, dayEnd));
  }
  if (from === Infinity && msgs.length) {
    from = msgs[0].ts;
    to = msgs[msgs.length - 1].ts;
  }
  const asked = msgs.find((m) => m.sender === 'human');
  return {
    sessionId: session.id,
    title: session.title,
    source: session.source,
    project: session.project || '',
    ms: session.dayMs.get(key) || 0,
    msgs: msgs.length,
    prompt: asked ? asked.text.replace(/\s+/g, ' ').trim() : '',
    firstMsgId: msgs.length ? msgs[0].id : null,
    from: from === Infinity ? dayStart : from,
    to: to === -Infinity ? dayStart : to,
  };
}

/**
 * Every active day, oldest first, grouped into weeks:
 * [{ week (its Monday's key), totalMs, chats (distinct), days: [{ key,
 *   totalMs, from, to, items: [{ sessionId, title, source, project, ms,
 *   msgs, prompt, firstMsgId, from, to }] }] }]
 */
export function buildDailyLog(model) {
  const weeks = [];
  for (const key of model.dayKeys) {
    const day = model.getDay(key);
    const items = [...day.sessionIds]
      .map((id) => model.getSession(id))
      .filter(Boolean)
      .map((s) => itemFor(s, key))
      .sort((a, b) => a.from - b.from || a.title.localeCompare(b.title));
    const row = {
      key,
      totalMs: day.totalMs,
      from: Math.min(...items.map((i) => i.from)),
      to: Math.max(...items.map((i) => i.to)),
      items,
    };
    const week = weekOf(key);
    let w = weeks[weeks.length - 1];
    if (!w || w.week !== week) {
      w = { week, totalMs: 0, chats: 0, days: [], ids: new Set() };
      weeks.push(w);
    }
    w.days.push(row);
    w.totalMs += row.totalMs;
    for (const it of items) w.ids.add(it.sessionId);
    w.chats = w.ids.size;
  }
  for (const w of weeks) delete w.ids;
  return weeks;
}

const DEFAULT_FMT = {
  date: (key) => fmtDayMed(key),
  time: (ts) => fmtTime(ts),
  duration: (ms) => fmtDuration(ms),
};

/** "≈2h 10m · 09:12–18:40" */
export function dayTimeText(day, fmt = DEFAULT_FMT) {
  return `${fmt.duration(day.totalMs)} · ${fmt.time(day.from)}–${fmt.time(day.to)}`;
}

/** One cell of tab-separated text: no tabs or line breaks inside. */
const tsvCell = (s) => String(s).replace(/[\t\r\n]+/g, ' ').trim();

// ---------------------------------------------------------------------------
// The sheet: one row per task.
// ---------------------------------------------------------------------------

/**
 * A day's chats grouped by the folder each started in, as the sheet, Copy
 * rows and the Day page show them: folders in the order their first chat
 * started, chats without a folder last; inside a folder, the day's order.
 */
export function chatsByFolder(items) {
  const groups = new Map();
  for (const it of items) {
    const k = it.project || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1)).flatMap((k) => groups.get(k));
}

/**
 * A day's rows in the sheet, numbered: per chat (by folder, see
 * chatsByFolder) each of its summary lines — editable — or, while the chat
 * isn't summarized, its title (a placeholder, not editable); then lines of
 * chats not loaded now; then the rows you added by hand (editable).
 * [{ n, text, edit: {kind: 'line', chatId, index} | {kind: 'manual', id} | null,
 *    item (the chat that day, or null), chatFirst (its first row), pending }]
 */
export function sheetRows(day, saved) {
  const chats = (saved && saved.chats) || {};
  const rows = [];
  for (const it of chatsByFolder(day.items)) {
    const c = chats[it.sessionId];
    if (c) {
      (c.lines || []).forEach((text, index) => rows.push({ text, edit: { kind: 'line', chatId: it.sessionId, index, text }, item: it, chatFirst: index === 0 }));
    } else if (!(Object.keys(chats).length && !it.msgs)) {  // once summarized, a chat with no text has nothing to add
      rows.push({ text: `${it.title}${it.project ? ` (${it.project})` : ''}`, edit: null, item: it, chatFirst: true, pending: true });
    }
  }
  const loaded = new Set(day.items.map((it) => it.sessionId));
  for (const [chatId, c] of Object.entries(chats)) {
    if (loaded.has(chatId)) continue;
    (c.lines || []).forEach((text, index) => rows.push({ text, edit: { kind: 'line', chatId, index, text }, item: null, chatFirst: index === 0 }));
  }
  for (const m of (saved && saved.manual) || []) rows.push({ text: m.text, edit: { kind: 'manual', id: m.id }, item: null, chatFirst: true, manual: true });
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}

const SHEET_HEAD = ['Date', 'Time', '#', 'Task', 'Folder', 'App', '≈Time'];

/**
 * The sheet as tab-separated rows for pasting into any spreadsheet — the
 * same columns as on screen: Date · Time · # · Task · Folder · App · ≈Time,
 * a header first. The date and the day's time are on its first row, a chat's
 * folder, app and ≈time on its first task. A week's summary, when there is
 * one, ends that week as a row of its own.
 * @param {object} [ai] { days: {key: savedDay}, weeks: {monday: savedWeek} }
 */
export function sheetTsv(days, ai = {}, fmt = DEFAULT_FMT) {
  const out = [SHEET_HEAD.join('\t')];
  const weeks = [];
  days.forEach((day) => {
    const week = weekOf(day.key);
    if (!weeks.includes(week)) weeks.push(week);
    sheetRows(day, ai.days && ai.days[day.key]).forEach((r, i) => {
      const it = r.chatFirst ? r.item : null;
      out.push([
        i ? '' : fmt.date(day.key), i ? '' : dayTimeText(day, fmt), r.n, r.text,
        it ? it.project : '', it ? sourceLabel(it.source) : '', it ? fmt.duration(it.ms) : '',
      ].map(tsvCell).join('\t'));
    });
    const last = days[days.length - 1] === day || weekOf(days[days.indexOf(day) + 1].key) !== week;
    const recap = last && ai.weeks && ai.weeks[week] && ai.weeks[week].text;
    if (recap) out.push(['Week summary', '', '', recapPlain(recap), '', '', ''].map(tsvCell).join('\t'));
  });
  return out.join('\n');
}

/**
 * A CSV cell. Text that a spreadsheet would run as a formula (= + - @, or a
 * leading tab or return) gets a leading apostrophe, so a chat title can
 * never execute in a spreadsheet.
 */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 24-hour "HH:MM" for the CSV, whatever the locale. */
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The sheet as CSV: one row per task, minutes as numbers, 24-hour times,
 *  and what each row is (summary · added by you · not summarized yet). */
export function sheetCsv(days, ai = {}) {
  const head = ['Date', 'Weekday', 'From', 'To', 'Active minutes (day)', '#', 'Task', 'Folder', 'App', 'Chat', 'Minutes in chat', 'Row'];
  const lines = [head.map(csvCell).join(',')];
  for (const day of days) {
    const weekday = keyToDate(day.key).toLocaleDateString('en-US', { weekday: 'short' });
    for (const r of sheetRows(day, ai.days && ai.days[day.key])) {
      const it = r.item;
      lines.push([
        day.key, weekday, hhmm(day.from), hhmm(day.to), Math.round(day.totalMs / 60000), r.n, r.text,
        it ? it.project : '', it ? sourceLabel(it.source) : '', it ? it.title : '', it ? Math.round(it.ms / 60000) : '',
        r.manual ? 'added by you' : r.pending ? 'not summarized yet' : 'summary',
      ].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Editing the sheet. A saved day may also hold:
//   manual: [{ id, text }]     rows you added by hand
//   editedAt                   when you last changed it by hand
//   previous: [{ at, provider, model, chats, manual }]
//                              the versions a Rewrite replaced, newest first (up to 3)
// Each edit returns a new object; an empty text removes the row. A line is
// found by the text the sheet showed (its index first), so an edit made
// after the rows shifted still lands on the right line — or on none.
// ---------------------------------------------------------------------------

/** When a day's summary last changed — written by the AI or edited by you. */
export const dayStamp = (saved) => Math.max((saved && saved.updatedAt) || 0, (saved && saved.editedAt) || 0);

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Change (or, with empty text, remove) one row the sheet shows as editable.
 * Returns null when that row isn't there any more (removed or rewritten
 * since the sheet was drawn).
 */
export function editSheetRow(saved, dayKey, edit, text, now) {
  const base = saved || { v: 1, date: dayKey, updatedAt: 0, chats: {} };
  const value = clean(text);
  if (edit.kind === 'line') {
    const c = base.chats && base.chats[edit.chatId];
    if (!c || !Array.isArray(c.lines)) return null;
    const at = edit.text === undefined || c.lines[edit.index] === edit.text ? edit.index : c.lines.indexOf(edit.text);
    if (at < 0 || at >= c.lines.length) return null;
    const lines = value ? c.lines.map((l, i) => (i === at ? value : l)) : c.lines.filter((_, i) => i !== at);
    return { ...base, editedAt: now, chats: { ...base.chats, [edit.chatId]: { ...c, lines } } };
  }
  if (edit.kind === 'manual') {
    if (!(base.manual || []).some((m) => m.id === edit.id)) return null;
    const manual = (base.manual || []).flatMap((m) => (m.id !== edit.id ? [m] : value ? [{ ...m, text: value }] : []));
    return { ...base, editedAt: now, manual };
  }
  return base;
}

/**
 * Saved summaries read again from where they're kept, merged with this
 * tab's: per day and per week the newer copy wins (another tab may have
 * written since; this tab may have a save still on its way). Something
 * only in this tab is kept.
 */
export function newerSummaries(mine, disk) {
  const pick = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (!out[k] || dayStamp(v) > dayStamp(out[k])) out[k] = v;
    return out;
  };
  return { ...mine, ...disk, days: pick(mine.days, disk.days), weeks: pick(mine.weeks, disk.weeks),
    months: pick(mine.months, disk.months), periods: pick(mine.periods, disk.periods) };
}

/** Add a row of your own to a day (it survives Add new and Rewrite). */
export function addSheetRow(saved, dayKey, text, now, id) {
  const base = saved || { v: 1, date: dayKey, updatedAt: 0, chats: {} };
  const value = clean(text);
  if (!value) return base;
  return { ...base, editedAt: now, manual: [...(base.manual || []), { id, text: value }] };
}

/** Did you change this day by hand since the AI last wrote it? */
export const editedByHand = (saved) => !!(saved && saved.editedAt && saved.editedAt > (saved.updatedAt || 0));

// ---------------------------------------------------------------------------
// The AI column: what each day's saved summary covers, what's new since,
// and folding fresh lines in. A saved day is
//   { v: 1, date, updatedAt, provider, model,
//     chats: { [sessionId]: { title, upTo, covered, lines: [...] } } }
// where upTo is the time of the last message already summarized in that
// chat that day — later messages are what a refresh sends.
// ---------------------------------------------------------------------------

/** A chat's messages as plain text for the summarizer. */
export function partText(messages) {
  return messages.map((m) => `${m.sender === 'human' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
}

/** A chat's app, from its id ("copilot-cli:…" → "copilot-cli"). */
export const appOfChat = (id) => String(id).slice(0, Math.max(0, String(id).indexOf(':')));

/** Never sent to the summarizer: a chat whose app is in `skip`, or the chat itself (a made-up one). */
const skipped = (skip, id, app = appOfChat(id)) => !!(skip && (skip.has(app) || skip.has(id)));

/**
 * What still needs summarizing for one day: for each chat (in the day's
 * order), its messages that day after the last one already covered, plus
 * the lines written for it so far. With rewrite, everything counts as new.
 * `skip`: apps whose chats are never sent (Settings → AI summaries), and
 * chats that never are (the sample's, next to your real summaries).
 */
export function pendingParts(day, model, saved, { rewrite = false, skip = null } = {}) {
  const parts = [];
  for (const it of day.items) {
    if (skipped(skip, it.sessionId, it.source)) continue;
    const session = model.getSession(it.sessionId);
    if (!session) continue;
    const msgs = session.messages.filter((m) => m.day === day.key);
    const prev = !rewrite && saved && saved.chats ? saved.chats[it.sessionId] : null;
    const fresh = prev ? msgs.filter((m) => m.ts > prev.upTo) : msgs;
    if (!fresh.length) continue;
    parts.push({
      id: it.sessionId,
      title: it.title,
      project: it.project,
      text: partText(fresh),
      earlier: prev ? prev.lines : [],
      upTo: fresh[fresh.length - 1].ts,
      covered: (prev ? prev.covered : 0) + fresh.length,
    });
  }
  return parts;
}

/** A day's AI summary: none yet, current, or stale (new chats or messages since). */
export function daySummaryState(day, model, saved, { skip = null } = {}) {
  const has = saved && saved.chats && Object.keys(saved.chats).length > 0;
  if (!has) return { state: 'none' };
  const pending = pendingParts(day, model, saved, { skip });
  const upTo = Math.max(...Object.values(saved.chats).map((c) => c.upTo || 0));
  return { state: pending.length ? 'stale' : 'current', newChats: pending.length, upTo };
}

/**
 * Fold freshly written lines into a day's summary (a new object). A chat
 * with no result (it failed, or the run was cancelled) keeps its old state,
 * so it shows as still to do. A rewrite replaces the chats it re-did and
 * keeps the rest (e.g. chats from an app that isn't loaded right now).
 */
export function mergeDaySummary(saved, dayKey, parts, results, meta, { rewrite = false } = {}) {
  const chats = { ...(saved && saved.chats ? saved.chats : {}) };
  for (const p of parts) {
    if (!results.has(p.id)) continue;
    const before = !rewrite && chats[p.id] ? chats[p.id].lines : [];
    chats[p.id] = { title: p.title, upTo: p.upTo, covered: p.covered, lines: [...before, ...results.get(p.id)] };
    // Its folder, so a recap can group the day's lines by project even when the chat isn't loaded.
    if (p.project) chats[p.id].project = p.project;
  }
  // Your own rows and edits stay; a Rewrite keeps the version it replaces.
  const next = { ...(saved || {}), v: 1, date: dayKey, updatedAt: meta.now, provider: meta.provider, model: meta.model, chats };
  if (rewrite && saved && saved.chats && Object.keys(saved.chats).length) {
    next.previous = [{ at: dayStamp(saved), provider: saved.provider, model: saved.model, chats: saved.chats, manual: saved.manual || [] },
      ...(saved.previous || [])].slice(0, 3);
  }
  return next;
}

/** A day's summary lines in the sheet's order (by folder, then any chats not
 *  loaded now), and the rows you added. `day`: its row, or null when none of
 *  its chats is loaded. `skip`: chats to leave out (a recap never sends the
 *  lines of an app you left out). */
export function daySummaryLines(day, saved, { skip = null } = {}) {
  return daySummaryGroups(day, saved, { skip }).flatMap((g) => g.lines);
}

/**
 * The same lines, in the same order, under their project: [{project, lines}] — a
 * chat's folder as loaded now, else as saved with its lines; '' for none, null
 * when it isn't known (a chat not loaded, saved before its folder was kept),
 * and 'Added by you' for your own rows. What a recap is written from.
 */
export function daySummaryGroups(day, saved, { skip = null } = {}) {
  if (!saved) return [];
  const chats = saved.chats || {};
  const items = day ? day.items : [];
  const order = (day ? chatsByFolder(items) : []).map((it) => it.sessionId).filter((id) => chats[id]);
  for (const id of Object.keys(chats)) if (!order.includes(id)) order.push(id);
  const groups = [];
  for (const id of order) {
    if (skipped(skip, id)) continue;
    const lines = chats[id].lines || [];
    if (!lines.length) continue;
    const it = items.find((x) => x.sessionId === id);
    const project = it ? it.project || '' : chats[id].project ?? null;
    const last = groups[groups.length - 1];
    if (last && last.project === project) last.lines.push(...lines);
    else groups.push({ project, lines: [...lines] });
  }
  const manual = (saved.manual || []).map((m) => m.text);
  if (manual.length) groups.push({ project: 'Added by you', lines: manual });
  return groups;
}

/**
 * A recap read back as parts: its first line ('head'), each project's name
 * ('group') and its points ('point') — the shape summarize.js asks for — or
 * plain paragraphs ('para'), as recaps written before 2026-11-16 are.
 * @returns {Array<{type: 'head'|'group'|'point'|'para', text: string}>}
 */
export function recapBlocks(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^```/.test(l));
  // A model's preamble ("Here's the week's update:") isn't the recap's line.
  if (lines.length > 1 && /:$/.test(lines[0]) && !/^#|^\*\*/.test(lines[0])) lines.shift();
  // A project's name however it's marked: "## etl", "**etl:**", "## [etl]".
  const name = (s) => s.replace(/^\*\*(.+)\*\*:?$/, '$1').replace(/:$/, '').replace(/^\[(.+)\]$/, '$1').trim();
  const out = [];
  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)$/) || line.match(/^(\*\*[^*]+\*\*:?)$/);
    const point = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (heading) out.push({ type: 'group', text: name(heading[1]) });
    else if (point) out.push({ type: 'point', text: point[1].replace(/\*\*/g, '') });
    else out.push({ type: out.length ? 'para' : 'head', text: line.replace(/\*\*/g, '') });
  }
  // "Still open" with nothing open under it ("- None") says nothing: it goes.
  const kept = [];
  let open = false;
  for (const b of out) {
    if (b.type === 'group') open = /^still open$/i.test(b.text);
    if (!(open && b.type === 'point' && /^(none|nothing|n\/a)\.?$/i.test(b.text))) kept.push(b);
  }
  return kept.filter((b, i) => !(b.type === 'group' && /^still open$/i.test(b.text) && (kept[i + 1] || {}).type !== 'point'));
}

/** A recap as one line of plain text, for a spreadsheet cell: "Line · notes-app: a; b · Still open: c". */
export function recapPlain(text) {
  const parts = [];
  let group = null;
  for (const b of recapBlocks(text)) {
    if (b.type === 'group') { group = { name: b.text, points: [] }; parts.push(group); }
    else if (b.type === 'point' && group) group.points.push(b.text);
    else { group = null; parts.push(b.text); }
  }
  return parts.map((p) => (typeof p === 'string' ? p : `${p.name}: ${p.points.join('; ')}`)).join(' · ');
}

/** A day key `n` days after `key`. */
function shiftDay(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateKey(d.getTime());
}
/** A month's last day ("2026-02" → "2026-02-28"). */
const monthEnd = (month) => dateKey(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getTime());

/**
 * Every summary for the Summaries page, newest first by the day it reaches
 * (never past today): days, recaps — weeks, months, periods, and the older
 * range summaries — and chats (a session's own summary). `ranges`: the saved
 * range and session summaries (summarize-ui.js histAll).
 * @returns {Array<{id, type: 'day'|'week'|'month'|'period'|'range'|'chat', group: 'day'|'recap'|'chat',
 *   key, covers: string, written: number|null, saved?, entry?, usage, sessionId?}>}
 */
export function summaryList(summaries, ranges = [], today = dateKey(Date.now())) {
  const out = [];
  const upTo = (k) => (k > today ? today : k);
  for (const [key, saved] of Object.entries((summaries && summaries.days) || {})) {
    const has = saved && ((saved.chats && Object.values(saved.chats).some((c) => (c.lines || []).length)) || (saved.manual && saved.manual.length));
    if (!has) continue;
    out.push({ id: `day:${key}`, type: 'day', group: 'day', key, covers: key, written: saved.updatedAt || saved.editedAt || null, saved, usage: saved.usage || null });
  }
  for (const [type, bucket] of [['week', 'weeks'], ['month', 'months'], ['period', 'periods']]) {
    for (const [key, saved] of Object.entries((summaries && summaries[bucket]) || {})) {
      if (!saved || !saved.text) continue;
      const end = type === 'week' ? shiftDay(key, 6) : type === 'month' ? monthEnd(key) : key.split('_')[1];
      out.push({ id: `${type}:${key}`, type, group: 'recap', key, covers: upTo(end), written: saved.updatedAt || null, saved, usage: saved.usage || null });
    }
  }
  for (const entry of ranges || []) {
    if (!entry || !entry.id || !Number.isFinite(entry.at)) continue;
    const first = entry.perSession && entry.perSession[0];
    const chat = !!entry.sessionId || /^Session · /.test(entry.rangeLabel || '');
    out.push({
      id: `${chat ? 'chat' : 'range'}:${entry.id}`, type: chat ? 'chat' : 'range', group: chat ? 'chat' : 'recap',
      key: entry.id, covers: dateKey(entry.at), written: entry.at, entry, usage: entry.usage || null,
      sessionId: chat ? entry.sessionId || (first && first.id) || null : null,
    });
  }
  return out.sort((a, b) => (a.covers < b.covers ? 1 : a.covers > b.covers ? -1 : (b.written || 0) - (a.written || 0)));
}

/** The longest period a recap takes: about ten years (the dialog says so). */
export const RECAP_MAX_DAYS = 3660;

/** The days a recap covers: a week's seven, a month's, or a period's from–to (both included). */
export function recapDays(kind, key) {
  const [from, to] = kind === 'week' ? [key, shiftDay(key, 6)] : kind === 'month' ? [`${key}-01`, monthEnd(key)] : String(key).split('_');
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return out;
  for (let k = from; k <= to && out.length < RECAP_MAX_DAYS; k = shiftDay(k, 1)) out.push(k);
  return out;
}

/**
 * A week's recap: none, current, or stale because a day summary changed (or
 * appeared) after it was written. `daySaved` maps day keys to saved days.
 */
export function weekSummaryState(week, daySaved, weekSaved) {
  if (!weekSaved || !weekSaved.text) return { state: 'none' };
  const basis = weekSaved.basedOn || {};
  const changed = week.days.some((d) => daySaved[d.key] && dayStamp(daySaved[d.key]) !== basis[d.key]);
  return { state: changed ? 'stale' : 'current' };
}
