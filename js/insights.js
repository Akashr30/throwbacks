// insights.js — the Insights page: your plans' usage, then the activity
// report for whatever the tool filter shows — totals, a GitHub-style
// heatmap, where the time went by topic, activity and tokens over time
// (daily / weekly / monthly), topics and folders (each opens to its
// sessions), apps, busiest days, longest sessions and the most active
// hours, and who made your commits (you, or an AI tool, month by month).
// Topics are local keyword guesses; nothing leaves the tab. The report
// downloads as Markdown.

import { el, dateKey, keyToDate, truncate, fmtTokens, fmtDayLong, fmtDayShort, fmtDayMed, fmtMonth } from './util.js';
import { fmtDuration } from './time.js';
import { donutChart, columnChart, dotChart, shareBar, heatmapChart, longestRun, SERIES, OTHER_COLOR } from './charts.js';
import { appOf, plansPresent, filterLabel } from './plans.js';
import { h, planMark, todayKey, plural } from './ui.js';
import { allCommits, whoMade, whoText, commitsByMonth, sharePct } from './commits.js';
import { whoShares } from './commitview.js';
import { usageWindows, usageNote, loginCopy } from './topbar.js';
import { plansKnown, CURSOR_USAGE_URL } from './usage.js';

/** Chart choices — kept for the tab's lifetime only. */
const gran = { activity: null, tokens: null, heatmap: null };

/** Identity order of the sources: their colors never depend on rank. */
const SOURCE_ORDER = ['web', 'code', 'copilot', 'cursor', 'copilot-cli', 'cowork'];

