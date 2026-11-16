// main.js — entry point: the two phases (the front page and the journal),
// loading every source (exports, zips, Claude Code folders, the apps on
// this Mac through serve.py, sample data), the tool filter, routing, the
// conversation beside the page, and the AI summary jobs.
//
// The phases are mutually exclusive: setPhase() clones the matching
// <template> into #root, so the other phase's markup is genuinely absent.
// The journal is day first — #/today (home), #/day/<date>, #/week/<monday>,
// #/sessions, #/commits, #/summaries, #/insights, #/search, #/settings — and every page
// shows what the tool filter allows: a model built from just those sessions
// (Commits excepted: a commit belongs to no chat app, so Made by is its filter).

import {
  parseExport, parseCodeSessions, parseCopilotFiles, parseCursorData,
  parseCopilotCliSessions, parseCoworkSessions, isCopilotLog, isCopilotSession,
} from './parse.js';
import { buildModel } from './model.js';
import { buildDailyLog, newerSummaries } from './log.js';
import { sampleData } from './sample.js';
import { apiFetch } from './util.js';
import { hydrateIcons, icon } from './icons.js';
import { renderSourceGrid, fetchSourceStatus, loadAppIcons, importableIds } from './sources.js';
import { applySavedTheme } from './theme.js';
import {
  initSummarizer, summarizerStatus, summarizeSingleSession, openSummarizerSettings, histAll, forgetTabSummaries,
} from './summarize-ui.js';
import { loadLogSummaries, reloadLogSummaries, BUCKET } from './logstore.js';
import { readUsage, planUsage, loginNeeded, LIVE_TOOLS } from './usage.js';
import { matcher, normalizeFilter, filterKey, filterLabel, homeDay, mondayOf, addDays, stepDay, weekKeys, viewPrefs, FOLDERS_MAX, marksOf, applyMark } from './plans.js';
import { loadMarks, changeMark, currentMarks } from './marks.js';
import { h, showToast, todayKey, downloadText, copyText, fmtShort } from './ui.js';
import { resumeTarget, resumeCommand, liveWhere, desktopLink, sourceTarget } from './resume.js';
import { indexCommits, mergeCommitData } from './commits.js';
import { retentionOf, dueSessions } from './keep.js';
import { expiringPage } from './expiring.js';
import { configureChips, renderReader } from './reader.js';
import { planBar, weekNav, monthNav, titleRow, sessionsRow, searchRow } from './topbar.js';
import { dayPage, weekPage, monthPage } from './journal.js';
import { cellUnchanged, focusCell } from './sheet.js';
import { sessionsPage, searchPage } from './browse.js';
import { commitsRow, madeByBar, commitsPage, jumpToDay } from './commitspage.js';
import { summariesRow, summariesFilter, summariesPage, renderSummaryPane, chatSummaryOf } from './summariespage.js';
import { insightsPage, reportMarkdown } from './insights.js';
import { settingsPage } from './settings.js';
import { createDayLog, SUMMARY_LOCK } from './daylog.js';

const $ = (id) => document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** /?sample: the sample data only — no app is read and Claude Code is never asked (demos, layout checks). */
const SAMPLE_ONLY = new URLSearchParams(location.search).has('sample');

// ---------------------------------------------------------------------------
// State — chats live in this tab's memory only
// ---------------------------------------------------------------------------

const PREFS_KEY = 'throwbacks-view'; // how pages are shown (never any chat data)

function loadPrefs() {
  try { return viewPrefs(JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { return viewPrefs(null); }  // storage blocked: defaults
}

/** The Commits page's filters (this tab only). */
function freshCommitView() {
  return { who: 'all', repo: '', q: '', range: null, open: new Set() };
}

const state = {
  phase: null,          // 'import' | 'viewer'
  webSessions: [],      // claude.ai exports
  codeSessions: [],     // Claude Code (folder, files or serve.py)
  ideSessions: [],      // Copilot, Copilot CLI, Cursor, Cowork
  imported: new Set(),  // apps loaded through serve.py — Refresh re-reads them
  sourceStatus: undefined, // serve.py's import status (null: no local bridge)
  dirHandle: null,      // the folder from "Choose folder", for Refresh and file chips
  model: null,          // every loaded session
  views: new Map(),     // filter key -> {model, rows}: the same, narrowed by the tool filter
  filter: { plan: null, app: null },
  route: { page: 'day', key: null },
  lastDay: null,        // the day page you were last on: Day from Week or Month goes back to it
  reader: null,         // {kind:'session', id, day?, part, msgId?} | {kind:'folder', path}
  popover: null,        // a plan id, or 'calendar'
  calMonth: null,
  summaries: { days: {}, weeks: {}, months: {}, periods: {}, where: null },
  savedRanges: [],      // the chat (session) summaries and older range summaries (summarize-ui.js histAll)
  sumView: { kind: 'all' },  // the Summaries page's filter (this tab only)
  job: null,            // a summary being written (daylog.js)
  commits: null,        // your git commits, placed by commits.js (null until read)
  commitsRead: false,   // the first read of them has answered (or there was nothing to ask)
  commitView: freshCommitView(),  // the Commits page: Made by, a repo, words, the heatmap's range, months opened
  commitJump: null,     // #/commits/<day> opened before the commits were read: go there once they are
  keep: null,           // Claude Code's cleanup setting and Throwbacks' kept copies (/api/keep)
  marks: marksOf(null), // Still going: what you pinned and archived (marks.js; IDs and times only)
  errors: new Map(),
  usageInfo: readUsage(null),
  asking: new Set(),    // the tools asked for their usage right now (Settings says "Asking…" only for these)
  checkingLogin: false, // Today's note's Check again is waiting on Claude Code
  summarizer: { enabled: false },
  prefs: loadPrefs(),
  sessQ: '',
  searchQ: '',
  findFolder: null,     // Sessions → Folder: the folder to scroll to once drawn (showFolder)
  busy: null,
  loadError: null,
};

const daylog = createDayLog({ state, redraw: () => redraw(), skip: () => summarySkip(), reread: () => rereadSummaries() });

/**
 * What's never sent to the summarizer: the apps you left out (Settings → AI
 * summaries), and — next to your real summaries, after Try or Add sample
 * data — the sample's made-up chats, so none lands in your saved days.
 */
function summarySkip() {
  const skip = new Set(state.prefs.summaryOff || []);
  if (state.sampleLoaded && !SAMPLE_ONLY && state.model) {
    for (const s of state.model.listSessions()) if (isSampleChat(s)) skip.add(s.id);
  }
  return skip;
}

const allRaw = () => [...state.webSessions, ...state.codeSessions, ...state.ideSessions];

/** The model and Daily log rows for a filter (cached until the data changes). */
function viewFor(filter) {
  const key = filterKey(filter);
  if (!state.views.has(key)) {
    const model = key ? buildModel(allRaw().filter(matcher(filter))) : state.model;
    const rows = new Map();
    for (const w of buildDailyLog(model)) for (const d of w.days) rows.set(d.key, d);
    state.views.set(key, { model, rows });
  }
  return state.views.get(key);
}
const view = () => viewFor(state.filter);

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function setPhase(phase) {
  state.phase = phase;
  const root = $('root');
  root.textContent = '';
  root.append($(phase === 'import' ? 'tpl-import' : 'tpl-viewer').content.cloneNode(true));
  hydrateIcons(root);
  if (phase === 'import') wireImport();
  else wireViewer();
}

function wireImport() {
  $('choose-file-btn').addEventListener('click', chooseFile);
  $('choose-folder-btn').addEventListener('click', openCodeFolder);
  $('sample-btn').addEventListener('click', loadSample);
  $('load-all-btn').addEventListener('click', importAll);
  drawLandingGrid();
}

function drawLandingGrid() {
  const grid = $('source-grid');
  if (!grid) return;
  renderSourceGrid(grid, { status: state.sourceStatus, loaded: state.imported, onPick: pickSource });
  const all = $('load-all-btn');
  const n = importableIds(state.sourceStatus).length;
  if (all) {
    all.hidden = n < 2;
    all.querySelector('.btn-label').textContent = `Load all ${n} apps`;
  }
}

function pickSource(src, action) {
  if (action === 'import') importSources([src.id]);
  else if (action === 'folder') openCodeFolder();
  else if (action === 'file') chooseFile();
}

const chooseFile = () => $('file-input').click();
const importAll = () => importSources(importableIds(state.sourceStatus));

function wireViewer() {
  state.route = parseRoute();
  initSummarizer({
    getModel: () => state.model,
    onChanged: () => { state.summarizer = summarizerStatus(); state.autoStopped = false; redraw(); endOfDay(); },
    // A chat's summary is one job like the others: it waits its turn, and Stop stops it.
    sample: () => (SAMPLE_ONLY ? sampleData().summaries.chats : null),
    // A made-up chat's summary stays in this tab, never with yours.
    isSampleChat: (id) => {
      const s = state.model && state.model.getSession(id);
      return !!s && isSampleChat(s);
    },
    busy: () => !!state.job,
    begin: (controller) => { state.job = { kind: 'session', key: 'session', controller }; redraw(); },
    end: () => { state.job = null; redraw(); },
    onSaved: () => reloadSaved(),
  });
  state.summarizer = summarizerStatus();
  $('job-stop').addEventListener('click', () => daylog.stop());
  // /?sample shows the sample's own made-up summaries, never yours.
  loadLogSummaries({ sample: SAMPLE_ONLY ? sampleData().summaries : null }).then((s) => { state.summaries = s; redraw(); endOfDay(); });
  reloadSaved();
  loadCommits();
  loadKeep();
  readMarks();
  refreshUsage({ live: true });
  render({ entering: true });
}

/** Clear everything loaded in this tab and go back to the front page. */
function clearAll() {
  if (state.job) {
    showToast('Wait for the summary that’s being written');
    return;
  }
  if (!window.confirm('Clear all loaded chats from this tab and go back to the front page? Your files on disk are untouched.')) return;
  forgetTabSummaries();  // a sample chat's summary kept in this tab goes too
  Object.assign(state, {
    webSessions: [], codeSessions: [], ideSessions: [], imported: new Set(), dirHandle: null,
    model: null, views: new Map(), filter: { plan: null, app: null }, reader: null, popover: null,
    errors: new Map(), sessQ: '', searchQ: '', loadError: null, sampleLoaded: false, commits: null, keep: null,
    commitsRead: false, commitView: freshCommitView(),
  });
  lastRealCommits = null;
  history.replaceState(null, '', location.pathname + location.search);
  setPhase('import');
}

// ---------------------------------------------------------------------------
// Load feedback: on the front page, or in Settings → Your chats. A failed
// load never leaves the front page.
// ---------------------------------------------------------------------------

function showLoadError(msg) {
  if (state.phase === 'viewer') {
    state.loadError = msg;
    showToast(msg.length > 90 ? 'Couldn’t load that — see Settings' : msg);
    redraw();
  } else {
    const box = $('landing-error');
    box.textContent = msg;
    box.hidden = false;
  }
}

function clearLoadError() {
  state.loadError = null;
  const box = $('landing-error');
  if (box) box.hidden = true;
}

function setBusy(msg) {
  if (state.phase === 'viewer') {
    state.busy = msg || null;
    const pill = $('busy-pill');
    if (pill) {
      pill.hidden = !msg;
      pill.lastChild.textContent = msg || '';
    }
    if (state.route.page === 'settings') drawPage();
    return;
  }
  const box = $('import-busy');
  if (!box) return;
  box.textContent = msg || '';
  box.hidden = !msg;
}

// ---------------------------------------------------------------------------
// Source loading (unchanged readers: exports, zips, folders, apps, sample)
// ---------------------------------------------------------------------------

async function loadJszip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('offline'));
    document.head.append(s);
  });
  return window.JSZip;
}

