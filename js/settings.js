// settings.js — the Settings page: your chats (the app tiles, files and
// folders, Refresh, Clear), the usage meter (each plan in one row: where it
// stands, the one thing to do, its switch — Throwbacks never edits Claude
// Code's settings itself), AI summaries (the summarizer, the end of day, a
// range summary, the history), Appearance, and Privacy. Each card says only
// that much; how things work folds into one line per card, and a fold stays
// open across the page's redraws. Beside the cards on a wide page, an
// overview: each card's status in a few words, a click scrolling to it, and
// it follows the card you're reading. On a phone, just the cards.

import { icon } from './icons.js';
import { PROVIDERS } from './summarize.js';
import { renderSourceGrid, importableIds } from './sources.js';
import { renderAppearance, appearanceLine } from './theme.js';
import { h, copyText, showToast, fmtAgo, planMark, plural, appMark } from './ui.js';
import { APPS } from './plans.js';
import { usageWindows } from './topbar.js';
import { liveShort, sourceLabel, LIVE_TOOLS, CURSOR_USAGE_URL } from './usage.js';
import { retentionOf, SAFE_DAYS } from './keep.js';

/** The folds you opened (this tab only): the page redraws when usage answers or something loads. */
const openFolds = new Set();

function card(id, title, iconName, actions, ...kids) {
  return h('section', { class: 'card set-card', id: `set-${id}`, 'aria-label': title, tabindex: '-1', 'data-focus': `card-${id}` },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon(iconName, 16), title),
      actions ? h('div', { class: 'card-actions' }, actions) : null),
    kids);
}

/** One line that opens to the explanations — and stays open when the page redraws. */
function fold(key, label, ...kids) {
  const d = h('details', { class: 'set-fold', open: openFolds.has(key) || null },
    h('summary', { 'data-focus': `fold-${key}` }, label), h('div', { class: 'set-fold-body' }, kids));
  d.addEventListener('toggle', () => (d.open ? openFolds.add(key) : openFolds.delete(key)));
  return d;
}

/** A status: a dot, a few words, and under them the one thing to do (`code` in backticks). */
function status(level, text, fix = null) {
  return h('div', { class: `set-st is-${level}` }, h('span', { class: 'status-dot' }),
    h('span', { class: 'set-st-text' }, h('span', null, text), fix ? h('span', { class: 'set-fix' }, withCode(fix)) : null));
}
const withCode = (text) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? h('code', null, part) : part));

export function settingsPage(app) {
  const plans = usageRows(app);
  const cards = [chatsCard(app), usageCard(app, plans), summariesCard(app), appearanceCard(app), privacyCard(app)];
  const page = h('section', { class: 'page page-settings' },
    h('div', { class: 'set-split' }, overview(app, plans), h('div', { class: 'set-cards' }, cards)));
  setTimeout(followCards, 0);  // once it's on the page: mark the card in view
  return page;
}

// ---- The overview: each card's status, a click scrolling to it ------------------

function overview(app, plans) {
  const entries = [
    ['chats', 'Your chats', 'layers', ...chatsState(app)],
    ['usage', 'Usage meter', 'gauge', ...usageState(app, plans)],
    ['summaries', 'AI summaries', 'sparkles', ...summariesState(app)],
    ['appearance', 'Appearance', 'palette', null, appearanceLine()],
    ['privacy', 'Privacy', 'lock', null, 'Read-only · no uploads'],
  ];
  return h('nav', { class: 'set-overview', 'aria-label': 'Settings sections' }, entries.map(([id, name, ic, level, text]) => h('button', {
    type: 'button', class: 'set-ov', 'data-sec': id, 'data-focus': `ov-${id}`,
    onclick: () => {
      const target = document.getElementById(`set-${id}`);
      if (!target) return;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
      held = id;  // a card near the end can't reach the top: it stays the one marked until you scroll yourself
      mark(id);
    },
  }, icon(ic, 18), h('span', { class: 'set-ov-name' }, name),
  h('span', { class: `set-ov-st${level ? ` is-${level}` : ''}`, 'data-ov': id }, level ? h('span', { class: 'status-dot' }) : null, text))));
}

