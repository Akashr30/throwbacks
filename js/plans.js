// plans.js — how the app groups the AI tools it reads. Each app (a
// session's source) belongs to the plan whose usage limits it shares —
// Claude: Claude Code, Cowork, claude.ai · Copilot: VS Code, Copilot CLI ·
// Cursor · ChatGPT: Codex · Google AI: Antigravity — and a filter on a plan,
// or on one app, narrows every page. Codex and Antigravity have no chat
// reader yet: their plans show when the usage meter has their numbers.
// Also the day helpers the journal needs: weeks, the day Today opens on,
// a day's sessions grouped by folder with their merged ≈time, and a saved
// summary narrowed to the chats on screen; how the Sessions page sorts and
// sections its chats; the saved view settings. Pure, no DOM.

import { dateKey, keyToDate } from './util.js';
import { blocksDuration, mergeBlocks } from './time.js';

/** Every app, keyed by session source, with the plan whose limits it uses. */
export const APPS = {
  code: { name: 'Claude Code', short: 'Code', plan: 'claude', icon: 'claude', glyph: 'terminal' },
  cowork: { name: 'Cowork', short: 'Cowork', plan: 'claude', icon: 'claude', glyph: 'briefcase' },
  web: { name: 'claude.ai', short: 'claude.ai', plan: 'claude', icon: 'claude', glyph: 'globe' },
  copilot: { name: 'Copilot in VS Code', short: 'VS Code', plan: 'copilot', icon: 'copilot', glyph: 'code' },
  'copilot-cli': { name: 'Copilot CLI', short: 'Copilot CLI', plan: 'copilot', icon: 'copilot', glyph: 'terminal' },
  cursor: { name: 'Cursor', short: 'Cursor', plan: 'cursor', icon: 'cursor', glyph: 'code' },
  codex: { name: 'Codex', short: 'Codex', plan: 'chatgpt', icon: 'chatgpt', glyph: 'terminal' },
  antigravity: { name: 'Antigravity', short: 'Antigravity', plan: 'google', icon: 'antigravity', glyph: 'code' },
};
const OTHER = { name: 'Other', short: 'Other', plan: 'other', glyph: 'message' };

/** Plans in a fixed order. */
export const PLANS = [
  { id: 'claude', name: 'Claude', apps: ['code', 'cowork', 'web'] },
  { id: 'copilot', name: 'Copilot', apps: ['copilot', 'copilot-cli'] },
  { id: 'cursor', name: 'Cursor', apps: ['cursor'] },
  { id: 'chatgpt', name: 'ChatGPT', apps: ['codex'] },
  { id: 'google', name: 'Google AI', apps: ['antigravity'] },
];

export const appOf = (source) => APPS[source] || OTHER;
export const planById = (id) => PLANS.find((p) => p.id === id) || null;

/** The plans that have at least one of these sessions — or, with `usage`
 *  ({plan id: anything}), something the usage meter knows — in order. */
export function plansPresent(sessions, usage = null) {
  const plans = new Set(sessions.map((s) => appOf(s.source).plan));
  for (const id of Object.keys(usage || {})) plans.add(id);
  return PLANS.filter((p) => plans.has(p.id));
}

/** A tool filter, normalized: {plan: null} is every tool; an app needs its plan. */
export function normalizeFilter(f) {
  const plan = f && planById(f.plan) ? f.plan : null;
  const app = plan && f.app && APPS[f.app] && APPS[f.app].plan === plan ? f.app : null;
  return { plan, app };
}

/** A filter as a short stable key ('' = every tool). */
export const filterKey = (f) => (f && f.plan ? `${f.plan}${f.app ? `/${f.app}` : ''}` : '');

/** Does a session pass the filter? */
export function matcher(f) {
  const { plan, app } = normalizeFilter(f);
  if (!plan) return () => true;
  return (s) => appOf(s.source).plan === plan && (!app || s.source === app);
}

/** "Copilot apps" / "Copilot CLI" / '' — what a filter shows, in words. */
export function filterLabel(f) {
  const { plan, app } = normalizeFilter(f);
  if (!plan) return '';
  return app ? APPS[app].name : `${planById(plan).name} apps`;
}

// ---------------------------------------------------------------------------
// Days and weeks (local dates, "YYYY-MM-DD")
// ---------------------------------------------------------------------------

export function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateKey(d.getTime());
}

/** The Monday of a day's week. */
export function mondayOf(key) {
  return addDays(key, -((keyToDate(key).getDay() + 6) % 7));
}

/** The seven days of a week, from its Monday. */
export const weekKeys = (monday) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));

