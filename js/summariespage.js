// summariespage.js — the Summaries page (#/summaries): every summary in one
// place — days, recaps (a week's, a month's, any dates', and the older range
// summaries) and chats (a session's own) — newest first, in bands (this week,
// earlier this month, a month each). One opens beside the page, like a chat:
// its lines or recap, what it cost in tokens when the summarizer said, and
// Open / Copy / Delete. "Recap a period…" writes a recap of the last 7 days,
// this month, last month or any dates from their day summaries — writing the
// days still missing first, and saying so before it starts. Its filter
// (All · Days · Recaps · Chats) takes the plan bar's place: a summary covers
// every tool you send.

import { icon } from './icons.js';
import { PROVIDERS, summaryToMarkdown, tokensIn } from './summarize.js';
import { summaryList, recapDays, daySummaryLines, weekSummaryState, recapBlocks, RECAP_MAX_DAYS } from './log.js';
import { recapLabel } from './daylog.js';
import { histDelete } from './summarize-ui.js';
import { dateBand, addDays, APPS } from './plans.js';
import { titleRow } from './topbar.js';
import { h, appMark, showToast, copyText, plural, relDay, fmtLong, fmtShort, fmtMonth, fmtMonthYear, fmtClock, todayKey, recapView } from './ui.js';
import { dateKey, fmtTokens } from './util.js';

const KINDS = [['all', 'All'], ['day', 'Days'], ['recap', 'Recaps'], ['chat', 'Chats']];
/** What each kind is, on its chip. */
const KIND_TIPS = {
  day: 'Each day’s work-log lines, written from that day’s chats',
  recap: 'Short versions of your day summaries — for a week, a month or any dates',
  chat: 'One chat summarized on its own',
};
const ICON = { day: 'today', week: 'calendar', month: 'calendar', period: 'layers', range: 'layers', chat: 'message' };
const KIND_LABEL = { day: 'Day', week: 'Week', month: 'Month', period: 'Period', range: 'Range', chat: 'Chat' };

/** Every summary, as the page lists them. */
const listOf = (app) => summaryList(app.state.summaries, app.state.savedRanges || [], todayKey());

/** "18.2k tokens" — what the summarizer said a summary used (in and out), or null when it didn't say. */
function tokens(usage) {
  if (!usage) return null;
  const n = tokensIn(usage) + (usage.output || 0);
  return n ? `${fmtTokens(n)} tokens` : null;
}

const providerName = (id) => (PROVIDERS[id] ? PROVIDERS[id].label : id || '');
const written = (ms) => (ms ? `${relDay(dateKey(ms))} ${fmtClock(ms)}` : null);

/** A summary's name: its day, its week, its month, its dates, or its chat. */
function titleOf(app, e) {
  if (e.type === 'day') return relDay(e.key);
  if (e.type === 'week') return `Week of ${fmtShort(e.key)}`;
  if (e.type === 'month') return fmtMonthYear(`${e.key}-01`);
  if (e.type === 'period') return recapLabel('period', e.key);
  if (e.type === 'chat') {
    const s = e.sessionId && app.model.getSession(e.sessionId);
    return s ? s.title : String(e.entry.rangeLabel || 'A chat').replace(/^Session · /, '');
  }
  return e.entry.rangeLabel || 'A range';
}

/** Its first line, to tell one from another. */
function firstLine(app, e) {
  if (e.type === 'day') {
    return daySummaryLines(app.allRows.get(e.key) || null, e.saved)[0] || '';
  }
  if (e.group === 'recap' && e.saved) return (recapBlocks(e.saved.text).find((b) => b.type !== 'group') || { text: '' }).text;
  return e.entry.recap || ((e.entry.perSession || [])[0] || { bullets: [''] }).bullets[0] || '';
}

/** The days a recap was written from (an older one: its days with a summary now). */
function recapFrom(app, e) {
  if (e.saved.daysUsed) return e.saved.daysUsed;
  if (e.saved.basedOn) return Object.keys(e.saved.basedOn).sort();
  return recapDays(e.type, e.key).filter((k) => app.state.summaries.days[k]);
}