const BAD_JSON_MSG = 'That file isn’t valid JSON. Expected the conversations.json from your Claude export.';

async function handleExportJsonText(text, name) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    showLoadError(BAD_JSON_MSG);
    return false;
  }
  return handleExportJson(json, name);
}

/** `name`: the export file's name — all the browser is told about where it was (the conversation shows it). */
function handleExportJson(json, name = null) {
  const sessions = parseExport(json);
  if (name) for (const s of sessions) s.exportName = name;
  if (sessions.length === 0) {
    showLoadError('Valid JSON, but no messages found in it. Is this the conversations.json from Settings → Privacy → Export data?');
    return false;
  }
  state.webSessions = sessions;
  return true;
}

async function handleZip(file) {
  let JSZip;
  try {
    JSZip = await loadJszip();
  } catch {
    showLoadError('Couldn’t load the unzip library (are you offline?). Unzip the export manually and drop conversations.json here instead.');
    return false;
  }
  try {
    const zip = await JSZip.loadAsync(file);
    const entry = Object.values(zip.files).find((f) => /conversations\.json$/i.test(f.name));
    if (!entry) {
      showLoadError('That zip has no conversations.json inside. Drop the Claude export zip, or the conversations.json itself.');
      return false;
    }
    return handleExportJsonText(await entry.async('string'), file.name);
  } catch {
    showLoadError('Couldn’t read that zip file. Unzip it manually and drop conversations.json here instead.');
    return false;
  }
}

async function handleFiles(fileList) {
  clearLoadError();
  const files = [...fileList];
  const jsonls = files.filter((f) => /\.jsonl$/i.test(f.name));
  const jsons = files.filter((f) => /\.json$/i.test(f.name));
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (!files.length || (!zip && !jsons.length && !jsonls.length)) {
    showLoadError('Unsupported file type. Drop a Claude export (.zip or conversations.json), Claude Code .jsonl sessions, or Copilot chat session files.');
    return;
  }
  setBusy('Loading your history…');
  await tick();
  let loaded = false;
  try {
    // .json / .jsonl files can also be Copilot sessions — sort them by content.
    const copilot = [];
    const codeEntries = [];
    for (const f of jsonls) {
      const text = await f.text();
      if (isCopilotLog(text)) copilot.push({ name: f.name, workspace: null, text });
      else codeEntries.push({ name: f.name.split('/').pop(), project: guessProjectFolder(f), text });
    }
    let exportFile = null; // the first non-Copilot .json: a claude.ai export
    for (const f of jsons) {
      const text = await f.text();
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        obj = undefined;
      }
      if (isCopilotSession(obj)) copilot.push({ name: f.name, workspace: null, text });
      else if (!exportFile) exportFile = { obj, name: f.name };
    }
    const codeSessions = parseCodeSessions(codeEntries);
    if (codeSessions.length) {
      mergeCodeSessions(codeSessions);
      loaded = true;
    }
    const ideSessions = parseCopilotFiles(copilot);
    if (ideSessions.length) {
      mergeIdeSessions(ideSessions);
      loaded = true;
    }
    if (zip) {
      loaded = (await handleZip(zip)) || loaded;
    } else if (exportFile) {
      if (exportFile.obj === undefined) showLoadError(BAD_JSON_MSG);
      else loaded = handleExportJson(exportFile.obj, exportFile.name) || loaded;
    }
  } finally {
    setBusy(null);
  }
  if (loaded) onLoadSuccess();
}