function mark(id) {
  for (const b of document.querySelectorAll('.set-overview .set-ov')) {
    const on = b.dataset.sec === id;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
}

/**
 * The card you're reading: the last whose top has passed the top of the page
 * (the last one once you've scrolled to the end) — or the one you clicked in
 * the overview, until you scroll yourself.
 */
function followCards() {
  const box = document.getElementById('page-scroll');
  const cards = [...document.querySelectorAll('.set-cards > .set-card')];
  if (!box || !cards.length || !document.querySelector('.set-overview')) return;
  if (held && document.getElementById(`set-${held}`)) {
    mark(held);
    return;
  }
  const top = box.getBoundingClientRect().top + 80;
  const atEnd = box.scrollHeight > box.clientHeight + 4 && box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  const here = atEnd ? cards[cards.length - 1] : cards.filter((c) => c.getBoundingClientRect().top <= top).pop() || cards[0];
  mark(here.id.replace(/^set-/, ''));
}
let held = null;      // the card clicked in the overview
let followed = null;  // the page box the scroll listener is on (the journal's is made again after Clear)
function followOnScroll() {
  const box = document.getElementById('page-scroll');
  if (!box || followed === box) return;
  followed = box;
  box.addEventListener('scroll', () => { if (document.querySelector('.set-overview')) followCards(); }, { passive: true });
  // You scrolling (not the click's own glide) lets the mark follow again.
  for (const ev of ['wheel', 'touchstart', 'keydown']) box.addEventListener(ev, () => { held = null; }, { passive: true });
}

// ---- Your chats --------------------------------------------------------------

function chatsCard(app) {
  followOnScroll();
  const { sourceStatus, imported, busy, loadError } = app.state;
  const grid = h('div', { class: 'source-grid' });
  renderSourceGrid(grid, { status: sourceStatus, loaded: imported, onPick: (src, action) => app.pickSource(src, action) });
  // The apps Throwbacks can't read yet fold to one line.
  const later = grid.querySelector('.app-later');
  if (later) {
    const n = later.querySelectorAll('.app-later-chip').length;
    later.querySelector('.app-later-title')?.remove();
    const f = fold('later', `${n} more apps Throwbacks can’t read yet`);
    later.before(f);
    f.querySelector('.set-fold-body').append(later);
  }
  const n = importableIds(sourceStatus).length;
  const auto = app.state.prefs.auto;
  return card('chats', 'Your chats', 'layers', null,
    grid,
    h('div', { class: 'set-actions' },
      n > 1 ? h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => app.importAll() }, icon('layers', 15), `Load all ${n} apps`) : null,
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => app.chooseFile() }, icon('upload', 15), 'Choose file'),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => app.chooseFolder() }, icon('folder', 15), 'Choose folder'),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => app.addSample() }, icon('flask', 15), 'Add sample data'),
      app.canRefresh() ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => app.refresh() }, icon('refresh', 15), 'Refresh') : null),
    busy ? h('p', { class: 'set-busy', role: 'status' }, h('span', { class: 'spinner' }), busy) : null,
    loadError ? h('p', { class: 'summary-err', role: 'alert' }, loadError) : null,
    sourceStatus ? h('label', { class: 'set-check', title: 'Throwbacks reads every app it finds as it opens' },
      h('input', { type: 'checkbox', checked: auto || null, 'data-focus': 'set-auto', onchange: (e) => app.setPref('auto', e.target.checked) }),
      h('span', null, h('b', null, 'Open straight into my chats'))) : null,
    h('div', { class: 'set-row-line' }, historyLine(app),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost is-danger set-end', 'data-focus': 'set-clear', title: 'Forgets what’s loaded in this tab and goes back to the front page; your files are untouched', onclick: () => app.clearAll() },
        icon('trash', 15), 'Clear loaded data…')));
}

/** History safety: how long Claude Code keeps chats, and what's about to go (the Expiring page). */
function historyLine(app) {
  if (!app.keep) return h('span');
  const ret = retentionOf(app.keep);
  const ok = ret.paused || (ret.set && ret.days >= SAFE_DAYS);
  const whose = { managed: ' (your organisation’s setting)', project: ' (a project’s setting)', default: ' (its default)' }[ret.source] || '';
  const text = app.keep.sample ? `Sample data: a made-up ${ret.days}-day cleanup`
    : ret.paused ? 'Claude Code’s cleanup is paused'
      : ok ? `Claude Code keeps chats ${ret.days} days${whose}` : `Claude Code deletes chats after ${ret.days} days${whose}`;
  return h('p', { class: `set-status is-${ok && !app.due.length ? 'ok' : 'warn'}` }, h('span', { class: 'status-dot' }),
    h('span', null, text, app.due.length ? ` · ${app.due.length} ${app.due.length === 1 ? 'goes' : 'go'} this week` : ''), ' ',
    h('a', { class: 'link-btn', href: '#/expiring' }, 'Expiring and kept chats'));
}

