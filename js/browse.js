// browse.js — the Sessions page and Search. Sessions shows every chat as a
// Tree (the default) or as Cards; the plan bar does what Group by Tool did.
// Both start with Still going (chats you came back to on another day, in
// the last two weeks, and the ones you pinned: every one a card, with its
// path, pin, archive and the resume buttons). Tree: then the folders chats
// started in — sections such as ~/Dev with their projects as rows, newest
// first, closed to their paths until you open one; a folder's quick chats,
// its commits and a section's quieter folders each fold into one line.
// Cards: then every other chat as a card, newest first — this week, the rest
// of this month, then a band per month, each band's quick chats folded.
// Search finds every message and title; a hit opens the conversation at
// that message. Your commits' messages are found too (the newest few, then
// the Commits page).

import { icon } from './icons.js';
import { dateKey } from './util.js';
import { fmtDuration, blocksDuration, mergeBlocks } from './time.js';
import {
  appOf, filterLabel, folderIsOpen, isQuick, stillGoing, dateBand, treeSections, homeShort, QUIET_DAYS,
} from './plans.js';
import { commitsOfRepos, whoMade, whoText, allCommits, matchCommit } from './commits.js';
import { commitRow } from './commitview.js';
import { h, appMark, plural, relDay, fmtShort, fmtClock, fmtDMY, fmtMonth, fmtMonthYear, todayKey, resumeButtons } from './ui.js';

const ARCHIVED_KEY = '::going-archived';  // Still going's archived fold, remembered with the folders
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));

const isOn = (app, s) => app.state.reader && app.state.reader.kind === 'session' && app.state.reader.id === s.id;
const byLast = (a, b) => b.last - a.last;
const unionOf = (sessions) => blocksDuration(mergeBlocks(sessions.map((s) => s.blocks)));

/** Across days: "since 7 Sep · active on 31 days"; one day: its messages. */
const spanOf = (s) => (s.dayKeys.length > 1 ? `since ${fmtDMY(s.dayKeys[0])} · active on ${s.dayKeys.length} days` : plural(s.msgCount, 'message'));

/**
 * A chat's row in the tree: its app's icon, its title and what it spans, its
 * ≈time and when you last worked on it — and, for a chat you can pick up
 * again, the resume buttons beside it (never inside it).
 */
function sessionRow(app, s) {
  const on = isOn(app, s);
  const meta = spanOf(s);
  const row = h('button', {
    type: 'button', class: `srow${on ? ' is-open' : ''}`, 'aria-pressed': String(on),
    title: [appOf(s.source).name, plural(s.msgCount, 'message'), s.startDir].filter(Boolean).join(' · '),
    onclick: () => app.openSession(s.id, { part: 'all' }),
  }, appMark(s.source, 'md'),
  h('span', { class: 'srow-main' }, h('span', { class: 'srow-title' }, s.title),
    h('span', { class: 'srow-meta' }, h('span', { class: 'sr-only' }, `${appOf(s.source).name} · `), meta)),
  h('span', { class: 'srow-side' }, h('b', null, fmtDuration(s.totalMs)), h('span', null, relDay(dateKey(s.lastTs)))));
  const act = app.resume ? app.resume(s) : null;
  return act ? h('div', { class: 'srow-wrap' }, row, resumeButtons(s, act, 'srow-acts')) : row;
}

/**
 * One line that opens to more — quick chats, a folder's commits, quieter
 * folders. Opened or closed is remembered with the folders (`key`).
 */
function fold(app, key, open, ico, label, { more = null, marks = null, filtering = false } = {}) {
  return h('button', {
    type: 'button', class: 'fold', 'aria-expanded': String(open), 'data-focus': key,
    onclick: () => { if (!filtering) app.rememberFolder(key, !open); },
  }, icon(open ? 'chevron-down' : 'chevron-right', 15), icon(ico, 15),
  h('span', { class: 'fold-label' }, label, more ? h('span', { class: 'fold-more' }, more) : null),
  marks ? h('span', { class: 'fold-marks' }, marks) : null,
  h('span', { class: 'fold-go' }, open ? 'Hide' : 'Show'));
}

