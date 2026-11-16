// summarize-ui.js — thin DOM layer for the optional AI summarizer: the
// settings dialog (provider, key, model), a chat's whole-session summary
// (written in a window you can stop, then kept with the others), and the
// store of those chat summaries and the older range summaries (~/.throwbacks/
// summaries, or this browser) that the Summaries page lists. The app's pages
// place the buttons; this only says whether Summarize can run, and why not.
// All logic lives in summarize.js.
//
// Settings persist in localStorage ONLY (never in any file the app reads
// or writes). With no key saved, no Summarize control exists anywhere.

import {
  PROVIDERS, testKey, summarizeRange, summaryToMarkdown, localClaudeStatus, addUsage,
} from './summarize.js';
import { el, dateKey, keyToDate, fmtDayMed, fmtDayShort, fmtMonth, apiFetch } from './util.js';
import { showToast, copyText, modalTitle } from './ui.js';
import { iconButton, closeButton } from './icons.js';

const LS_KEY = 'throwbacks-summarizer';
const HIST_KEY = 'throwbacks-summary-history';
const HIST_MAX = 50;

// --- Saved chat summaries (and older range summaries): kept so a generated
// --- summary never has to be paid for twice; the Summaries page lists them,
// --- each with a Delete.

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HIST_KEY));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function saveHistoryList(list) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function addToHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);
  while (list.length > HIST_MAX) list.pop();
  // storage quota: evict oldest entries until the save fits
  while (!saveHistoryList(list) && list.length > 1) list.pop();
}

// Preferred store: the server's ~/.throwbacks/summaries folder (probed
// once); browser localStorage remains the automatic fallback.
let fileStore = null; // null = unknown, else {dir} or false

async function probeStore() {
  if (fileStore !== null) return fileStore;
  try {
    const r = await apiFetch('/api/summaries');
    const j = await r.json();
    fileStore = r.ok && Array.isArray(j.entries) ? { dir: j.dir } : false;
  } catch {
    fileStore = false;
  }
  return fileStore;
}

// Kept in this tab only, never with yours: in /?sample every chat summary
// (the sample's made-up ones, and any written there), elsewhere the summary
// of a made-up chat (after Try or Add sample data).
let inTab = null;
const sampleOnly = () => !!ctx?.sample?.();
const tabList = () => {
  if (!inTab) inTab = [...(ctx?.sample?.() || [])];
  return inTab;
};
const byNewest = (a, b) => b.at - a.at;

/** Clear loaded data: the summaries kept in this tab go with the chats. */
export function forgetTabSummaries() {
  inTab = null;
}

/**
 * Every saved chat (session) summary and older range summary, newest first —
 * in /?sample only the sample's, which shows nothing of yours.
 */
export async function histAll() {
  const tab = tabList();
  if (sampleOnly()) return [...tab].sort(byNewest);
  const local = loadHistory();
  if (await probeStore()) {
    try {
      const r = await apiFetch('/api/summaries');
      const j = await r.json();
      const server = Array.isArray(j.entries) ? j.entries : [];
      const seen = new Set(server.map((e) => e.id));
      return [...server, ...local.filter((e) => !seen.has(e.id)), ...tab].sort(byNewest);
    } catch { /* fall through */ }
  }
  return [...local, ...tab].sort(byNewest);
}

async function histSave(entry, md) {
  if (sampleOnly() || (entry.sessionId && ctx?.isSampleChat?.(entry.sessionId))) {
    tabList().unshift(entry);
    return 'tab';
  }
  if (await probeStore()) {
    try {
      const r = await apiFetch('/api/summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry, md }),
      });
      if (r.ok) return 'file';
    } catch { /* fall through */ }
  }
  addToHistory(entry);
  return 'browser';
}