function guessProjectFolder(file) {
  const parts = (file.webkitRelativePath || '').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

function mergeCodeSessions(sessions) {
  const map = new Map(state.codeSessions.map((s) => [s.id, s]));
  for (const s of sessions) map.set(s.id, s);
  state.codeSessions = [...map.values()];
}

function mergeIdeSessions(sessions) {
  const map = new Map(state.ideSessions.map((s) => [s.id, s]));
  for (const s of sessions) map.set(s.id, s);
  state.ideSessions = [...map.values()];
}

function loadSample() {
  clearLoadError();
  const { conversations, codeFiles, copilotFiles, cursorData } = sampleData();
  state.webSessions = parseExport(conversations);
  mergeCodeSessions(parseCodeSessions(codeFiles));
  mergeIdeSessions([...parseCopilotFiles(copilotFiles), ...parseCursorData(cursorData)]);
  state.sampleLoaded = true;  // made-up chats: never summarized by themselves
  onLoadSuccess();
}

// Each app serve.py can read: its import route, its parser, and whether its
// sessions join the Claude Code set (same ids as the folder reader, so the
// two never duplicate) or the other tools' set.
const SERVER_SOURCES = {
  'claude-code': { name: 'Claude Code', path: '/api/import/claude-code', parse: (b) => parseCodeSessions(b.files), code: true },
  cowork: { name: 'Claude Cowork', path: '/api/import/cowork', parse: (b) => parseCoworkSessions(b.sessions) },
  copilot: { name: 'Copilot', path: '/api/import/copilot', parse: (b) => parseCopilotFiles(b.files) },
  'copilot-cli': { name: 'Copilot CLI', path: '/api/import/copilot-cli', parse: (b) => parseCopilotCliSessions(b.sessions) },
  cursor: { name: 'Cursor', path: '/api/import/cursor', parse: (b) => parseCursorData(b) },
};

async function importSources(ids, { quiet = false } = {}) {
  const wanted = ids.filter((id) => SERVER_SOURCES[id]);
  if (!wanted.length) return false;
  clearLoadError();
  setBusy(wanted.length > 1
    ? 'Reading your AI apps’ chats… (big histories take a few seconds)'
    : `Reading ${SERVER_SOURCES[wanted[0]].name} chats…`);
  await tick();
  try {
    const get = async (path) => {
      const r = await apiFetch(path);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    };
    const results = await Promise.allSettled(wanted.map((id) => get(SERVER_SOURCES[id].path)));
    const code = [];
    const other = [];
    const failed = [];
    const done = [];
    results.forEach((r, i) => {
      const src = SERVER_SOURCES[wanted[i]];
      if (r.status !== 'fulfilled') {
        failed.push(`${src.name}: ${r.reason.message}`);
        return;
      }
      (src.code ? code : other).push(...src.parse(r.value));
      done.push(wanted[i]);
    });
    if (!code.length && !other.length) {
      showLoadError(failed.length ? `Couldn’t read those chats — ${failed.join(' · ')}` : 'No chats with messages were found there.');
      return false;
    }
    if (done.includes('claude-code')) {
      // The server's list is the whole picture: a chat Claude Code deleted (or a kept copy you
      // removed) drops out, while the folder picker's and the sample's stay.
      const fresh = new Set(code.map((s) => s.id));
      state.codeSessions = state.codeSessions.filter((s) => !s.fromServer || fresh.has(s.id));
      for (const s of code) s.fromServer = true;
    }
    if (code.length) mergeCodeSessions(code);
    if (other.length) mergeIdeSessions(other);
    for (const id of done) state.imported.add(id);
    onLoadSuccess({ quiet });
    if (failed.length) showToast(`Partly loaded — ${failed.join(' · ')}`);
    return true;
  } finally {
    setBusy(null);
  }
}

// --- A Claude Code folder: directory picker / webkitdirectory fallback ----

/**
 * Resolve a file path to a live handle inside the opened folder tree, for
 * a file chip's preview. The File System Access API never reveals the
 * picked folder's absolute path, so we anchor on its NAME: for each
 * occurrence of that name in the path (last first), walk the remaining
 * segments. Relative paths are also tried from the folder root.
 */
async function resolveFileInTree(path) {
  const dir = state.dirHandle;
  if (!dir || !path) return null;
  const segs = path.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  const walk = async (from, parts) => {
    if (!parts.length) return null;
    let d = from;
    for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
    const file = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    return { name: file.name, text: await file.text() };
  };
  for (let i = segs.length - 2; i >= 0; i--) {
    if (segs[i] !== dir.name) continue;
    try {
      const found = await walk(dir, segs.slice(i + 1));
      if (found) return found;
    } catch { /* try an earlier occurrence */ }
  }
  if (!/^(?:[A-Za-z]:|\/)/.test(path)) {
    try {
      return await walk(dir, segs);
    } catch { /* not in the tree */ }
  }
  return null;
}

/**
 * A subagent transcript cut to its token usage, as serve.py cuts it (cc_usage_line):
 * {timestamp, requestId, message: {id, usage}} per line — never its text or tool output.
 */
function usageLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.includes('"usage"')) continue;
    try {
      const line = JSON.parse(raw);
      const msg = line && line.message;
      if (!msg || !msg.usage || typeof msg.usage !== 'object' || typeof line.timestamp !== 'string') continue;
      out.push(JSON.stringify({ timestamp: line.timestamp, requestId: line.requestId, message: { id: msg.id, usage: msg.usage } }));
    } catch { /* a malformed line */ }
  }
  return out.join('\n');
}

/** Each session's subagent lines (by its file name) handed to its entry, as serve.py does. */
function attachSubagents(entries, subs) {
  for (const e of entries) {
    const lines = subs.get(e.name.replace(/\.jsonl$/i, ''));
    if (lines) e.subTokens = lines.join('\n');
  }
  return entries;
}

/**
 * The .jsonl files under a folder. A session's subagents (<session>/subagents/…) are
 * internal agent transcripts, never conversations: only their token usage is kept,
 * in `subs` by session (`sid`: the session whose subagents these are).
 */
async function collectJsonl(dirHandle, project, out, subs, sid = null) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && /\.jsonl$/i.test(entry.name)) {
      const text = await (await entry.getFile()).text();
      if (sid) (subs.get(sid) || subs.set(sid, []).get(sid)).push(usageLines(text));
      else out.push({ name: entry.name, project, text });
    } else if (entry.kind === 'directory') {
      if (entry.name === 'subagents') await collectJsonl(entry, project, out, subs, sid || dirHandle.name);
      else await collectJsonl(entry, entry.name, out, subs, sid);
    }
  }
}

async function openCodeFolder() {
  clearLoadError();
  if (window.showDirectoryPicker) {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // cancelled
    }
    state.dirHandle = handle;
    await readCodeFolder();
  } else {
    $('dir-fallback-input').click();
  }
}

async function readCodeFolder() {
  setBusy('Reading the folder…');
  await tick();
  try {
    const entries = [];
    const subs = new Map();
    try {
      await collectJsonl(state.dirHandle, state.dirHandle.name, entries, subs);
      attachSubagents(entries, subs);
    } catch {
      showLoadError('Couldn’t read that folder. Try picking it again.');
      return;
    }
    if (!entries.length) {
      showLoadError('No .jsonl session files found in that folder. Pick your ~/.claude/projects folder (or one project inside it).');
      return;
    }
    const sessions = parseCodeSessions(entries);
    if (!sessions.length) {
      showLoadError('Found .jsonl files, but none contained readable session lines.');
      return;
    }
    state.codeSessions = sessions.concat(state.codeSessions.filter((s) => !sessions.some((n) => n.id === s.id)));
    onLoadSuccess();
  } finally {
    setBusy(null);
  }
}