/** A list's chats, with its quick ones (two or more) folded into one line. */
function withQuick(app, key, sessions, { filtering } = {}) {
  const quick = filtering ? [] : sessions.filter(isQuick);
  if (quick.length < 2) return sessions.map((s) => sessionRow(app, s));
  const open = !!app.state.prefs.folders[key];
  const apps = [...new Set(quick.map((s) => s.source))];
  return [
    ...sessions.filter((s) => !isQuick(s)).map((s) => sessionRow(app, s)),
    fold(app, key, open, 'message', [h('b', null, `${quick.length} quick chats`), ` · ${fmtDuration(unionOf(quick))}`],
      { more: ' together · 1–2 messages each', marks: apps.map((a) => appMark(a)) }),
    open ? h('div', { class: 'fold-kids' }, quick.map((s) => sessionRow(app, s))) : null,
  ];
}

export function sessionsPage(app) {
  const { prefs } = app.state;
  const q = app.state.sessQ.trim().toLowerCase();
  const list = app.view.listSessions()
    .filter((s) => !q || s.title.toLowerCase().includes(q) || (s.project || '').toLowerCase().includes(q) || (s.startDir || '').toLowerCase().includes(q))
    .sort((a, b) => b.lastTs - a.lastTs);
  const page = h('section', { class: 'page page-sessions' });
  const fl = filterLabel(app.state.filter);
  if (!list.length) {
    page.append(h('div', { class: 'card empty-card' },
      h('p', null, q ? 'No session’s name or folder matches that.' : 'No sessions for this tool.'),
      q ? h('button', {
        type: 'button', class: 'btn btn-small', onclick: () => app.go(`#/search?q=${encodeURIComponent(app.state.sessQ.trim())}`),
      }, icon('search', 15), `Search every message for “${app.state.sessQ.trim()}”`) : null));
    return page;
  }
  const count = h('p', { class: 'page-count' }, `${plural(list.length, 'session')}${fl ? ` in ${fl}` : ''}${q ? ` matching “${app.state.sessQ.trim()}”` : ''}`);
  const going = q ? { going: [], archived: [] } : stillGoing(list, todayKey(), app.marks);
  const shown = new Set(going.going.map((s) => s.id));
  // (append() would write a null as the text "null": Still going is null when it has nothing, or while you filter)
  if (prefs.group !== 'date') {
    if (q) page.append(count);
    else {
      page.append(h('div', { class: 'page-count-row' }, count,
        h('div', { class: 'tree-tools' },
          h('button', { type: 'button', class: 'link-btn', 'data-focus': 'tree-expand', title: 'Every folder, quick chats and quieter folders open', onclick: () => app.rememberFolders({ ...pick(prefs.folders, [ARCHIVED_KEY]), ...expandAll(app.view, list) }) }, 'Expand all'),
          h('button', { type: 'button', class: 'link-btn', 'data-focus': 'tree-collapse', title: 'Back to folders only', onclick: () => app.rememberFolders({}) }, 'Collapse all'))));
    }
    page.append(...[goingBlock(app, going, { all: list.length }), folderTree(app, list, !!q, shown)].filter(Boolean));
  } else {
    page.append(...[count, goingBlock(app, going), ...dateBands(app, list.filter((s) => !shown.has(s.id)), !!q)].filter(Boolean));
  }
  return page;
}

// ---------------------------------------------------------------------------
// Still going
// ---------------------------------------------------------------------------

/**
 * Every chat that's still going as a card, pinned first — no "Show more" —
 * then the ones you archived, folded into one line until you work on one
 * again. Pins and archives are Throwbacks' own (app.marks); the apps' chats
 * are never touched.
 */
