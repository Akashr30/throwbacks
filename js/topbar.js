// topbar.js — the bar at the top of every page: on Today and Week the week
// strip (each day's ≈time as a little bar), a month calendar to jump
// further, and Day / Week; on the other pages their title and controls.
// Below it, on every page, the plan bar: All tools, then one chip per plan
// with chats, each with a ring for how much of its limit is used, and a
// menu with its apps and its usage. A chip filters every page.

import { icon } from './icons.js';
import { keyToDate, dateKey } from './util.js';
import { fmtDuration } from './time.js';
import { heatLevels } from './charts.js';
import { APPS, PLANS, appOf, plansPresent, planPct, weekKeys, mondayOf, addDays, stepDay } from './plans.js';
import { allCommits } from './commits.js';
import { liveProblem, loginNeeded, sourceLabel, plansKnown, LIVE_TOOLS, CURSOR_USAGE_URL } from './usage.js';
import {
  h, appMark, planMark, ring, usageBar, levelOf, fmtShort, fmtDM, fmtWd, fmtMonthYear,
  fmtReset, fmtAgo, todayKey, showToast, copyText,
} from './ui.js';

// ---------------------------------------------------------------------------
// The plan bar
// ---------------------------------------------------------------------------

export function planBar(app) {
  const { filter, popover } = app.state;
  const all = app.model.listSessions();
  const bar = h('div', { class: 'planbar', role: 'toolbar', 'aria-label': 'Filter by tool' },
    h('button', {
      type: 'button', class: `chip${filter.plan ? '' : ' is-on'}`, 'aria-pressed': String(!filter.plan),
      onclick: () => app.setFilter(null),
    }, 'All tools'));
  for (const p of plansPresent(all, plansKnown(app.state.usageInfo))) {
    const on = filter.plan === p.id;
    const u = app.usage[p.id];
    const pct = planPct(u);
    // A plan shown only for its usage (no chats loaded from it) opens its menu instead of filtering to nothing.
    const has = all.some((x) => appOf(x.source).plan === p.id);
    const label = on && filter.app ? `${p.name} · ${APPS[filter.app].short}` : p.name;
    const open = popover === p.id;
    const wrap = h('div', { class: `chip-wrap${on ? ' is-on' : ''}${open ? ' is-open' : ''}` },
      h('button', {
        type: 'button', class: 'chip plan-chip', 'aria-pressed': String(on),
        title: !has ? `${p.name} usage${pct == null ? '' : ` · ${pct}% of its tightest limit used`}`
          : pct == null ? `Show only ${p.name}` : `Show only ${p.name} · ${pct}% of its tightest limit used`,
        onclick: has ? () => app.setFilter(on && !filter.app ? null : p.id) : (e) => { e.stopPropagation(); app.togglePopover(p.id); },
      }, planMark(p.id), h('span', { class: 'chip-label' }, label),
      ring(pct, 16), pct != null ? h('span', { class: `chip-pct is-${levelOf(pct)}` }, `${pct}%`) : null),
      h('button', {
        type: 'button', class: 'chip-more', 'aria-label': `${p.name}: apps and usage`, 'aria-expanded': String(open),
        onclick: (e) => { e.stopPropagation(); app.togglePopover(p.id); },
      }, icon('chevron-down', 14)));
    if (open) wrap.append(planMenu(app, p, all));
    bar.append(wrap);
  }
  return bar;
}

/** Usage windows as bars: label, %, what it is, when it resets. */
export function usageWindows(u) {
  return u.windows.map((w) => h('div', { class: 'uwin' },
    h('div', { class: 'uwin-top' }, h('span', { class: 'uwin-label' }, w.label), h('span', { class: `uwin-pct is-${levelOf(w.pct)}` }, `${w.pct}%`)),
    usageBar(w.pct),
    h('div', { class: 'uwin-foot' }, h('span', null, w.detail),
      // No reset time saved (Claude desktop's numbers): when it has reset at the latest.
      h('span', null, w.resetsAt ? fmtReset(w.resetsAt) : w.until ? fmtReset(w.until).replace(/^resets /, 'resets by ') : ''))));
}

/**
 * The one command that logs a plan's tool in again, as a button that copies it —
 * shown wherever that login problem is (null when there's none).
 */
