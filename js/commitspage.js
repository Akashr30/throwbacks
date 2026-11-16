// commitspage.js — the Commits page (#/commits): every commit of yours in the
// repos your chats started in, in one place. On top, how many and who made
// them (you, or an AI tool) and a square per day — click one to go to that
// day; then week by week and month by month, each day's commits in columns:
// message (and branch) · who · repo · time · ID. Made by takes the plan
// bar's place (a commit belongs to no chat app); a repo and words narrow it.
// `#/commits/<day or month>` opens at that day (a day's, week's or month's
// commits line, Insights' months). It shows what /api/commits answered.

import { icon } from './icons.js';
import { commitRow, whoShares } from './commitview.js';
import { heatmapChart, shareBar } from './charts.js';
import { TOOLS, allCommits, whoMade, whoText, toolOf, matchCommit, commitBands, commitDayFor, sharePct } from './commits.js';
import { dateBand, addDays, homeShort } from './plans.js';
import { titleRow } from './topbar.js';
import { h, appMark, plural, relDay, fmtDMY, fmtMonth, fmtMonthYear, todayKey } from './ui.js';
import { dateKey, keyToDate, fmtDayLong } from './util.js';

/** Bands shown whole; an older one shows its newest days, then the rest on a click. */
const WHOLE_BANDS = 2;
const DAYS_SHOWN = 4;
/** A 12-hour clock ("04:24 PM") needs a wider time column than "16:24". */
const H12 = (() => {
  try { return !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12; } catch { return false; }
})();

/** The page's filters as they stand (a repo or tool that's gone since reads as all). */
function filters(app, all) {
  const v = app.state.commitView;
  const who = v.who === 'all' || v.who === 'you' || all.some((c) => toolOf(c.by) === v.who) ? v.who : 'all';
  const repo = v.repo && all.some((c) => c.repo === v.repo) ? v.repo : '';
  return { who, repo, q: v.q };
}

const toTop = () => {
  const box = document.getElementById('page-scroll');
  if (box) box.scrollTop = 0;
};

// ---------------------------------------------------------------------------
// The top bar: the title, a repo, words; then Made by
// ---------------------------------------------------------------------------