function goingBlock(app, { going, archived }, { all = 0 } = {}) {
  if (!going.length && !archived.length) return null;
  const open = !!app.state.prefs.folders[ARCHIVED_KEY];
  const pins = going.some((s) => isPinned(app, s));
  return h('section', { class: 'sgroup-block tiles going' },
    h('h2', { class: 'section-title is-small' }, 'Still going', h('span', { class: 'count' }, String(going.length)),
      // On the Tree: every chat as cards is one click away (the top bar's Cards).
      all > going.length ? h('button', {
        type: 'button', class: 'link-btn going-all', 'data-focus': 'going-all', title: 'Every chat as a card, newest first',
        onclick: () => app.setSessionsView('date'),
      }, `See all ${all} as cards`) : null),
    h('p', { class: 'going-hint' }, `Chats you came back to on another day and worked on in the last two weeks${pins ? ', and the ones you pinned' : ''}`),
    going.length ? h('div', { class: 'cards' }, going.map((s) => goingCard(app, s))) : null,
    archived.length ? h('div', { class: 'going-arch' },
      fold(app, ARCHIVED_KEY, open, 'archive', h('b', null, `${archived.length} archived`), { more: ' · back here when you work on one again' }),
      open ? h('div', { class: 'rows fold-kids' }, archived.map((s) => archivedRow(app, s))) : null) : null);
}

const isPinned = (app, s) => Object.prototype.hasOwnProperty.call(app.marks.pinned, s.id);
const whereOf = (s) => (s.startDir ? homeShort(s.startDir) : 'No folder');

/**
 * A chat as a card: its app, when you last worked on it, its title (two
 * lines at most), its folder's path, how many days and its ≈time. Pin (and,
 * in Still going, archive) show at its top right when you point at it (in
 * place of the day), the resume buttons at its bottom right — beside the
 * card, never inside it. Pinning a chat from the Cards puts it in Still going.
 */
function goingCard(app, s, { archive = true } = {}) {
  const on = isOn(app, s);
  const pinned = isPinned(app, s);
  const days = s.dayKeys.length;
  const card = h('button', {
    type: 'button', class: `scard${on ? ' is-open' : ''}`, 'aria-pressed': String(on), 'data-focus': `card:${s.id}`,
    title: [s.title, s.startDir, days > 1 ? `Since ${fmtDMY(s.dayKeys[0])} · active on ${days} days` : null].filter(Boolean).join('\n'),
    onclick: () => app.openSession(s.id, { part: 'all' }),
  },
  h('span', { class: 'scard-top' }, appMark(s.source), h('span', { class: 'scard-app' }, appOf(s.source).name),
    h('span', { class: 'scard-when' }, pinned ? h('span', { class: 'scard-pin', title: 'Pinned' }, icon('pin', 13), h('span', { class: 'sr-only' }, 'Pinned · ')) : null,
      relDay(dateKey(s.lastTs)))),
  h('span', { class: 'scard-title' }, s.title),
  h('span', { class: `scard-path${s.startDir ? '' : ' is-none'}` }, icon('folder', 13), h('span', null, whereOf(s))),
  h('span', { class: 'scard-foot' }, h('span', null, days > 1 ? `${days} days` : plural(s.msgCount, 'message')), h('b', null, fmtDuration(s.totalMs))));
  const act = app.resume ? app.resume(s) : null;
  return h('div', { class: `scard-wrap${act ? ' has-actions' : ''}${pinned ? ' is-pinned' : ''}` }, card,
    h('div', { class: 'scard-tools' },
      h('button', {
        type: 'button', class: `scard-act${pinned ? ' is-on' : ''}`, 'aria-pressed': String(pinned), 'data-focus': `pin:${s.id}`,
        title: pinned ? 'Unpin' : 'Pin: it stays in Still going, first, until you unpin it', 'aria-label': `Pin “${s.title}”`,  // aria-pressed says which
        onclick: () => app.markChat(s, { pin: !pinned }, [`pin:${s.id}`]),
      }, icon('pin', 15)),
      archive ? h('button', {
        type: 'button', class: 'scard-act', 'data-focus': `archive:${s.id}`,
        title: 'Archive: out of Still going until you work on it again', 'aria-label': `Archive “${s.title}”`,
        onclick: () => app.markChat(s, { archive: { last: s.lastTs } }, [ARCHIVED_KEY]),
      }, icon('archive', 15)) : null),
    act ? resumeButtons(s, act) : null);
}