export function insightsPage(app) {
  const model = app.view;
  const page = h('section', { class: 'page page-insights' });
  const fl = filterLabel(app.state.filter);
  if (fl) page.append(h('p', { class: 'page-note' }, `Showing ${fl} only.`));

  page.append(usageCard(app));
  if (model.isEmpty) {
    page.append(h('div', { class: 'card empty-card' }, h('p', null, 'No chats for this tool.')));
    return page;
  }

  const rep = el('div', 'report');
  page.append(rep);
  const card = (num, label) => {
    const c = el('div', 'rep-card');
    c.append(el('div', 'rep-num', num), el('div', 'rep-label', label));
    return c;
  };
  const cards = el('div', 'rep-cards');
  cards.append(
    card(String(model.sessionCount), 'sessions'),
    card(model.msgTotal.toLocaleString(), 'messages'),
    card(String(model.dayKeys.length), 'active days'),
    card(fmtDuration(model.totalActiveMs), 'active time'),
  );
  if (model.totalTokens > 0) cards.append(card(fmtTokens(model.totalTokens), 'tokens (Claude)'));
  rep.append(cards);

  const section = (title, hint) => {
    const s = el('section', 'rep-section');
    s.append(el('h2', 'rep-title', title));
    if (hint) s.append(el('p', 'rep-hint', hint));
    rep.append(s);
    return s;
  };
  const openDay = (key) => app.go(`#/day/${key}`);
  const openSession = (id) => app.openSession(id, { part: 'all' });

  // Heatmap: the last 12 months, or one year when the history spans several.
  {
    const sec = section('Activity heatmap',
      'A square per day — the darker, the more ≈active time (shades are quartiles of your active days). Click a day to open it.');
    const controls = el('div', 'gran-row');
    const holder = el('div');
    sec.append(controls, holder);
    const today = todayKey();
    const endKey = model.maxDayKey > today ? model.maxDayKey : today;
    const yearAgo = keyToDate(endKey);
    yearAgo.setDate(yearAgo.getDate() - 364);
    const ranges = [['last', 'Last 12 months', dateKey(yearAgo.getTime()), endKey]];
    const years = [...new Set(model.dayKeys.map((k) => k.slice(0, 4)))].sort().reverse();
    if (years.length > 1) for (const y of years) ranges.push([y, y, `${y}-01-01`, `${y}-12-31` < endKey ? `${y}-12-31` : endKey]);
    const busy = ([, , from, to]) => model.dayKeys.some((k) => k >= from && k <= to);
    const fallback = (busy(ranges[0]) ? ranges[0] : ranges.find(busy) || ranges[0])[0];
    const draw = () => {
      const choice = ranges.some(([id]) => id === gran.heatmap) ? gran.heatmap : fallback;
      controls.textContent = '';
      if (ranges.length > 1) controls.append(segmented('Heatmap range', ranges.map(([id, label]) => [id, label]), choice, (id) => { gran.heatmap = id; draw(); }));
      const [, label, from, to] = ranges.find(([id]) => id === choice);
      const days = [];
      for (const d = keyToDate(from); dateKey(d.getTime()) <= to; d.setDate(d.getDate() + 1)) {
        const key = dateKey(d.getTime());
        const rec = model.getDay(key);
        const msgs = rec ? rec.msgCount : 0;
        days.push({
          key,
          value: rec ? rec.totalMs : 0,
          label: `${fmtDayLong(key)}${msgs ? ` · ${msgs} message${msgs === 1 ? '' : 's'}` : ''}`,
          onClick: rec ? () => openDay(key) : null,
        });
      }
      const values = days.map((d) => d.value);
      const active = values.filter((v) => v > 0).length;
      const streak = longestRun(values);
      const summary = active
        ? `${fmtDuration(values.reduce((t, v) => t + v, 0))} on ${active} active day${active === 1 ? '' : 's'} · longest streak ${streak} day${streak === 1 ? '' : 's'}`
        : 'No activity in this range';
      holder.textContent = '';
      holder.append(heatmapChart(days, fmtDuration, { todayKey: today, summary, label: `Activity heatmap, ${label}: ${summary}` }));
    };
    draw();
  }

  // Where the time went: each session counted once, under its strongest topic.
  if (model.primaryTagStats.length > 1) {
    const sec = section('Where the time went', 'Share of ≈active time by each session’s strongest topic — every session counted once.');
    const total = model.primaryTagStats.reduce((t, s) => t + s.ms, 0);
    sec.append(donutChart(model.primaryTagStats.map((s) => ({ label: s.label, value: s.ms })), total, fmtDuration));
  }

  // Activity and tokens over time, Daily / Weekly / Monthly
  const allKeys = [];
  for (const d = keyToDate(model.minDayKey), end = keyToDate(model.maxDayKey); d <= end; d.setDate(d.getDate() + 1)) allKeys.push(dateKey(d.getTime()));
  const spanYears = new Set(allKeys.map((k) => k.slice(0, 4))).size > 1;
  const defaultGran = allKeys.length <= 120 ? 'day' : allKeys.length <= 550 ? 'week' : 'month';
  const buildBins = (g) => {
    if (g === 'day') return allKeys.map((k) => ({ label: fmtDayLong(k), shortLabel: fmtDayShort(k), dayKeys: [k] }));
    const bins = new Map();
    for (const k of allKeys) {
      const dt = keyToDate(k);
      let bk; let label; let shortLabel;
      if (g === 'week') {
        dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
        bk = dateKey(dt.getTime());
        label = `Week of ${fmtDayMed(bk)}`;
        shortLabel = fmtDayShort(bk);
      } else {
        bk = `${dt.getFullYear()}-${dt.getMonth()}`;
        label = fmtMonth(dt.getFullYear(), dt.getMonth());
        shortLabel = dt.toLocaleDateString(undefined, spanYears ? { month: 'short', year: '2-digit' } : { month: 'short' });
      }
      if (!bins.has(bk)) bins.set(bk, { label, shortLabel, dayKeys: [] });
      bins.get(bk).dayKeys.push(k);
    }
    return [...bins.values()];
  };
  const timeChart = (prefKey, title, hint, makePoint, ChartFn, fmt) => {
    const sec = section(title, hint);
    const controls = el('div', 'gran-row');
    const holder = el('div');
    sec.append(controls, holder);
    const render = () => {
      const g = gran[prefKey] || defaultGran;
      controls.textContent = '';
      controls.append(segmented(`${title} granularity`, [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']], g, (v) => { gran[prefKey] = v; render(); }));
      holder.textContent = '';
      const chart = ChartFn(buildBins(g).map(makePoint), fmt);
      holder.append(chart.root);
      chart.draw();
    };
    render();
  };
  timeChart('activity', 'Activity over time', null, (bin) => {
    let ms = 0;
    let first = null;
    for (const k of bin.dayKeys) {
      const rec = model.getDay(k);
      if (rec) { ms += rec.totalMs; first = first || k; }
    }
    return { label: bin.label, shortLabel: bin.shortLabel, value: ms, onClick: first ? () => openDay(first) : null };
  }, columnChart, fmtDuration);
  if (model.totalTokens > 0) {
    const detail = (t) => `cache reads ${fmtTokens(t.cr)} · input ${fmtTokens(t.i - t.cw)} · cache writes ${fmtTokens(t.cw)} · output ${fmtTokens(t.o)}`;
    timeChart('tokens', 'Token consumption',
      'From Claude Code’s usage records, each reply once, its subagents’ included — every kind, as Claude Code’s own stats count them: cache reads (the conversation sent again with each reply: most of it), input, cache writes and output; the split shows on each dot. Other tools record no tokens.',
      (bin) => {
        const t = { i: 0, cw: 0, o: 0, cr: 0, total: 0 };
        let first = null;
        for (const k of bin.dayKeys) {
          const d = model.tokenByDay.get(k);
          if (d) { t.i += d.i; t.cw += d.cw; t.o += d.o; t.cr += d.cr; t.total += d.total; first = first || k; }
        }
        return { label: bin.label, shortLabel: bin.shortLabel, value: t.total, detail: t.total ? detail(t) : null, onClick: first ? () => openDay(first) : null };
      }, dotChart, fmtTokens);
  }

  // A bar row; opens to its sessions when it has some.
  const barRow = (sec, label, ms, maxMs, detail, sessions, onClick) => {
    const wrap = el('div', 'rep-row-wrap');
    const row = el('button', 'rep-row');
    row.type = 'button';
    row.append(el('span', 'rep-name', label));
    const track = el('span', 'rep-bar-track');
    const bar = el('span', 'rep-bar');
    bar.style.width = `${maxMs ? Math.max(2, Math.round((ms / maxMs) * 100)) : 0}%`;
    track.append(bar);
    row.append(track, el('span', 'rep-val', detail));
    wrap.append(row);
    if (sessions && sessions.length) {
      const sub = el('div', 'rep-sub');
      for (const s of sessions.slice(0, 8)) {
        const b = el('button', 'rep-sess-btn', `${truncate(s.title, 52)} · ${fmtDuration(s.totalMs)}`);
        b.type = 'button';
        b.addEventListener('click', () => openSession(s.id));
        sub.append(b);
      }
      if (sessions.length > 8) sub.append(el('div', 'rep-more', `+ ${sessions.length - 8} more on the Sessions page`));
      wrap.append(sub);
      row.setAttribute('aria-expanded', 'false');
      row.addEventListener('click', () => row.setAttribute('aria-expanded', String(wrap.classList.toggle('open'))));
    } else if (onClick) {
      row.addEventListener('click', onClick);
    }
    sec.append(wrap);
  };
  const statRows = (title, stats, hint) => {
    if (!stats.length) return;
    const sec = section(title, hint);
    const max = stats[0].ms;
    for (const st of stats) {
      barRow(sec, st.label, st.ms, max, `${fmtDuration(st.ms)} · ${st.sessions.length} session${st.sessions.length === 1 ? '' : 's'}`,
        st.sessions.map((id) => model.getSession(id)));
    }
  };
  statRows('Topics', model.tagStats, 'Keyword guesses, made on this machine. A session can count toward several topics — click a row to see its sessions.');
  statRows('Folders', model.projectStats);

  // Apps: fixed identity colors, never by rank.
  {
    const bySrc = new Map();
    for (const s of model.listSessions()) bySrc.set(s.source, (bySrc.get(s.source) || 0) + s.totalMs);
    if (bySrc.size > 1) {
      const sec = section('Apps');
      const data = [...SOURCE_ORDER.filter((src) => bySrc.has(src)), ...[...bySrc.keys()].filter((src) => !SOURCE_ORDER.includes(src))]
        .map((src) => ({ label: appOf(src).name, value: bySrc.get(src), color: SERIES[SOURCE_ORDER.indexOf(src)] || OTHER_COLOR }));
      sec.append(shareBar(data, data.reduce((t, d) => t + d.value, 0), fmtDuration));
    }
  }

  // Who made your commits: you, or an AI tool (all tools only — commits belong to no tool).
  if (!app.state.filter.plan && app.commits && app.commits.count) {
    const sec = section('Who made your commits',
      'Your commits in the repos your chats started in. An AI tool made one when its own record says it ran that commit (Claude Code, Copilot) or the commit names it (a co-author line); “probably” when it ran a commit just then but git printed no ID. Click a month to see its commits.');
    sec.classList.add('rep-commits');
    const all = whoMade(allCommits(app.commits));
    const ai = all.total - all.you;
    sec.append(h('p', { class: 'rep-commits-total' }, h('b', null, String(all.total)), ` ${all.total === 1 ? 'commit' : 'commits'} · ${ai} by an AI tool (${sharePct(ai, all.total)}%)`,
      h('a', { class: 'link-btn rep-commits-all', href: '#/commits' }, 'See every commit')),
      shareBar(whoShares(all), all.total, (n) => plural(n, 'commit')));
    const months = commitsByMonth(app.commits).slice(0, 12);
    const max = Math.max(...months.map((m) => m.who.total));
    const rows = el('div', 'rep-commit-months');
    for (const m of months) {
      const label = fmtMonth(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)) - 1);
      const row = el('button', 'rep-row');
      row.type = 'button';
      row.title = `See ${label}’s commits`;
      row.addEventListener('click', () => app.go(`#/commits/${m.month}`));
      const stack = h('span', { class: 'rep-stack', style: { width: `${Math.max(2, Math.round((m.who.total / max) * 100))}%` } },
        whoShares(m.who).map((d) => h('span', { style: { 'flex-grow': String(d.value), background: d.color }, title: `${d.label}: ${plural(d.value, 'commit')}` })));
      const ai = m.who.total - m.who.you;
      row.append(el('span', 'rep-name', label), h('span', { class: 'rep-bar-track' }, stack),
        el('span', 'rep-val', `${plural(m.who.total, 'commit')}${ai ? ` · ${whoText(m.who)}` : ''}`));
      rows.append(row);
    }
    sec.append(rows);
  }

  {
    const sec = section('Busiest days');
    const top = model.listDays().slice().sort((a, b) => b.totalMs - a.totalMs).slice(0, 6);
    for (const d of top) barRow(sec, fmtDayLong(d.key), d.totalMs, top[0].totalMs, `${fmtDuration(d.totalMs)} · ${d.msgCount} msgs`, null, () => openDay(d.key));
  }
  {
    const sec = section('Longest sessions');
    const top = model.listSessions().slice().sort((a, b) => b.totalMs - a.totalMs).slice(0, 6);
    for (const s of top) barRow(sec, truncate(s.title, 34), s.totalMs, top[0].totalMs, `${fmtDuration(s.totalMs)} · ${s.msgCount} msgs`, null, () => openSession(s.id));
  }
  {
    const sec = section('Most active hours');
    const hist = el('div', 'hour-hist');
    const max = Math.max(1, ...model.hourHist);
    model.hourHist.forEach((n, hr) => {
      const b = el('div', 'hour-bar');
      b.style.height = `${Math.max(3, Math.round((n / max) * 100))}%`;
      if (n === max) b.classList.add('peak');
      b.title = `${String(hr).padStart(2, '0')}:00 — ${n} message${n === 1 ? '' : 's'}`;
      hist.append(b);
    });
    const lab = el('div', 'hour-labels');
    for (const t of ['00', '06', '12', '18', '23']) lab.append(el('span', null, t));
    sec.append(hist, lab);
  }
  rep.append(el('p', 'rep-note',
    'Every figure is a ≈ estimate from message times: active stretches, parallel sessions counted once. Topics are keyword matches — computed in this tab, nothing sent anywhere.'));
  return page;
}

/** Your plans' usage: the numbers the usage meter has, or why there are none. */
function usageCard(app) {
  const sec = h('section', { class: 'card usage-card', 'aria-label': 'Usage' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Usage'),
      h('a', { href: '#/settings', class: 'link-btn card-link' }, 'Usage meter')));
  for (const p of plansPresent(app.model.listSessions(), plansKnown(app.state.usageInfo))) {
    const u = app.usage[p.id];
    sec.append(h('div', { class: 'uplan' },
      h('div', { class: 'uplan-name' }, planMark(p.id), h('b', null, p.name),
        h('span', null, p.apps.map((id) => appOf(id).short).join(' · '))),
      h('div', { class: 'uplan-body' },
        u && u.windows.length ? h('div', { class: 'uplan-wins' }, usageWindows(u)) : null,
        h('p', { class: 'uplan-note' }, usageNote(app, p.id)),
        loginCopy(app.state.usageInfo, p.id),
        p.id === 'cursor' ? h('a', { href: CURSOR_USAGE_URL, target: '_blank', rel: 'noopener noreferrer', class: 'link-btn' }, 'Cursor’s usage page') : null)));
  }
  return sec;
}

function segmented(label, options, current, onPick) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const [id, text] of options) {
    seg.append(h('button', {
      type: 'button', class: `seg-btn${id === current ? ' is-on' : ''}`, 'aria-pressed': String(id === current),
      onclick: () => id !== current && onPick(id),
    }, text));
  }
  return seg;
}