function chatsState(app) {
  const { imported, busy, loadError, sampleLoaded } = app.state;
  if (busy) return ['wait', 'Loading…'];
  if (loadError) return ['warn', 'Something didn’t load'];
  if (app.due && app.due.length) return ['warn', `${app.due.length} deleted within a week`];
  if (imported.size) return ['ok', `${plural(imported.size, 'app')} loaded`];
  if (sampleLoaded) return ['ok', 'Sample data'];
  return [app.model && !app.model.isEmpty ? 'ok' : null, app.model && !app.model.isEmpty ? 'Chats loaded' : 'Nothing loaded'];
}

// ---- The usage meter -----------------------------------------------------------

const PLAN_NAME = { claude: 'Claude', copilot: 'Copilot', chatgpt: 'ChatGPT · Codex', google: 'Google AI · Antigravity', cursor: 'Cursor' };
/** What asking each tool involves (the switch's tooltip; said in full in How it works). */
const ASK_NOTES = {
  claude: 'Claude Code asks Anthropic for your 5-hour, weekly and per-model limits.',
  copilot: 'Copilot CLI asks GitHub for your monthly allowance. It also sends GitHub its own startup telemetry, which it can’t turn off.',
  chatgpt: 'Codex asks ChatGPT for your 5-hour and weekly limits, and may update its own files while it runs.',
  google: 'agy (1.1.11 or later) answers its /usage command itself, from Google.',
};
/** While a switch is off, what turning it on means — said on its row, where you choose. */
const OFF_NOTES = {
  chatgpt: 'Turn on Ask for live numbers — Codex may update its own files while it runs.',
  google: 'Only agy 1.1.11 or later is asked: older versions would send /usage to the model.',
};

const age = (ts) => (ts ? fmtAgo(ts) : 'earlier');
/** "last numbers from Claude desktop, 3 h ago": where Claude's saved numbers came from. */
const SAVED_FROM = { statusline: 'from the status line, ', claudecode: 'from Claude Code’s last check, ', desktop: 'from Claude desktop, ' };
const UNLIMITED = { premium: 'premium requests', chat: 'chat', completions: 'completions' };
const BIN = { copilot: ['copilot', 'COPILOT_BIN'], chatgpt: ['codex', 'CODEX_BIN'], google: ['agy', 'AGY_BIN'] };
/** " · Session and Week reset since" — limits past their reset since the reading. */
const resetSince = (usage) => (usage && usage.expired.length ? ` · ${usage.expired.map((w) => w.label).join(' and ')} reset since` : '');
/** A reading every limit of which has reset since: it says so, and isn't counted as up to date. */
const allReset = (usage) => !!usage && !usage.windows.length && usage.expired.length > 0;

/**
 * Each plan's row: where it stands in a few words ({level, text, fix}),
 * its bars when there are current numbers, and whether it has a switch.
 * "Asking…" only while a request for it is on its way (app.state.asking).
 * @returns {Array<{id, level, text, fix, usage, ask: boolean}>}
 */