/** An archived chat: its row opens it; Restore puts it back. */
function archivedRow(app, s) {
  const on = isOn(app, s);
  const mark = app.marks.archived[s.id];
  const when = mark ? relDay(dateKey(mark.at)).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase()) : null;
  return h('div', { class: 'srow-wrap going-arch-row' },
    h('button', {
      type: 'button', class: `srow${on ? ' is-open' : ''}`, 'aria-pressed': String(on), 'data-focus': `archrow:${s.id}`,
      title: [appOf(s.source).name, s.startDir].filter(Boolean).join(' · '), onclick: () => app.openSession(s.id, { part: 'all' }),
    }, appMark(s.source, 'md'),
    h('span', { class: 'srow-main' }, h('span', { class: 'srow-title' }, s.title),
      h('span', { class: 'srow-meta' }, [whereOf(s), when ? `archived ${when}` : null].filter(Boolean).join(' · '))),
    h('span', { class: 'srow-side' }, h('b', null, fmtDuration(s.totalMs)), h('span', null, relDay(dateKey(s.lastTs))))),
    h('div', { class: 'srow-acts' }, h('button', {
      type: 'button', class: 'restore-btn', 'data-focus': `restore:${s.id}`, title: 'Back in Still going',
      'aria-label': `Restore “${s.title}” to Still going`, onclick: () => app.markChat(s, { archive: null }, [`card:${s.id}`]),
    }, 'Restore')));
}

// ---------------------------------------------------------------------------
// Cards: every other chat — this week, the rest of this month, then each month
// ---------------------------------------------------------------------------

/** Each band: its name (a link to its week's or month's sheet), its chats as cards, its quick ones (two or more) folded. */
function dateBands(app, list, filtering) {
  const today = todayKey();
  const bands = new Map();
  for (const s of list) {
    const b = dateBand(dateKey(s.lastTs), today);
    if (!bands.has(b.id)) bands.set(b.id, { ...b, list: [] });
    bands.get(b.id).list.push(s);
  }
  const cards = (sessions, cls = 'cards') => h('div', { class: cls }, sessions.map((s) => goingCard(app, s, { archive: false })));
  return [...bands.values()].map((b) => {
    const first = `${b.at.slice(0, 7)}-01`;
    const [label, href, title] = b.kind === 'week' ? ['This week', `#/week/${b.at}`, 'Open this week’s sheet']
      : [b.kind === 'rest' ? `Earlier in ${fmtMonth(first)}` : fmtMonthYear(first), `#/month/${b.at}`, `Open ${fmtMonthYear(first)}’s sheet`];
    const quickKey = `::quick-date:${b.id}`;
    const quick = filtering ? [] : b.list.filter(isQuick);
    const folded = quick.length >= 2;
    const open = folded && !!app.state.prefs.folders[quickKey];
    const rest = folded ? b.list.filter((s) => !isQuick(s)) : b.list;
    return h('section', { class: 'sgroup-block tiles' },
      h('h2', { class: 'section-title is-small' },
        h('button', { type: 'button', class: 'link-btn day-link', title, onclick: () => app.go(href) }, label),
        h('span', { class: 'count' }, String(b.list.length))),
      rest.length ? cards(rest) : null,
      folded ? fold(app, quickKey, open, 'message', [h('b', null, `${quick.length} quick chats`), ` · ${fmtDuration(unionOf(quick))}`],
        { more: ' together · 1–2 messages each', marks: [...new Set(quick.map((s) => s.source))].map((a) => appMark(a)) }) : null,
      open ? cards(quick, 'cards fold-kids') : null);
  });
}

// ---------------------------------------------------------------------------
// By Folder: the tree
// ---------------------------------------------------------------------------