export function loginCopy(info, planId) {
  const fix = loginNeeded(info, planId);
  if (!fix) return null;
  return h('button', {
    type: 'button', class: 'btn btn-small login-copy', 'data-focus': `login-copy-${planId}`,
    title: `Copy it, then paste it into Terminal to log ${fix.app} in again`,
    onclick: async () => showToast((await copyText(fix.command)) ? 'Copied — paste it into Terminal' : 'Couldn’t copy'),
  }, icon('copy', 15), h('code', null, fix.command));
}

/** Who updates numbers read earlier, by where they came from. */
const AGAIN = {
  statusline: 'your next Claude Code reply in a terminal updates it',
  claudecode: 'Claude Code updates it when it checks your usage',
  desktop: 'Claude desktop updates it when it checks your usage',
};

/** One line on where a plan's numbers stand. `here`: said on the Settings page itself. */
export function usageNote(app, planId, { here = false } = {}) {
  const u = app.usage[planId];
  const info = app.state.usageInfo;
  const plan = info.plans && info.plans[planId];
  const tool = LIVE_TOOLS[planId];
  if (info.sample) return 'Sample data — the usage meter is off here, so nothing of yours is read or asked.';
  if (u) {
    const live = planId === 'claude' ? info.source === 'live' : plan && plan.source === 'live';
    const when = u.asOf ? fmtAgo(u.asOf) : 'earlier';
    const again = live ? 'Throwbacks asks again when you come back'
      : planId === 'chatgpt' ? 'your next Codex reply updates it' : AGAIN[info.source] || AGAIN.statusline;
    const gone = u.expired.length ? ` ${u.expired.map((w) => w.label).join(' and ')} reset since then — ${again}.` : '';
    const lag = planId === 'chatgpt' && !live ? ' (as of Codex’s last reply)' : '';
    const failed = live ? null : liveProblem(info, planId);  // a failed ask, beside the older numbers
    return `${failed ? `${failed} ` : ''}${sourceLabel(info, planId)} · ${when}${lag}.${gone}`;
  }
  if (!info.available) return 'The usage meter needs the app’s server (python3 serve.py --claude).';
  if (planId === 'cursor') {
    if (plan && plan.signedOut) return 'Cursor is signed out on this Mac — and it doesn’t share its usage with other apps anyway: see it on Cursor’s site.';
    const seen = plan && plan.seenAt ? ` (${fmtAgo(plan.seenAt)})` : '';
    const name = plan && plan.plan ? `Cursor last saved your plan as ${plan.plan}${seen}. ` : '';
    return `${name}Cursor doesn’t share its usage with other apps — see it on Cursor’s site.`;
  }
  if (planId !== 'claude' && (!plan || !tool)) return `${planById(planId)} doesn’t hand its usage to other apps yet, so there’s no ring.`;
  if (planId !== 'claude' && !plan.found) return NOT_FOUND[planId];
  if (info.ask && info.ask[planId] === false) {
    return here ? `Not asking ${tool.app} — turn on “${tool.ask}” below.` : `Not asking ${tool.app} — turn it on in Settings → Usage meter.`;
  }
  if (planId === 'copilot' && plan.pooled) return 'Your organisation pools its Copilot AI credits, so GitHub gives no per-person number.';
  const problem = liveProblem(info, planId);
  if (problem) return problem;
  if (planId !== 'claude' && plan.answered) {
    const names = plan.unlimited.map((k) => UNLIMITED[k] || k);
    return names.length ? `${tool.app} reports no limit on ${names.join(' or ')}, so there’s no ring.` : `${tool.app} answered, but reported no limits for this plan.`;
  }
  if (planId === 'claude' && info.data === 'missing') return 'Claude Code isn’t reporting plan usage for this login (an API key has no plan limits).';
  const enabled = planId === 'claude' ? info.live.enabled : plan.enabled;
  if (enabled) return `Asking ${tool.app}…`;
  if (planId === 'claude' && info.setup === 'on') return 'Waiting for your next reply in Claude Code (in a terminal).';
  if (planId !== 'claude' && !plan.cli && info.live.enabled) return NO_COMMAND[planId];
  return `Start the server with python3 serve.py --claude to ask ${tool.app}.`;
}
const UNLIMITED = { premium: 'premium requests', chat: 'chat', completions: 'completions' };
const NOT_FOUND = {
  copilot: 'Copilot CLI isn’t installed on this Mac (the copilot command) — once it is, Throwbacks asks it for your allowance.',
  chatgpt: 'Codex isn’t installed on this Mac yet. Once you use it, its 5-hour and weekly limits show here, read from its own session files.',
  google: 'The Antigravity CLI (agy) isn’t installed on this Mac yet. Once it is, turn on Ask on its row in Settings → Usage meter and your quota shows here.',
};
const NO_COMMAND = {
  copilot: 'Throwbacks can’t find the copilot command where it looks — start the server with COPILOT_BIN=<its path>.',
  chatgpt: 'Throwbacks can’t find the codex command where it looks — start the server with CODEX_BIN=<its path> to ask Codex.',
  google: 'Throwbacks can’t find the agy command where it looks — start the server with AGY_BIN=<its path>.',
};
const planById = (id) => (PLANS.find((p) => p.id === id) || { name: id }).name;