async function handleDirFallback(input) {
  clearLoadError();
  const all = [...input.files].filter((f) => /\.jsonl$/i.test(f.name));
  const subOf = (f) => ((f.webkitRelativePath || '').match(/([^/]+)\/subagents\//) || [])[1] || null;
  const files = all.filter((f) => !subOf(f));
  if (!files.length) {
    showLoadError('No .jsonl session files found in that folder. Pick your ~/.claude/projects folder.');
    return;
  }
  setBusy('Loading your sessions…');
  await tick();
  try {
    const entries = await Promise.all(files.map(async (f) => ({ name: f.name, project: guessProjectFolder(f), text: await f.text() })));
    const subs = new Map();
    for (const f of all.filter(subOf)) (subs.get(subOf(f)) || subs.set(subOf(f), []).get(subOf(f))).push(usageLines(await f.text()));
    const sessions = parseCodeSessions(attachSubagents(entries, subs));
    if (!sessions.length) {
      showLoadError('Found .jsonl files, but none contained readable session lines.');
      return;
    }
    mergeCodeSessions(sessions);
    onLoadSuccess();
  } finally {
    setBusy(null);
  }
}

const canRefresh = () => !!(state.dirHandle || state.imported.size);

async function refresh() {
  sourceAsked.clear();  // a chat's file may have moved, been deleted or kept since
  if (state.dirHandle) await readCodeFolder();
  if (state.imported.size) await importSources([...state.imported]);
  readMarks();  // another tab may have pinned or archived since
  refreshUsage({ live: true });
}

/**
 * After any load: the front page moves on to the journal; inside the
 * journal everything updates in place, keeping the page, the filter and
 * the open conversation (unless it's gone).
 */
function onLoadSuccess({ quiet = false } = {}) {
  state.model = buildModel(allRaw());
  state.views = new Map();
  if (state.model.isEmpty) {
    showLoadError('Loaded the file, but found no messages in it.');
    return;
  }
  clearLoadError();
  if (state.phase !== 'viewer') {
    setPhase('viewer');
    return;
  }
  if (state.reader && state.reader.kind === 'session' && !view().model.getSession(state.reader.id)) state.reader = null;
  if (state.reader && state.reader.kind === 'folder' && !view().model.getFolder(state.reader.path)) state.reader = null;
  if (!quiet) showToast('Chats updated');
  redraw();
  loadCommits();
  loadKeep();
}

/**
 * The usage meter's numbers. `live` asks the server to ask Claude Code (with
 * --claude; at most once a minute however often it's called) — when the
 * journal opens, when you come back to it after LIVE_EVERY_MS, and on Refresh /
 * Check again. Otherwise it only re-reads what the server has: the last live
 * answer and the status line's file. /?sample never asks.
 */
async function refreshUsage({ live = false, only = null } = {}) {
  const shown = () => state.phase === 'viewer' && state.model && (state.route.page === 'insights' || state.route.page === 'settings');
  const take = (status) => {
    const next = readUsage(status);
    if (JSON.stringify(next) === JSON.stringify(state.usageInfo)) return;
    // Claude Code's login lapsed or came back: a day's page says so (on Today).
    const relogged = !!loginNeeded(next) !== !!loginNeeded(state.usageInfo);
    state.usageInfo = next;
    // Only what shows usage: the plan bar, and Insights or Settings. Never the
    // open conversation — redrawing it would lose your place in it.
    if (state.phase !== 'viewer' || !state.model) return;
    drawTopbar();
    if (shown() || (relogged && state.route.page === 'day')) drawPage();
    if (relogged && !loginNeeded(next) && !state.checkingLogin) showToast('Claude Code is logged in again — usage updated');
  };
  const read = async (path, init) => {
    try {
      const r = await apiFetch(path, init);
      return r.ok ? await r.json() : null;
    } catch { return null; /* no server: the meter is unavailable */ }
  };
  // Which tools may be asked is the server's (it never runs one you turned off): before the
  // first ask, read its switches — not the defaults — so a tool you turned on is asked too.
  if (live && !SAMPLE_ONLY && !state.usageInfo.available) take(await read('/api/usage'));
  const tools = live && !SAMPLE_ONLY
    ? (only || Object.keys(LIVE_TOOLS)).filter((id) => state.usageInfo.ask[id] !== false) : [];
  if (tools.length) liveAskedAt = Date.now();
  if (!tools.length) {
    // /?sample reads no app's files: the server leaves Codex's sessions, Cursor's plan and Claude Code's settings alone.
    take(await read(SAMPLE_ONLY ? '/api/usage?apps=0' : '/api/usage'));
    return;
  }
  // One request per tool, side by side, so a slow one (agy can take seconds)
  // never holds up the rest; each answer is the whole picture so far.
  let last = null;
  for (const tool of tools) state.asking.add(tool);
  if (shown()) drawPage();
  await Promise.all(tools.map((tool) => read('/api/usage/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool }),
  }).then((status) => {
    state.asking.delete(tool);
    if (status) { last = status; take(status); }
  })));
  // Answers can arrive out of order: read the final state once all are in.
  const before = state.usageInfo;
  take((await read('/api/usage')) || last);
  if (state.usageInfo === before && shown()) drawPage();  // no change, but nothing is "Asking…" any more
}

const LIVE_EVERY_MS = 5 * 60 * 1000;
/** serve.py asks a tool at most once a minute; within it, an ask gets the last answer. */
const LIVE_GAP_MS = 61 * 1000;

/**
 * Today's note's Check again: asks Claude Code once more — after that minute
 * if it was asked just now, so a login made a moment ago is seen ("Checking…"
 * meanwhile) — and says how it went.
 */
async function checkLogin() {
  if (state.checkingLogin) return;
  state.checkingLogin = true;
  drawPage();
  try {
    const wait = liveAskedAt + LIVE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await refreshUsage({ live: true, only: ['claude'] });
  } finally {
    state.checkingLogin = false;
  }
  const still = !!loginNeeded(state.usageInfo);
  showToast(still ? 'Still not logged in to a Claude plan — checked just now' : 'Claude Code is logged in — usage updated');
  if (state.route.page !== 'day') return;
  drawPage();
  // The note (and its button) went: the keyboard goes to the day's title, not the page's top.
  const lost = !document.activeElement || document.activeElement === document.body;
  const title = lost ? document.querySelector('#page-scroll .day-title') : null;
  if (title) {
    title.setAttribute('tabindex', '-1');
    title.focus({ preventScroll: true });
  }
}

// ---- The end-of-day summaries (Settings → AI summaries) ------------------------
const AUTO_RAN_KEY = 'throwbacks-auto-summary';  // the last day whose end-of-day run happened

/**
 * Write summaries by themselves: today once your end of day has passed
 * (once a day), and any of the last 7 days with chats not summarized yet.
 * Only while the journal is open, with a summarizer set up, never on
 * sample data, and in one tab at a time — after reading again what other
 * tabs saved, so nothing is written twice or over their edits.
 */
async function endOfDay() {
  const ready = () => {
    const auto = state.prefs.autoSummary;
    return !SAMPLE_ONLY && !state.sampleLoaded && auto.on && state.phase === 'viewer' && state.model && !state.job
      && !state.autoStopped && state.summarizer.enabled && state.summaries.where;
  };
  if (!ready()) return;
  const run = async () => {
    await refreshSummaries();
    if (!ready()) return;
    const today = todayKey();
    const [hh, mm] = state.prefs.autoSummary.at.split(':').map(Number);
    const due = new Date().getHours() * 60 + new Date().getMinutes() >= hh * 60 + mm;
    let ranToday = false;
    try { ranToday = localStorage.getItem(AUTO_RAN_KEY) === today; } catch { /* fine */ }
    const rows = [...viewFor(null).rows.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
    await daylog.autoSummarize(rows, state.model, { today, endOfDay: due, ranToday });
    if (due && !state.autoStopped) {
      try { localStorage.setItem(AUTO_RAN_KEY, today); } catch { /* fine */ }
    }
  };
  // Another tab already writing them is enough (no lock support: this tab only).
  if (navigator.locks && navigator.locks.request) {
    await navigator.locks.request(SUMMARY_LOCK, { ifAvailable: true }, (lock) => (lock ? run() : null));
  } else await run();
}

/** Turn the end-of-day summaries on (run now if due) or off (stop one that's writing). */
function setAutoSummary(on) {
  setPref('autoSummary', { ...state.prefs.autoSummary, on });
  if (on) {
    state.autoStopped = false;
    endOfDay();
  } else if (state.job && state.job.kind === 'auto') daylog.stop();
}

/** Read the saved summaries again (another tab may have written); redraw if anything changed. */
async function refreshSummaries() {
  if (state.job || !state.summaries.where) return;
  const fresh = await reloadLogSummaries();
  if (!fresh || fresh.where !== state.summaries.where || state.job) return;
  takeSummaries(fresh);
}

/** The same, inside a summary job that just got its turn (daylog.js): before it writes anything. */
async function rereadSummaries() {
  if (!state.summaries.where) return;
  const fresh = await reloadLogSummaries();
  if (fresh && fresh.where === state.summaries.where) takeSummaries(fresh);
}

function takeSummaries(fresh) {
  const before = state.summaries;
  const next = newerSummaries(before, fresh);
  const changed = ['days', 'weeks', 'months', 'periods'].some((k) => Object.keys(next[k]).length !== Object.keys(before[k]).length
    || Object.entries(next[k]).some(([key, v]) => before[k][key] !== v));
  if (!changed) return;
  state.summaries = next;
  redraw();
}
let liveAskedAt = 0;
let cameBackAt = 0;

/** You came back to the tab or the window: fresh numbers if the last ask is old. */
function cameBack() {
  if (state.phase !== 'viewer' || Date.now() - cameBackAt < 2000) return;  // focus + visibility fire together
  cameBackAt = Date.now();
  refreshUsage({ live: Date.now() - liveAskedAt >= LIVE_EVERY_MS });
  refreshSummaries();  // what you wrote in another tab meanwhile
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const isKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');

function parseRoute() {
  const raw = (location.hash || '#/today').slice(1);
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'day': return isKey(parts[1]) ? { page: 'day', key: parts[1] } : homeRoute();
    case 'week': return { page: 'week', key: mondayOf(isKey(parts[1]) ? parts[1] : todayKey()) };
    case 'month': return { page: 'month', key: /^\d{4}-\d{2}$/.test(parts[1] || '') ? parts[1] : todayKey().slice(0, 7) };
    case 'sessions': return { page: 'sessions' };
    // #/commits/<day or month>: open at that day's commits (the newest on or before it).
    case 'commits': return { page: 'commits', key: isKey(parts[1]) || /^\d{4}-\d{2}$/.test(parts[1] || '') ? parts[1] : null };
    case 'summaries': return { page: 'summaries' };
    case 'insights': return { page: 'insights' };
    case 'search': {
      const q = new URLSearchParams(query).get('q');
      if (q != null) state.searchQ = q;
      return { page: 'search' };
    }
    case 'settings': return { page: 'settings' };
    case 'expiring': return { page: 'expiring' };
    default: return homeRoute();
  }
}

function homeRoute() {
  const home = homeDay(view().model.dayKeys, todayKey());
  return { page: 'day', key: home.key, moved: home.moved, home: true };
}

const homeKey = () => homeDay(view().model.dayKeys, todayKey()).key;

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------------------------------------------------------------------------
// Drawing the journal
// ---------------------------------------------------------------------------

const NAV = [
  ['today', 'Today', 'today', '#/today'],
  ['sessions', 'Sessions', 'stack', '#/sessions'],
  ['commits', 'Commits', 'commit', '#/commits'],
  ['summaries', 'Summaries', 'sparkles', '#/summaries'],
  ['insights', 'Insights', 'chart', '#/insights'],
  ['search', 'Search', 'search', '#/search'],
  ['expiring', 'Expiring', 'clock', '#/expiring'],
];
const SETTINGS = ['settings', 'Settings', 'sliders', '#/settings'];

/** What the pages read: the state, the models, and the actions. */
function app() {
  const v = view();
  return {
    state,
    model: state.model,
    view: v.model,
    rows: v.rows,
    allRows: viewFor(null).rows,
    usage: planUsage(state.usageInfo),
    summarizer: state.summarizer,
    commits: state.commits,
    keep: state.keep,
    due: dueNow(),
    keepCopy, removeCopy, resume: resumeActions,
    marks: state.marks, markChat,
    go, homeKey, canRefresh, refresh, refreshUsage, setAsk, checkLogin,
    renderPage: drawPage, redrawTopbar: drawTopbar,
    openSession, openCommit, openFolder, showFolder, setFilter, togglePopover, setPref, setSheetGroup, setSessionsView, rememberFolder, rememberFolders,
    summarizeDay: (key, opts) => daylog.summarizeDay(view().rows.get(key), view().model, opts),
    editSheetRow: (key, edit, text) => daylog.editRow(key, edit, text).then((ok) => { redraw(); return ok; }),
    addSheetRow: (key, text) => daylog.addRow(key, text).then((ok) => { redraw(); return ok; }),
    editWeekSummary: (monday, text) => daylog.editWeek(monday, text).then(() => redraw()),
    editRecap: (kind, key, text) => daylog.editRecap(kind, key, text).then(() => redraw()),
    setAutoSummary,
    removeDaySummary: (key) => {
      // Under a tool filter, only the lines of the chats it shows go.
      const row = state.filter.plan ? view().rows.get(key) : null;
      return daylog.removeDay(key, row ? { only: new Set(row.items.map((it) => it.sessionId)), label: filterLabel(state.filter) } : {});
    },
    stopJob: daylog.stop,
    pickSource, importAll, chooseFile, chooseFolder: openCodeFolder, addSample: loadSample, clearAll,
    openSummarizerSettings,
    // The Summaries page: a summary beside the page, a recap of any period, removing them.
    openSummary, closeReader, reloadSaved,
    removeDay: (key) => daylog.removeDay(key),
    removeRecap: (kind, key) => daylog.removeRecap(kind, key),
    recapPlan: (kind, key, rows) => daylog.recapPlan(kind, key, rows, state.model),
    summarySkip,
    recap: async (kind, key, rows) => {
      const before = state.summaries[BUCKET[kind]][key];
      await daylog.summarizeRecap(kind, key, rows, state.model);
      const now = state.summaries[BUCKET[kind]][key];
      return !!now && now !== before;
    },
  };
}

const navOf = (page) => (page === 'day' || page === 'week' || page === 'month' ? 'today' : page);

function drawNav() {
  const active = navOf(state.route.page);
  const due = dueNow().length;  // chats Claude Code deletes within a week: a count on Expiring
  // `badgeOn`: the rail counts on Expiring; the phone's bar (five tabs) counts on Today, whose note links there.
  const item = ([id, label, iconName, href], cls, badgeOn = 'expiring') => h('a', {
    href, class: `${cls}${active === id ? ' is-on' : ''}`, 'aria-current': active === id ? 'page' : null,
    'aria-label': id === badgeOn && due ? `${label}: ${due} chat${due === 1 ? '' : 's'} deleted within a week` : null,
  }, icon(iconName, 20), h('span', null, label), id === badgeOn && due ? h('span', { class: 'nav-badge' }, String(due)) : null);
  const rail = $('rail');
  rail.textContent = '';
  rail.append(
    h('a', { href: '#/today', class: 'brand', 'aria-label': 'Throwbacks — Today', title: 'Throwbacks' },
      h('span', { class: 'brand-mark' }, icon('rewind', 16))),
    h('div', { class: 'rail-items' }, NAV.map((n) => item(n, 'rail-item'))),
    item(SETTINGS, 'rail-item rail-bottom'));
  const tabs = $('tabbar');
  tabs.textContent = '';
  // The phone's bar keeps five tabs: Expiring is reached from Today's note (and Settings),
  // Commits from a day's, week's or month's commits line, Insights and Search, Summaries
  // from Today's summary card.
  tabs.append(...NAV.filter((n) => !['expiring', 'commits', 'summaries'].includes(n[0])).map((n) => item(n, 'tab', 'today')), item(SETTINGS, 'tab', 'today'));
}

function topRow(a) {
  const r = state.route;
  if (r.page === 'day') return weekNav(a, r.key, 'day');
  if (r.page === 'week') return weekNav(a, r.key, 'week');
  if (r.page === 'month') return monthNav(a, r.key);
  if (r.page === 'sessions') return sessionsRow(a);
  if (r.page === 'commits') return commitsRow(a);
  if (r.page === 'summaries') return summariesRow(a);
  if (r.page === 'search') return searchRow(a);
  if (r.page === 'insights') {
    return titleRow(a, 'Insights', h('button', {
      type: 'button', class: 'btn btn-small btn-ghost', title: 'Download this report as Markdown (made here, on this Mac)',
      onclick: () => downloadText('throwbacks-report.md', reportMarkdown(view().model, filterLabel(state.filter))),
    }, icon('download', 15), 'Markdown'));
  }
  if (r.page === 'expiring') return titleRow(a, 'Expiring');
  return titleRow(a, 'Settings');
}

function drawTopbar() {
  const bar = $('topbar');
  if (!bar) return;
  const a = app();
  // keep typing focus in the search / filter field across redraws
  const focused = document.activeElement && bar.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
    ? { id: document.activeElement.id, cls: document.activeElement.className, pos: document.activeElement.selectionStart } : null;
  // …and a button or chip with a data-focus key (a redraw mid-job must not drop the keyboard).
  const had = !focused && document.activeElement && bar.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  bar.textContent = '';
  // Commits: Made by in the plan bar's place — a commit belongs to no chat app.
  // Summaries: its filter there — a summary covers every tool you send.
  bar.append(topRow(a), state.route.page === 'commits' ? madeByBar(a) : state.route.page === 'summaries' ? summariesFilter(a) : planBar(a));
  if (focused) {
    const again = bar.querySelector(focused.id ? `#${focused.id}` : `input.${focused.cls.split(' ').join('.')}`);
    if (again) {
      again.focus();
      try { again.setSelectionRange(focused.pos, focused.pos); } catch { /* not a text field */ }
    }
  }
  if (had) bar.querySelector(`[data-focus="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
}

function pageFor(a) {
  const r = state.route;
  if (r.page === 'day') return dayPage(a, r.key, r.moved);
  if (r.page === 'week') return weekPage(a, r.key);
  if (r.page === 'month') return monthPage(a, r.key);
  if (r.page === 'sessions') return sessionsPage(a);
  if (r.page === 'commits') return commitsPage(a);
  if (r.page === 'summaries') return summariesPage(a);
  if (r.page === 'search') return searchPage(a);
  if (r.page === 'insights') return insightsPage(a);
  if (r.page === 'expiring') return expiringPage(a);
  return settingsPage(a);
}

function drawPage({ entering = false } = {}) {
  const box = $('page-scroll');
  if (!box) return;
  const keep = box.scrollTop;
  // A redraw keeps the keyboard where it was: a control with a data-focus key gets it back.
  const active = document.activeElement;
  const had = !entering && active && box.contains(active) ? active.dataset.focus : null;
  box.textContent = '';
  const page = pageFor(app());
  if (entering) page.classList.add('is-entering');
  box.append(page);
  box.scrollTop = entering ? 0 : keep;
  if (had) box.querySelector(`[data-focus="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
}

function drawReader() {
  const pane = $('reader');
  if (!pane) return;
  const open = !!state.reader;
  pane.hidden = !open;
  $('app').classList.toggle('has-reader', open);
  document.body.classList.toggle('reader-open', open);
  if (!open) return;
  if (state.reader.kind === 'summary') {
    pane.setAttribute('aria-label', 'Summary');
    if (!renderSummaryPane(pane, app(), state.reader.id)) closeReader();  // deleted meanwhile
    return;
  }
  // A chat or folder the tool filter doesn't show would be a blank pane with no way back: it closes.
  const gone = state.reader.kind === 'session' ? !view().model.getSession(state.reader.id)
    : state.reader.kind === 'folder' ? !view().model.getFolder(state.reader.path) : false;
  if (gone) {
    closeReader();
    return;
  }
  pane.setAttribute('aria-label', 'Conversation');
  const s = state.summarizer;
  renderReader(pane, {
    model: view().model,
    summaries: state.summaries,
    match: () => true,
    reader: state.reader,
    canSummarize: s.enabled,
    onSummarize: (id) => summarizeSingleSession(state.model, id),
    onClose: closeReader,
    onPart: (part) => { state.reader = { ...state.reader, part, msgId: null, commit: null }; drawReader(); },
    onOpenDay: (key) => {
      if (state.reader.kind === 'session') state.reader = { ...state.reader, day: key, part: 'day', msgId: null };
      go(`#/day/${key}`);
    },
    onOpenSession: (id) => openSession(id, { part: 'all' }),
    // The chat's own summary on top, and the way to it on the Summaries page.
    chatSummary: (id) => chatSummaryOf(app(), id),
    onOpenSummary: (id) => { go('#/summaries'); openSummary(id); },
    order: state.prefs.order,
    onOrder: (order) => setPref('order', order),
    // Claude Code and Copilot CLI sessions: copy the command that continues them.
    resume: resumeActions,
    // Every app with a file per chat (and Cursor's database): copy its path, Show in Finder.
    source: sourceActions,
  });
}

let lastRoute = '';

function render({ entering = false } = {}) {
  if (state.phase !== 'viewer' || !state.model) return;
  state.route = parseRoute();
  if (state.route.page === 'day') state.lastDay = state.route.key;
  const routeKey = `${state.route.page}:${state.route.key || ''}`;
  const moved = entering || routeKey !== lastRoute;
  lastRoute = routeKey;
  if (moved) state.popover = null;
  // A link to a day's commits shows them all: Made by, the repo and the words start over.
  const toDay = moved && state.route.page === 'commits' && state.route.key;
  if (toDay) Object.assign(state.commitView, { who: 'all', repo: '', q: '' });
  drawNav();
  drawTopbar();
  drawPage({ entering: moved });
  drawJobPill();  // the card running a job may have come into view, or gone out of it
  if (state.route.page === 'sessions' && state.findFolder) revealFolder();
  // Before your commits have been read, it goes there once they are.
  if (toDay) state.commitJump = !jumpToDay(app(), state.route.key, { smooth: false }) && !state.commitsRead ? state.route.key : null;
  drawReader();
  const pill = $('busy-pill');
  if (pill) pill.hidden = !state.busy;
  if (moved && state.route.page === 'search') {
    const input = $('search-input');
    if (input) input.focus();
  }
}

/** Redraw in place (data, summaries or usage changed). */
function redraw() {
  if (state.phase !== 'viewer' || !state.model) return;
  drawNav();
  drawTopbar();
  const cell = editingInPage() ? document.activeElement : null;
  if (!cell) drawPage();
  else if (cellUnchanged(cell)) {  // just clicked into: redraw, and put you back in the same cell
    const id = cell.dataset.cell;
    drawPage();
    focusCell($('page-scroll'), id);
  } else pageRedrawWaits = true;  // never pull a cell out from under your typing
  drawJobPill();
  drawReader();
}

/**
 * The bar of a summary job you can't see otherwise: what it's writing, and
 * Stop — unless the page shows the card that's running it (a day's, a week's
 * or a month's: `data-running`). A chat's summary has its own window. Drawn
 * after the page, which it reads.
 */
function drawJobPill() {
  const pill = $('job-pill');
  if (!pill) return;
  const job = state.job;
  const ownCard = !!document.querySelector('#page-scroll [data-running]');
  pill.hidden = !(job && job.kind !== 'session' && !ownCard);
  if (pill.hidden) return;
  pill.querySelector('.job-note').textContent = job.note
    || (job.kind === 'auto' ? 'Writing the end-of-day summaries…'
      : job.kind === 'day' ? `Writing ${fmtShort(job.key)}’s summary${job.total ? ` (${job.done || 0} of ${job.total})` : ''}…` : 'Writing the recap…');
}

/** You're typing in a cell of the page (the sheet, a week's or month's recap). */
const editingInPage = () => {
  const a = document.activeElement;
  return !!(a && a.isContentEditable && $('page-scroll') && $('page-scroll').contains(a));
};
let pageRedrawWaits = false;
document.addEventListener('focusout', () => {
  setTimeout(() => {  // after the cell's own save has run
    if (pageRedrawWaits && !editingInPage()) {
      pageRedrawWaits = false;
      if (state.phase === 'viewer' && state.model) drawPage();
    }
  }, 0);
});

/** "2026-10" ± n months. */
function stepMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openSession(id, { day = null, part = 'day', msgId = null } = {}) {
  state.reader = { kind: 'session', id, day, part: day ? part : 'all', msgId };
  drawPage();
  drawReader();
}

/**
 * A commit's chat, open at the moment it made that commit: a marker there names the
 * commit. A copy of an amended or rebased commit is placed by when it was first written.
 */
function openCommit(id, c) {
  const at = c.via === 'copy' ? c.at : (c.committed || c.at);
  // Under a tool filter the chat may not be on screen (the Commits page lists every commit): show all tools.
  const unfilter = !view().model.getSession(id);
  if (unfilter) state.filter = normalizeFilter({ plan: null, app: null });
  state.reader = { kind: 'session', id, day: null, part: 'all', msgId: null, commit: { short: c.short, subject: c.subject, at } };
  if (unfilter) render();
  else {
    drawPage();
    drawReader();
  }
}

/** Sessions → Folder with this folder (and the folders above it) open, in view — from a folder's name on Today. */
function showFolder(path) {
  const open = { ...state.prefs.folders };
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = `/${parts.slice(0, i).join('/')}`;
    for (const k of [p, `::quiet:${p}`]) {  // and a section's quieter folders, in case it's one
      delete open[k];  // re-added last, so it outlives older choices
      open[k] = true;
    }
  }
  state.prefs.folders = Object.fromEntries(Object.entries(open).slice(-FOLDERS_MAX));
  state.prefs.group = 'folder';
  state.sessQ = '';
  savePrefs();
  state.findFolder = `/${parts.join('/')}`;
  go('#/sessions');
}

/** After the Sessions page is drawn: the folder showFolder asked for, scrolled to and marked. */
function revealFolder() {
  const path = state.findFolder;
  state.findFolder = null;
  const box = $('page-scroll');
  const node = path && box && [...box.querySelectorAll('.tnode[data-path]')].find((el) => el.dataset.path === path);
  if (!node) return;
  node.classList.add('is-found');
  node.scrollIntoView({ block: 'center' });
  const btn = node.querySelector('.trow-toggle');
  if (btn) btn.focus({ preventScroll: true });
}

function openFolder(path) {
  state.reader = { kind: 'folder', path };
  drawPage();
  drawReader();
}

function closeReader() {
  state.reader = null;
  drawPage();
  drawReader();
}

/** A summary beside the page (the Summaries page's rows, a recap just written). */
function openSummary(id) {
  state.reader = { kind: 'summary', id };
  if (state.route.page === 'summaries') drawPage();
  drawReader();
}

/** Read the chat (session) and older range summaries again — after one is written or deleted. */
async function reloadSaved() {
  state.savedRanges = await histAll();
  if (state.phase === 'viewer' && state.model) redraw();
}

function setFilter(plan, one = null) {
  state.filter = normalizeFilter({ plan, app: one });
  if (state.reader && state.reader.kind === 'session' && !view().model.getSession(state.reader.id)) state.reader = null;
  if (state.reader && state.reader.kind === 'folder' && !view().model.getFolder(state.reader.path)) state.reader = null;
  render();
}

function togglePopover(id) {
  state.popover = id && state.popover !== id ? id : null;
  drawTopbar();
}

function setPref(k, v) {
  state.prefs[k] = v;
  savePrefs();
  redraw();
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* fine */ }
}

/** Sessions → Folder: remember one folder opened or closed (only the page redraws, never the conversation). */
function rememberFolder(path, open) {
  const next = { ...state.prefs.folders };
  delete next[path];  // re-added last, so the oldest choices are the ones dropped
  next[path] = open;
  rememberFolders(next);
}
function rememberFolders(map) {
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
  state.prefs.folders = Object.fromEntries(Object.entries(map).slice(-FOLDERS_MAX));
  savePrefs();
  drawPage();
  // The page was rebuilt: put the keyboard back on the folder (or button) you used.
  const box = $('page-scroll');
  const again = focused && box && [...box.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focused);
  if (again) again.focus({ preventScroll: true });
}

/** Week / Month: group the sheet by day or by folder (only the page redraws, never the conversation). */
function setSheetGroup(group) {
  if (state.prefs.sheetGroup === group) return;
  state.prefs.sheetGroup = group;
  savePrefs();
  drawPage();
  const again = $('page-scroll') && $('page-scroll').querySelector(`[data-focus="sheet-group-${group}"]`);
  if (again) again.focus({ preventScroll: true });
}

/** Sessions: the Tree ('folder') or the Cards ('date') — the top bar and the page redraw, never the
 *  conversation; the keyboard goes to the switch's button for it (from the switch, or "See all N as cards"). */
function setSessionsView(group) {
  if (state.prefs.group === group) return;
  const had = document.activeElement && (document.activeElement.closest('#topbar, #page-scroll'));
  state.prefs.group = group;
  savePrefs();
  drawTopbar();
  drawPage();
  const again = document.querySelector(`#topbar [data-focus="sessions-${group === 'date' ? 'cards' : 'tree'}"]`);
  if (had && again) again.focus({ preventScroll: true });
}

// ---- Your git commits (each day's folders, Sessions → Folder) ---------------
let commitsAsked = 0;

/**
 * Read your commits in the folders your sessions started in — from serve.py
 * (read-only git, in the background: the first look at a big repo takes a
 * few seconds), plus the sample's made-up ones when sample chats are loaded.
 * /?sample never asks the server.
 */
let lastRealCommits = null;  // the last answer read from your repos

async function loadCommits() {
  if (state.phase !== 'viewer' || !state.model) return;
  const me = ++commitsAsked;
  const sample = SAMPLE_ONLY || state.sampleLoaded ? sampleData().commits : null;
  let real = null;
  if (!SAMPLE_ONLY && state.sourceStatus !== null) {
    const sessions = state.model.listSessions();
    const folders = [...new Set(sessions.map((s) => s.startDir).filter(Boolean))];
    const since = state.model.dayKeys.length ? state.model.dayKeys[0] : null;
    if (folders.length && since) {
      try {
        const r = await apiFetch('/api/commits', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders, since }),
        });
        real = r.ok ? await r.json() : lastRealCommits;  // a failed read keeps what was shown
      } catch { real = lastRealCommits; /* no server here, or it failed */ }
    }
  }
  lastRealCommits = real;
  if (me !== commitsAsked || state.phase !== 'viewer') return;  // a newer read is on its way
  state.commits = indexCommits(mergeCommitData(real, sample));
  state.commitsRead = true;
  if (state.route.page === 'commits') drawTopbar();  // its repos and Made by's counts
  redrawPage();
  if (state.commitJump && state.route.page === 'commits' && !editingInPage()) {
    jumpToDay(app(), state.commitJump, { smooth: false });
    state.commitJump = null;
  }
}