/** Whole days from one key to another (positive when `to` is later). */
export const daysBetween = (from, to) => Math.round((keyToDate(to) - keyToDate(from)) / 864e5);

/**
 * The day Today opens on: today when it has chats, else the last active day
 * before it (so the first screen is never empty), else the latest one.
 */
export function homeDay(dayKeys, today) {
  if (dayKeys.includes(today)) return { key: today, moved: false };
  const before = dayKeys.filter((k) => k < today);
  const key = before.length ? before[before.length - 1] : dayKeys[dayKeys.length - 1] || today;
  return { key, moved: key !== today };
}

/** The active day before / after `key` (or null). */
export function stepDay(dayKeys, key, dir) {
  if (dir < 0) {
    for (let i = dayKeys.length - 1; i >= 0; i--) if (dayKeys[i] < key) return dayKeys[i];
    return null;
  }
  return dayKeys.find((k) => k > key) || null;
}

// ---------------------------------------------------------------------------
// One day's sessions
// ---------------------------------------------------------------------------

/** ≈time of several sessions on one day, parallel work counted once. */
export function unionMs(model, ids, key) {
  return blocksDuration(mergeBlocks(ids.map((id) => {
    const s = model.getSession(id);
    return (s && s.dayBlocks && s.dayBlocks.get(key)) || [];
  })));
}

/**
 * A Daily log row's sessions (log.js buildDailyLog) grouped by the folder
 * each started in: [{name, folder, items, ms}], in the order the groups'
 * first sessions started, chats without a folder last.
 */
export function folderGroups(model, row) {
  const groups = new Map();
  for (const it of row.items) {
    const s = model.getSession(it.sessionId);
    const name = (s && s.project) || 'No folder';
    if (!groups.has(name)) groups.set(name, { name, folder: s && s.project ? s.startDir : null, items: [] });
    groups.get(name).items.push(it);
  }
  const list = [...groups.values()];
  for (const g of list) g.ms = unionMs(model, g.items.map((it) => it.sessionId), row.key);
  return list.sort((a, b) => (a.folder ? 0 : 1) - (b.folder ? 0 : 1));
}

/** A saved day summary narrowed to the chats on this row (others hidden). */
export function filteredSaved(saved, row) {
  if (!saved || !saved.chats) return saved;
  const ids = new Set(row.items.map((it) => it.sessionId));
  return { ...saved, chats: Object.fromEntries(Object.entries(saved.chats).filter(([id]) => ids.has(id))) };
}

/**
 * A conversation's messages by day, for drawing: [{day, messages}] in the
 * order the days are shown — oldest first, or the newest day on top. Inside
 * a day, messages always stay in reading order (a question above its answer).
 */
export function dayGroups(messages, newestFirst = false) {
  const groups = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.day === m.day) last.messages.push(m);
    else groups.push({ day: m.day, messages: [m] });
  }
  return newestFirst ? groups.reverse() : groups;
}

/**
 * Is this folder open in Sessions → Folder? Folders that hold other
 * folders start open and the rest closed, so the page shows the paths and
 * not every session; what you opened or closed wins (`saved`: path →
 * true/false); while you filter, everything is open so matches show.
 */
export function folderIsOpen(path, hasSubfolders, saved, filtering = false) {
  if (filtering) return true;
  const v = saved && Object.prototype.hasOwnProperty.call(saved, path) ? saved[path] : undefined;
  return typeof v === 'boolean' ? v : !!hasSubfolders;
}

// ---------------------------------------------------------------------------
// The Sessions page
// ---------------------------------------------------------------------------

/** A quick chat: a question and its answer, a few minutes at most (a folder folds them into one line). */
export const isQuick = (s) => s.msgCount <= 2 && s.totalMs < 5 * 60e3;

export const GOING_DAYS = 14;
export const NO_MARKS = Object.freeze({ pinned: Object.freeze({}), archived: Object.freeze({}) });
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** A slash command as you typed it ("/model opus"), not a path ("/Users/…") or a question. */
const SLASH = /^\/[a-z][\w:-]*(\s|$)/i;
/** Nothing typed but commands ("/model"), or nothing of yours at all: not a chat to pick up. */
const onlyCommands = (s) => !s.messages.some((m) => m.sender === 'human' && !SLASH.test(m.text.trim()));
/** A branched chat's copies start with the same message of yours, at the same moment. */
const branchKey = (s) => {
  const m = s.messages.find((x) => x.sender === 'human');
  return m ? `${s.source}\n${m.ts}\n${m.text}` : `id\n${s.id}`;
};
/** Archived, and not worked on since (its own last time then, so a chat's clock is only compared with itself). */
export const isArchived = (s, marks) => own(marks.archived, s.id) && !(s.lastTs > marks.archived[s.id].last);