function planMenu(app, p, all) {
  const { filter } = app.state;
  const counts = new Map(p.apps.map((id) => [id, all.filter((s) => s.source === id).length]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const pick = (id) => h('button', {
    type: 'button',
    class: `pop-app${filter.plan === p.id && (filter.app || null) === id ? ' is-on' : ''}`,
    onclick: () => { app.togglePopover(null); app.setFilter(p.id, id); },
  }, id ? appMark(id) : planMark(p.id),
  h('span', { class: 'pop-app-name' }, id ? APPS[id].name : `All ${p.name} apps`),
  h('span', { class: 'pop-app-n' }, String(id ? counts.get(id) : total)));
  const u = app.usage[p.id];
  return h('div', { class: 'popover plan-menu', role: 'dialog', 'aria-label': `${p.name} plan`, onclick: (e) => e.stopPropagation() },
    h('div', { class: 'pop-head' }, planMark(p.id), h('span', null, `${p.name} plan`)),
    // A plan shown only for its usage (Codex, Antigravity: no chat reader yet) has no apps to pick.
    total ? h('div', { class: 'pop-apps' }, pick(null), p.apps.filter((id) => counts.get(id)).map(pick)) : null,
    h('div', { class: 'pop-usage' },
      h('div', { class: 'pop-sub' }, 'Usage'),
      u ? usageWindows(u) : null,
      h('p', { class: 'pop-note' }, usageNote(app, p.id)),
      loginCopy(app.state.usageInfo, p.id),
      p.id === 'cursor'
        ? h('a', { href: CURSOR_USAGE_URL, target: '_blank', rel: 'noopener noreferrer', class: 'link-btn' }, 'Cursor’s usage page')
        : !u ? h('a', { href: '#/settings', class: 'link-btn', onclick: () => app.togglePopover(null) }, 'Usage meter settings') : null));
}

// ---------------------------------------------------------------------------
// Today / Week: the week strip
// ---------------------------------------------------------------------------

export function weekNav(app, key, page) {
  const monday = mondayOf(key);
  const keys = weekKeys(monday);
  const rows = keys.map((k) => app.rows.get(k) || null);
  const max = Math.max(3 * 3600e3, ...rows.map((r) => (r ? r.totalMs : 0)));
  const today = todayKey();
  const days = app.view.dayKeys;
  const step = page === 'week'
    ? [`#/week/${addDays(monday, -7)}`, `#/week/${addDays(monday, 7)}`, 'Previous week', 'Next week']
    : [stepDay(days, key, -1), stepDay(days, key, 1)].map((k) => k && `#/day/${k}`)
      .concat(['Previous day with chats', 'Next day with chats']);
  const strip = h('div', { class: 'weekstrip', role: 'group', 'aria-label': `Week of ${fmtDM(monday)}` },
    keys.map((k, i) => {
      const r = rows[i];
      const sel = page === 'day' && k === key;
      return h('button', {
        type: 'button',
        class: `wday${k === today ? ' is-today' : ''}${sel ? ' is-sel' : ''}${r ? '' : ' is-idle'}`,
        'aria-current': sel ? 'date' : null,
        title: r ? `${fmtShort(k)} · ${fmtDuration(r.totalMs)}` : `${fmtShort(k)} · no chats`,
        onclick: () => app.go(`#/day/${k}`),
      },
      h('span', { class: 'wday-name' }, fmtWd(k)),
      h('span', { class: 'wday-num' }, String(Number(k.slice(8)))),
      h('span', { class: 'wday-bar', style: { '--h': String(r ? Math.max(0.12, r.totalMs / max) : 0) } }));
    }));
  const stepBtn = (href, label, name) => h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': label, title: `${label} (${name === 'chevron-left' ? '←' : '→'})`,
    disabled: href ? null : true, onclick: () => href && app.go(href),
  }, icon(name, 18));
  const calOpen = app.state.popover === 'calendar';
  const cal = h('div', { class: `cal-wrap${calOpen ? ' is-open' : ''}` },
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Pick a day', title: 'Pick a day', 'aria-expanded': String(calOpen),
      onclick: (e) => { e.stopPropagation(); app.state.calMonth = monthOf(key); app.togglePopover('calendar'); },
    }, icon('calendar', 18)),
    calOpen ? monthPicker(app, key) : null);
  const isHome = page === 'day' && key === app.homeKey();
  return h('div', { class: 'topbar-row' },
    h('div', { class: 'weeknav' }, stepBtn(step[0], step[2], 'chevron-left'), strip, stepBtn(step[1], step[3], 'chevron-right'), cal),
    h('div', { class: 'topbar-actions' },
      isHome ? null : h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => app.go('#/today') }, 'Today'),
      viewSeg(app, page, { day: () => app.go(`#/day/${pickDayIn(app, keys)}`), week: () => app.go(`#/week/${monday}`), month: () => app.go(`#/month/${monthFor(page, key, keys)}`) }),
      refreshButton(app)));
}