function usageRows(app) {
  const u = app.state.usageInfo;
  if (!u.available || u.sample) return [];
  const rows = [];
  const asked = u.ask;
  const asking = app.state.asking || new Set();

  // Claude: live from Claude Code; else the newest numbers saved on this Mac (the status line's, Claude Code's last check, Claude desktop's).
  const reading = app.usage.claude;
  const short = liveShort(u);
  let st;
  if (u.source === 'live') st = [allReset(reading) ? 'off' : 'ok', `Live · ${age(u.live.at)}${resetSince(reading)}`];
  else if (short) st = ['warn', reading ? `${short.text} · last numbers ${SAVED_FROM[u.source] || ''}${age(reading.asOf)}${resetSince(reading)}` : short.text, short.fix];
  else if (reading) st = [allReset(reading) ? 'off' : 'ok', `${sourceLabel(u, 'claude')} · ${age(reading.asOf)}${resetSince(reading)}`];
  else if (u.live.enabled && asked.claude === false) st = ['off', 'Not asked'];
  else if (u.data === 'missing') st = ['warn', 'No plan usage reported', 'This login may use an API key, which has no plan limits.'];
  else if (u.live.enabled && asking.has('claude')) st = ['wait', 'Asking Claude Code…'];
  else if (u.live.enabled) st = ['off', 'Not asked yet', 'Check again asks it now.'];
  else if (u.setup === 'on') st = ['off', 'Waiting for your next reply in a terminal', 'The status line keeps the numbers after each reply there.'];
  else st = ['off', 'Live readings are off', 'Start the server with `python3 serve.py --claude`.'];
  rows.push({ id: 'claude', level: st[0], text: st[1], fix: st[2] || null, usage: reading && reading.windows.length ? reading : null, ask: true });

  // Copilot, ChatGPT (Codex), Google AI (Antigravity): shown even when not installed, so it's clear why there's nothing.
  for (const id of ['copilot', 'chatgpt', 'google']) {
    const plan = u.plans[id];
    if (!plan) continue;
    const usage = app.usage[id] || null;
    const tool = LIVE_TOOLS[id];
    const sh = liveShort(u, id);
    // Codex can be found by its session files with no codex command to ask: there's no switch then.
    const noCmd = plan.found && !plan.cli;
    const cmdNote = noCmd ? `No \`${BIN[id][0]}\` command found to ask: start the server with \`${BIN[id][1]}=<its path>\`.` : null;
    const offNote = plan.cli && asked[id] === false ? OFF_NOTES[id] || null : null;
    let r;
    if (usage) {
      const src = plan.source === 'local' ? 'From its own files' : plan.source === 'live' ? 'Live' : 'Last reading';
      r = sh ? ['warn', `${sh.text} · numbers from ${age(usage.asOf)}${resetSince(usage)}`, sh.fix]
        : [allReset(usage) ? 'off' : 'ok', `${src} · ${age(usage.asOf)}${resetSince(usage)}`, offNote || cmdNote];
    } else if (!plan.found) {
      r = ['off', { copilot: 'Copilot CLI isn’t installed', chatgpt: 'Codex isn’t installed', google: 'agy isn’t installed' }[id],
        { copilot: 'Once it is, Throwbacks asks it for your allowance.', chatgpt: 'Once you use it, its limits show here.', google: null }[id]];
    } else if (noCmd) r = ['off', 'Command not found', cmdNote];
    else if (asked[id] === false) r = ['off', 'Not asked', offNote];
    else if (id === 'copilot' && plan.pooled) r = ['off', 'Pooled by your organisation', 'GitHub gives no per-person number.'];
    else if (sh) r = ['warn', sh.text, sh.fix];
    else if (plan.answered) {
      const names = plan.unlimited.map((k) => UNLIMITED[k] || k);
      r = names.length ? ['ok', `Unlimited ${names.join(' and ')}`] : ['off', 'No limits reported', `${tool.app} answered without limits for this plan.`];
    } else if (plan.enabled && asking.has(id)) r = ['wait', `Asking ${tool.app}…`];
    else if (plan.enabled) r = ['off', 'Not asked yet', 'Check again asks it now.'];
    else r = ['off', 'Live readings are off', 'Start the server with `python3 serve.py --claude`.'];
    rows.push({ id, level: r[0], text: r[1], fix: r[2] || null, usage: usage && usage.windows.length ? usage : null, ask: !!plan.cli });
  }

  if (u.plans.cursor) {
    const c = u.plans.cursor;
    rows.push({ id: 'cursor', level: 'off', text: `${c.signedOut ? 'Signed out · ' : c.plan ? `${c.plan} plan · ` : ''}Cursor doesn’t share its usage`, fix: null, usage: null, ask: false });
  }
  return rows;
}