/** Redraw only the page (commits arrived): never the open conversation, never under your typing. */
function redrawPage() {
  if (state.phase !== 'viewer' || !state.model) return;
  if (editingInPage()) pageRedrawWaits = true;
  else drawPage();
}

// ---- Still going: what you pinned and archived ----

const marking = [];  // changes on their way to being saved, in the order they were made
/** What's saved, with the changes still on their way laid over it (so a slow answer never undoes a later click). */
const marksNow = () => marking.reduce((m, op) => applyMark(m, op, Date.now()) || m, currentMarks());

async function readMarks() {
  await loadMarks({ sample: SAMPLE_ONLY });
  if (state.phase !== 'viewer') return;
  state.marks = marksNow();
  redrawPage();
}

const MARK_SAID = {
  pin: ['Pinned — it stays in Still going until you unpin it', 'Unpinned'],
  archive: ['Archived — it comes back if you work on it again', 'Back in Still going'],
};

/**
 * Pin, unpin, archive or restore one chat in Still going: shown at once,
 * then saved (a sample chat in this tab only); if it couldn't be saved, it's
 * undone and the toast says why. `focus`: data-focus keys to put the
 * keyboard back on after the page is drawn again, the first found.
 */
async function markChat(s, change, focus = []) {
  const op = { id: s.id, ...change };
  marking.push(op);
  state.marks = marksNow();
  drawPageFocused(focus);
  let said;
  try {
    await changeMark(op, { local: SAMPLE_ONLY || isSampleChat(s) });
    const [on, off] = MARK_SAID['pin' in change ? 'pin' : 'archive'];
    said = ('pin' in change ? change.pin : change.archive) ? on : off;
  } catch (e) {
    said = e.message || 'Not saved';
  }
  marking.splice(marking.indexOf(op), 1);
  const next = marksNow();
  const shape = (m) => JSON.stringify([Object.keys(m.pinned).sort(), Object.keys(m.archived).sort()]);
  const moved = shape(next) !== shape(state.marks);  // another tab's changes, or this one undone
  state.marks = next;
  if (moved && state.route.page === 'sessions') drawPageFocused(focus);
  showToast(said);
}