/** The month to open from a day (its own) or a week (today's if it's in it, else the month most of it is in). */
function monthFor(page, key, keys) {
  if (page === 'day') return key.slice(0, 7);
  const t = todayKey();
  return (keys.includes(t) ? t : keys[3]).slice(0, 7);
}

/** Day · Week · Month — the same journal, at three scales (Week and Month are the sheet). */
function viewSeg(app, page, to) {
  const btn = (id, label) => h('button', {
    type: 'button', class: `seg-btn${page === id ? ' is-on' : ''}`, 'aria-pressed': String(page === id), onclick: () => page !== id && to[id](),
  }, label);
  return h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, btn('day', 'Day'), btn('week', 'Week'), btn('month', 'Month'));
}

/** The Month page's bar: ‹ the month › and Day / Week / Month. */
export function monthNav(app, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const at = (n) => {
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const first = `${monthKey}-01`;
  const days = app.view.dayKeys.filter((k) => k.startsWith(monthKey));
  // Day and Week go back to the day you came from when it's in this month, else to its last day with chats.
  const back = app.state.lastDay && app.state.lastDay.startsWith(monthKey) ? app.state.lastDay : days.length ? days[days.length - 1] : first;
  const stepBtn = (n, name, title) => h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': title, title: `${title} (${n < 0 ? '←' : '→'})`, onclick: () => app.go(`#/month/${at(n)}`),
  }, icon(name, 18));
  const thisMonth = todayKey().slice(0, 7);
  return h('div', { class: 'topbar-row' },
    h('div', { class: 'weeknav' }, stepBtn(-1, 'chevron-left', 'Previous month'),
      h('span', { class: 'month-label' }, label), stepBtn(1, 'chevron-right', 'Next month')),
    h('div', { class: 'topbar-actions' },
      monthKey === thisMonth ? null : h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => app.go(`#/month/${thisMonth}`) }, 'This month'),
      viewSeg(app, 'month', {
        day: () => app.go(`#/day/${back}`),
        week: () => app.go(`#/week/${mondayOf(back)}`),
        month: () => {},
      }),
      refreshButton(app)));
}

const monthOf = (key) => {
  const d = keyToDate(key);
  return { y: d.getFullYear(), m: d.getMonth() };
};

/** The day Day opens from a week: the one you came from, if it's in this week; else today; else its last day with chats. */
function pickDayIn(app, keys) {
  if (app.state.lastDay && keys.includes(app.state.lastDay)) return app.state.lastDay;
  const t = todayKey();
  if (keys.includes(t)) return t;
  const active = keys.filter((k) => app.rows.has(k));
  return active.length ? active[active.length - 1] : keys[0];
}

