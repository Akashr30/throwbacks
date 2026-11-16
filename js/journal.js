// journal.js — the Today, Week and Month pages. A day: its title and
// ≈time, the day's summary first (the AI lines and your own rows, grouped by
// folder — or the plain list of what you worked on until it's summarized),
// when each app was active, then the day's sessions as cards grouped by
// folder. A week or a month: the sheet (sheet.js) — one row per task, which
// you can edit — under the week's summary. Copy rows / CSV export the sheet.

import { icon } from './icons.js';
import { truncate, dateKey, keyToDate } from './util.js';
import { fmtDuration } from './time.js';
import { PROVIDERS } from './summarize.js';
import { daySummaryState, weekSummaryState, sheetTsv, sheetCsv, editedByHand, weekOf, recapDays } from './log.js';
import { openRecapDialog } from './summariespage.js';
import { sheetGrid, sheetNote, sheetGroupSwitch } from './sheet.js';
import { commitsOfRepos, otherCommits, assignRepos, allCommits, commitsLine } from './commits.js';
import { commitList } from './commitview.js';
import { loginCopy } from './topbar.js';
import { loginNeeded } from './usage.js';
import { APPS, appOf, folderGroups, filteredSaved, weekKeys, mondayOf, addDays, stepDay, filterLabel } from './plans.js';
import {
  h, appMark, showToast, copyText, downloadText, plural, resumeButtons,
  fmtLong, fmtShort, fmtDM, fmtWd, relDay, eyebrowFor, fmtClock, todayKey, recapView,
} from './ui.js';

const providerLabel = (id) => (PROVIDERS[id] ? PROVIDERS[id].label : id);

function note(text, iconName = 'info') {
  return h('p', { class: 'page-note' }, icon(iconName, 15), h('span', null, text));
}

// ---------------------------------------------------------------------------
// A day
// ---------------------------------------------------------------------------

export function dayPage(app, key, moved) {
  const row = app.rows.get(key) || null;
  const page = h('section', { class: 'page page-day' });
  const fl = filterLabel(app.state.filter);
  if (moved) {
    page.append(note(`Nothing yet today${fl ? ` in ${fl}` : ''}. Here’s ${relDay(key) === 'Yesterday' ? 'yesterday' : fmtShort(key)}, your last day with chats.`));
  }

  if (!row) {
    const prev = stepDay(app.view.dayKeys, key, -1);
    const next = stepDay(app.view.dayKeys, key, 1);
    page.append(
      h('header', { class: 'day-head' }, h('div', null, h('div', { class: 'eyebrow' }, eyebrowFor(key)), h('h1', { class: 'day-title' }, fmtLong(key)))),
      h('div', { class: 'card empty-card' },
        h('p', null, fl ? `No ${fl} chats on this day.` : 'No chats on this day.'),
        h('div', { class: 'empty-actions' },
          prev ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => app.go(`#/day/${prev}`) }, icon('chevron-left', 15), fmtShort(prev)) : null,
          next ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => app.go(`#/day/${next}`) }, fmtShort(next), icon('chevron-right', 15)) : null)),
      fl ? '' : otherDayCommits(app, key, []) || '');
    return page;
  }

  // Chats Claude Code deletes within a week: say so where you look every day.
  if (app.due && app.due.length && key === app.homeKey()) {
    page.append(h('div', { class: 'card keep-note', role: 'status' }, icon('clock', 16),
      h('span', null, `${app.due.length === 1 ? 'A chat' : `${app.due.length} chats`} will be deleted by Claude Code this week.`),
      h('a', { class: 'btn btn-small', href: '#/expiring' }, 'Review and keep')));
  }
  const login = key === app.homeKey() ? loginNote(app) : null;
  if (login) page.append(login);
  const groups = folderGroups(app.view, row);
  // Each repo's commits that day under one folder group only (folders inside one repo share its commits).
  const dayRepos = assignRepos(app.commits, groups.map((g) => ({ folder: g.folder, folders: g.folder ? groupFolders(app, g.items) : [] })));
  const apps = new Set(row.items.map((it) => it.source));
  const copyDay = async () => {
    const saved = filteredSaved(app.state.summaries.days[key], row);
    const ok = await copyText(sheetTsv([row], { days: { [key]: saved } }));
    showToast(ok ? 'Copied — paste it into any spreadsheet' : 'Couldn’t copy');
  };
  page.append(
    h('header', { class: 'day-head' },
      h('div', null,
        h('div', { class: 'eyebrow' }, eyebrowFor(key)),
        h('h1', { class: 'day-title' }, fmtLong(key)),
        h('div', { class: 'day-sub' },
          h('b', null, fmtDuration(row.totalMs)),
          ` · ${fmtClock(row.from)}–${fmtClock(row.to)} · ${plural(row.items.length, 'session')} · ${plural(apps.size, 'app')}`,
          commitsSub(app, key, key))),
      h('div', { class: 'day-actions' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: copyDay, title: 'Copy this day’s rows — they paste into any spreadsheet' },
          icon('copy', 15), 'Copy rows'))),
    summaryCard(app, row, groups),
    activityStrip(app, row),
    h('section', { class: 'day-sessions', 'aria-label': 'Sessions' },
      h('h2', { class: 'section-title' }, 'Sessions', h('span', { class: 'count' }, String(row.items.length))),
      groups.map((g, i) => groupNode(app, row, g, dayRepos[i]))),
    // Commits in repos you didn't chat in that day (all tools only: they belong to no tool).
    (app.state.filter.plan ? null : otherDayCommits(app, key, groupFolders(app, row.items))) || '');
  return page;
}