/**
 * Draw the page again and put the keyboard on the first of `keys` there, else on
 * Still going's first card, its archived fold, or the first folder (never lost to the page's top).
 */
function drawPageFocused(keys) {
  const active = document.activeElement;
  const hadFocus = active && $('page-scroll') && $('page-scroll').contains(active);
  redrawPage();
  const box = $('page-scroll');
  if (!hadFocus || !box) return;
  const all = [...box.querySelectorAll('[data-focus]')];
  const again = keys.map((k) => all.find((el) => el.dataset.focus === k)).find(Boolean)
    || ['.going .scard', '.going-arch .fold', '.tree .trow-toggle'].map((q) => box.querySelector(q)).find(Boolean);
  if (!again) return;
  again.focus({ preventScroll: true });
  // It moved (a card pinned from a band goes up to Still going, an unpinned one down to its band): follow it.
  const r = again.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  if (r.bottom < view.top || r.top > view.bottom) again.scrollIntoView({ block: 'center' });
}

// ---- Chats Claude Code is about to delete, and the copies Throwbacks keeps ----

/** Claude Code's cleanup setting and the kept copies (the sample's made-up ones in the sample). */
async function loadKeep() {
  if (state.phase !== 'viewer') return;
  let keep = null;
  if (SAMPLE_ONLY || (state.sampleLoaded && state.sourceStatus === null)) keep = sampleData().keep;
  else {
    try {
      const r = await apiFetch('/api/keep');
      keep = r.ok ? await r.json() : null;
    } catch { /* no server here */ }
  }
  state.keep = keep;
  drawNav();
  redrawPage();
}