/** The overview's line: what needs you first, then what's being asked, then what's current. */
function usageState(app, rows) {
  const u = app.state.usageInfo;
  if (u.sample) return [null, 'Off for sample data'];
  if (!u.available) return [null, 'Needs the server'];
  const warn = rows.filter((r) => r.level === 'warn');
  if (warn.length) {
    const login = warn.every((r) => /^(Not logged in|No plan limits)/.test(r.text));
    return ['warn', `${warn.length} need${warn.length === 1 ? 's' : ''} ${login ? 'a login' : 'a look'}`];
  }
  if (rows.some((r) => r.level === 'wait')) return ['wait', 'Asking…'];
  // Up to date: what was just asked; numbers read earlier (the status line, Codex's files) only "shown".
  const fine = rows.filter((r) => r.level === 'ok');
  const live = fine.filter((r) => /^(Live|Unlimited)/.test(r.text));
  const names = (list) => list.map((r) => PLAN_NAME[r.id].split(' · ')[0]).join(', ');
  if (live.length) return ['ok', `${names(live)} up to date`];
  if (fine.length) return ['ok', `${names(fine)}: numbers shown`];
  return [null, u.live.enabled ? 'Nothing read yet' : 'Live readings off'];
}

function usageCard(app, rows) {
  const u = app.state.usageInfo;
  const check = h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'data-focus': 'set-check-usage', onclick: () => app.refreshUsage({ live: true }) }, icon('refresh', 15), 'Check again');
  if (!u.available || u.sample) {
    return card('usage', 'Usage meter', 'gauge', null, h('p', { class: 'set-note' }, u.sample
      ? 'Sample data — the usage meter is off here, so nothing of yours is read or asked. Open Throwbacks without ?sample to see your plans.'
      : 'The usage meter needs the app’s server: open Throwbacks through python3 serve.py --claude.'));
  }
  const asked = u.ask;
  const row = (r) => h('div', { class: 'set-plan-row' },
    h('span', { class: 'set-plan-name' }, planMark(r.id), PLAN_NAME[r.id]),
    status(r.level, r.text, r.fix),
    r.id === 'cursor'
      ? h('a', { href: CURSOR_USAGE_URL, target: '_blank', rel: 'noopener noreferrer', class: 'link-btn set-plan-end' }, 'Usage page ↗')
      : r.ask ? h('label', { class: 'set-plan-end', title: ASK_NOTES[r.id] },
        h('input', { type: 'checkbox', checked: asked[r.id] !== false || null, 'aria-label': LIVE_TOOLS[r.id].ask, 'data-focus': `ask-${r.id}`, onchange: (e) => app.setAsk(r.id, e.target.checked) }), 'Ask')
        : h('span'),
    r.usage ? h('div', { class: 'uplan-wins' }, usageWindows(r.usage)) : null);

  // The status line, Claude's backup: on, someone else's, or off (then how to turn it on, right here).
  const line = u.setup === 'on' ? 'on' : u.setup === 'other' ? 'other' : 'off';
  const backup = h('div', { class: 'set-plan-row' },
    h('span', { class: 'set-plan-name' }, icon('terminal', 16), 'Status line backup'),
    line === 'on' ? status('ok', 'On · keeps your terminal’s 5-hour and weekly numbers')
      : line === 'other' ? status('off', 'Another status line is set', `It runs: ${u.command || 'another command'}. Replacing it turns that one off.`)
        : status('off', 'Off', 'Turn it on to keep your terminal’s numbers when Claude Code isn’t asked.'),
    h('span'));
  const kids = [
    h('p', { class: 'set-lead' }, 'Each tool’s own app asks for your limits, with its own login. No AI request, nothing from your chats.'),
    h('div', { class: 'set-plans' }, rows.map(row), backup),
  ];
  if (line !== 'on' && u.snippet) {
    const text = JSON.stringify(u.snippet, null, 2).replace(/^\{\n|\n\}$/g, '');
    kids.push(
      h('p', { class: 'set-note' }, 'To turn it on, add this to ', h('code', null, u.settingsFile || '~/.claude/settings.json'),
        ' (Throwbacks only reads that file; it never changes it):'),
      h('pre', { class: 'set-code' }, text),
      h('div', { class: 'set-actions' },
        h('button', {
          type: 'button', class: 'btn btn-small', 'data-focus': 'set-copy-line',
          onclick: async () => showToast((await copyText(text)) ? 'Copied — paste it into the settings file' : 'Couldn’t copy'),
        }, icon('copy', 15), 'Copy')));
  }
  kids.push(fold('usage', 'How it works · what each tool sends',
    h('p', null, h('b', null, 'When it asks. '), 'When you open Throwbacks, and when you come back after 5 minutes — at most once a minute per tool. Each run is short, in an empty folder, with the tool’s own login: Throwbacks never sees a login. Needs the server started with ', h('code', null, '--claude'), '.'),
    h('p', null, h('b', null, 'Claude Code '), 'asks Anthropic for your 5-hour, weekly and per-model limits. ',
      h('b', null, 'Copilot CLI '), 'asks GitHub for your monthly allowance, and also sends GitHub its own startup telemetry, which it can’t turn off. ',
      h('b', null, 'Codex '), 'asks ChatGPT for your 5-hour and weekly limits, and may update its own files while it runs; with Ask off, its numbers come from its own session files, no network. ',
      h('b', null, 'agy '), 'is asked only from version 1.1.11: older ones would send /usage to the model.'),
    h('p', null, h('b', null, 'Cursor '), 'shares no usage with other apps: every way to its numbers means using its saved sign-in, which its terms forbid.'),
    h('p', null, h('b', null, 'When Claude Code can’t be asked '), '(its login lapsed, say), the newest Claude numbers already saved on this Mac show, with their age: the status line’s, Claude Code’s own copy of its last check (',
      h('code', null, '~/.claude.json'), ': only that entry is kept), or Claude desktop’s record of its own checks (its 5-hour and weekly numbers, no reset times). Read only, no login used, nothing sent.'),
    h('p', null, h('b', null, 'The status line '), '(Claude’s backup): in a terminal, Claude Code hands its 5-hour and weekly numbers to the status line after each reply. Throwbacks’ script keeps only those, in ',
      h('code', null, '~/.throwbacks/usage.json'), ', and shows them in the terminal’s footer (where it hides a few of Claude Code’s hints). It reads nothing else, sends nothing and uses no tokens; to undo it, delete its lines from the settings file.'),
    h('p', null, 'The plan menus on the bar above, and Insights, say the same in full sentences.')));
  return card('usage', 'Usage meter', 'gauge', check, kids);
}