/**
 * Claude Code not logged in to a plan: your Claude usage stops updating — and
 * your day summaries, when Claude Code writes them. Said where you look every
 * day, with the one command that fixes it and a way to check once you have.
 */
function loginNote(app) {
  const info = app.state.usageInfo;
  if (info.sample || !loginNeeded(info, 'claude')) return null;
  const summaries = app.summarizer.provider === 'claudecode';
  const checking = !!app.state.checkingLogin;
  return h('div', { class: 'card keep-note login-note', role: 'status' }, icon('lock', 16),
    h('span', null, `Claude Code isn’t logged in to a Claude plan, so your Claude usage${summaries ? ' and day summaries' : ''} can’t update. Copy this into Terminal to log in:`),
    h('span', { class: 'login-note-acts' },
      loginCopy(info, 'claude'),
      h('button', {
        type: 'button', class: 'btn btn-small btn-ghost', 'data-focus': 'login-check', 'aria-disabled': checking ? 'true' : null,
        title: 'Asks Claude Code again — at most once a minute',
        onclick: () => app.checkLogin(),
      }, icon('refresh', 15), checking ? 'Checking…' : 'Check again')));
}

/**
 * " · 5 commits · 2 by Claude" in a day's, week's or month's line — all tools only: commits belong to no tool.
 * It opens the Commits page at them (`to`: the line's last day).
 */
function commitsSub(app, from, to) {
  if (app.state.filter.plan) return null;
  const line = commitsLine(allCommits(app.commits, from, to));
  return line ? h('span', { class: 'day-commits' }, ' · ',
    h('a', { href: `#/commits/${to}`, title: 'See them on the Commits page, with who made each' }, line)) : null;
}

/** The session folders of these day items. */
function groupFolders(app, items) {
  return [...new Set(items.map((it) => app.view.getSession(it.sessionId)).filter(Boolean).map((s) => s.startDir).filter(Boolean))];
}