/** The sessions Claude Code deletes within a week (none without the server's numbers). */
function dueNow() {
  if (!state.keep || !state.model) return [];
  return dueSessions(state.model.listSessions(), retentionOf(state.keep));
}

let sampleChatIds = null;
/** One of the sample's made-up chats (Try / Add sample data). */
function isSampleChat(session) {
  if (!sampleChatIds) {  // every app's made-up chats, not just Claude Code's
    const sd = sampleData();
    sampleChatIds = new Set([...parseExport(sd.conversations), ...parseCodeSessions(sd.codeFiles),
      ...parseCopilotFiles(sd.copilotFiles), ...parseCursorData(sd.cursorData)].map((x) => x.id));
  }
  return sampleChatIds.has(session.id) && !session.fromServer;
}

/** Keep a copy of one Claude Code session in ~/.throwbacks (this Mac only); the chats are read again to show it. */
async function keepCopy(session) {
  const id = String(session.id || '').replace(/^code:/, '').replace(/\.jsonl$/, '');
  if (SAMPLE_ONLY || isSampleChat(session)) {
    showToast('Sample chats are made up — there’s nothing to keep');
    return false;
  }
  if (!session.fromServer) {
    showToast('Keeping a copy needs the chat loaded through python3 serve.py');
    return false;
  }
  try {
    const r = await apiFetch('/api/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      showToast(j.error || 'Couldn’t keep a copy');
      if (r.status === 404) await refreshKept();  // Claude Code already deleted it: read the chats again
      return false;
    }
  } catch {
    showToast('Keeping a copy needs python3 serve.py');
    return false;
  }
  showToast('Kept — a copy is in ~/.throwbacks on this Mac');
  await refreshKept();
  return true;
}