// ---- AI summaries ----------------------------------------------------------------

function summariesState(app) {
  const s = app.summarizer;
  if (!s.enabled) return [null, 'Not set up'];
  const name = PROVIDERS[s.provider] ? PROVIDERS[s.provider].label.replace(/ \(.*\)$/, '') : s.provider;
  const auto = app.state.prefs.autoSummary;
  return ['ok', `${name} · ${auto.on ? `daily at ${auto.at}` : 'when you click'}`];
}

function summariesCard(app) {
  const s = app.summarizer;
  const auto = app.state.prefs.autoSummary;
  const where = app.state.summaries.where === 'files'
    ? ['They’re saved as small files in ', h('code', null, app.state.summaries.dir || '~/.throwbacks'), ' (daily/, weekly/, monthly/, periods/, and summaries/ for a chat’s), each with the tokens your summarizer said it used.']
    : ['They’re saved in this browser only.'];
  return card('summaries', 'AI summaries', 'sparkles', null,
    s.enabled ? status('ok', `On · ${PROVIDERS[s.provider] ? PROVIDERS[s.provider].label : s.provider}`) : status('off', 'Not set up', s.why || null),
    h('label', { class: 'set-check' },
      h('input', { type: 'checkbox', checked: auto.on || null, 'data-focus': 'set-eod', onchange: (e) => app.setAutoSummary(e.target.checked) }),
      h('span', null, h('b', null, 'Write each day’s summary at '), endOfDay(app, auto),
        h('span', { class: 'set-sub' }, 'While Throwbacks is open. Only what’s new is sent.'))),
    sendFrom(app),
    h('div', { class: 'set-actions' },
      h('button', { type: 'button', class: 'btn btn-small', 'data-focus': 'set-summarizer', onclick: () => app.openSummarizerSettings() }, icon('sparkles', 15), 'AI summarizer…'),
      h('a', { class: 'link-btn set-link', href: '#/summaries' }, 'Your summaries →')),
    fold('summaries', 'How it works',
      h('p', null, 'Summaries are written when you click Summarize — on a day, on a chat, or a recap of a week, a month or any dates (Summaries → Recap a period) — or at your end of day: today, and any of the last 7 days with chats not summarized yet. A recap is written from its days’ summaries, writing the missing days first; it says how many before it starts. Stop any of them from the bar that shows while it writes.'),
      h('p', null, 'Add new and the end-of-day run send only what’s new; Rewrite and a chat’s summary send all of theirs — to the summarizer you chose (your own API key, or Claude Code on this Mac: no key, ',
        h('code', null, 'python3 serve.py --claude'), '), on its quota. Whatever app a chat is from, this one summarizer writes it. The apps left out above are never sent by a day’s summary, a recap or the end-of-day run; a chat’s own Summarize still sends that chat when you click it.'),
      h('p', null, where)));
}