/**
 * The folder tree: folders as they're nested, chats by their exact names,
 * in sections (~/Dev, then Elsewhere), newest first. Folders start closed
 * (folders of folders open), so the page shows paths; each row says how
 * many chats, their ≈time together, its commits and when you last worked
 * there. A folder with just one chat is that chat's row. What you open or
 * close is remembered.
 */
function folderTree(app, list, filtering, going) {
  const saved = app.state.prefs.folders || {};
  const model = app.view;
  const ids = new Set(list.map((s) => s.id));
  const quietBefore = Date.now() - QUIET_DAYS * 864e5;
  // Each repo's commits have one home: the deepest folder that holds all of
  // that repo's session folders (so they show once, and counts match).
  const homedAt = new Map();
  if (app.commits) {
    const chains = new Map();
    const walk = (node, chain) => {
      const here = [...chain, node];
      if (node.sessions.some((id) => ids.has(id))) {
        const repo = app.commits.folderRepo.get(node.path);
        if (repo) (chains.get(repo) || chains.set(repo, []).get(repo)).push(here);
      }
      node.children.forEach((c) => walk(c, here));
    };
    model.dirTree.roots.forEach((r) => walk(r, []));
    for (const [repo, chs] of chains) {
      let home = null;
      for (let d = 0; chs.every((ch) => ch[d] && ch[d] === chs[0][d]); d++) home = chs[0][d];
      if (home) (homedAt.get(home.path) || homedAt.set(home.path, []).get(home.path)).push(repo);
    }
  }
  const ownOf = (node) => node.sessions.filter((id) => ids.has(id)).map((id) => model.getSession(id)).filter(Boolean);
  const stat = (own, kids, repos) => {
    const all = [...own, ...kids.flatMap((k) => k.all)];
    const commits = commitsOfRepos(app.commits, repos);
    return {
      all, own, repos, commits, n: all.length, subs: kids.filter((k) => k.n).length, ms: unionOf(all),
      last: Math.max(all.reduce((t, s) => Math.max(t, s.lastTs), 0), commits.length ? commits[0].at : 0),
    };
  };
  const stats = new Map();
  const statOf = (node) => {
    if (!stats.has(node.path)) {
      const kids = node.children.map(statOf);
      // Your commits whose home is this folder or one inside it.
      stats.set(node.path, stat(ownOf(node), kids, [...(homedAt.get(node.path) || []), ...kids.flatMap((k) => k.repos)]));
    }
    return stats.get(node.path);
  };
  // A folder without its subfolders (they're sections of their own): your home folder's chats.
  const aloneOf = (node) => stat(ownOf(node), [], homedAt.get(node.path) || []);

  // While you filter every folder is open, so a click there changes (and saves) nothing.
  const setOpen = (path, open) => { if (!filtering) app.rememberFolder(path, open); };
  const toggleAttrs = (path, open) => (filtering
    ? { 'aria-disabled': 'true', title: 'Clear the filter to open or close folders', 'data-focus': `folder:${path}` }
    : { 'aria-expanded': String(open), 'data-focus': `folder:${path}` });
  const meta = (ms, last, commits = 0, together = false) => h('span', { class: 'trow-meta' },
    [`${fmtDuration(ms)}${together ? ' together' : ''}`, commits ? plural(commits, 'commit') : null, relDay(dateKey(last))].filter(Boolean).join(' · '));
  const goingDot = (sessions) => (sessions.some((s) => going.has(s.id))
    ? h('span', { class: 'going-dot', title: 'A chat here is still going', 'aria-label': 'still going' }) : null);

  const single = (node, name, s, commits) => {
    const on = isOn(app, s);
    const act = app.resume ? app.resume(s) : null;
    return h('div', { class: 'tnode', 'data-path': node.path },
      h('div', { class: `trow is-single${on ? ' is-open' : ''}` },
        h('button', {
          type: 'button', class: 'trow-toggle', 'aria-pressed': String(on), title: `${node.path} — open “${s.title}”`,
          'data-focus': `folder:${node.path}`, onclick: () => app.openSession(s.id, { part: 'all' }),
        }, h('span', { class: 'trow-gap', 'aria-hidden': 'true' }), icon('folder', 16),
        h('span', { class: 'trow-name' }, name), h('span', { class: 'trow-dot', 'aria-hidden': 'true' }, '·'),
        h('span', { class: 'trow-sess' }, appMark(s.source), h('span', { class: 'trow-title' }, s.title)),
        goingDot([s]), meta(s.totalMs, s.lastTs)),
        act || commits.length ? h('div', { class: 'trow-end' },
          act ? resumeButtons(s, act, 'srow-acts') : null,
          // Its commits: the folder opens, showing the chat and the commits.
          commits.length ? h('button', {
            type: 'button', class: 'trow-commits', title: `${plural(commits.length, 'commit')} here — show them`,
            'aria-label': `Show the ${plural(commits.length, 'commit')} in ${name}`, 'data-focus': `commits:${node.path}`,
            onclick: () => app.rememberFolders({ ...saved, [node.path]: true, [`::commits:${node.path}`]: true }),
          }, icon('commit', 14), String(commits.length)) : null) : null));
  };

  const nodeEl = (node, { name = node.name, alone = false } = {}) => {
    const st = alone ? aloneOf(node) : statOf(node);
    if (!st.n) return null;
    const commits = filtering ? [] : st.commits;
    // A folder with one chat is that chat's row — until you open its commits.
    if (!st.subs && st.own.length === 1 && (!commits.length || saved[node.path] !== true)) return single(node, name, st.own[0], commits);
    const open = folderIsOpen(node.path, st.subs > 0, saved, filtering);
    const ownCommits = filtering ? [] : commitsOfRepos(app.commits, homedAt.get(node.path) || []);
    return h('div', { class: 'tnode', 'data-path': node.path },
      h('div', { class: `trow${open ? ' is-expanded' : ''}` },
        h('button', { type: 'button', class: 'trow-toggle', ...toggleAttrs(node.path, open), onclick: () => setOpen(node.path, !open) },
          icon(open ? 'chevron-down' : 'chevron-right', 15), icon(open ? 'folder-open' : 'folder', 16),
          h('span', { class: 'trow-name', title: node.path }, name), h('span', { class: 'count' }, String(st.n)),
          goingDot(st.all), meta(st.ms, st.last, commits.length, true)),
        // Every chat under it as one conversation — not for your home folder, which holds every other folder too.
        alone ? null : h('div', { class: 'trow-end' }, h('button', {
          type: 'button', class: 'trow-one', title: `Every session under ${node.path} as one conversation`,
          'aria-label': `Open every session in ${name} as one chat`, onclick: () => app.openFolder(node.path),
        }, icon('layers', 14), h('span', { class: 'trow-one-label' }, 'Open as one chat')))),
      open ? h('div', { class: 'tkids' },
        alone ? null : node.children.filter((c) => statOf(c).n).sort((a, b) => byLast(statOf(a), statOf(b))).map((c) => nodeEl(c)),
        withQuick(app, `::quick:${node.path}`, [...st.own].sort((a, b) => b.lastTs - a.lastTs), { filtering }),
        commitsFold(app, node.path, ownCommits, saved)) : null);
  };

  const tree = h('div', { class: 'tree card' });
  const { sections, elsewhere } = treeSections(model.dirTree.roots, (n) => ownOf(n).length, (n) => statOf(n).n);
  const lastOfRows = (rws) => Math.max(...rws.map((n) => statOf(n).last));
  for (const sec of sections.sort((a, b) => lastOfRows(b.rows) - lastOfRows(a.rows))) {
    const rws = [...sec.rows].sort((a, b) => byLast(statOf(a), statOf(b)));
    const quiet = filtering ? [] : rws.filter((n) => statOf(n).last < quietBefore);
    const key = `::quiet:${sec.node.path}`;
    const open = !!saved[key];
    tree.append(h('div', { class: 'tree-label', title: sec.node.path }, icon('folder', 14), homeShort(sec.node.path)),
      ...(quiet.length < 2 ? rws : rws.filter((n) => !quiet.includes(n))).map((n) => nodeEl(n)));
    if (quiet.length >= 2) {
      tree.append(fold(app, key, open, 'folder', [h('b', null, `${quiet.length} quieter folders`), ` · nothing in the last ${QUIET_DAYS} days`]));
      if (open) tree.append(h('div', { class: 'fold-kids' }, quiet.map((n) => nodeEl(n))));
    }
  }
  const loose = model.dirTree.webSessions.filter((id) => ids.has(id)).map((id) => model.getSession(id)).filter(Boolean);
  const rest = elsewhere.map((e) => ({ ...e, last: (e.alone ? aloneOf(e.node) : statOf(e.node)).last })).filter((e) => e.last).sort(byLast);
  if (sections.length && (rest.length || loose.length)) tree.append(h('div', { class: 'tree-label' }, icon('folder', 14), 'Elsewhere'));
  tree.append(...rest.map((e) => nodeEl(e.node, {
    alone: e.alone, name: homeShort(e.node.path) === '~' ? '~ (home folder)' : homeShort(e.node.path),
  })));
  if (loose.length) {
    const open = folderIsOpen('::none', false, saved, filtering);
    const kinds = [...new Set(loose.map((s) => appOf(s.source).name))];
    tree.append(h('div', { class: 'tnode' },
      h('div', { class: `trow${open ? ' is-expanded' : ''}` },
        h('button', { type: 'button', class: 'trow-toggle', ...toggleAttrs('::none', open), onclick: () => setOpen('::none', !open) },
          icon(open ? 'chevron-down' : 'chevron-right', 15), icon('message', 16),
          h('span', { class: 'trow-name' }, 'No folder'), h('span', { class: 'count' }, String(loose.length)),
          h('span', { class: 'trow-hint' }, kinds.join(', ')), goingDot(loose),
          meta(unionOf(loose), loose.reduce((t, s) => Math.max(t, s.lastTs), 0)))),
      open ? h('div', { class: 'tkids' }, withQuick(app, '::quick:::none', loose, { filtering })) : null));
  }
  return tree;
}