/** "Commits in other folders": each repo with its commits that day. */
function otherDayCommits(app, key, folders) {
  const other = otherCommits(app.commits, folders, key);
  if (!other.length) return null;
  const byRepo = new Map();
  for (const c of other) {
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
    byRepo.get(c.repo).push(c);
  }
  return h('section', { class: 'day-sessions day-other-commits', 'aria-label': 'Commits in other folders' },
    h('h2', { class: 'section-title' }, 'Commits in other folders', h('span', { class: 'count' }, String(other.length))),
    [...byRepo.values()].map((list) => h('section', { class: 'fgroup' },
      h('div', { class: 'fgroup-head' }, icon('folder', 15), h('span', { class: 'fgroup-name', title: list[0].repo }, list[0].repoName)),
      commitList(app, list, { title: 'Commits' }))));
}

/** The day's summary: AI lines by folder, or the plain list until there are some. */
function summaryCard(app, row, groups) {
  const { summaries, job, errors } = app.state;
  const saved = filteredSaved(summaries.days[row.key], row);
  // Chats from the apps left out in Settings are never sent: they're never "new" either (nor are
  // the sample's made-up chats beside your real summaries).
  const skip = app.summarySkip();
  const st = daySummaryState(row, app.view, saved, { skip });
  // This day being written: by its own Summarize, the end-of-day run or a recap (each can Stop).
  const running = job && ((job.kind === 'day' && job.key === row.key) || (job.kind !== 'session' && job.dayKey === row.key));
  const can = app.summarizer.enabled;
  const chats = (saved && saved.chats) || {};

  let badge;
  // Waiting its turn (another tab's job) says so; then how far it is.
  if (running) badge = h('span', { class: 'tag is-live' }, h('span', { class: 'spinner' }), job.total ? `Writing… ${job.done || 0} of ${job.total}` : job.note || 'Writing…');
  else if (st.state === 'none') badge = h('span', { class: 'tag' }, 'Not written yet');
  else if (st.state === 'stale') badge = h('span', { class: 'tag is-new' }, `New since ${fmtClock(st.upTo)} · ${plural(st.newChats, 'chat')}`);
  else badge = h('span', { class: 'tag', title: saved.model ? `Model: ${saved.model}` : null },
    `Written ${fmtClock(saved.updatedAt)} · ${providerLabel(saved.provider)}${editedByHand(saved) ? ' · edited' : ''}`);

  const busy = !!job;
  // What's never sent, and why — a sample chat, or an app you left out in Settings.
  const notSent = (it) => (skip.has(it.sessionId) ? 'a sample chat: never sent' : skip.has(it.source) ? `not sent: ${APPS[it.source].name} is left out in Settings` : null);
  const sendable = row.items.some((it) => it.msgs && !notSent(it));
  const actions = h('div', { class: 'card-actions' });
  if (running) {
    actions.append(h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => app.stopJob() }, icon('stop', 14), 'Stop'));
  } else if (can) {
    if (st.state === 'none' && sendable) {
      actions.append(h('button', { type: 'button', class: 'btn btn-small btn-brand', disabled: busy || null, onclick: () => app.summarizeDay(row.key) },
        icon('sparkles', 15), 'Summarize this day'));
    } else if (st.state === 'stale') {
      actions.append(h('button', {
        type: 'button', class: 'btn btn-small btn-brand', disabled: busy || null, title: 'Send only the messages not summarized yet',
        onclick: () => app.summarizeDay(row.key),
      }, icon('sparkles', 15), 'Add new'));
    }
    if (st.state !== 'none') {
      actions.append(h('button', {
        type: 'button', class: 'btn btn-small btn-ghost', disabled: busy || null, title: 'Write the whole day again',
        onclick: () => app.summarizeDay(row.key, { rewrite: true }),
      }, 'Rewrite'));
    }
  }
  if (st.state !== 'none' && !running) {
    actions.append(h('button', {
      type: 'button', class: 'icon-btn', disabled: busy || null, 'aria-label': 'Remove this day’s summary', title: 'Remove this day’s summary',
      onclick: () => app.removeDaySummary(row.key),
    }, icon('trash', 16)));
  }
  // Every summary in one place (on a phone, the way there: its bar keeps five tabs).
  actions.prepend(h('a', { class: 'link-btn summary-all', href: '#/summaries' }, 'All summaries'));

  const body = h('div', { class: 'summary-body' });
  if (st.state === 'none') {
    body.append(h('p', { class: 'summary-intro' }, 'What you worked on — not summarized yet:'));
    for (const g of groups) {
      body.append(h('div', { class: 'sgroup' },
        h('div', { class: 'sgroup-name' }, g.name),
        h('ul', { class: 'slines is-plain' }, g.items.map((it) => h('li', null,
          h('span', { class: 'sline-title' }, it.title),
          it.msgs && notSent(it) ? h('span', { class: 'sline-ask' }, ` — ${notSent(it)}`)
            : it.prompt ? h('span', { class: 'sline-ask' }, ` — ${truncate(it.prompt, 100)}`) : null)))));
    }
  } else {
    for (const g of groups) {
      const lines = [];
      for (const it of g.items) {
        const c = chats[it.sessionId];
        if (c && c.lines && c.lines.length) for (const l of c.lines) lines.push(h('li', null, l));
        else if (it.msgs && notSent(it)) lines.push(h('li', { class: 'is-pending' }, icon('info', 13), h('span', null, `${it.title} — ${notSent(it)}`)));
        else if (it.msgs) lines.push(h('li', { class: 'is-pending' }, icon('plus', 13), h('span', null, `${it.title} — not in the summary yet`)));
      }
      if (lines.length) body.append(h('div', { class: 'sgroup' }, h('div', { class: 'sgroup-name' }, g.name), h('ul', { class: 'slines' }, lines)));
    }
  }
  const mine = (saved && saved.manual) || [];
  if (mine.length) {
    body.append(h('div', { class: 'sgroup' }, h('div', { class: 'sgroup-name' }, 'Added by you'),
      h('ul', { class: 'slines' }, mine.map((m) => h('li', null, m.text)))));
  }
  if (st.state !== 'none' || mine.length) {
    body.append(h('p', { class: 'summary-hint' }, icon('table', 14),
      h('span', null, 'Edit these lines, or add your own, in the sheet.'),
      h('button', { type: 'button', class: 'link-btn', onclick: () => app.go(`#/week/${weekOf(row.key)}`) }, 'Open the week’s sheet')));
  }
  if (!can) {
    body.append(h('p', { class: 'summary-hint' }, icon('info', 14),
      h('span', null, app.summarizer.why || 'Set up a summarizer to write these lines.'),
      h('button', { type: 'button', class: 'link-btn', onclick: () => app.openSummarizerSettings() }, 'Set up')));
  }
  if (errors.has(row.key)) body.append(h('p', { class: 'summary-err', role: 'alert' }, errors.get(row.key)));

  return h('section', { class: `card summary-card${running ? ' is-running' : ''}`, 'aria-label': 'Summary', 'data-running': running ? '' : null },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('sparkles', 16), 'Summary'), badge, actions),
    body);
}