/**
 * Which apps' chats go to the summarizer: every app with chats here (and any
 * left out before); a left-out app's chats are never sent — by a day's
 * Summarize, a recap or the end-of-day run.
 */
function sendFrom(app) {
  const off = new Set(app.state.prefs.summaryOff || []);
  const here = new Set(app.model ? app.model.listSessions().map((s) => s.source) : []);
  const ids = Object.keys(APPS).filter((id) => here.has(id) || off.has(id));
  if (!ids.length) return null;
  return h('div', { class: 'set-send', role: 'group', 'aria-label': 'Send chats from' },
    h('span', { class: 'set-send-label' }, 'Send chats from'),
    ids.map((id) => h('label', { class: 'set-send-app', title: off.has(id) ? `${APPS[id].name}: left out of the day summaries and recaps (a chat’s own Summarize still sends that chat)` : `${APPS[id].name}: its chats are summarized` },
      h('input', {
        type: 'checkbox', checked: off.has(id) ? null : true, 'data-focus': `send-${id}`,
        onchange: (e) => app.setPref('summaryOff', e.target.checked ? [...off].filter((x) => x !== id) : [...off, id]),
      }), appMark(id), APPS[id].name)));
}

/**
 * The end-of-day time. Saved once you've finished with it (you leave the
 * field, or press Enter): a time field reports a change at every digit, and
 * saving "01:00" on the way to "19:00" would redraw the page under you.
 */
function endOfDay(app, auto) {
  const time = h('input', { type: 'time', class: 'set-time', value: auto.at, 'aria-label': 'End of day', 'data-focus': 'set-time' });
  const save = () => {
    if (/^\d{2}:\d{2}$/.test(time.value) && time.value !== auto.at) app.setPref('autoSummary', { ...auto, at: time.value });
  };
  time.addEventListener('blur', save);
  time.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    save();
  });
  return time;
}

// ---- Appearance and Privacy ----------------------------------------------------------

function appearanceCard() {
  const box = h('div', { class: 'appearance-settings' });
  renderAppearance(box, {
    onChange: (st) => {  // the overview's line follows
      const line = document.querySelector('.set-overview [data-ov="appearance"]');
      if (line) line.textContent = appearanceLine(st);
    },
  });
  return card('appearance', 'Appearance', 'palette', null, box);
}

function privacyCard(app) {
  const line = (ic, b, ...text) => h('li', null, icon(ic, 15), h('span', null, h('b', null, b), ' ', text));
  const files = app.state.summaries.where === 'files';
  const dir = h('code', null, app.state.summaries.dir || '~/.throwbacks');
  return card('privacy', 'Privacy', 'lock', null,
    h('ul', { class: 'set-privacy' },
      line('lock', 'No uploads, no analytics.', 'Your chats leave this Mac only as the text you send to the summarizer you pick (from the apps you send, AI summaries above — and any chat whose own Summarize you click). The other calls out carry nothing from them: the usage tools switched on above (each asking its maker), and the fonts (and JSZip, to open a .zip).'),
      line('check', 'Read-only.', 'Throwbacks never changes, moves or deletes any app’s files — Claude Code’s settings included.'),
      app.state.usageInfo.sample
        ? line('folder', 'Sample data:', 'nothing of yours is read here, and its pins and archives stay in this tab', files ? ['; summaries are saved in ', dir, '.'] : '.')
        : files
          ? line('folder', 'Saved on this Mac,', 'in ', dir, ': summaries, kept copies, pins and archives, the usage switches. Loaded chats stay in this tab.')
          : line('folder', 'Saved in this browser only:', 'summaries, pins and archives. Loaded chats stay in this tab.'),
      line('clock', 'Times are estimates (≈):', 'stretches of activity, with parallel sessions counted once.')),
    h('div', { class: 'set-keys' }, h('kbd', null, '⌘K search'), h('kbd', null, '← → previous / next'), h('kbd', null, 'Esc closes')));
}
