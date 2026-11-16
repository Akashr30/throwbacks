// daylog.js — writing the journal's AI summaries: one day (only the
// messages not summarized yet, or all of it with Rewrite — which keeps the
// version it replaces), a recap of a week, a month or any dates (their days
// that aren't summarized, then a short version of their lines: a line, each project's points, what's still open), the
// end-of-day run (today at the time you set, and any of the last days that
// are missing or out of date), your edits from the sheet, and removing them.
// Uses the summarizer chosen in Settings, never with the apps you left out
// there; every summary keeps the tokens the summarizer said it used. Saves
// through logstore.js (~/.throwbacks/daily, weekly, monthly, periods, or this
// browser). One job at a time — in every open tab on this address (a Web
// Lock is per origin: 127.0.0.1 and localhost are two): a day's or a recap's
// waits for another tab's, then reads what it saved; Stop keeps whatever
// finished.

import { pendingParts, mergeDaySummary, daySummaryState, daySummaryGroups, dayStamp, editSheetRow, addSheetRow, editedByHand, recapDays } from './log.js';
import { summarizeDayLog, summarizeWeekLog, addUsage, addSpent, tokensIn, planLogBatches, recapCalls, PROVIDERS } from './summarize.js';
import { getSettings } from './summarize-ui.js';
import { saveLogSummary, deleteLogSummary, BUCKET } from './logstore.js';
import { fmtDayLong, fmtDayMed, fmtDayShort, keyToDate, dateKey } from './util.js';
import { showToast } from './ui.js';

/** The Web Lock every tab's summary job takes (the end-of-day run's too): one at a time. */
export const SUMMARY_LOCK = 'throwbacks-summaries';

/** This month, "YYYY-MM": where a run's tokens are counted. */
const thisMonth = () => dateKey(Date.now()).slice(0, 7);

/**
 * A summary's tokens by month so far. One saved before they were kept by
 * month counts whole in the month it was last written — so its next run adds
 * to it rather than starting it again.
 */
function spentSoFar(saved) {
  if (!saved) return null;
  if (saved.spent) return saved.spent;
  const n = tokensIn(saved.usage) + ((saved.usage && saved.usage.output) || 0);
  return n && saved.updatedAt ? { [dateKey(saved.updatedAt).slice(0, 7)]: n } : null;
}

/** A day key `n` days from `key`. */
function addDaysKey(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateKey(d.getTime());
}