/** A recap whose days changed (or got a summary) since it was written. */
function stale(app, e) {
  if (!['week', 'month', 'period'].includes(e.type)) return false;
  return weekSummaryState({ days: recapDays(e.type, e.key).map((key) => ({ key })) }, app.state.summaries.days, e.saved).state === 'stale';
}

function metaOf(app, e) {
  const bits = [];
  if (e.type === 'day') {
    const lines = Object.values(e.saved.chats || {}).reduce((t, c) => t + (c.lines || []).length, 0) + (e.saved.manual || []).length;
    bits.push(plural(lines, 'line'));
    if (e.saved.editedAt && e.saved.editedAt > (e.saved.updatedAt || 0)) bits.push('edited');
    if ((e.saved.previous || []).length) bits.push(plural(e.saved.previous.length, 'earlier version'));
  } else if (e.group === 'recap' && e.saved) {
    bits.push(plural(recapFrom(app, e).length, 'day'));
    if (stale(app, e)) bits.push('a day changed since');
  } else {
    bits.push(plural((e.entry.perSession || []).length, 'chat'));
    if (e.type === 'range') bits.push('older kind, from the chats');
  }
  const t = tokens(e.usage);
  if (t) bits.push(t);
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// The top bar: the title, Recap a period…; then the filter in the plan bar's place
// ---------------------------------------------------------------------------

export function summariesRow(app) {
  const can = app.summarizer.enabled;
  return titleRow(app, 'Summaries', h('button', {
    type: 'button', class: 'btn btn-small btn-brand', 'data-focus': 'recap-period', disabled: can && !app.state.job ? null : true,
    title: can ? 'A recap of the last 7 days, a month or any dates, from their day summaries' : (app.summarizer.why || 'Set up a summarizer first'),
    onclick: () => openRecapDialog(app),
  }, icon('sparkles', 15), 'Recap a period…'));
}

export function summariesFilter(app) {
  const list = listOf(app);
  const v = app.state.sumView;
  const count = (k) => list.filter((e) => k === 'all' || e.group === k).length;
  return h('div', { class: 'planbar', role: 'toolbar', 'aria-label': 'Show' }, KINDS.map(([k, label]) => h('button', {
    type: 'button', class: `chip${v.kind === k ? ' is-on' : ''}`, 'aria-pressed': String(v.kind === k), 'data-focus': `sum-kind-${k}`, title: KIND_TIPS[k] || null,
    onclick: () => { v.kind = k; app.redrawTopbar(); app.renderPage(); },  // the top bar keeps the keyboard on it
  }, label, h('span', { class: 'chip-n' }, String(count(k))))));
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function summariesPage(app) {
  const all = listOf(app);
  const v = app.state.sumView;
  const list = all.filter((e) => v.kind === 'all' || e.group === v.kind);
  const page = h('section', { class: 'page page-sums' }, strip(app, all));
  if (!all.length) {
    page.append(h('div', { class: 'card empty-card' },
      h('p', null, 'No summaries yet.'),
      h('p', { class: 'muted' }, 'Summarize a day on its page — or, once a summarizer is set up, the end of each day writes it — and recap a period here.')));
    return page;
  }
  // What a recap is, said where you choose them (a tooltip never shows on a touch screen).
  if (v.kind === 'recap') page.append(h('p', { class: 'summary-hint ssum-what' }, icon('info', 14), h('span', null, 'A recap is a short version of your day summaries — for a week, a month or any dates.')));
  if (!list.length) {
    page.append(h('div', { class: 'card empty-card' }, h('p', null, 'None of these yet.')));
    return page;
  }
  const today = todayKey();
  const bands = new Map();
  for (const e of list) {
    const b = dateBand(e.covers, today);
    if (!bands.has(b.id)) bands.set(b.id, { ...b, items: [] });
    bands.get(b.id).items.push(e);
  }
  for (const b of bands.values()) {
    const first = `${b.at.slice(0, 7)}-01`;
    const label = b.kind === 'week' ? 'This week' : b.kind === 'rest' ? `Earlier in ${fmtMonth(first)}` : fmtMonthYear(first);
    page.append(h('section', { class: 'sband', 'aria-label': label },
      h('h2', { class: 'section-title is-small' }, label, h('span', { class: 'count' }, String(b.items.length))),
      b.items.map((e) => row(app, e))));
  }
  return page;
}

/**
 * The tokens a summary's runs used this month: each run counts in the month
 * it ran (`spent`); one written before that was kept counts whole, in the
 * month it was last written.
 */
function spentIn(e, month) {
  const saved = e.saved || e.entry || {};
  if (saved.spent) return saved.spent[month] || 0;
  return e.usage && e.written && dateKey(e.written).startsWith(month) ? tokensIn(e.usage) + (e.usage.output || 0) : 0;
}

/**
 * Recaps that didn't get written, and why (they have no row of their own to
 * say it on) — until written after all, or dismissed. Not an alert: the toast
 * said it once, and the page redraws often.
 */
function recapErrors(app) {
  return [...app.state.errors.entries()].filter(([id]) => /^(week|month|period):/.test(id)).map(([id, msg]) => {
    const [kind, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    return h('p', { class: 'summary-err ssum-err' }, h('span', null, `The recap of ${recapLabel(kind, key)} wasn’t written: ${msg}`),
      h('button', { type: 'button', class: 'link-btn', 'aria-label': `Dismiss: the recap of ${recapLabel(kind, key)} wasn’t written`, onclick: () => { app.state.errors.delete(id); app.renderPage(); } }, 'Dismiss'));
  });
}

/** On top: how many of each, how they're written, and what they've cost this month. */
function strip(app, all) {
  const count = (g) => all.filter((e) => e.group === g).length;
  const s = app.summarizer;
  const auto = app.state.prefs.autoSummary;
  const month = todayKey().slice(0, 7);
  const spent = all.reduce((t, e) => t + spentIn(e, month), 0);
  const counted = all.some((e) => e.usage);
  const off = app.state.prefs.summaryOff || [];
  return h('section', { class: 'card ssum', 'aria-label': 'Your summaries' },
    h('div', { class: 'ssum-counts' },
      [['day', 'day', 'days'], ['recap', 'recap', 'recaps'], ['chat', 'chat', 'chats']].map(([g, one, many]) => h('span', { class: 'ssum-count' },
        h('b', null, String(count(g))), count(g) === 1 ? one : many))),
    h('div', { class: 'ssum-how' },
      h('span', { class: `status-dot${s.enabled ? ' is-ok' : ''}` }),
      h('span', null, s.enabled ? `${providerName(s.provider)} · ${auto.on ? `each day at ${auto.at}` : 'when you click'}` : 'No summarizer yet'),
      counted ? h('span', { class: 'ssum-spent', title: 'Tokens in and out that your summarizer reported for this month’s runs, of the summaries you still have' }, `this month: ${fmtTokens(spent)} tokens`) : null,
      off.length ? h('span', { class: 'ssum-off', title: 'Left out of the day summaries, recaps and the end-of-day run (a chat’s own Summarize still sends that chat)' }, `not sent: ${off.map((id) => (APPS[id] ? APPS[id].name : id)).join(', ')}`) : null,
      h('a', { class: 'link-btn', href: '#/settings' }, 'Settings')),
    recapErrors(app));
}

function row(app, e) {
  const open = app.state.reader && app.state.reader.kind === 'summary' && app.state.reader.id === e.id;
  const when = written(e.written);
  return h('button', {
    type: 'button', class: `srow2${open ? ' is-open' : ''}`, 'data-focus': `sum-${e.id}`, 'aria-current': open ? 'true' : null,
    onclick: () => app.openSummary(e.id),
  }, h('span', { class: `srow2-ico${e.group === 'day' ? '' : ' is-recap'}` }, icon(ICON[e.type], 17)),
  h('span', { class: 'srow2-top' }, h('span', { class: 'srow2-title' }, titleOf(app, e)), h('span', { class: 'srow2-kind' }, KIND_LABEL[e.type])),
  h('span', { class: 'srow2-line' }, firstLine(app, e)),
  h('span', { class: 'srow2-meta' }, h('span', null, metaOf(app, e)), when ? h('span', null, `written ${when}`) : null));
}

// ---------------------------------------------------------------------------
// One summary, beside the page (a phone: full screen, with a back arrow)
// ---------------------------------------------------------------------------

/** Draw summary `id` into the reader pane; false when it's gone (deleted meanwhile). */
export function renderSummaryPane(pane, app, id) {
  const e = listOf(app).find((x) => x.id === id);
  pane.textContent = '';
  if (!e) return false;
  const close = h('button', { type: 'button', class: 'icon-btn reader-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => app.closeReader() },
    h('span', { class: 'only-wide' }, icon('x', 18)), h('span', { class: 'only-narrow' }, icon('arrow-left', 18)));
  const saved = e.saved || e.entry;
  const meta = [KIND_LABEL[e.type], metaOf(app, e), written(e.written) ? `written ${written(e.written)}` : null,
    saved && saved.provider ? `${providerName(saved.provider)}${saved.model && saved.model !== 'default' ? ` · ${saved.model}` : ''}` : null].filter(Boolean);
  // On a narrow pane (a phone, or floating) the buttons are their icons, named on hover.
  const btn = (cls, name, label, onclick, extra = {}) => h('button', { type: 'button', class: `btn btn-small${cls}`, 'aria-label': label, title: label, onclick, ...extra },
    icon(name, 15), h('span', { class: 'btn-label' }, label));
  // Full screen (a phone) or floating over the page (a laptop, a tablet), the summary would hide the
  // page it opens: it closes first. Beside the page (a wide screen) it stays.
  const goTo = (hash) => () => {
    if (window.matchMedia('(max-width: 1180px)').matches) app.closeReader();
    app.go(hash);
  };
  const actions = [];
  if (e.type === 'day') actions.push(btn('', 'today', 'Open the day', goTo(`#/day/${e.key}`)));
  if (e.type === 'week') actions.push(btn('', 'table', 'Open the week', goTo(`#/week/${e.key}`)));
  if (e.type === 'month') actions.push(btn('', 'table', 'Open the month', goTo(`#/month/${e.key}`)));
  if (e.type === 'chat' && e.sessionId && app.model.getSession(e.sessionId)) {
    actions.push(btn('', 'message', 'Open the chat', () => {
      // Under a tool filter that leaves its app out, the chat isn't on screen: show all tools.
      if (!app.view.getSession(e.sessionId)) app.setFilter(null);
      app.openSession(e.sessionId, { part: 'all' });
    }));
  }
  if (['week', 'month', 'period'].includes(e.type) && app.summarizer.enabled) {
    actions.push(btn(' btn-ghost', 'refresh', 'Write again', () => openRecapDialog(app, { kind: e.type, key: e.key }), { disabled: app.state.job ? true : null }));
  }
  actions.push(btn(' btn-ghost', 'copy', 'Copy', async () => showToast((await copyText(markdownOf(app, e))) ? 'Copied as Markdown' : 'Couldn’t copy')));
  actions.push(h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Delete this summary', title: 'Delete this summary', disabled: app.state.job ? true : null,
    onclick: () => remove(app, e),
  }, icon('trash', 16)));

  const body = h('div', { class: 'reader-body' }, h('div', { class: 'sread-body' }, contentOf(app, e)));
  pane.append(h('header', { class: 'reader-head' }, close,
    h('div', { class: 'reader-titles' },
      h('h2', { class: 'reader-title' }, e.type === 'day' ? fmtLong(e.key) : titleOf(app, e)),
      h('div', { class: 'reader-meta' }, meta.map((m, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '·') : null, h('span', { class: 'reader-meta-item' }, m)])),
      h('div', { class: 'reader-actions' }, actions))), body);
  return true;
}

/** Chat lines under their chat (its name now, its app), your rows, and the versions a Rewrite replaced. */
function dayGroups(app, chats, manual) {
  const out = [];
  for (const [id, c] of Object.entries(chats || {})) {
    if (!(c.lines || []).length) continue;
    const s = app.model.getSession(id);
    out.push(h('div', { class: 'sgroup' },
      h('div', { class: 'sgroup-name sread-chat' }, s ? appMark(s.source) : null, s ? s.title : c.title || 'A chat'),
      h('ul', { class: 'slines' }, c.lines.map((l) => h('li', null, l)))));
  }
  if ((manual || []).length) {
    out.push(h('div', { class: 'sgroup' }, h('div', { class: 'sgroup-name' }, 'Added by you'),
      h('ul', { class: 'slines' }, manual.map((m) => h('li', null, m.text)))));
  }
  return out;
}

function contentOf(app, e) {
  if (e.type === 'day') {
    return [...dayGroups(app, e.saved.chats, e.saved.manual),
      ...(e.saved.previous || []).map((p) => h('details', { class: 'sum-prev sread-prev' },
        h('summary', null, `The version a Rewrite replaced${p.at ? ` — ${written(p.at)}` : ''}`),
        dayGroups(app, p.chats, p.manual)))];
  }
  if (e.group === 'recap' && e.saved) {
    const days = recapFrom(app, e);
    const err = app.state.errors.get(e.id);
    // A day whose summary was deleted since is still one it was written from — named, not a link.
    const have = new Set(listOf(app).filter((x) => x.type === 'day').map((x) => x.key));
    return [
      err ? h('p', { class: 'summary-err', role: 'alert' }, `Writing it again didn’t work: ${err}`) : null,
      stale(app, e) ? h('p', { class: 'summary-hint' }, icon('info', 14), h('span', null, app.summarizer.enabled
        ? 'A day’s summary changed since this was written — Write again brings it up to date.'
        : 'A day’s summary changed since this was written. Set up a summarizer (Settings) to write it again.')) : null,
      recapView(e.saved.text, 'sread-recap'),
      // A recap is a short version of these days' summaries, never of the chats themselves.
      days.length ? h('div', { class: 'sgroup' }, h('div', { class: 'sgroup-name' }, 'Written from these day summaries'),
        h('div', { class: 'sread-days' }, days.map((k) => (have.has(k)
          ? h('button', { type: 'button', class: 'link-btn', onclick: () => app.openSummary(`day:${k}`) }, fmtShort(k))
          : h('span', { class: 'muted', title: 'Its summary was deleted since' }, `${fmtShort(k)} (deleted since)`))))) : null,
    ];
  }
  const en = e.entry;
  return [
    en.recap ? recapView(en.recap, 'sread-recap') : null,
    ...(en.perSession || []).map((p) => h('div', { class: 'sgroup' },
      h('div', { class: 'sgroup-name' }, `${p.title}${p.when ? ` — ${p.when}` : ''}`),
      h('ul', { class: 'slines' }, (p.bullets || []).map((b) => h('li', null, b))))),
    h('p', { class: 'summary-hint' }, icon('info', 14), h('span', null, 'AI-written and approximate — not a word-for-word record.')),
  ];
}

function markdownOf(app, e) {
  if (e.type === 'day') {
    const lines = daySummaryLines(app.allRows.get(e.key) || null, e.saved);
    return `# ${fmtLong(e.key)}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
  }
  if (e.group === 'recap' && e.saved) return `# Recap — ${recapLabel(e.type, e.key)}\n\n${e.saved.text}\n`;
  return summaryToMarkdown(e.entry.rangeLabel, e.entry.recap, e.entry.perSession || []);
}

async function remove(app, e) {
  let ok = false;
  if (e.type === 'day') ok = await app.removeDay(e.key);
  else if (e.saved && e.group === 'recap') ok = await app.removeRecap(e.type, e.key);
  else if (window.confirm(`Delete this ${e.type === 'chat' ? 'chat’s summary' : 'summary'}? This can’t be undone.`)) {
    try {
      await histDelete(e.entry.id);
      ok = true;
    } catch (err) {
      showToast(`Couldn’t delete it: ${err.message}`, { long: true });
    }
    await app.reloadSaved();
  }
  if (ok) app.closeReader();
}

// ---------------------------------------------------------------------------
// Recap a period: the last 7 days, this month, last month, or any dates
// ---------------------------------------------------------------------------

/** The choices, as (kind, key): a month is a month's recap, the rest a period's. */
function choices() {
  const today = todayKey();
  const thisMonth = today.slice(0, 7);
  const d = new Date(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 2, 1);
  const lastMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return [
    ['last7', 'Last 7 days', 'period', `${addDays(today, -6)}_${today}`],
    ['month', 'This month', 'month', thisMonth],
    ['lastmonth', 'Last month', 'month', lastMonth],
    ['custom', 'Custom dates', 'period', null],
  ];
}

/**
 * The recap dialog. `preset`: {kind, key} to open on (a week's or month's
 * card, Write again). It says what a recap will do before you start it, and
 * is built once: a choice or a date only changes what it says (typing a date
 * reports a change at every digit — the field must stay as it is).
 */
export function openRecapDialog(app, preset = null) {
  if (app.state.job) {
    showToast('Wait for the summary that’s being written');
    return;
  }
  const today = todayKey();
  const opts = choices();
  const known = preset && opts.find((o) => o[2] === preset.kind && o[3] === preset.key);
  let pick = preset ? (known ? known[0] : 'preset') : 'last7';
  let from = addDays(today, -13);
  let to = today;
  const overlay = h('div', { class: 'modal-overlay' });
  const done = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => {
    if (ev.key !== 'Escape' || [...document.querySelectorAll('.modal-overlay')].pop() !== overlay) return;
    ev.preventDefault();
    done();
  };
  // A click outside closes it — not a text selection dragged out of it (that click lands here too).
  let downHere = false;
  overlay.addEventListener('pointerdown', (ev) => { downHere = ev.target === overlay; });
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay && downHere) done(); });
  document.addEventListener('keydown', onKey);
  const modal = h('div', { class: 'modal recap-modal', role: 'dialog', 'aria-label': 'Recap a period' });
  overlay.append(modal);
  document.body.append(overlay);

  const isKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');
  const target = () => {
    if (pick === 'preset') return { kind: preset.kind, key: preset.key };
    if (pick === 'custom') {
      if (!isKey(from) || !isKey(to) || from > to) return { error: 'Pick a start and an end (the end not before the start).' };
      if (to > today) return { error: 'Pick an end no later than today.' };
      if (recapDays('period', `${from}_${to}`).length >= RECAP_MAX_DAYS) return { error: 'Pick at most ten years.' };
      return { kind: 'period', key: `${from}_${to}` };
    }
    const o = opts.find((x) => x[0] === pick);
    return { kind: o[2], key: o[3] };
  };

  const seg = h('div', { class: 'seg recap-choices', role: 'group', 'aria-label': 'Period' },
    [...(pick === 'preset' ? [['preset', recapLabel(preset.kind, preset.key)]] : []), ...opts.map((o) => [o[0], o[1]])].map(([id, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'data-pick': id, onclick: () => { pick = id; refresh(); },
    }, label)));
  const dateField = (value, set) => h('input', { type: 'date', class: 'set-input', value, max: today, onchange: (ev) => { set(ev.target.value); refresh(); } });
  const dates = h('div', { class: 'recap-dates' },
    h('label', null, 'From ', dateField(from, (v) => { from = v; })),
    h('label', null, 'to ', dateField(to, (v) => { to = v; })));
  const say = h('p', { class: 'recap-plan', role: 'status' });
  const again = h('p', { class: 'recap-plan muted' });
  const startLabel = h('span');
  let now = null;  // what Start would do: {t, rows}
  const start = h('button', {
    type: 'button', class: 'btn btn-small btn-brand',
    onclick: async () => {
      if (!now) return;
      const { t, rows } = now;
      done();
      const was = app.state.reader;
      const where = location.hash;
      const ok = await app.recap(t.kind, t.key, rows);
      // It opens beside the page — unless you opened something else meanwhile, or went to another
      // page (the toast said it's written; it's on the Summaries page).
      if (ok && app.state.reader === was && (was || location.hash === where)) app.openSummary(`${t.kind}:${t.key}`);
    },
  }, icon('sparkles', 15), startLabel);
  modal.append(
    h('div', { class: 'modal-head' }, h('span', { class: 'modal-title is-brand' }, icon('sparkles', 17), h('span', null, 'Recap a period')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: done }, icon('x', 18))),
    h('p', { class: 'modal-sub' }, 'A recap is a short version of the period’s day summaries — one line, then each project’s main points and what’s still open. It’s written from the days’ summary lines as you left them, not from the chats; days not summarized yet are written first.'),
    seg, dates, say, again,
    h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: done }, 'Cancel'), start));

  function refresh() {
    for (const b of seg.querySelectorAll('.seg-btn')) {
      const on = b.dataset.pick === pick;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    dates.hidden = pick !== 'custom';
    const t = target();
    now = null;
    let text;
    let ready = false;
    if (t.error) text = t.error;
    else {
      const rows = recapDays(t.kind, t.key).filter((k) => k <= today).map((k) => app.allRows.get(k)).filter(Boolean);
      const plan = app.recapPlan(t.kind, t.key, rows);
      const label = recapLabel(t.kind, t.key);
      if (!plan.from && !rows.length) text = `No chats in ${label} — nothing to recap.`;
      else if (!plan.from) text = `Nothing to send: ${plural(rows.length, 'day')} with chats, but ${unsent(plan.why)}.`;
      else {
        ready = true;
        now = { t, rows };
        text = !plan.days
          ? `Written from ${plural(plan.from, 'day')} already summarized: ${plural(plan.calls, 'call')} to your summarizer.`
          : `Written from ${plural(plan.from, 'day')}; ${plan.days} of them ${plan.days === 1 ? 'has' : 'have'} chats not summarized yet. It summarizes ${plan.days === 1 ? 'that day' : 'those'} first, then writes the recap — about ${plural(plan.calls, 'call')} to your summarizer.`;
        if (plan.quiet) text += ` ${plural(plan.quiet, 'other day')} with chats ${plan.quiet === 1 ? 'has' : 'have'} nothing to send (${unsent(plan.why)}).`;
        startLabel.textContent = plan.days ? `Summarize ${plural(plan.days, 'day')}, then the recap` : 'Write the recap';
      }
      const existing = app.state.summaries[{ week: 'weeks', month: 'months', period: 'periods' }[t.kind]][t.key];
      again.textContent = existing ? `A recap of it was written ${written(existing.updatedAt) || 'earlier'}: this writes it again.` : '';
    }
    if (!ready) startLabel.textContent = 'Write the recap';
    again.hidden = !!t.error || !again.textContent;
    say.textContent = text;
    start.disabled = !ready;
  }
  refresh();
  seg.querySelector('.is-on')?.focus();
}

/** Why days have nothing to send, from recapPlan's reasons: "only sample chats, or no messages". */
function unsent(why) {
  const say = { apps: 'only chats from apps you left out in Settings', sample: 'only sample chats, which are never sent', quiet: 'no messages' };
  const bits = ['apps', 'sample', 'quiet'].filter((w) => (why || []).includes(w)).map((w) => say[w]);
  return bits.length ? bits.join(', or ') : 'no messages';
}

/** The latest whole-chat summary of this session, for the top of its conversation (null if none). */
export function chatSummaryOf(app, sessionId) {
  return listOf(app).find((e) => e.type === 'chat' && e.sessionId === sessionId) || null;
}