/** Delete one; throws when the server couldn't (so the page can say so). */
export async function histDelete(id) {
  const tab = tabList();
  const i = tab.findIndex((e) => e.id === id);
  if (i >= 0) {
    tab.splice(i, 1);
    return;
  }
  if (sampleOnly()) return;  // never one of yours from here
  if (await probeStore()) {
    let r;
    try {
      r = await apiFetch(`/api/summaries?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      throw new Error('the server isn’t answering');
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  }
  saveHistoryList(loadHistory().filter((e) => e.id !== id));
}


function defaults() {
  const d = { active: 'groq' };
  for (const [id, p] of Object.entries(PROVIDERS)) d[id] = { key: '', model: p.defaultModel };
  return d;
}

export function getSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY));
    const d = defaults();
    if (!raw || typeof raw !== 'object') return d;
    const s = { active: PROVIDERS[raw.active] ? raw.active : 'groq' };
    for (const id of Object.keys(PROVIDERS)) s[id] = { ...d[id], ...(raw[id] || {}) };
    // Migrate OUR old defaults when the provider retires them (a model the
    // user typed themselves is never touched).
    if (s.gemini.model === 'gemini-2.5-flash') s.gemini.model = d.gemini.model;
    return s;
  } catch {
    return defaults();
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    showToast('Couldn’t save settings (storage blocked)');
  }
}

let localClaudeOk = false; // probed from /api/claude-status

async function probeLocalClaude() {
  localClaudeOk = (await localClaudeStatus()).enabled === true;
  return localClaudeOk;
}

export function summarizerEnabled() {
  const s = getSettings();
  if (PROVIDERS[s.active].noKey) return localClaudeOk;
  return !!s[s.active].key.trim();
}

// ---------------------------------------------------------------------------
// Wiring: the app tells it how to reach the chats; it tells the app when
// the setup changed (a key saved, the local bridge found).
// ---------------------------------------------------------------------------

let ctx = null; // { getModel, onChanged, sample, isSampleChat, busy, begin, end, onSaved }

export async function initSummarizer(context) {
  ctx = context;
  await probeLocalClaude();
  ctx?.onChanged?.();
}

/** {enabled, provider, why}: whether Summarize can run now, and if not, why. */
export function summarizerStatus() {
  const s = getSettings();
  if (summarizerEnabled()) return { enabled: true, provider: s.active };
  return {
    enabled: false,
    provider: s.active,
    why: PROVIDERS[s.active].noKey
      ? 'Your summarizer is Claude Code on this Mac, but the server isn’t running with --claude (python3 serve.py --claude).'
      : 'No summarizer yet: paste an API key, or use Claude Code on this Mac (no key).',
  };
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

/** A dialog's backdrop. `onClose`: run however it closes (×, Esc, a click outside). */
function overlayShell(extraClass, { onClose = null } = {}) {
  const overlay = el('div', `modal-overlay ${extraClass || ''}`);
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  // Esc closes only the dialog on top.
  const onTop = () => [...document.querySelectorAll('.modal-overlay')].pop() === overlay;
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !onTop()) return;
    e.preventDefault();
    close();
  };
  // A click outside closes it — not a text selection dragged out of it (that click lands here too).
  let downHere = false;
  overlay.addEventListener('pointerdown', (e) => { downHere = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downHere) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { overlay, close };
}

/** The AI summarizer's settings dialog (⋮ → AI summarizer…). */
export function openSummarizerSettings() {
  openSettings();
}

function openSettings() {
  const s = getSettings();
  const { overlay, close } = overlayShell();
  const modal = el('div', 'modal');
  const head = el('div', 'modal-head');
  head.append(modalTitle('sparkles', 'AI summarizer', true));
  const x = closeButton();
  x.addEventListener('click', close);
  head.append(x);
  modal.append(head);

  modal.append(el('p', 'modal-sub',
    'Optional. Summaries send the selected conversations’ text to the provider you '
    + 'choose, using your own API key. Keys and chat text otherwise stay in this '
    + 'browser; the core app stays fully local. Settings live in this browser’s '
    + 'localStorage. Note: OpenAI/Anthropic keys come from their developer consoles '
    + '(platform.openai.com / console.anthropic.com) — a ChatGPT or Claude chat '
    + 'subscription alone is not an API key. Exception: “Claude Code (local)” needs '
    + 'no key at all — it pipes text to this machine’s own Claude Code CLI (your '
    + 'subscription, localhost only), when the server runs with --claude.'));

  // Provider radios
  const provRow = el('div', 'set-row');
  const radios = {};
  for (const id of Object.keys(PROVIDERS)) {
    const lab = el('label', 'set-radio');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'sum-provider';
    r.value = id;
    r.checked = s.active === id;
    radios[id] = r;
    lab.append(r, ` ${PROVIDERS[id].label}`);
    provRow.append(lab);
  }
  modal.append(el('div', 'set-label', 'Active provider'), provRow);

  // Per-provider fields (only the selected provider's fields are shown)
  const fields = el('div', null);
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'set-input';
  keyInput.autocomplete = 'off';
  const modelSelect = document.createElement('select');
  modelSelect.className = 'filter-select set-input';
  const modelOverride = document.createElement('input');
  modelOverride.type = 'text';
  modelOverride.className = 'set-input';
  modelOverride.placeholder = 'custom model id (overrides the dropdown)';

  const active = () => Object.keys(PROVIDERS).find((id) => radios[id].checked) || 'groq';
  const liveModels = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, null]));
  const keyLabel = el('div', 'set-label', 'API key (stored only in this browser)');
  const noKeyNote = el('div', 'set-status');
  noKeyNote.hidden = true;
  const fillModelOptions = (id, list) => {
    const prev = modelOverride.value.trim() || modelSelect.value;
    modelSelect.textContent = '';
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      modelSelect.append(o);
    }
    if (list.includes(prev)) {
      modelSelect.value = prev;
      modelOverride.value = '';
    } else if (list.includes(PROVIDERS[id].defaultModel)) {
      modelSelect.value = PROVIDERS[id].defaultModel;
    }
  };
  const loadFields = () => {
    const id = active();
    const p = PROVIDERS[id];
    keyInput.hidden = !!p.noKey;
    keyLabel.hidden = !!p.noKey;
    noKeyNote.hidden = !p.noKey;
    if (p.noKey) {
      noKeyNote.textContent = 'Checking the local bridge…';
      probeLocalClaude().then((ok) => {
        if (active() !== id) return;
        noKeyNote.textContent = ok
          ? '✓ No key needed — uses this machine’s own Claude Code login via the local server bridge.'
          : '✗ Bridge not available. Restart the server with:  python3 serve.py --claude  (needs the Claude CLI installed and logged in on this machine).';
      });
    }
    keyInput.value = s[id].key;
    keyInput.placeholder = `${p.label} API key`;
    const list = liveModels[id] || p.models;
    modelSelect.textContent = '';
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      modelSelect.append(o);
    }
    const isListed = list.includes(s[id].model);
    modelSelect.value = isListed ? s[id].model
      : (list.includes(p.defaultModel) ? p.defaultModel : list[0]);
    modelOverride.value = isListed ? '' : s[id].model;
  };
  const fetchModels = async () => {
    const id = active();
    const key = keyInput.value.trim();
    if (!key) { status.textContent = 'Paste a key first, then fetch models.'; return; }
    status.textContent = 'Fetching the live model list…';
    try {
      const list = await PROVIDERS[id].listModels(key);
      if (!list.length) { status.textContent = 'The provider returned no models.'; return; }
      liveModels[id] = list;
      fillModelOptions(id, list);
      status.textContent = `✓ ${list.length} ${PROVIDERS[id].label} models loaded from the API.`;
    } catch (e) {
      status.textContent = `✗ ${PROVIDERS[id].label}: ${e.message}`;
    }
  };
  const stashFields = (id) => {
    s[id].key = keyInput.value.trim();
    s[id].model = modelOverride.value.trim() || modelSelect.value;
  };
  let shown = s.active;
  for (const r of Object.values(radios)) {
    r.addEventListener('change', () => {
      stashFields(shown);
      shown = active();
      loadFields();
    });
  }
  loadFields();

  const status = el('div', 'set-status');
  const modelRow = el('div', 'set-model-row');
  const fetchBtn = iconButton('btn btn-small', 'refresh', 'Fetch models', 14);
  fetchBtn.title = 'Load the current model list from the provider’s API (model ids change often)';
  fetchBtn.addEventListener('click', fetchModels);
  modelRow.append(modelSelect, fetchBtn);
  fields.append(
    keyLabel, keyInput, noKeyNote,
    el('div', 'set-label', 'Model'), modelRow, modelOverride,
  );
  modal.append(fields);
  const btnRow = el('div', 'landing-actions set-actions');
  const testBtn = el('button', 'btn', 'Test key');
  testBtn.addEventListener('click', async () => {
    stashFields(active());
    const id = active();
    if (!s[id].key && !PROVIDERS[id].noKey) { status.textContent = 'Paste a key first.'; return; }
    status.textContent = 'Testing…';
    try {
      await testKey(id, s[id].key, s[id].model);
      status.textContent = `✓ ${PROVIDERS[id].label} key works (model: ${s[id].model}).`;
      fetchModels(); // key is good — refresh the dropdown with the live list
    } catch (e) {
      status.textContent = `✗ ${PROVIDERS[id].label}: ${e.message}`;
    }
  });
  const saveBtn = el('button', 'btn btn-primary', 'Save');
  saveBtn.addEventListener('click', () => {
    stashFields(active());
    s.active = active();
    saveSettings(s);
    ctx?.onChanged?.();
    showToast(summarizerEnabled() ? 'Summarizer enabled' : 'Saved (no key — summarizer stays hidden)');
    close();
  });
  btnRow.append(testBtn, saveBtn);
  modal.append(btnRow, status);
  overlay.append(modal);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Collect range data from the loaded model (never fetches anything)
// ---------------------------------------------------------------------------

function sessionWhen(msgs) {
  const d1 = dateKey(msgs[0].ts);
  const d2 = dateKey(msgs[msgs.length - 1].ts);
  return d1 === d2 ? fmtDayMed(d1) : `${fmtDayShort(d1)}–${fmtDayShort(d2)}`;
}

function collectItems(model, startMs, endMs, onlySessionId) {
  const items = [];
  for (const s of model.listSessions()) {
    if (onlySessionId && s.id !== onlySessionId) continue;
    const msgs = s.messages.filter((m) => m.ts >= startMs && m.ts <= endMs);
    if (!msgs.length) continue;
    const text = msgs.map((m) => `${m.sender === 'human' ? 'User' : 'Claude'}: ${m.text}`).join('\n');
    items.push({ id: s.id, title: s.title, when: sessionWhen(msgs), text, firstTs: msgs[0].ts });
  }
  items.sort((a, b) => a.firstTs - b.firstTs);
  return items;
}

// ---------------------------------------------------------------------------
// Summary panel — streams partial results, cancellable
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A saved chat or range summary in a window (layout checks open a made-up one)
// ---------------------------------------------------------------------------

/** A saved range or session summary (exported for tests/layout.html, which opens a made-up one). */
export function openSummaryViewer(entry) {
  const { overlay, close } = overlayShell('sum-overlay');
  const modal = el('div', 'modal modal-wide sum-panel');

  const head = el('div', 'modal-head');
  head.append(modalTitle('sparkles', entry.rangeLabel, true));
  const actions = el('div', 'preview-actions');
  const copyBtn = iconButton('btn btn-small', 'copy', 'Copy', 14);
  copyBtn.addEventListener('click', async () => {
    showToast((await copyText(summaryToMarkdown(entry.rangeLabel, entry.recap, entry.perSession)))
      ? 'Summary copied as markdown' : 'Couldn’t copy');
  });
  const x = closeButton();
  x.addEventListener('click', close);
  actions.append(copyBtn, x);
  head.append(actions);
  modal.append(head);

  modal.append(el('div', 'sum-hist-meta',
    `Generated ${new Date(entry.at).toLocaleString()} · ${PROVIDERS[entry.provider]?.label || entry.provider}`
    + (entry.model ? ` (${entry.model})` : '')
    + (entry.status !== 'done' ? ` · ${entry.status}` : '')));

  // The recap and the conversations scroll together (the title and buttons stay put).
  const body = el('div', 'sum-body');
  const recapBox = el('div', 'sum-recap');
  recapBox.append(el('div', 'rep-title', `Overall recap — ${entry.rangeLabel}`));
  recapBox.append(el('div', 'sum-recap-text', entry.recap || '(no recap in this run)'));
  recapBox.append(el('div', 'sum-caveat', 'AI-generated and approximate — not a verbatim record.'));
  body.append(recapBox);

  const list = el('div', 'sum-list');
  for (const r of entry.perSession || []) {
    const g = el('div', 'sum-session');
    g.append(el('div', 'sum-sess-head', `${r.title} — ${r.when}`));
    const ul = el('ul', 'sum-bullets');
    for (const b of r.bullets) ul.append(el('li', null, b));
    g.append(ul);
    list.append(g);
  }
  body.append(list);
  modal.append(body);
  overlay.append(modal);
}

export function summarizeSingleSession(model, sessionId) {
  const s = model.getSession(sessionId);
  if (!s) return;
  runSummary(0, Infinity, `Session · ${s.title}`, sessionId);
}

async function runSummary(startMs, endMs, rangeLabel, onlySessionId) {
  const model = ctx?.getModel?.();
  if (!model) return;
  // One summary at a time: this waits for a day's, a recap's or the end-of-day run.
  if (ctx?.busy?.()) { showToast('Wait for the summary that’s being written'); return; }
  const settings = getSettings();
  const cfg = settings[settings.active];
  if (!cfg.key && !PROVIDERS[settings.active].noKey) { showToast('No API key saved'); return; }

  const items = collectItems(model, startMs, endMs, onlySessionId);
  if (!items.length) { showToast('No messages in that range'); return; }

  const ac = new AbortController();
  ctx?.begin?.(ac);
  let running = true;
  // Closing the window while it writes stops it (what finished is kept).
  const { overlay, close } = overlayShell('sum-overlay', { onClose: () => { if (running) ac.abort(); } });
  const modal = el('div', 'modal modal-wide sum-panel');
  const head = el('div', 'modal-head');
  head.append(modalTitle('sparkles', `Summary — ${rangeLabel}`, true));
  const actions = el('div', 'preview-actions');
  const copyBtn = iconButton('btn btn-small', 'copy', 'Copy', 14);
  copyBtn.disabled = true;
  const x = closeButton();
  x.addEventListener('click', close);
  actions.append(copyBtn);
  // Export hook: route the markdown to a last-mile exporter when present.
  if (typeof window.throwbacksExportHook === 'function') {
    const exp = iconButton('btn btn-small', 'upload', 'Export', 14);
    exp.disabled = true;
    exp.id = 'sum-export-btn';
    actions.append(exp);
  }
  actions.append(x);
  head.append(actions);
  modal.append(head);

  const progress = el('div', 'sum-progress');
  const cancelBtn = el('button', 'btn btn-small', 'Cancel');
  cancelBtn.addEventListener('click', () => ac.abort());
  const progRow = el('div', 'sum-prog-row');
  progRow.append(progress, cancelBtn);
  modal.append(progRow);

  // Everything under the status line scrolls as one: a long recap never squeezes what follows.
  const body = el('div', 'sum-body');
  const recapBox = el('div', 'sum-recap');
  recapBox.append(el('div', 'rep-title', `Overall recap — ${rangeLabel}`));
  const recapText = el('div', 'sum-recap-text', '…');
  recapBox.append(recapText,
    el('div', 'sum-caveat', 'AI-generated and approximate — not a verbatim record.'));
  body.append(recapBox);

  const list = el('div', 'sum-list');
  body.append(list);
  const errBox = el('div', 'landing-error');
  errBox.hidden = true;
  body.append(errBox);
  modal.append(body);
  overlay.append(modal);

  const perDone = [];
  const renderPartial = (r) => {
    perDone.push(r);
    const g = el('div', 'sum-session');
    g.append(el('div', 'sum-sess-head', `${r.title} — ${r.when}`));
    const ul = el('ul', 'sum-bullets');
    for (const b of r.bullets) ul.append(el('li', null, b));
    g.append(ul);
    list.append(g);
  };
  const showErr = (msg) => { errBox.textContent = msg; errBox.hidden = false; };

  let recap = null;
  let runStatus = 'done';
  let usage = null;  // the tokens the summarizer says it used
  try {
    const res = await summarizeRange({
      items,
      provider: settings.active,
      key: cfg.key,
      model: cfg.model,
      rangeLabel,
      signal: ac.signal,
      onUsage: (u) => { usage = addUsage(usage, u); },
      onProgress: (d, t) => { progress.textContent = `Summarizing ${d} of ${t} conversation${t === 1 ? '' : 's'}…`; },
      onPartial: renderPartial,
    });
    recap = res.recap;
    recapText.textContent = recap || '(no recap — see errors below)';
    if (res.errors.length) showErr(res.errors.join(' · '));
    if (!recap) runStatus = 'partial';
    progress.textContent = `Done — ${perDone.length} of ${items.length} conversation${items.length === 1 ? '' : 's'} summarized.`;
  } catch (e) {
    if (e.cancelled) {
      runStatus = 'cancelled';
      progress.textContent = `Cancelled — showing ${perDone.length} partial result${perDone.length === 1 ? '' : 's'}.`;
      recapText.textContent = '(cancelled before the recap)';
    } else {
      runStatus = 'partial';
      showErr(e.message);
      progress.textContent = 'Stopped on an error — partial results kept.';
      recapText.textContent = '(no recap)';
    }
  }
  cancelBtn.remove();
  running = false;
  ctx?.end?.();

  // Keep anything worth revisiting: the Summaries page lists it, and the chat shows it on top.
  if (recap || perDone.length) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      rangeLabel,
      ...(onlySessionId ? { sessionId: onlySessionId } : {}),
      provider: settings.active,
      model: cfg.model,
      status: runStatus,
      recap,
      perSession: perDone,
      ...(usage ? { usage } : {}),
    };
    histSave(entry, summaryToMarkdown(rangeLabel, recap, perDone)).then((where) => {
      progress.textContent += where === 'file' ? ' · saved to ~/.throwbacks'
        : where === 'tab' ? ' · kept in this tab (a sample chat)' : ' · saved in this browser';
      ctx?.onSaved?.();
    });
  }

  const md = () => summaryToMarkdown(rangeLabel, recap, perDone);
  copyBtn.disabled = false;
  copyBtn.addEventListener('click', async () => {
    showToast((await copyText(md())) ? 'Summary copied as markdown' : 'Couldn’t copy');
  });
  const exp = document.getElementById('sum-export-btn');
  if (exp) {
    exp.disabled = false;
    exp.addEventListener('click', () => window.throwbacksExportHook(md(), rangeLabel));
  }
}