/** One lane per app active that day; each block is a stretch of one session. */
function activityStrip(app, row) {
  const dayStart = keyToDate(row.key).getTime();
  let h0 = Math.floor((row.from - dayStart) / 3600e3);
  let h1 = Math.ceil((row.to - dayStart) / 3600e3);
  if (h1 - h0 < 4) h1 = Math.min(24, h0 + 4);
  if (h1 - h0 < 4) h0 = Math.max(0, h1 - 4);
  const t0 = dayStart + h0 * 3600e3;
  const span = (h1 - h0) * 3600e3;
  const bySource = new Map();
  for (const it of row.items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  const order = [...Object.keys(APPS).filter((s) => bySource.has(s)), ...[...bySource.keys()].filter((s) => !APPS[s])];
  const open = app.state.reader && app.state.reader.kind === 'session' ? app.state.reader.id : null;
  const lanes = order.map((source) => h('div', { class: 'lane' },
    h('span', { class: 'lane-label' }, appMark(source), h('span', null, appOf(source).short)),
    h('div', { class: 'lane-track' }, bySource.get(source).flatMap((it) => {
      const s = app.view.getSession(it.sessionId);
      return ((s && s.dayBlocks.get(row.key)) || []).map((b) => h('button', {
        type: 'button',
        class: `lane-block src-${source}${open === it.sessionId ? ' is-open' : ''}`,
        style: { left: `${Math.max(0, ((b.start - t0) / span) * 100)}%`, width: `${Math.max(0.8, ((Math.min(b.end, t0 + span) - b.start) / span) * 100)}%` },
        title: `${it.title} · ${fmtClock(b.start)}–${fmtClock(b.end)}`,
        'aria-label': `${it.title}, ${fmtClock(b.start)} to ${fmtClock(b.end)}`,
        onclick: () => app.openSession(it.sessionId, { day: row.key, part: 'day' }),
      }));
    }))));
  const stepH = h1 - h0 > 10 ? 3 : h1 - h0 > 6 ? 2 : 1;
  const ticks = [];
  for (let hr = h0; hr <= h1; hr += stepH) {
    ticks.push(h('span', { class: 'tick', style: { left: `${((hr - h0) / (h1 - h0)) * 100}%` } }, String(hr % 24).padStart(2, '0')));
  }
  return h('section', { class: 'card strip-card', 'aria-label': 'When each app was active' },
    h('div', { class: 'lanes' }, lanes),
    h('div', { class: 'axis', 'aria-hidden': 'true' }, h('span'), h('div', { class: 'axis-track' }, ticks)));
}

function groupNode(app, row, g, repos = []) {
  return h('section', { class: 'fgroup' },
    h('div', { class: 'fgroup-head' }, icon(g.folder ? 'folder' : 'message', 15),
      // A folder's name opens it in Sessions: every chat and commit there, not just this day's.
      g.folder ? h('button', {
        type: 'button', class: 'fgroup-name link-btn', title: `${g.folder} — every chat here, in Sessions`, onclick: () => app.showFolder(g.folder),
      }, g.name) : h('span', { class: 'fgroup-name', title: 'Chats that didn’t start in a folder' }, g.name),
      h('span', { class: 'fgroup-time' }, fmtDuration(g.ms))),
    h('div', { class: 'cards' }, g.items.map((it) => sessionCard(app, row, it))),
    // One repo: "Commits"; a group of same-named folders in several repos: one list per repo, named.
    repos.map((repo) => {
      const list = commitsOfRepos(app.commits, [repo], row.key);
      return commitList(app, list, { title: repos.length > 1 && list.length ? `Commits in ${list[0].repoName}` : 'Commits' });
    }));
}

function sessionCard(app, row, it) {
  const s = app.view.getSession(it.sessionId);
  const open = app.state.reader && app.state.reader.kind === 'session' && app.state.reader.id === s.id;
  const card = cardButton(app, row, it, s, open);
  const act = app.resume ? app.resume(s) : null;
  if (!act) return card;
  // Pick it up again from here: Claude desktop (one click) and the command for Terminal.
  return h('div', { class: 'scard-wrap has-actions' }, card, resumeButtons(s, act));
}

function cardButton(app, row, it, s, open) {
  return h('button', {
    type: 'button', class: `scard${open ? ' is-open' : ''}`, 'aria-pressed': String(open),
    onclick: () => app.openSession(s.id, { day: row.key, part: 'day' }),
  },
  h('span', { class: 'scard-top' }, appMark(s.source), h('span', { class: 'scard-app' }, appOf(s.source).name),
    h('span', { class: 'scard-when' }, `${fmtClock(it.from)}–${fmtClock(it.to)}`)),
  h('span', { class: 'scard-title' }, s.title),
  it.prompt ? h('span', { class: 'scard-ask' }, `“${truncate(it.prompt, 160)}”`) : null,
  h('span', { class: 'scard-foot' },
    h('span', null, fmtDuration(it.ms)), h('span', null, plural(it.msgs, 'message')),
    s.dayKeys.length > 1 ? h('span', null, `day ${s.dayKeys.indexOf(row.key) + 1} of ${s.dayKeys.length}`) : null));
}

// ---------------------------------------------------------------------------
// A week
// ---------------------------------------------------------------------------

export function weekPage(app, monday) {
  const { summaries } = app.state;
  const keys = weekKeys(monday);
  const days = keys.map((k) => ({ key: k, row: app.rows.get(k) || null }));
  const active = days.map((d) => d.row).filter(Boolean);
  const total = active.reduce((t, r) => t + r.totalMs, 0);
  const ids = new Set(active.flatMap((r) => r.items.map((it) => it.sessionId)));
  const aiDays = Object.fromEntries(active.map((r) => [r.key, filteredSaved(summaries.days[r.key], r)]));
  const copyWeek = async () => {
    const ok = await copyText(sheetTsv(active, { days: aiDays, weeks: summaries.weeks }));
    showToast(ok ? 'Week copied — paste it into any spreadsheet' : 'Couldn’t copy');
  };
  const csv = () => downloadText(`throwbacks-week-${monday}.csv`, sheetCsv(active, { days: aiDays }), 'text/csv');
  const page = h('section', { class: 'page page-week' },
    h('header', { class: 'day-head' },
      h('div', null,
        h('div', { class: 'eyebrow' }, monday === mondayOf(todayKey()) ? 'This week' : monday === addDays(mondayOf(todayKey()), -7) ? 'Last week' : 'Week'),
        h('h1', { class: 'day-title' }, `${fmtDM(monday)} – ${fmtDM(addDays(monday, 6))}`),
        h('div', { class: 'day-sub' }, active.length
          ? [h('b', null, fmtDuration(total)), ` · ${plural(active.length, 'active day')} · ${plural(ids.size, 'session')}`,
            commitsSub(app, monday, addDays(monday, 6))]
          : ['No chats this week', commitsSub(app, monday, addDays(monday, 6))])),
      h('div', { class: 'day-actions' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: copyWeek, disabled: active.length ? null : true, title: 'Copy the week’s rows (and its summary) — they paste into any spreadsheet' },
          icon('copy', 15), 'Copy rows'),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: csv, disabled: active.length ? null : true }, icon('download', 15), 'CSV'))));
  if (active.length) page.append(recapCard(app, 'week', monday));
  const group = app.state.prefs.sheetGroup;
  page.append(...[sheetErrors(app, keys), active.length ? sheetGroupSwitch(app) : null,
    sheetGrid(app, days, { saved: (k) => aiDays[k], weekOf, weekRecap: () => null, group, total: 'Week total' }),
    sheetNote(group)].filter(Boolean));
  return page;
}