/** Remove Throwbacks' copy of a session (the original, if Claude Code still has it, is untouched). */
async function removeCopy(session) {
  const id = String(session.id || '').replace(/^code:/, '').replace(/\.jsonl$/, '');
  const gone = session.onlyKept;
  if (!window.confirm(gone
    ? `Remove the kept copy of “${session.title}”? Claude Code has already deleted the original, so it will be gone for good.`
    : `Remove the kept copy of “${session.title}”? The original stays in Claude Code (until its cleanup).`)) return false;
  try {
    const r = await apiFetch(`/api/keep?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error();
  } catch {
    showToast('Couldn’t remove the copy');
    return false;
  }
  showToast('Copy removed');
  await refreshKept();
  return true;
}

/** After keeping or removing: read Claude Code's chats again, so kept flags (and kept-only chats) show. */
async function refreshKept() {
  sourceAsked.clear();  // kept or removed: a chat's file may now be the kept copy, or the original again
  if (state.imported.has('claude-code')) await importSources(['claude-code'], { quiet: true });
  else await loadKeep();
}

// ---- Picking a session up again (the conversation's "Copy resume command") ----
const resumeAsked = new Map();  // "app:id" → {at, promise}

/** What serve.py knows about resuming a session — its folder, whether that still exists, whether it's open now — or null without it. */
function resumeInfo(target, { fresh = false } = {}) {
  if (SAMPLE_ONLY) return Promise.resolve(null);  // the sample never asks about real sessions
  const key = `${target.app}:${target.id}`;
  const hit = resumeAsked.get(key);
  if (hit && !fresh && Date.now() - hit.at < 15000) return hit.promise;
  const promise = apiFetch(`/api/resume?app=${target.app}&id=${encodeURIComponent(target.id)}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  resumeAsked.set(key, { at: Date.now(), promise });
  return promise;
}

/** Picking a session up again: {app, info(), copy(), desktop link | null}, or null where it can't be (the conversation, the day's cards). */
function resumeActions(s) {
  const target = s && !s.onlyKept ? resumeTarget(s) : null;  // Claude Code no longer has a kept-only chat
  return target ? { app: target.app, info: () => resumeInfo(target), copy: () => copyResume(s), desktop: desktopHere() ? desktopLink(target) : null } : null;
}

/** This Mac's own tab (a LAN visitor's page never asks about this Mac's files). */
const localTab = () => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);

/** Open in Claude desktop: only on this Mac's own tab with Claude desktop installed, never for sample chats. */
function desktopHere() {
  const icons = (state.sourceStatus && state.sourceStatus.icons) || [];
  return localTab() && !SAMPLE_ONLY && !state.sampleLoaded && icons.includes('claude');
}

const sourceAsked = new Map();  // app:id query → {at, promise, last: the last answer that came}

/** Where a chat lives — {info(), reveal()} for its file, or null: only on this Mac's own tab
 *  with the server, never on the sample (it never asks about real files), never for sample chats. */
function sourceActions(s) {
  const target = s && localTab() && !SAMPLE_ONLY && state.sourceStatus && !isSampleChat(s) ? sourceTarget(s) : null;
  if (!target) return null;
  const q = `app=${encodeURIComponent(target.app)}&id=${encodeURIComponent(target.id)}`;
  return {
    // The last answer, to draw at once (the conversation redraws often); info() asks again after a minute.
    last: () => (sourceAsked.get(q) || {}).last || null,
    info: () => {
      const hit = sourceAsked.get(q);
      if (hit && hit.promise && Date.now() - hit.at < 60000) return hit.promise;
      const promise = apiFetch(`/api/source?${q}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((info) => {
          const now = sourceAsked.get(q);
          if (info) sourceAsked.set(q, { at: now ? now.at : Date.now(), promise, last: info });
          else if (now && now.promise === promise) now.promise = null;  // a failed ask isn't kept: the next draw asks again
          return info;
        });
      sourceAsked.set(q, { at: Date.now(), promise, last: hit ? hit.last : null });
      return promise;
    },
    reveal: async () => {
      let r = null;
      try {
        r = await apiFetch('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
      } catch { /* no server */ }
      if (r && r.status === 404) sourceAsked.delete(q);  // gone: the header asks again next time
      showToast(r && r.ok ? 'Shown in Finder' : r && r.status === 404 ? 'That chat’s file isn’t on this Mac any more' : 'Couldn’t show it in Finder');
    },
  };
}

/** Copy the command that continues this session in its own app (Throwbacks runs nothing). */
async function copyResume(session) {
  const target = resumeTarget(session);
  if (!target) return;
  const name = target.app === 'claude' ? 'Claude Code' : 'Copilot CLI';
  // Ask what's true right now (still open elsewhere?), but start the clipboard
  // write inside the click: Safari refuses one that comes after a fetch.
  const infoP = resumeInfo(target, { fresh: true }).then((info) => info || { folder: session.startDir });
  const cmdP = infoP.then((info) => resumeCommand(target, info));
  let copied = false;
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': cmdP.then((c) => {
          if (!c) throw new Error('nothing to copy');
          return new Blob([c.command], { type: 'text/plain' });
        }),
      })]);
      copied = true;
    } catch { /* tried below */ }
  }
  const [info, cmd] = await Promise.all([infoP, cmdP]);
  if (!cmd) {
    showToast(`${name} no longer has this session on this Mac`);
    return;
  }
  if (!copied && !(await copyText(cmd.command))) {
    showToast('Couldn’t copy');
    return;
  }
  showToast(cmd.attach ? 'Copied — it’s running in the background; this opens that run'
      : cmd.closeFirst ? `Copied — close it in ${liveWhere(info.live)} before you paste it`
        : cmd.gone ? 'Copied — its folder is gone, so it runs wherever you paste it'
          : 'Copied — paste it into Terminal');
}

/** Whether the usage meter asks a tool (Settings → Usage meter) — saved by the
 *  server, which then never runs it while it's off; turning one on asks it now. */
async function setAsk(id, on) {
  let status = null;
  try {
    const r = await apiFetch('/api/usage/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: id, on }),
    });
    if (r.ok) status = await r.json();
  } catch { /* no server */ }
  if (!status) {
    showToast('Couldn’t save that — is the server running?');
    redraw();  // the switch goes back to what's saved
    return;
  }
  state.usageInfo = readUsage(status);
  redraw();
  if (on) refreshUsage({ live: true, only: [id] });
}

// ---------------------------------------------------------------------------
// Global wiring, then the front page — or straight into your chats
// ---------------------------------------------------------------------------

function init() {
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) handleFiles(e.target.files);
    e.target.value = '';
  });
  $('dir-fallback-input').addEventListener('change', (e) => handleDirFallback(e.target));

  // Drag & drop anywhere, in either phase.
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  document.addEventListener('keydown', (e) => {
    if (state.phase !== 'viewer') return;
    if (document.querySelector('.modal-overlay')) return; // a dialog handles its own keys
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.route.page === 'search') $('search-input')?.focus();
      else go('#/search');
      return;
    }
    if (e.key === 'Escape') {
      if (state.popover) togglePopover(null);
      else if (state.reader) closeReader();
      else if (typing) e.target.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('.sheet-wrap')) return;  // the arrows scroll the sheet
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.route.page === 'day') {
      const to = stepDay(view().model.dayKeys, state.route.key, e.key === 'ArrowLeft' ? -1 : 1);
      if (to) go(`#/day/${to}`);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.route.page === 'week') {
      go(`#/week/${addDays(state.route.key, e.key === 'ArrowLeft' ? -7 : 7)}`);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.route.page === 'month') {
      go(`#/month/${stepMonth(state.route.key, e.key === 'ArrowLeft' ? -1 : 1)}`);
    }
  });
  document.addEventListener('click', (e) => {
    if (state.popover && !(e.target.closest && e.target.closest('.popover'))) togglePopover(null);
  });
  window.addEventListener('hashchange', () => render());
  // Another tab changed a setting (Send chats from, the end of day, a view): take it, so this
  // tab never sends an app you left out there — nor writes the old setting back.
  window.addEventListener('storage', (e) => {
    if (e.key !== PREFS_KEY) return;
    const was = state.prefs.autoSummary;
    state.prefs = loadPrefs();
    if (was.on && !state.prefs.autoSummary.on && state.job && state.job.kind === 'auto') daylog.stop();
    redraw();
  });
  // Usage moves while you work in Claude Code: look again when you come back
  // (asking Claude Code itself if its last answer is 5 minutes old), and re-read
  // the server's copy now and then while the tab is open.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cameBack(); });
  window.addEventListener('focus', cameBack);
  setInterval(() => { if (!document.hidden && state.phase === 'viewer') refreshUsage(); }, 2 * 60 * 1000);
  setInterval(() => { endOfDay(); }, 5 * 60 * 1000);  // the end of day comes while the tab is open

  configureChips({ resolveFile: resolveFileInTree });
  applySavedTheme();
  setPhase('import');
  start();
}

/** Ask serve.py what's on this Mac; with "Open straight into my chats" on, read it all.
 *  /?sample opens the sample instead and never reads your apps (demos, layout checks). */
async function start() {
  if (SAMPLE_ONLY) {
    loadSample();
    return;
  }
  const status = await fetchSourceStatus();
  await loadAppIcons(status ? status.icons : []);
  state.sourceStatus = status;
  drawLandingGrid();
  const ids = importableIds(status);
  if (status && state.prefs.auto && ids.length) await importSources(ids, { quiet: true });
}

init();