const COMMITS_SHOWN = 10;      // a folder's newest commits when you open them; the rest on request
const allCommitsShown = new Set();  // folders whose every commit is showing (this tab only)

/** A folder's commits as one line — how many, who made them besides you, the newest — that opens to the list. */
function commitsFold(app, path, commits, saved) {
  if (!commits.length) return null;
  const key = `::commits:${path}`;
  const open = !!saved[key];
  const who = whoMade(commits);
  const all = allCommitsShown.has(path);
  const shown = all ? commits : commits.slice(0, COMMITS_SHOWN);
  return [
    fold(app, key, open, 'commit', [h('b', null, plural(commits.length, 'commit')), who.tools.length ? ` · ${whoText(who)}` : ''],
      { more: ` · newest ${relDay(commits[0].day).replace(/^(Today|Yesterday)$/, (m) => m.toLowerCase())}` }),
    open ? h('div', { class: 'fold-kids crows' },
      shown.map((c) => commitRow(app, c, { date: true })),
      commits.length > shown.length ? h('button', {
        type: 'button', class: 'link-btn crows-more', onclick: () => { allCommitsShown.add(path); app.renderPage(); },
      }, `Show all ${commits.length} commits`) : null) : null,
  ];
}

/** Expand all: every folder, every folder's quick chats and every section's quieter folders open (not commits). */
function expandAll(model, list) {
  const ids = new Set(list.map((s) => s.id));
  const out = { '::none': true, '::quick:::none': true };
  const walk = (n) => {
    out[n.path] = true;
    if (n.sessions.filter((id) => ids.has(id)).map((id) => model.getSession(id)).filter((s) => s && isQuick(s)).length > 1) out[`::quick:${n.path}`] = true;
    if (n.children.length) out[`::quiet:${n.path}`] = true;
    n.children.forEach(walk);
  };
  model.dirTree.roots.forEach(walk);
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function snippet(text, idx, len) {
  const from = Math.max(0, idx - 70);
  const to = Math.min(text.length, idx + len + 110);
  const flat = (s) => s.replace(/\s+/g, ' ');
  return h('span', { class: 'snip-text' }, from ? '…' : '', flat(text.slice(from, idx)),
    h('mark', null, flat(text.slice(idx, idx + len))), flat(text.slice(idx + len, to)), to < text.length ? '…' : '');
}

export function searchPage(app) {
  const q = app.state.searchQ.trim();
  const page = h('section', { class: 'page page-search' });
  if (q.length < 2) {
    page.append(h('div', { class: 'card empty-card' },
      h('p', null, 'Type at least two letters to search every message and session title.'),
      h('p', { class: 'muted' }, 'From anywhere: ⌘K (Ctrl+K).')));
    return page;
  }
  const bySession = new Map();
  for (const r of app.view.search(q, 400)) {
    if (!bySession.has(r.session.id)) bySession.set(r.session.id, { session: r.session, hits: [] });
    bySession.get(r.session.id).hits.push(r);
  }
  // Your commits' messages too (all tools only: a commit belongs to no tool).
  const commits = app.state.filter.plan ? [] : allCommits(app.commits).filter((c) => matchCommit(c, { q }));
  if (!bySession.size && !commits.length) {
    page.append(h('div', { class: 'card empty-card' }, h('p', null, `Nothing found for “${q}”.`)));
    return page;
  }
  if (commits.length) page.append(commitHits(app, commits, q));
  if (!bySession.size) return page;
  const fl = filterLabel(app.state.filter);
  page.append(h('p', { class: 'page-count' },
    `${plural(bySession.size, 'session')}${fl ? ` in ${fl}` : ''}${bySession.size > 50 ? ' — the first 50 shown' : ''}`));
  for (const { session: s, hits } of [...bySession.values()].slice(0, 50)) {
    const msgHits = hits.filter((r) => r.msg).slice(0, 3);
    page.append(h('section', { class: 'card sres' },
      h('button', { type: 'button', class: 'sres-head', onclick: () => app.openSession(s.id, { part: 'all' }) },
        appMark(s.source, 'md'),
        h('span', { class: 'srow-main' }, h('span', { class: 'srow-title' }, s.title),
          h('span', { class: 'srow-meta' }, [appOf(s.source).name, s.project, relDay(dateKey(s.lastTs))].filter(Boolean).join(' · ')))),
      msgHits.map((r) => h('button', {
        type: 'button', class: 'snip', onclick: () => app.openSession(s.id, { part: 'all', msgId: r.msg.id }),
      }, h('span', { class: 'snip-who' }, r.msg.sender === 'human' ? 'You' : 'AI', ` · ${fmtShort(r.msg.day)} ${fmtClock(r.msg.ts)}`),
      snippet(r.msg.text, r.matchIndex, q.length)))));
  }
  return page;
}

/** Commits whose message (or repo, branch, ID) matches: the newest few, then the rest on the Commits page. */
const COMMIT_HITS = 3;
function commitHits(app, commits, q) {
  return h('section', { class: 'commits sres-commits', 'aria-label': 'Commits' },
    h('div', { class: 'commits-head' }, icon('commit', 14), h('span', null, 'Commits'), h('span', { class: 'count' }, String(commits.length)),
      h('button', {
        type: 'button', class: 'link-btn sres-commits-all', title: 'Every matching commit, with who made each',
        onclick: () => {
          Object.assign(app.state.commitView, { who: 'all', repo: '', q });
          app.go('#/commits');
        },
      }, commits.length > COMMIT_HITS ? `See all ${commits.length} on the Commits page` : 'On the Commits page')),
    h('div', { class: 'crows' }, commits.slice(0, COMMIT_HITS).map((c) => commitRow(app, c, { date: true }))));
}