/** A month as one sheet: its days with chats, a summary and total per week. */
export function monthPage(app, monthKey) {
  const { summaries } = app.state;
  const first = `${monthKey}-01`;
  const keys = [];
  for (let k = first; k.startsWith(monthKey); k = addDays(k, 1)) keys.push(k);
  const days = keys.map((k) => ({ key: k, row: app.rows.get(k) || null }));
  const active = days.map((d) => d.row).filter(Boolean);
  const total = active.reduce((t, r) => t + r.totalMs, 0);
  const aiDays = Object.fromEntries(active.map((r) => [r.key, filteredSaved(summaries.days[r.key], r)]));
  const copyMonth = async () => {
    const ok = await copyText(sheetTsv(active, { days: aiDays, weeks: summaries.weeks }));
    showToast(ok ? 'Month copied — paste it into any spreadsheet' : 'Couldn’t copy');
  };
  const csv = () => downloadText(`throwbacks-month-${monthKey}.csv`, sheetCsv(active, { days: aiDays }), 'text/csv');
  const label = keyToDate(first).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const page = h('section', { class: 'page page-week page-month' },
    h('header', { class: 'day-head' },
      h('div', null,
        h('div', { class: 'eyebrow' }, monthKey === todayKey().slice(0, 7) ? 'This month' : 'Month'),
        h('h1', { class: 'day-title' }, label),
        h('div', { class: 'day-sub' }, active.length
          ? [h('b', null, fmtDuration(total)), ` · ${plural(active.length, 'active day')}`, commitsSub(app, first, keys[keys.length - 1])]
          : ['No chats this month', commitsSub(app, first, keys[keys.length - 1])])),
      h('div', { class: 'day-actions' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: copyMonth, disabled: active.length ? null : true, title: 'Copy the month’s rows — they paste into any spreadsheet' },
          icon('copy', 15), 'Copy rows'),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: csv, disabled: active.length ? null : true }, icon('download', 15), 'CSV'))));
  if (!active.length) {
    // Insights links every month with commits: show them, even with no chats.
    const commits = app.state.filter.plan ? [] : allCommits(app.commits, first, keys[keys.length - 1]);
    page.append(commits.length ? commitList(app, commits, { title: 'Commits', date: true, cap: 20 })
      : h('div', { class: 'card empty-card' }, h('p', null, 'No chats this month.')));
    return page;
  }
  const group = app.state.prefs.sheetGroup;
  page.append(...[recapCard(app, 'month', monthKey), sheetErrors(app, keys), sheetGroupSwitch(app),
    sheetGrid(app, days, {
      saved: (k) => aiDays[k], weekOf, showEmpty: false, group, total: 'Month total',
      weekRecap: (m) => (summaries.weeks[m] && summaries.weeks[m].text) || null,
    }),
    sheetNote(group)].filter(Boolean));
  return page;
}

