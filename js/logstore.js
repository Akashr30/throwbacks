// logstore.js — where the journal's AI summaries are kept: one small JSON
// file per day, week, month and period (any dates' recap) in ~/.throwbacks/
// daily, weekly, monthly and periods, written by serve.py (loopback only).
// When the server can't store them (--no-store, serve.js, a LAN visitor)
// they live in this browser's localStorage instead; /?sample keeps the
// sample's in the tab only and never reads yours. No DOM.

import { apiFetch } from './util.js';

const LS_KEY = 'throwbacks-log-summaries';
let where = null; // 'files' | 'browser' | 'memory' (/?sample), decided by the first load
let memory = null;  // the sample's, in this tab only

/** Each kind's bucket in what's loaded: day → days, week → weeks, month → months, period → periods. */
export const BUCKET = { day: 'days', week: 'weeks', month: 'months', period: 'periods' };
const buckets = (v) => Object.fromEntries(Object.values(BUCKET).map((b) => [b, (v && v[b]) || {}]));

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY));
    if (v && typeof v === 'object') return buckets(v);
  } catch { /* blocked or corrupt */ }
  return buckets(null);
}

function writeLocal(all) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every saved summary: {days: {date: day}, weeks: {monday: week}, months: {YYYY-MM: month}, periods: {from_to: period}, where, dir?}.
 * `sample`: the sample's own (made-up, in this tab) — yours are never read.
 */
export async function loadLogSummaries({ sample = null } = {}) {
  if (sample) {
    where = 'memory';
    memory = buckets(sample);
    return { ...memory, where };
  }
  try {
    const r = await apiFetch('/api/log-summaries');
    if (r.ok) {
      const j = await r.json();
      where = 'files';
      return { ...buckets(j), where, dir: j.dir };
    }
  } catch { /* no bridge here */ }
  where = 'browser';
  return { ...readLocal(), where };
}

/** Read them again from the same place (never switches where they're saved); null if it can't. */
export async function reloadLogSummaries() {
  if (!where) return null;
  if (where === 'memory') return { ...memory, where };
  if (where === 'browser') return { ...readLocal(), where };
  try {
    const r = await apiFetch('/api/log-summaries');
    if (!r.ok) return null;
    const j = await r.json();
    return { ...buckets(j), where, dir: j.dir };
  } catch {
    return null;
  }
}

/** Save one day ('day', date), week ('week', its Monday), month ('month', YYYY-MM) or period ('period', from_to). Throws on failure. */
export async function saveLogSummary(kind, key, data) {
  if (where === 'files') {
    const r = await apiFetch('/api/log-summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key, data }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Couldn’t save (HTTP ${r.status})`);
    return;
  }
  if (where === 'memory') {
    memory[BUCKET[kind]][key] = data;
    return;
  }
  const all = readLocal();
  all[BUCKET[kind]][key] = data;
  if (!writeLocal(all)) throw new Error('Couldn’t save — this browser’s storage is full or blocked');
}

/** Forget one saved day, week, month or period. */
export async function deleteLogSummary(kind, key) {
  if (where === 'files') {
    const r = await apiFetch(`/api/log-summaries?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`,
      { method: 'DELETE' });
    if (!r.ok) throw new Error(`Couldn’t delete (HTTP ${r.status})`);
    return;
  }
  if (where === 'memory') {
    delete memory[BUCKET[kind]][key];
    return;
  }
  const all = readLocal();
  delete all[BUCKET[kind]][key];
  writeLocal(all);
}