/** The report as Markdown (generated here, for the filtered view). */
export function reportMarkdown(model, label) {
  const L = [];
  L.push(`# Throwbacks — activity report${label ? ` (${label})` : ''}`, '');
  L.push(`**Range:** ${fmtDayMed(model.minDayKey)} – ${fmtDayMed(model.maxDayKey)}  `);
  L.push(`**Sessions:** ${model.sessionCount} · **Messages:** ${model.msgTotal} · **Active days:** ${model.dayKeys.length} · **Active time:** ${fmtDuration(model.totalActiveMs)}`
    + (model.totalTokens > 0 ? ` · **Tokens (Claude Code):** ${fmtTokens(model.totalTokens)}` : ''), '');
  const table = (title, stats) => {
    if (!stats.length) return;
    L.push(`## ${title}`, '| Name | Time | Sessions | Messages |', '| --- | --- | --- | --- |');
    for (const st of stats) L.push(`| ${st.label} | ${fmtDuration(st.ms)} | ${st.sessions.length} | ${st.msgCount} |`);
    L.push('');
  };
  table('Topics', model.tagStats);
  table('Folders', model.projectStats);
  table('Apps', model.sourceStats);
  L.push('## Busiest days');
  for (const d of model.listDays().slice().sort((a, b) => b.totalMs - a.totalMs).slice(0, 10)) {
    L.push(`- ${fmtDayLong(d.key)} — ${fmtDuration(d.totalMs)}, ${d.msgCount} messages`);
  }
  L.push('', '## Longest sessions');
  for (const s of model.listSessions().slice().sort((a, b) => b.totalMs - a.totalMs).slice(0, 10)) {
    L.push(`- ${s.title} — ${fmtDuration(s.totalMs)}, ${s.msgCount} messages${s.tags.length ? ` _(${s.tags.join(', ')})_` : ''}`);
  }
  L.push('', '> All times are ≈ estimates from message times; topics are local keyword matches. Generated on this machine by Throwbacks.');
  return L.join('\n');
}