/** Edits that couldn't be saved, by day. */
function sheetErrors(app, keys) {
  const errs = keys.map((k) => app.state.errors.get(`sheet:${k}`)).filter(Boolean);
  return errs.length ? h('p', { class: 'summary-err', role: 'alert' }, errs.join(' · ')) : null;
}

/**
 * A week's or a month's recap: written from its day summaries (any day not
 * summarized yet first — the recap window says how many before it starts),
 * editable in place, and marked when a day changed since.
 */
function recapCard(app, kind, key) {
  const { summaries, job, errors } = app.state;
  const days = recapDays(kind, key);
  const saved = summaries[kind === 'week' ? 'weeks' : 'months'][key];
  const st = weekSummaryState({ days: days.map((k) => ({ key: k })) }, summaries.days, saved).state;
  const running = job && job.kind === kind && job.key === key;
  const can = app.summarizer.enabled;
  const name = kind === 'week' ? 'week' : 'month';
  const Name = kind === 'week' ? 'Week' : 'Month';
  const rec = saved && saved.text ? recapEditor(app, kind, key, saved.text) : null;
  const actions = h('div', { class: 'card-actions' });
  if (rec && !running) {
    actions.append(h('button', {
      type: 'button', class: 'btn btn-small btn-ghost', 'data-focus': `recap-edit-${kind}`, 'aria-label': `Edit the ${name}’s recap`, onclick: () => rec.edit(),
    }, 'Edit'));
  }
  if (running) {
    actions.append(h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => app.stopJob() }, icon('stop', 14), 'Stop'));
  } else if (can) {
    actions.append(h('button', {
      type: 'button', class: 'btn btn-small btn-brand', disabled: job ? true : null, 'data-focus': `recap-${kind}`,
      title: `Summarize the days that aren’t yet, then write the ${name}’s recap`,
      onclick: () => openRecapDialog(app, { kind, key }),
    }, icon('sparkles', 15), st === 'none' ? `Recap the ${name}` : 'Update the recap'));
  }
  let badge = null;
  if (running) badge = h('span', { class: 'tag is-live' }, h('span', { class: 'spinner' }), job.note || 'Writing…');
  else if (st === 'stale') badge = h('span', { class: 'tag is-new' }, 'A day changed since');
  else if (st === 'current') badge = h('span', { class: 'tag' }, `Written ${fmtShort(dateKey(saved.updatedAt))} · ${providerLabel(saved.provider)}`);
  const body = rec
    ? rec.node
    : h('p', { class: 'summary-intro' }, can
      ? `Not written yet. A recap is a short version of the ${name}’s day summaries: a line, then each project’s points and what’s still open. Recap the ${name} writes any day that isn’t summarized first.`
      : `Not written yet. A recap is a short version of the ${name}’s day summaries; set up a summarizer to write one.`);
  return h('section', { class: `card week-card${running ? ' is-running' : ''}`, 'aria-label': `${Name} recap`, 'data-running': running ? '' : null },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('sparkles', 16), `${Name} recap`), badge, actions),
    body,
    app.state.filter.plan ? h('p', { class: 'summary-hint' }, icon('info', 14), `The ${name}’s recap covers every tool you send.`) : null,
    errors.has(`${kind}:${key}`) ? h('p', { class: 'summary-err', role: 'alert' }, errors.get(`${kind}:${key}`)) : null,
    errors.has(`edit:${kind}:${key}`) ? h('p', { class: 'summary-err', role: 'alert' }, errors.get(`edit:${kind}:${key}`)) : null);
}

