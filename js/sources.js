// sources.js — the app tiles on the landing page and in "Add data": one
// tile per AI tool Throwbacks can read, showing the tool's own icon (read
// by serve.py from the app installed on this Mac) and what was found.
// Tools with no reader yet are listed underneath and are never clickable.

import { el, apiFetch } from './util.js';
import { icon } from './icons.js';

/**
 * The tools Throwbacks reads. `count` names the /api/import/status field
 * saying how much was found; `src` is the source id the rest of the app
 * uses (it picks the tile's accent, same as the source dots).
 */
export const APP_SOURCES = [
  { id: 'claude-code', name: 'Claude Code', where: 'Claude in your terminal', icon: 'claude', badge: 'terminal', glyph: 'terminal', src: 'code', count: 'claudeCode', unit: ['session', 'sessions'] },
  { id: 'cowork', name: 'Claude Cowork', where: 'Tasks in the Claude desktop app', icon: 'claude', badge: 'briefcase', glyph: 'briefcase', src: 'cowork', count: 'cowork', unit: ['task', 'tasks'] },
  { id: 'claude-web', name: 'Claude.ai', where: 'Web and mobile chats, from an export', icon: 'claude', badge: 'globe', glyph: 'message', src: 'web' },
  { id: 'copilot', name: 'GitHub Copilot', where: 'Copilot Chat in VS Code', icon: 'copilot', glyph: 'code', src: 'copilot', count: 'copilot', unit: ['chat file', 'chat files'] },
  { id: 'copilot-cli', name: 'Copilot CLI', where: 'GitHub Copilot in your terminal', icon: 'copilot', badge: 'terminal', glyph: 'terminal', src: 'copilot-cli', count: 'copilotCli', unit: ['session', 'sessions'] },
  { id: 'cursor', name: 'Cursor', where: 'Cursor’s AI chat', icon: 'cursor', glyph: 'code', src: 'cursor', count: 'cursor' },
];

/** Tools with no reader yet — shown so it's clear what's covered. */
export const LATER_SOURCES = [
  { id: 'antigravity', name: 'Antigravity', icon: 'antigravity' },
  { id: 'windsurf', name: 'Windsurf', icon: 'windsurf' },
  { id: 'chatgpt', name: 'ChatGPT', icon: 'chatgpt' },
  { id: 'gemini-cli', name: 'Gemini CLI' },
  { id: 'codex', name: 'Codex CLI' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'zed', name: 'Zed', icon: 'zed' },
];

/** serve.py's import status, or null when the page has no local bridge. */
export async function fetchSourceStatus() {
  try {
    const r = await apiFetch('/api/import/status');
    return r.ok ? await r.json() : null;
  } catch {
    return null; // python -m http.server, serve.js, or a LAN visitor
  }
}

const iconUrls = new Map(); // app id -> object URL, for the tab's lifetime

/** The object URL of an app's icon once loaded ('claude', 'copilot', …), or null. */
export const appIconUrl = (id) => iconUrls.get(id) || null;

/** Fetch the app icons serve.py can provide (PNG only), once each. */
export async function loadAppIcons(ids) {
  await Promise.all((ids || []).filter((id) => !iconUrls.has(id)).map(async (id) => {
    try {
      const r = await apiFetch(`/api/app-icon?app=${encodeURIComponent(id)}`);
      if (r.ok && (r.headers.get('Content-Type') || '').startsWith('image/png')) {
        iconUrls.set(id, URL.createObjectURL(await r.blob()));
      }
    } catch { /* the tile keeps its glyph */ }
  }));
}

/** What a tile can do right now: {enabled, detail, action: 'import'|'file'|'folder'|null}. */
export function tileState(src, status) {
  if (src.id === 'claude-web') return { enabled: true, detail: 'From an export file', action: 'file' };
  if (status === undefined) return { enabled: false, detail: 'Checking…', action: null };
  if (!status) {
    return src.id === 'claude-code'
      ? { enabled: true, detail: 'Choose your ~/.claude folder', action: 'folder' }
      : { enabled: false, detail: 'Needs python3 serve.py', action: null };
  }
  const n = status[src.count];
  if (!n) {
    return src.id === 'claude-code'
      ? { enabled: true, detail: 'Not found — choose a folder', action: 'folder' }
      : { enabled: false, detail: 'Not found on this Mac', action: null };
  }
  const detail = typeof n === 'number' ? `${n} ${n === 1 ? src.unit[0] : src.unit[1]}` : 'Found on this Mac';
  return { enabled: true, detail, action: 'import' };
}

/** Ids of the tiles "Load everything" would import. */
export function importableIds(status) {
  return APP_SOURCES.filter((s) => tileState(s, status).action === 'import').map((s) => s.id);
}

function appIcon(src, small) {
  const box = el('span', `app-icon src-${src.src || 'other'}`);
  const url = src.icon && iconUrls.get(src.icon);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.decoding = 'async';
    box.append(img);
    if (src.badge && !small) {
      const badge = el('span', 'app-badge');
      badge.append(icon(src.badge, 11));
      box.append(badge);
    }
  } else {
    box.classList.add('app-glyph');
    box.append(src.glyph ? icon(src.glyph, small ? 13 : 20) : el('span', 'app-mono', src.name[0]));
  }
  return box;
}

/**
 * @param {object} opts { status (undefined = still checking, null = no
 *   bridge), loaded: Set of imported tile ids, onPick(src, action) }
 */
export function renderSourceGrid(container, { status, loaded, onPick }) {
  container.textContent = '';
  const grid = el('div', 'app-grid');
  for (const src of APP_SOURCES) {
    const st = tileState(src, status);
    const isLoaded = loaded.has(src.id);
    const tile = el('button', `app-tile${st.enabled ? '' : ' is-off'}${isLoaded ? ' is-loaded' : ''}`);
    tile.type = 'button';
    tile.disabled = !st.enabled;
    tile.title = `${src.where}${st.enabled ? '' : ` — ${st.detail.toLowerCase()}`}`;
    const text = el('span', 'app-text');
    text.append(el('span', 'app-name', src.name),
      el('span', 'app-detail', isLoaded ? `Loaded · ${st.detail}` : st.detail));
    tile.append(appIcon(src, false), text);
    if (isLoaded) {
      const mark = el('span', 'app-check');
      mark.append(icon('check', 13));
      tile.append(mark);
    }
    if (st.enabled) tile.addEventListener('click', () => onPick(src, st.action));
    grid.append(tile);
  }

  const later = el('div', 'app-later');
  later.append(el('div', 'app-later-title', 'Not readable yet'));
  const row = el('div', 'app-later-row');
  for (const src of LATER_SOURCES) {
    const here = !!(status && status.later && status.later[src.id]);
    const chip = el('span', `app-later-chip${here ? ' is-here' : ''}`);
    chip.title = here
      ? `${src.name} is on this Mac — Throwbacks can’t read its chats yet`
      : `${src.name} isn’t on this Mac (and isn’t readable yet)`;
    chip.append(appIcon(src, true), el('span', null, src.name));
    if (here) chip.append(el('span', 'app-later-here', 'on this Mac'));
    row.append(chip);
  }
  later.append(row);
  container.append(grid, later);
}