/** A month of days, shaded by ≈time (the old Days tab's calendar). */
function monthPicker(app, key) {
  const { y, m } = app.state.calMonth || monthOf(key);
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(y, m + 1, 0).getDate();
  const keys = Array.from({ length: daysIn }, (_, i) => dateKey(new Date(y, m, i + 1).getTime()));
  const levels = heatLevels(keys.map((k) => (app.rows.get(k) ? app.rows.get(k).totalMs : 0)));
  const today = todayKey();
  const move = (delta) => {
    const d = new Date(y, m + delta, 1);
    app.state.calMonth = { y: d.getFullYear(), m: d.getMonth() };
    app.redrawTopbar();
  };
  const latest = app.view.maxDayKey;
  // A day with only commits opens too (all tools only: commits belong to no tool).
  const commits = new Map();
  if (!app.state.filter.plan) for (const c of allCommits(app.commits, keys[0], keys[keys.length - 1])) commits.set(c.day, (commits.get(c.day) || 0) + 1);
  return h('div', { class: 'popover cal-pop', role: 'dialog', 'aria-label': 'Pick a day', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => move(-1) }, icon('chevron-left', 16)),
      h('span', { class: 'cal-title' }, fmtMonthYear(dateKey(first.getTime()))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', onclick: () => move(1) }, icon('chevron-right', 16))),
    h('div', { class: 'cal-grid' },
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'cal-wd' }, d)),
      Array.from({ length: lead }, () => h('span')),
      keys.map((k, i) => {
        const r = app.rows.get(k);
        const n = commits.get(k) || 0;
        return h('button', {
          type: 'button',
          class: `cal-day lv-${levels[i]}${k === today ? ' is-today' : ''}${k === key ? ' is-sel' : ''}${n ? ' has-commits' : ''}`,
          disabled: r || n ? null : true,
          title: [fmtShort(k), r ? fmtDuration(r.totalMs) : null, n ? `${n} commit${n === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
          onclick: () => { app.togglePopover(null); app.go(`#/day/${k}`); },
        }, String(i + 1));
      })),
    latest ? h('button', {
      type: 'button', class: 'btn btn-small btn-ghost cal-latest',
      onclick: () => { app.state.calMonth = monthOf(latest); app.redrawTopbar(); },
    }, 'Latest month') : null);
}

export function refreshButton(app) {
  return app.canRefresh()
    ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Refresh', title: 'Re-read your apps’ chats', onclick: () => app.refresh() }, icon('refresh', 17))
    : null;
}

// ---------------------------------------------------------------------------
// The other pages' first row
// ---------------------------------------------------------------------------

export function titleRow(app, title, ...extra) {
  return h('div', { class: 'topbar-row' },
    h('h1', { class: 'top-title' }, title),
    h('div', { class: 'topbar-actions' }, extra, refreshButton(app)));
}

export function sessionsRow(app) {
  const input = h('input', {
    type: 'search', class: 'field', placeholder: 'Filter by name or folder', 'aria-label': 'Filter sessions',
    value: app.state.sessQ,
  });
  input.addEventListener('input', () => { app.state.sessQ = input.value; app.renderPage(); });
  const group = app.state.prefs.group;
  return titleRow(app, 'Sessions',
    input,
    // Tree: the folders (saved as 'folder'); Cards: every chat as a card, newest first ('date', its old name).
    // No Tool: the plan bar narrows every page to a tool already.
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Show sessions as' },
      [['folder', 'Tree', 'Your folders, each opening to its chats'], ['date', 'Cards', 'Every chat as a card, newest first']].map(([id, label, title]) => h('button', {
        type: 'button', class: `seg-btn${group === id ? ' is-on' : ''}`, 'aria-pressed': String(group === id), title, 'data-focus': `sessions-${label.toLowerCase()}`,
        onclick: () => app.setSessionsView(id),
      }, label))));
}

export function searchRow(app) {
  const input = h('input', {
    type: 'search', class: 'field field-big', id: 'search-input',
    placeholder: 'Search every message and title', 'aria-label': 'Search messages and session titles',
    value: app.state.searchQ,
  });
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { app.state.searchQ = input.value; app.renderPage(); }, 200);
  });
  return h('div', { class: 'topbar-row' }, h('label', { class: 'search-wrap' }, icon('search', 18), input));
}

/** "Showing Copilot apps only" — when a filter is on. */
export function appsOf(planId) {
  return PLANS.find((p) => p.id === planId).apps.map((id) => appOf(id).short).join(' · ');
}