/**
 * A week's or month's recap, drawn as its parts (a line, then each project's
 * points) — plain content, so it reads as itself. Edit (or a click on it)
 * opens its text in place: a line per row, "## " a project, "- " a point;
 * leaving it or ⌘/Ctrl+Enter saves, Esc undoes. {node, edit}.
 */
function recapEditor(app, kind, key, text) {
  const name = kind === 'week' ? 'Week' : 'Month';
  let editing = false;
  const view = (t) => {
    const v = recapView(t, 'week-recap is-edit');
    v.title = 'Click to edit';
    v.addEventListener('click', () => { if (!String(getSelection())) edit(); });  // a selection to copy isn't a click to edit
    return v;
  };
  const me = { node: view(text), edit };
  function edit() {
    if (editing) return;
    editing = true;
    const field = h('div', {
      class: 'week-recap recap-field', contenteditable: 'plaintext-only', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true',
      'aria-label': `${name} recap (## a project, - a point; ⌘ or Ctrl+Enter saves, Esc undoes)`,
    });
    field.textContent = text;
    let done = false;
    // Closed from the keyboard, the keyboard goes back to Edit; by a click elsewhere, it goes there.
    const close = (save, keep = false) => {
      if (done) return;
      done = true;
      editing = false;
      const now = field.innerText.replace(/\r\n?/g, '\n').trim();
      const next = view(save && now ? now : text);
      field.replaceWith(next);
      me.node = next;
      if (keep) document.querySelector(`[data-focus="recap-edit-${kind}"]`)?.focus({ preventScroll: true });
      if (save && now && now !== text) app.editRecap(kind, key, now);
    };
    field.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;  // an input method's Enter picks a word
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(true, true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false, true); }
    });
    // Pasted as plain text, its lines kept.
    field.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r\n?/g, '\n'));
    });
    // Leaving the window (another app, another tab) isn't leaving the field: it stays open.
    field.addEventListener('blur', () => { if (document.hasFocus()) close(true); });
    me.node.replaceWith(field);
    me.node = field;
    field.focus();
    getSelection().selectAllChildren(field);
    getSelection().collapseToEnd();
  }
  return me;
}