/** What each kind of recap is called: "the week of 9 Nov", "October 2026", "2 Oct – 14 Oct". */
export function recapLabel(kind, key) {
  if (kind === 'week') return `the week of ${fmtDayMed(key)}`;
  if (kind === 'month') return keyToDate(`${key}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const [from, to] = key.split('_');
  return `${fmtDayMed(from)} – ${fmtDayMed(to)}`;
}

/**
 * @param {{state: {summaries, job, errors, prefs}, redraw: () => void, skip?: () => Set<string>, reread?: () => Promise<void>}} hooks
 *   state.job while running: {kind: 'day'|'week'|'month'|'period'|'auto', key, controller, dayKey?, done?, total?, note?}
 *   skip: what's never sent — the apps you left out, and made-up chats beside your real summaries;
 *   reread: read the saved summaries again (another tab may have written).
 */
export function createDayLog({ state, redraw, skip: skipOf = null, reread = null }) {
  /** The apps whose chats are never sent (Settings → AI summaries), and the chats that never are. */
  const skip = () => (skipOf ? skipOf() : new Set((state.prefs && state.prefs.summaryOff) || []));

  /**
   * Run `fn` in this job's turn: after any other tab's summary job (its
   * end-of-day run, say) and after reading what it saved — so no day is sent
   * twice or written over. Stop while waiting gives up the turn.
   */
  async function inTurn(controller, fn) {
    const locks = typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request ? navigator.locks : null;
    if (!locks) return fn();
    const run = async () => {
      if (state.job) state.job.note = '';  // its turn: no longer waiting
      if (reread) await reread();
      return fn();
    };
    const now = await locks.request(SUMMARY_LOCK, { ifAvailable: true }, async (lock) => (lock ? { value: await run() } : null));
    if (now) return now.value;
    if (state.job) state.job.note = 'Waiting for another tab’s summary to finish…';
    redraw();
    try {
      return await locks.request(SUMMARY_LOCK, { signal: controller.signal }, run);
    } catch (e) {
      if (controller.signal.aborted) return { cancelled: true };
      throw e;
    }
  }

  /** Summarize one day's pending chats inside a running job. */
  async function runDay(row, model, controller, { rewrite = false } = {}) {
    const saved = state.summaries.days[row.key];
    const parts = pendingParts(row, model, saved, { rewrite, skip: skip() });
    if (!parts.length) return { ok: true, nothing: true };
    const settings = getSettings();
    const provider = settings.active;
    const cfg = settings[provider];
    Object.assign(state.job, { dayKey: row.key, done: 0, total: parts.length });
    state.errors.delete(row.key);
    redraw();
    let results = new Map();
    const problems = [];
    let cancelled = false;
    let usage = null;  // what this run used, as the summarizer counts it
    try {
      const out = await summarizeDayLog({
        parts,
        dateLabel: fmtDayLong(row.key),
        provider,
        key: cfg.key,
        model: cfg.model,
        signal: controller.signal,
        onUsage: (u) => { usage = addUsage(usage, u); },
        onProgress: (done, total) => { Object.assign(state.job, { done, total }); redraw(); },
      });
      results = out.results;
      problems.push(...out.errors);
    } catch (e) {
      if (e.cancelled) {
        cancelled = true;
        results = e.partial || new Map();
      } else {
        problems.push(e.message);
      }
    }
    if (results.size) {
      // Onto the day as it is now: edits and rows you made while this ran stay.
      const now = state.summaries.days[row.key];
      const next = mergeDaySummary(now, row.key, parts, results, { now: Date.now(), provider, model: cfg.model }, { rewrite });
      // Every token this day's summary has cost, across its runs (Add new, Rewrite) — when the summarizer
      // says — and by the month each run was in.
      const total = addUsage(now && now.usage, usage);
      if (total) next.usage = total;
      const spent = addSpent(spentSoFar(now), usage, thisMonth());
      if (spent) next.spent = spent;
      try {
        await saveLogSummary('day', row.key, next);
        state.summaries.days[row.key] = next;
      } catch (e) {
        problems.push(e.message);
      }
    }
    if (problems.length) state.errors.set(row.key, problems.join(' · '));
    return { ok: !problems.length && !cancelled, cancelled };
  }

  async function summarizeDay(row, model, { rewrite = false } = {}) {
    if (state.job || !row) return;
    const edited = editedByHand(state.summaries.days[row.key]);
    if (rewrite && !window.confirm(`Rewrite ${fmtDayMed(row.key)}’s summary from scratch? Its current lines are replaced${edited ? ', your edits to them too' : ''} — `
      + 'the current version stays on the Summaries page. Rows you added yourself are kept.')) return;
    state.job = { kind: 'day', key: row.key, controller: new AbortController() };
    const { controller } = state.job;
    let res;
    try {
      res = await inTurn(controller, () => runDay(row, model, controller, { rewrite }));
    } catch (e) {
      state.errors.set(row.key, e.message);
      res = { ok: false };
    }
    state.job = null;
    if (res.nothing) showToast('Nothing new to summarize');
    else if (res.cancelled) showToast('Stopped — what finished is kept');
    else if (res.ok) showToast(rewrite ? 'Day rewritten' : 'Summary updated');
    redraw();
  }

  /**
   * What a recap would do before it starts: how many of its days still need
   * summarizing, about how many calls that and the recap take, how many days
   * it will be written from, and how many days with chats have nothing to
   * send — and why (`why`: 'apps' you left out, 'sample' chats, 'quiet': no
   * messages). `rows`: its days with chats.
   */
  function recapPlan(kind, key, rows, model) {
    const per = (PROVIDERS[getSettings().active] || PROVIDERS.claudecode).perCallTokens;
    const sk = skip();
    const today = dateKey(Date.now());
    const byKey = new Map(rows.map((r) => [r.key, r]));
    let days = 0;
    let calls = 0;
    let quiet = 0;
    const why = new Set();
    const read = [];  // what the recap would read: the lines saved, or (for a day still to write) its chats
    for (const k of recapDays(kind, key)) {
      if (k > today) break;
      const row = byKey.get(k) || null;
      const saved = state.summaries.days[k];
      const parts = row ? pendingParts(row, model, saved, { skip: sk }) : [];
      const groups = daySummaryGroups(row, saved, { skip: sk });  // as writeRecap sends them, under their projects
      const lines = groups.flatMap((g) => g.lines);
      if (parts.length) {
        days++;
        calls += planLogBatches(parts, per).length;
      }
      if (lines.length || parts.length) read.push({ label: fmtDayLong(k), groups: [...groups, ...parts.map((p) => ({ project: p.project || '', lines: [p.title] }))], lines: [...lines, ...parts.map((p) => p.title)] });
      else if (row) {
        quiet++;
        for (const it of row.items.filter((x) => x.msgs)) why.add(sk.has(it.sessionId) ? 'sample' : sk.has(it.source) ? 'apps' : 'quiet');
        if (!row.items.some((x) => x.msgs)) why.add('quiet');
      }
    }
    return { days, calls: calls + (read.length ? recapCalls(read, per) : 0), from: read.length, quiet, why: [...why] };
  }

  /**
   * A recap of a week ('week', its Monday), a month ('month', YYYY-MM) or any
   * dates ('period', "from_to"): its days that aren't summarized (every tool
   * but the ones you left out), then a short version of the lines of every
   * day of it with a summary, under their projects (summarize.js RECAP_FORMAT).
   * `rows`: its days with chats. Says why when it
   * couldn't write it.
   */
  async function summarizeRecap(kind, key, rows, model) {
    if (state.job) {
      showToast('Wait for the summary that’s being written');
      return;
    }
    const id = `${kind}:${key}`;
    const label = recapLabel(kind, key);
    state.job = { kind, key, controller: new AbortController(), note: '' };
    state.errors.delete(id);
    const { controller } = state.job;
    let stopped = false;
    try {
      stopped = !!(await inTurn(controller, () => writeRecap(kind, key, rows, model, controller))).cancelled;
    } catch (e) {
      state.errors.set(id, e.message);
    }
    state.job = null;
    if (controller.signal.aborted) showToast('Stopped — what finished is kept');
    else if (state.errors.has(id)) showToast(`The recap of ${label} wasn’t written: ${state.errors.get(id)}`, { long: true });
    else if (!stopped) showToast(`Recap of ${label} written`);
    redraw();
  }

  async function writeRecap(kind, key, rows, model, controller) {
    const id = `${kind}:${key}`;
    const label = recapLabel(kind, key);
    const sk = skip();
    const todo = rows.filter((r) => daySummaryState(r, model, state.summaries.days[r.key], { skip: sk }).state !== 'current'
      && pendingParts(r, model, state.summaries.days[r.key], { skip: sk }).length);
    for (let i = 0; i < todo.length; i++) {
      state.job.note = `Writing ${fmtDayShort(todo[i].key)}… (day ${i + 1} of ${todo.length}, then the recap)`;
      redraw();
      const res = await runDay(todo[i], model, controller);
      state.job.dayKey = null;
      if (res.cancelled) return { cancelled: true };
      if (!res.ok) {
        state.errors.set(id, `${fmtDayMed(todo[i].key)} couldn’t be summarized — its page says why`);
        return {};
      }
    }
    // Every day of it with a summary — its chats loaded now or not — never a left-out app's lines
    // (as the setting is now: it may have changed while the days were written).
    const sent = skip();
    const today = dateKey(Date.now());
    const all = recapDays(kind, key);
    const keys = all.filter((k) => k <= today);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    // Each day's lines under their project, so the recap can group by project.
    const days = keys
      .map((k) => {
        const groups = daySummaryGroups(byKey.get(k) || null, state.summaries.days[k], { skip: sent });
        return { key: k, label: fmtDayLong(k), groups, lines: groups.flatMap((g) => g.lines) };
      })
      .filter((d) => d.lines.length);
    if (!days.length) {
      const off = (state.prefs && state.prefs.summaryOff) || [];
      state.errors.set(id, `No day in it has summary lines${off.length ? ' to send (chats from the apps you left out in Settings aren’t sent)' : ''}.`);
      return {};
    }
    // Stamped with the days as they were read: an edit during the call makes the recap out of date.
    const basedOn = Object.fromEntries(keys.filter((k) => state.summaries.days[k]).map((k) => [k, dayStamp(state.summaries.days[k])]));
    state.job.note = `Writing the recap of ${label}…`;
    redraw();
    const settings = getSettings();
    const provider = settings.active;
    const cfg = settings[provider];
    let usage = null;
    try {
      const text = await summarizeWeekLog({
        weekLabel: label, kind, days, provider, key: cfg.key, model: cfg.model, signal: controller.signal,
        onUsage: (u) => { usage = addUsage(usage, u); },
      });
      const before = state.summaries[BUCKET[kind]][key];
      const next = {
        v: 1, kind, key, ...(kind === 'week' ? { week: key } : {}), from: all[0], to: all[all.length - 1],
        updatedAt: Date.now(), provider, model: cfg.model, text, basedOn, daysUsed: days.map((d) => d.key),
      };
      if (usage) next.usage = usage;  // this version's tokens; `spent` keeps every run's, by month
      const spent = addSpent(spentSoFar(before), usage, thisMonth());
      if (spent) next.spent = spent;
      await saveLogSummary(kind, key, next);
      state.summaries[BUCKET[kind]][key] = next;
    } catch (e) {
      if (e.cancelled) return { cancelled: true };
      state.errors.set(id, e.message);
    }
    return {};
  }


  /**
   * Remove a day's summary — all of it, or under a tool filter only the
   * lines of the chats it shows (`only`: their ids, `label`: the tools), so
   * other tools' lines and your own rows stay.
   */
  async function removeDay(key, { only = null, label = '' } = {}) {
    if (state.job) {
      showToast('Wait for the summary that’s being written');
      return false;
    }
    const saved = state.summaries.days[key];
    const ids = only && saved && saved.chats ? Object.keys(saved.chats).filter((id) => only.has(id)) : null;
    const rest = ids && saved ? Object.fromEntries(Object.entries(saved.chats).filter(([id]) => !only.has(id))) : null;
    const partly = !!(rest && (Object.keys(rest).length || (saved.manual && saved.manual.length)));
    const question = partly
      ? `Remove ${fmtDayMed(key)}’s summary lines ${label ? `for ${label}` : 'shown here'}? Other tools’ lines and the rows you added stay.`
      : `Remove ${fmtDayMed(key)}’s summary? The day stays; its summary lines, your edits and rows, and earlier versions are deleted.`;
    if (!window.confirm(question)) return false;
    let ok = false;
    try {
      if (partly) {
        const next = { ...saved, chats: rest, editedAt: Date.now() };
        await saveLogSummary('day', key, next);
        state.summaries.days[key] = next;
        showToast('Lines removed');
      } else {
        await deleteLogSummary('day', key);
        delete state.summaries.days[key];
        showToast('Summary removed');
      }
      state.errors.delete(key);
      ok = true;
    } catch (e) {
      state.errors.set(key, e.message);
      showToast(`Couldn’t remove it: ${e.message}`);
    }
    redraw();
    return ok;
  }

  /** Remove a week's, a month's or a period's recap (its days' summaries stay). */
  async function removeRecap(kind, key) {
    if (state.job) {
      showToast('Wait for the summary that’s being written');
      return false;
    }
    if (!window.confirm(`Remove the recap of ${recapLabel(kind, key)}? Its days' summaries stay.`)) return false;
    try {
      await deleteLogSummary(kind, key);
      delete state.summaries[BUCKET[kind]][key];
      state.errors.delete(`${kind}:${key}`);
      state.errors.delete(`edit:${kind}:${key}`);
      showToast('Recap removed');
      redraw();
      return true;
    } catch (e) {
      showToast(`Couldn’t remove it: ${e.message}`);
      return false;
    }
  }
  const removeWeek = (monday) => removeRecap('week', monday);

  /** Save one edit from the sheet — applied to the whole saved day, never a filtered copy. */
  async function saveSheet(key, change) {
    const before = state.summaries.days[key];
    const next = change(before);
    if (next === null) {  // the row moved or went since the sheet was drawn
      state.errors.set(`sheet:${key}`, 'That row changed meanwhile — the sheet now shows it as it is. Try the edit again.');
      redraw();
      return false;
    }
    if (next === before) return true;
    state.summaries.days[key] = next;  // shown at once; put back if saving fails
    try {
      await saveLogSummary('day', key, next);
      state.errors.delete(`sheet:${key}`);
      return true;
    } catch (e) {
      if (before) state.summaries.days[key] = before;
      else delete state.summaries.days[key];
      state.errors.set(`sheet:${key}`, `Couldn’t save that edit: ${e.message}`);
      redraw();
      return false;
    }
  }
  const editRow = (key, edit, text) => saveSheet(key, (saved) => editSheetRow(saved, key, edit, text, Date.now()));
  const addRow = (key, text) => saveSheet(key, (saved) => addSheetRow(saved, key, text, Date.now(), `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`));

  /** Save a week's, month's or period's recap text as you edited it (empty: leave it). */
  async function editRecap(kind, key, text) {
    const before = state.summaries[BUCKET[kind]][key];
    // Its lines kept (a recap is a line, then each project's points), spaces at their ends and empty runs dropped.
    const value = String(text || '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!before || !value || value === before.text) return true;
    const next = { ...before, text: value, editedAt: Date.now() };
    // Its own key: a failed edit isn't a recap that wasn't written (the card shows it; a later save clears it).
    try {
      await saveLogSummary(kind, key, next);
      state.summaries[BUCKET[kind]][key] = next;
      state.errors.delete(`edit:${kind}:${key}`);
      return true;
    } catch (e) {
      state.errors.set(`edit:${kind}:${key}`, `Couldn’t save that edit: ${e.message}`);
      redraw();
      return false;
    }
  }
  const editWeek = (monday, text) => editRecap('week', monday, text);

  /**
   * The end-of-day run: today once your end of day has passed (and only
   * once a day), and every one of the last `days` days before it that has
   * something not summarized yet — oldest first, as one job you can Stop.
   * `rows` are the full day rows (every tool), newest first. Returns whether
   * it did anything. Stop, or a failure, ends it for this session (Settings
   * or a new summarizer starts it again).
   */
  async function autoSummarize(rows, model, { today, endOfDay, days = 7, ranToday }) {
    if (state.job || state.autoStopped) return false;
    const todo = [];
    for (const row of rows) {
      const isToday = row.key === today;
      if (isToday && (!endOfDay || ranToday)) continue;
      if (!isToday && row.key < addDaysKey(today, -days)) continue;
      if (row.key > today) continue;
      // Only days with messages to send: a day with nothing but activity has nothing to write.
      if (pendingParts(row, model, state.summaries.days[row.key], { skip: skip() }).length) todo.push(row);
    }
    if (!todo.length) return false;
    todo.sort((a, b) => (a.key < b.key ? -1 : 1));
    state.job = { kind: 'auto', key: 'auto', controller: new AbortController(), note: '' };
    const { controller } = state.job;
    let failedOn = null;
    const written = [];
    for (let i = 0; i < todo.length && !controller.signal.aborted; i++) {
      state.job.note = `Writing ${fmtDayShort(todo[i].key)}’s summary… (${i + 1} of ${todo.length})`;
      redraw();
      const res = await runDay(todo[i], model, controller);
      state.job.dayKey = null;
      if (res.ok && !res.nothing) written.push(todo[i].key);
      if (!res.ok && !res.cancelled) { failedOn = todo[i].key; break; }
    }
    state.job = null;
    if (failedOn) {
      state.autoStopped = true;  // e.g. the summarizer is out of quota: don't keep trying
      showToast(`End-of-day summaries stopped at ${fmtDayMed(failedOn)} — its page says why`);
    } else if (controller.signal.aborted) {
      state.autoStopped = true;  // you stopped it: not again by itself this session
      showToast('Stopped — what finished is kept');
    } else if (written.length) showToast(written.length === 1 ? `${fmtDayMed(written[0])} summarized` : `${written.length} days summarized`);
    redraw();
    return true;
  }

  const stop = () => { if (state.job) state.job.controller.abort(); };

  return { summarizeDay, summarizeRecap, recapPlan, removeDay, removeWeek, removeRecap, editRow, addRow, editWeek, editRecap, autoSummarize, stop };
}
