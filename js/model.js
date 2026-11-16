// model.js — builds the in-memory indexes ONCE from parsed sessions and
// exposes query helpers. Per-day and per-session indexes are built in the
// same pass; navigation never re-parses. Pure data, no DOM.

import { buildBlocks, blocksDuration, mergeBlocks } from './time.js';
import { dateKey, truncate, sourceLabel } from './util.js';
import { computeTags, tagSample } from './tags.js';

/**
 * @param {Array<session>} rawSessions normalized sessions from parse.js
 *   (every source, concatenated; duplicate ids collapse to the last one)
 * @returns model with query helpers
 */
export function buildModel(rawSessions) {
  // --- Dedupe by id: the same session must never appear twice. -------------
  const byId = new Map();
  for (const s of rawSessions) {
    if (s && s.id && (s.messages.length || s.activityTs.length)) byId.set(s.id, s);
  }

  const sessions = new Map(); // id -> enriched session
  const days = new Map();     // dateKey -> day record
  let msgSeq = 0;

  const getDayRec = (key) => {
    let d = days.get(key);
    if (!d) {
      d = { key, messages: [], sessionIds: new Set(), sessionBlocks: [], msgCount: 0 };
      days.set(key, d);
    }
    return d;
  };

  for (const raw of byId.values()) {
    const msgs = raw.messages.map((m) => ({
      ...m,
      id: `m${msgSeq++}`,
      sessionId: raw.id,
      day: dateKey(m.ts),
      startDir: raw.startDir || null, // completes relative paths in chips
    }));

    // Group activity timestamps by local date for per-day time scoping.
    const actByDay = new Map();
    for (const ts of raw.activityTs) {
      const k = dateKey(ts);
      if (!actByDay.has(k)) actByDay.set(k, []);
      actByDay.get(k).push(ts);
    }
    // Days the session is "on": any day with a rendered message or activity.
    const dayKeys = new Set(actByDay.keys());
    for (const m of msgs) dayKeys.add(m.day);
    const sortedDayKeys = [...dayKeys].sort();

    const dayMs = new Map();     // dateKey -> estimated ms that day
    const dayBlocks = new Map(); // dateKey -> blocks that day
    for (const k of sortedDayKeys) {
      const blocks = buildBlocks(actByDay.get(k) || msgs.filter((m) => m.day === k).map((m) => m.ts));
      dayBlocks.set(k, blocks);
      dayMs.set(k, blocksDuration(blocks));
    }

    const allTs = raw.activityTs.length ? raw.activityTs : msgs.map((m) => m.ts);
    const lifetimeBlocks = buildBlocks(allTs);
    const first = msgs.length ? msgs[0].ts : Math.min(...allTs);
    const last = msgs.length ? msgs[msgs.length - 1].ts : Math.max(...allTs);
    const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;

    const session = {
      id: raw.id,
      title: raw.title,
      source: raw.source,
      project: raw.project,
      startDir: raw.startDir || null,
      approxTimes: !!raw.approxTimes, // times synthesized (e.g. Cursor)
      touchedAt: raw.touchedAt || null, // Claude Code: when its file was last written (its cleanup goes by this)
      kept: !!raw.kept, // Throwbacks keeps a copy (~/.throwbacks/kept)
      onlyKept: !!raw.onlyKept, // …and Claude Code has deleted the original
      desktop: !!raw.desktop, // started in Claude desktop: Claude Code's cleanup leaves it
      fromServer: !!raw.fromServer, // read through serve.py (so a copy can be kept)
      exportName: raw.exportName || null, // claude.ai: the export file it came from (its name only)
      messages: msgs,
      dayKeys: sortedDayKeys,
      dayMs,
      dayBlocks, // per day, for the union of a few sessions (a folder's ≈time that day)
      firstTs: first,
      lastTs: last,
      lastSnippet: lastMsg ? truncate(lastMsg.text, 90) : '',
      totalMs: blocksDuration(lifetimeBlocks),
      blocks: lifetimeBlocks, // kept for merged-union math across sessions
      msgCount: msgs.length,
      tags: computeTags(tagSample(raw.title, msgs)),
      // Every kind, as Claude Code's own stats count them: input, cache writes, cache reads, output.
      tokens: (raw.tokenEvents || []).reduce(
        (t, e) => ({ i: t.i + e.i, cw: t.cw + (e.cw || 0), o: t.o + e.o, cr: t.cr + e.cr, total: t.total + e.i + e.o + e.cr }),
        { i: 0, cw: 0, o: 0, cr: 0, total: 0 },
      ),
      tokenEvents: raw.tokenEvents || [],
    };
    sessions.set(session.id, session);

    for (const m of msgs) {
      const d = getDayRec(m.day);
      d.messages.push(m);
      d.sessionIds.add(session.id);
      d.msgCount++;
    }
    for (const k of sortedDayKeys) {
      const d = getDayRec(k);
      d.sessionIds.add(session.id);
      d.sessionBlocks.push(dayBlocks.get(k));
    }
  }

  // --- Finalize day records. ------------------------------------------------
  for (const d of days.values()) {
    d.messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    // Day total on the MERGED union of all sessions' blocks: parallel
    // sessions must not double count.
    d.totalMs = blocksDuration(mergeBlocks(d.sessionBlocks));
    const lastM = d.messages[d.messages.length - 1];
    d.lastTs = lastM ? lastM.ts : 0;
    d.lastSnippet = lastM ? truncate(lastM.text, 90) : '';
    delete d.sessionBlocks;
  }

  const dayKeysSorted = [...days.keys()].sort();
  const sessionsByActivity = [...sessions.values()].sort((a, b) => b.lastTs - a.lastTs);
  const projects = [...new Set(
    sessionsByActivity.filter((s) => s.project).map((s) => s.project),
  )].sort();

  // --- Directory tree (Folders tab): sessions under their startDir. ---------
  const dirTree = (() => {
    const root = { name: '', path: '', children: new Map(), sessions: [] };
    const webSessions = [];
    for (const s of sessionsByActivity) {
      if (!s.startDir) { webSessions.push(s.id); continue; }
      let node = root;
      let p = '';
      for (const seg of s.startDir.replace(/\\/g, '/').split('/').filter(Boolean)) {
        p += '/' + seg;
        if (!node.children.has(seg)) {
          node.children.set(seg, { name: seg, path: p, children: new Map(), sessions: [] });
        }
        node = node.children.get(seg);
      }
      node.sessions.push(s.id);
    }
    // Compress chains of empty single-child directories into one node
    // ("Users/me/Dev" instead of three clicks through empty levels).
    const finalize = (node) => {
      let cur = node;
      let label = node.name;
      while (cur.children.size === 1 && cur.sessions.length === 0) {
        const child = [...cur.children.values()][0];
        label = label ? `${label}/${child.name}` : child.name;
        cur = child;
      }
      const children = [...cur.children.values()]
        .map(finalize)
        .sort((a, b) => a.name.localeCompare(b.name));
      const count = cur.sessions.length + children.reduce((t, c) => t + c.count, 0);
      return { name: label, path: cur.path, children, sessions: cur.sessions, count };
    };
    const top = finalize(root);
    // Root itself compressed into a single named node → present it as one
    // top-level entry; otherwise expose its children as the top level.
    const roots = top.name ? [top] : top.children;
    return { roots, webSessions };
  })();

  // --- Report aggregates (computed once alongside the indexes). -------------
  const aggregate = (keyFn) => {
    const map = new Map();
    for (const s of sessionsByActivity) {
      for (const key of keyFn(s)) {
        let a = map.get(key);
        if (!a) { a = { label: key, ms: 0, msgCount: 0, sessions: [] }; map.set(key, a); }
        a.ms += s.totalMs;
        a.msgCount += s.msgCount;
        a.sessions.push(s.id);
      }
    }
    return [...map.values()].sort((a, b) => b.ms - a.ms);
  };
  const tagStats = aggregate((s) => (s.tags.length ? s.tags : ['(untagged)']));
  // Primary-tag attribution: each session counts ONCE, under its strongest
  // tag — so these shares form a true 100% partition (donut-safe).
  const primaryTagStats = aggregate((s) => [s.tags[0] || '(untagged)']);
  const projectStats = aggregate((s) => (s.project ? [s.project] : []));
  // A folder's ≈time is its sessions' merged union — parallel ones counted once, as on Sessions.
  for (const a of projectStats) a.ms = blocksDuration(mergeBlocks(a.sessions.map((id) => sessions.get(id).blocks)));
  projectStats.sort((a, b) => b.ms - a.ms);
  const sourceStats = aggregate((s) => [sourceLabel(s.source)]);
  // Total active time = sum of per-day merged unions (never double-counted).
  const totalActiveMs = [...days.values()].reduce((t, d) => t + d.totalMs, 0);
  const hourHist = new Array(24).fill(0);
  for (const d of days.values()) {
    for (const m of d.messages) hourHist[new Date(m.ts).getHours()]++;
  }
  // Token consumption per local day (Code sessions only — exports carry none).
  const tokenByDay = new Map();
  let totalTokens = 0;
  const counted = new Set(); // a reply copied into a branched or resumed session counts once
  for (const s of sessionsByActivity) {
    for (const e of s.tokenEvents) {
      if (e.k) {
        if (counted.has(e.k)) continue;
        counted.add(e.k);
      }
      const k = dateKey(e.ts);
      let t = tokenByDay.get(k);
      if (!t) { t = { i: 0, cw: 0, o: 0, cr: 0, total: 0 }; tokenByDay.set(k, t); }
      t.i += e.i;
      t.cw += e.cw || 0;
      t.o += e.o;
      t.cr += e.cr;
      // Every kind, as Claude Code's own stats count them — cache reads (the conversation sent again with each reply) are most of it.
      t.total += e.i + e.o + e.cr;
      totalTokens += e.i + e.o + e.cr;
    }
  }

  return {
    isEmpty: sessions.size === 0,

    /** Sorted list of active date keys. */
    dayKeys: dayKeysSorted,
    minDayKey: dayKeysSorted[0] || null,
    maxDayKey: dayKeysSorted[dayKeysSorted.length - 1] || null,

    getDay: (key) => days.get(key) || null,
    getSession: (id) => sessions.get(id) || null,

    /** All sessions, most recent activity first; optional project filter. */
    listSessions(projectFilter) {
      if (!projectFilter || projectFilter === '*') return sessionsByActivity;
      return sessionsByActivity.filter((s) => s.project === projectFilter);
    },

    /** Active days, most recent first. */
    listDays() {
      return [...dayKeysSorted].reverse().map((k) => days.get(k));
    },

    projects,
    hasCodeSessions: projects.length > 0,

    /** Folders tab: {roots: [dirNode], webSessions: [id]}. */
    dirTree,

    /**
     * Everything under one folder (subtree): its sessions in start order,
     * all messages merged in time order, and the union ≈time (parallel
     * sessions never double-counted).
     */
    getFolder(path) {
      const stack = [...dirTree.roots];
      let node = null;
      while (stack.length) {
        const n = stack.pop();
        if (n.path === path) { node = n; break; }
        stack.push(...n.children);
      }
      if (!node) return null;
      const ids = [];
      (function walk(n) { ids.push(...n.sessions); n.children.forEach(walk); }(node));
      const sess = ids.map((id) => sessions.get(id)).filter(Boolean)
        .sort((a, b) => a.firstTs - b.firstTs);
      const messages = sess.flatMap((s) => s.messages).sort((a, b) => a.ts - b.ts);
      const totalMs = blocksDuration(mergeBlocks(sess.map((s) => s.blocks)));
      return { node, sessions: sess, messages, totalMs };
    },

    /** Report aggregates. */
    tagStats,
    primaryTagStats,
    tokenByDay,
    totalTokens,
    projectStats,
    sourceStats,
    totalActiveMs,
    hourHist,
    sessionCount: sessionsByActivity.length,
    msgTotal: sessionsByActivity.reduce((t, s) => t + s.msgCount, 0),

    /** Message-count of a day, 0 if inactive (for calendar heat). */
    dayMsgCount: (key) => (days.get(key) ? days.get(key).msgCount : 0),

    /**
     * Case-insensitive substring search over message text and session
     * titles. Capped. Returns [{session, msg|null, snippetIndex}].
     */
    search(query, cap = 200) {
      const q = query.toLowerCase();
      const results = [];
      for (const s of sessionsByActivity) {
        if (results.length >= cap) break;
        if (s.title.toLowerCase().includes(q)) {
          results.push({ session: s, msg: null });
        }
        for (const m of s.messages) {
          if (results.length >= cap) break;
          const idx = m.text.toLowerCase().indexOf(q);
          if (idx !== -1) results.push({ session: s, msg: m, matchIndex: idx });
        }
      }
      return results;
    },
  };
}