/**
 * Still going: chats you came back to on another day and worked on in the
 * last two weeks, and the ones you pinned (they stay until you unpin them;
 * your pin beats every rule below) — pinned first, then newest first. Left
 * out: a chat of only commands, and a branched chat's other copies (one card
 * per chat: the pinned one, else the newest). What you archived goes to `archived` (newest archived first)
 * until you work on it again — or, once quiet, two weeks after you archived
 * it — and its copies stay out with it unless one was worked on since.
 * `marks`: {pinned: {id: when}, archived: {id: {at, last, pin?}}}.
 * @returns {{going: object[], archived: object[]}}
 */
export function stillGoing(sessions, today, marks = NO_MARKS) {
  const from = addDays(today, -(GOING_DAYS - 1));
  const recent = (ts) => dateKey(ts) >= from;
  const pinned = (s) => own(marks.pinned, s.id);
  const shelved = (s) => isArchived(s, marks);
  const live = (s) => !shelved(s) && (pinned(s) || (s.dayKeys.length > 1 && recent(s.lastTs)));
  const groups = new Map();
  for (const s of sessions) {
    if ((onlyCommands(s) && !pinned(s)) || !(live(s) || (shelved(s) && (recent(marks.archived[s.id].at) || (s.dayKeys.length > 1 && recent(s.lastTs)))))) continue;
    const k = branchKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const rank = (a, b) => (pinned(b) - pinned(a)) || b.lastTs - a.lastTs;
  const going = [];
  const archived = [];
  for (const copies of groups.values()) {
    const pins = copies.filter((s) => pinned(s) && !shelved(s));
    if (pins.length) {  // you pinned it: it shows (and stands for its copies)
      going.push(...pins);
      continue;
    }
    const shelf = copies.filter(shelved).sort((a, b) => marks.archived[b.id].at - marks.archived[a.id].at)[0];
    if (shelf && !copies.some((s) => s !== shelf && !shelved(s) && s.lastTs > marks.archived[shelf.id].at)) archived.push(shelf);
    else {
      const card = copies.filter(live).sort(rank)[0];
      if (card) going.push(card);
    }
  }
  return { going: going.sort(rank), archived: archived.sort((a, b) => marks.archived[b.id].at - marks.archived[a.id].at) };
}

export const MARKS_MAX = 1000;  // pins, and archives, kept (the oldest go first)

/** Saved pins and archives, checked: {pinned: {id: when}, archived: {id: {at, last, pin?}}} (pin: when it was pinned, for Restore). */
export function marksOf(v) {
  const out = { pinned: {}, archived: {} };
  if (!v || typeof v !== 'object') return out;
  const id = (k) => typeof k === 'string' && k.length > 0 && k.length <= 400 && !/[\x00-\x1f\x7f]/.test(k);
  const num = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e15;  // as serve.py's _mark_time
  for (const [k, at] of Object.entries(v.pinned && typeof v.pinned === 'object' ? v.pinned : {})) if (id(k) && num(at)) out.pinned[k] = at;
  for (const [k, a] of Object.entries(v.archived && typeof v.archived === 'object' ? v.archived : {})) {
    if (id(k) && a && num(a.at) && num(a.last) && !own(out.pinned, k)) out.archived[k] = num(a.pin) ? { at: a.at, last: a.last, pin: a.pin } : { at: a.at, last: a.last };
  }
  return out;
}

/**
 * One change to the marks (a new object; serve.py's apply_mark does the
 * same): {id, pin: true|false} or {id, archive: {last}|null}. Pinning
 * restores an archived chat; archiving unpins it, and Restore (archive:
 * null) pins it again if it was pinned. Null for a bad change.
 */
export function applyMark(marks, op, now) {
  const m = marksOf(marks);
  if (!op || typeof op.id !== 'string' || !op.id || op.id.length > 400 || /[\x00-\x1f\x7f]/.test(op.id)) return null;
  const cap = (o, at) => Object.fromEntries(Object.entries(o).sort((a, b) => at(a[1]) - at(b[1])).slice(-MARKS_MAX));
  if (typeof op.pin === 'boolean') {
    delete m.pinned[op.id];
    if (op.pin) {
      m.pinned[op.id] = now;
      delete m.archived[op.id];
    }
  } else if (op.archive === null) {
    const was = m.archived[op.id];
    delete m.archived[op.id];
    if (was && was.pin !== undefined) m.pinned[op.id] = was.pin;
  } else if (op.archive && typeof op.archive.last === 'number' && Number.isFinite(op.archive.last) && op.archive.last >= 0 && op.archive.last < 1e15) {
    m.archived[op.id] = own(m.pinned, op.id) ? { at: now, last: op.archive.last, pin: m.pinned[op.id] } : { at: now, last: op.archive.last };
    delete m.pinned[op.id];
  } else return null;
  return { pinned: cap(m.pinned, (at) => at), archived: cap(m.archived, (a) => a.at) };
}

export const QUIET_DAYS = 90;  // a folder with nothing newer folds under "N quieter folders"

/** Sessions → Date: this week, the rest of this month, then one band per month. */
export function dateBand(key, today) {
  const monday = mondayOf(today);
  if (key >= monday) return { id: 'week', kind: 'week', at: monday };
  const month = key.slice(0, 7);
  return { id: month, kind: month === today.slice(0, 7) ? 'rest' : 'month', at: month };
}

/** "/Users/me/Dev/app" → "~/Dev/app" (a Mac's or Linux's home folder). */
export const homeShort = (path) => path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');

/**
 * Sessions → Folder in sections. A folder at the top of the tree that holds
 * only folders is a label over them (~/Dev, with its projects as the rows),
 * and a folder of only such folders hands them down (~ → ~/Dev, ~/Work);
 * what's left goes Elsewhere, such as your home folder's own chats (`alone`:
 * the folder without its subfolders, which became sections).
 * `own(node)` / `total(node)`: how many of the chats listed are in the
 * folder itself / in it or below it.
 * @returns {{sections: Array<{node, rows}>, elsewhere: Array<{node, alone}>}}
 */
export function treeSections(roots, own, total) {
  const sections = [];
  const elsewhere = [];
  const kidsOf = (n) => n.children.filter((c) => total(c));
  const container = (n) => !own(n) && kidsOf(n).length > 0;
  const place = (n) => {
    const kids = kidsOf(n);
    if (kids.every(container)) kids.forEach(place);
    else sections.push({ node: n, rows: kids });
  };
  for (const root of roots.filter((r) => total(r))) {
    const kids = kidsOf(root);
    if (container(root)) place(root);
    else if (kids.some(container)) {
      elsewhere.push({ node: root, alone: true });
      for (const k of kids) if (container(k)) place(k); else elsewhere.push({ node: k, alone: false });
    } else elsewhere.push({ node: root, alone: false });
  }
  return { sections, elsewhere };
}

// ---------------------------------------------------------------------------
// How pages are shown (localStorage `throwbacks-view`; never any chat data)
// ---------------------------------------------------------------------------

export const VIEW_VERSION = 2;
export const FOLDERS_MAX = 400;  // folders (and their folds) remembered as opened or closed

/**
 * Saved view settings, checked, over the defaults. Saves store every
 * setting, defaults included, so a save from before v2 (when Sessions
 * opened by Date and had Group by Tool) opens Sessions by Folder.
 */
export function viewPrefs(v) {
  const d = { v: VIEW_VERSION, group: 'folder', sheetGroup: 'day', auto: true, autoSummary: { on: true, at: '19:00' }, folders: {}, order: 'oldest', summaryOff: [] };
  if (!v || typeof v !== 'object') return d;
  if (v.v === VIEW_VERSION && v.group === 'date') d.group = 'date';
  if (v.sheetGroup === 'folder') d.sheetGroup = 'folder';  // Week / Month: each folder, then its days
  if (v.auto === false) d.auto = false;
  if (v.order === 'newest') d.order = 'newest';  // a conversation's days: newest on top
  if (v.autoSummary && typeof v.autoSummary === 'object') {
    if (typeof v.autoSummary.on === 'boolean') d.autoSummary.on = v.autoSummary.on;
    if (/^\d{2}:\d{2}$/.test(v.autoSummary.at || '')) d.autoSummary.at = v.autoSummary.at;
  }
  // AI summaries: the apps whose chats are never sent to the summarizer (Settings → AI summaries).
  if (Array.isArray(v.summaryOff)) d.summaryOff = [...new Set(v.summaryOff.filter((id) => typeof id === 'string' && APPS[id]))];
  // Sessions → Folder: the folders (and folds) you opened or closed (key → true/false).
  if (v.folders && typeof v.folders === 'object') {
    for (const [k, on] of Object.entries(v.folders).slice(-FOLDERS_MAX)) {
      if (typeof on === 'boolean' && k.length <= 1024) d.folders[k] = on;
    }
  }
  return d;
}

/** The share of a plan's tightest limit that's used, or null. */
export function planPct(usage) {
  return usage && usage.windows && usage.windows.length ? Math.max(...usage.windows.map((w) => w.pct)) : null;
}