/** Each repo once, busiest first: its name ("~/Dev/etl" when two share a name) and how many commits. */
function repoChoices(all) {
  const by = new Map();
  for (const c of all) {
    if (!by.has(c.repo)) by.set(c.repo, { top: c.repo, name: c.repoName, n: 0 });
    by.get(c.repo).n++;
  }
  const list = [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const names = new Map();
  for (const r of list) names.set(r.name, (names.get(r.name) || 0) + 1);
  return list.map((r) => ({ ...r, label: names.get(r.name) > 1 ? homeShort(r.top) : r.name }));
}

export function commitsRow(app) {
  const all = allCommits(app.commits);
  const f = filters(app, all);
  const v = app.state.commitView;
  const repos = repoChoices(all);
  const select = repos.length > 1 ? h('select', { class: 'filter-select', 'aria-label': 'Repo', title: 'Show one repo’s commits' },
    h('option', { value: '' }, `All repos (${repos.length})`),
    repos.map((r) => h('option', { value: r.top, selected: f.repo === r.top ? true : null }, `${r.label} · ${r.n}`))) : null;
  if (select) {
    select.addEventListener('change', () => {
      v.repo = select.value;
      redrawMadeBy(app);
      app.renderPage();
      toTop();
    });
  }
  const input = h('input', {
    type: 'search', class: 'field', placeholder: 'Filter by message or ID', 'aria-label': 'Filter commits', value: v.q,
  });
  input.addEventListener('input', () => {
    v.q = input.value;
    redrawMadeBy(app);
    app.renderPage();
    toTop();
  });
  const row = titleRow(app, 'Commits', select, input);
  row.classList.add('is-commits');
  return row;
}

/** Made by: Anyone · You · each AI tool with commits here, each with how many the other filters leave. */
export function madeByBar(app) {
  const all = allCommits(app.commits);
  const f = filters(app, all);
  const count = (who) => all.filter((c) => matchCommit(c, { ...f, who })).length;
  const tools = Object.keys(TOOLS).filter((t) => all.some((c) => toolOf(c.by) === t));
  const chip = (id, label, mark, title, n = count(id)) => h('button', {
    type: 'button', class: `chip${f.who === id ? ' is-on' : ''}`, 'aria-pressed': String(f.who === id), title, 'data-focus': `madeby-${id}`,
    disabled: n || f.who === id ? null : true,  // none here with the repo and words chosen
    onclick: () => {
      app.state.commitView.who = id;
      redrawMadeBy(app, id);
      app.renderPage();
      toTop();
    },
  }, mark, label, h('span', { class: 'chip-n' }, String(n)));
  return h('div', { class: 'planbar madeby', id: 'madeby', role: 'toolbar', 'aria-label': 'Made by' },
    h('span', { class: 'madeby-label' }, 'Made by'),
    chip('all', 'Anyone', null, 'Every commit'),
    chip('you', 'You', null, 'No sign an AI made them: you, in a terminal or an editor'),
    ...tools.map((t) => chip(t, TOOLS[t].name, TOOLS[t].mark ? appMark(TOOLS[t].mark) : null,
      `The commits ${TOOLS[t].name} made, or probably made`)));
}

/** Redraw only Made by (its counts follow the other filters), keeping the keyboard on a chip. */
function redrawMadeBy(app, focus = null) {
  const old = document.getElementById('madeby');
  if (!old) return;
  const bar = madeByBar(app);
  old.replaceWith(bar);
  if (focus) bar.querySelector(`[data-focus="madeby-${focus}"]`)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function commitsPage(app) {
  const page = h('section', { class: `page page-commits${H12 ? ' is-12h' : ''}` });
  if (!app.commits) {
    page.append(h('div', { class: 'card empty-card' }, ...(app.state.commitsRead
      ? noCommits(app)
      : [h('p', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Reading your commits…')])));
    return page;
  }
  const all = allCommits(app.commits);
  if (!all.length) {
    page.append(h('div', { class: 'card empty-card' }, ...noCommits(app)));
    return page;
  }
  const f = filters(app, all);
  const list = all.filter((c) => matchCommit(c, f));
  if (!list.length) {
    page.append(h('div', { class: 'card empty-card' },
      h('p', null, f.q.trim() ? `No commits match “${f.q.trim()}”${f.who !== 'all' || f.repo ? ' here' : ''}.` : 'No commits here.'),
      h('div', { class: 'empty-actions' }, h('button', {
        type: 'button', class: 'btn btn-small', onclick: () => {
          Object.assign(app.state.commitView, { who: 'all', repo: '', q: '' });
          app.redrawTopbar();
          app.renderPage();
        },
      }, 'Show every commit'))));
    return page;
  }
  const oneRepo = !!f.repo || new Set(all.map((c) => c.repo)).size < 2;
  // The ID column fits the longest short ID shown: git makes them longer in a big repo (7, 10, 12…).
  page.style.setProperty('--crow-id-chars', String(Math.max(7, ...list.map((c) => (c.short || '').length))));
  page.append(summary(app, all, list, f), ...bands(app, list, { repo: !oneRepo, whole: !!f.q.trim() }));
  return page;
}

/** Why there's nothing: no server to read git with, or no commits of yours where your chats started. */
function noCommits(app) {
  if (app.state.sourceStatus === null) {
    return [h('p', null, 'Your commits are read by the app’s server.'),
      h('p', { class: 'muted' }, 'Start it with python3 serve.py — it reads your repos with git log, read-only.')];
  }
  return [h('p', null, 'No commits of yours in the folders your chats started in.'),
    h('p', { class: 'muted' }, 'Throwbacks reads the repos your chats started in (git log, read-only), since the first day of your history.')];
}

/** How many, who made them, and a square per day (click one to go to that day). */
function summary(app, all, list, f) {
  const who = whoMade(list);
  const ai = who.total - who.you;
  const first = list[list.length - 1].day;
  const noun = who.total === 1 ? 'commit' : 'commits';
  const tool = who.tools[0];
  const by = f.who === 'all' ? '' : f.who === 'you' ? ' by you'
    : !tool ? '' : tool.maybe === tool.n ? ` probably by ${tool.name}` : ` by ${tool.name}${tool.maybe ? ` (${tool.maybe} probably)` : ''}`;
  const repo = f.repo ? ` in ${list[0].repoName}` : '';
  const line = `${noun}${by}${repo} since ${fmtDMY(first)}${f.who === 'all' && ai ? ` · ${ai} by an AI tool (${sharePct(ai, who.total)}%)` : ''}`;
  const parts = whoShares(who);
  return h('section', { class: 'card csum', 'aria-label': 'Your commits' },
    h('div', { class: 'csum-top' }, h('span', { class: 'csum-num' }, String(who.total)), h('span', { class: 'csum-line' }, line)),
    parts.length > 1 ? shareBar(parts, who.total, (n) => plural(n, 'commit')) : null,
    heatmap(app, all, list));
}

/** Heatmap ranges, as Insights' are: the last 12 months, and each year when your commits span several. */
function heatmap(app, all, list) {
  const today = todayKey();
  const yearAgo = keyToDate(today);
  yearAgo.setDate(yearAgo.getDate() - 364);
  const ranges = [['last', 'Last 12 months', dateKey(yearAgo.getTime()), today]];
  const years = [...new Set(all.map((c) => c.day.slice(0, 4)))].sort().reverse();
  if (years.length > 1) for (const y of years) ranges.push([y, y, `${y}-01-01`, `${y}-12-31` < today ? `${y}-12-31` : today]);
  const v = app.state.commitView;
  const [id, label, from, to] = ranges.find((r) => r[0] === v.range) || ranges[0];
  const perDay = new Map();
  for (const c of list) if (c.day >= from && c.day <= to) perDay.set(c.day, (perDay.get(c.day) || 0) + 1);
  const days = [];
  for (let k = from; k <= to; k = addDays(k, 1)) {
    const n = perDay.get(k) || 0;
    days.push({ key: k, value: n, label: fmtDayLong(k), onClick: n ? () => jumpToDay(app, k) : null });
  }
  const sum = perDay.size ? `${plural(perDay.size, 'day')} with commits · click a square to go to that day` : 'No commits in this range';
  return h('div', { class: 'csum-heat' },
    ranges.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Heatmap range' }, ranges.map(([rid, text]) => h('button', {
      type: 'button', class: `seg-btn${rid === id ? ' is-on' : ''}`, 'aria-pressed': String(rid === id),
      onclick: () => { if (rid !== id) { v.range = rid; app.renderPage(); } },
    }, text))) : null,
    heatmapChart(days, (n) => plural(n, 'commit'), { todayKey: today, none: 'no commits', summary: sum, label: `Commits by day, ${label}: ${sum}` }));
}

/** This week, Earlier in <month>, then a band per month — each a link to its sheet. */
function bands(app, list, { repo, whole }) {
  const today = todayKey();
  // Commits link to the chats that made them whatever the tool filter shows (main.js shows all tools then).
  const any = { ...app, view: app.model };
  const open = app.state.commitView.open;
  return commitBands(list, (k) => dateBand(k, today)).map((b, i) => {
    const first = `${b.at.slice(0, 7)}-01`;
    const label = b.kind === 'week' ? 'This week' : b.kind === 'rest' ? `Earlier in ${fmtMonth(first)}` : fmtMonthYear(first);
    const sheet = b.kind === 'week' ? `#/week/${b.at}` : `#/month/${b.at}`;
    const cap = whole || i < WHOLE_BANDS || open.has(b.id) ? b.days.length : DAYS_SHOWN;
    const more = b.days.length - cap;
    return h('section', { class: 'cband', 'aria-label': label },
      h('h2', { class: 'section-title is-small' },
        h('button', {
          type: 'button', class: 'link-btn day-link', title: b.kind === 'week' ? 'Open this week’s sheet' : `Open ${fmtMonthYear(first)}’s sheet`,
          onclick: () => app.go(sheet),
        }, label),
        h('span', { class: 'count' }, String(b.n))),
      b.days.slice(0, cap).map((d) => dayBlock(any, d, repo)),
      more > 0 ? h('button', {
        type: 'button', class: 'link-btn cband-more', 'data-focus': `more-${b.id}`,
        onclick: () => {
          open.add(b.id);
          app.renderPage();
          document.querySelector(`#d-${b.days[cap].key} .crow-main, #d-${b.days[cap].key} .crow-id`)?.focus({ preventScroll: true });
        },
      }, `Show ${plural(more, 'more day', 'more days')} in ${fmtMonth(first)}`) : null);
  });
}

/** A day: its date, how many and who made them, Open day; then its commits in columns. */
function dayBlock(app, { key, commits }, repo) {
  const who = whoText(whoMade(commits));
  return h('section', { class: 'cday', id: `d-${key}`, 'aria-label': relDay(key) },
    h('div', { class: 'fgroup-head' },
      h('span', null, relDay(key)), h('span', { class: 'count' }, String(commits.length)),
      who ? h('span', { class: 'cday-who' }, who) : null,
      h('a', { class: 'link-btn cday-open', href: `#/day/${key}`, title: 'This day’s chats, its summary and these commits' }, 'Open day')),
    h('div', { class: 'commits' }, h('div', { class: 'crows' }, commits.map((c) => commitRow(app, c, { cols: true, repo })))));
}

/**
 * Go to a day's commits (a square, or a link): a folded month opens first.
 * `key` may be a day or a month; it lands on the newest day with commits on
 * or before it. False when there's nothing to go to (yet).
 */
export function jumpToDay(app, key, { smooth = true } = {}) {
  const all = allCommits(app.commits);
  const list = all.filter((c) => matchCommit(c, filters(app, all)));
  const day = commitDayFor(list, key);
  if (!day) return false;
  let block = document.getElementById(`d-${day}`);
  if (!block) {
    app.state.commitView.open.add(dateBand(day, todayKey()).id);
    app.renderPage();
    block = document.getElementById(`d-${day}`);
  }
  if (!block) return false;
  const glide = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  block.scrollIntoView({ behavior: glide ? 'smooth' : 'auto', block: 'start' });
  block.classList.add('is-flash');
  setTimeout(() => block.classList.remove('is-flash'), 1600);
  return true;
}
