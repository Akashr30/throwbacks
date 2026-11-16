// marks.js — what you pinned and archived in Sessions → Still going: one
// small file, ~/.throwbacks/marks.json, written by serve.py (loopback only),
// so every browser and port sees the same. When the server says it can't
// store it (--no-store, a LAN visitor's page) or there's no serve.py at all
// (serve.js) it lives in this browser's localStorage; the sample's made-up
// chats are marked in this tab only. Only chat IDs and times — nothing from
// a chat, and never the apps' own files. No DOM.

import { apiFetch } from './util.js';
import { marksOf, applyMark } from './plans.js';

const LS_KEY = 'throwbacks-marks';
// 'files' | 'browser' | 'tab' once decided — never switched in a tab after that;
// 'old' (a serve.py from before /api/marks: restart it) and 'away' (the server
// didn't answer) are asked again on the next load.
let where = null;
let loading = null;
let saved = marksOf(null);  // what's in the file (or this browser)
let tab = marksOf(null);    // the sample's: this tab only

function readLocal() {
  try { return marksOf(JSON.parse(localStorage.getItem(LS_KEY))); } catch { return marksOf(null); }  // blocked or corrupt
}

/** Every mark as saved (a sample chat's ID never matches a real one's). */
export const currentMarks = () => ({
  pinned: { ...saved.pinned, ...tab.pinned },
  archived: { ...saved.archived, ...tab.archived },
});

async function read() {
  if (where === 'browser') {
    saved = readLocal();
    return;
  }
  let r;
  try {
    r = await apiFetch('/api/marks');
  } catch {
    if (where !== 'files') where = 'away';  // keep what was read; ask again next time
    return;
  }
  if (r.ok) {
    saved = marksOf(await r.json().catch(() => null));
    where = 'files';
    return;
  }
  if (where === 'files') return;  // a hiccup: the marks are still in the file
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && j.error === 'Unknown API route') where = 'old';
  else if (r.status >= 500) where = 'away';
  else {  // --no-store, a LAN visitor's page, or no serve.py (serve.js)
    where = 'browser';
    saved = readLocal();
  }
}

/** Read the marks (again: on Refresh). `sample`: /?sample, which never reads or writes anything real. */
export async function loadMarks({ sample = false } = {}) {
  if (sample) where = 'tab';
  if (where === 'tab') return currentMarks();
  loading = loading || read().finally(() => { loading = null; });
  await loading;
  return currentMarks();
}

/**
 * One change — {id, pin: true|false} or {id, archive: {last}|null} — saved
 * where the marks live (`local`: a sample chat, this tab only). Resolves to
 * every mark as saved (another tab's changes included); throws, saying why,
 * if it couldn't save.
 */
export async function changeMark(op, { local = false } = {}) {
  if (local || where === 'tab') {
    const next = applyMark(tab, op, Date.now());
    if (!next) throw new Error('Couldn’t change that');
    tab = next;
    return currentMarks();
  }
  if (where !== 'files' && where !== 'browser') await loadMarks();  // not known yet, or the server was away
  if (where === 'old') throw new Error('Not saved — restart python3 serve.py to save pins and archives');
  if (where === 'away') throw new Error('Not saved — python3 serve.py isn’t answering');
  if (where === 'files') {
    let r;
    try {
      r = await apiFetch('/api/marks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      });
    } catch {
      throw new Error('Not saved — python3 serve.py isn’t answering');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? `Not saved — ${j.error}` : `Not saved (HTTP ${r.status})`);
    saved = marksOf(j);
    return currentMarks();
  }
  const next = applyMark(readLocal(), op, Date.now());
  if (!next) throw new Error('Couldn’t change that');
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    throw new Error('Not saved — this browser’s storage is full or blocked');
  }
  saved = next;
  return currentMarks();
}
