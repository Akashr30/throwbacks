// resume.js — picking a session up again in its own app: the command that
// continues it (Claude Code: `claude --resume <id>`, Copilot CLI:
// `copilot --resume=<id>`), run from the session's folder, for you to paste
// into a terminal. Throwbacks never runs it — the app you paste it into
// writes to the session as it always does. Also where a chat lives: its own
// file, for the conversation's header (copy the path, Show in Finder). No DOM.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which app can continue this session, and the id that app knows it by —
 * or null. Only ids that are UUIDs: anything else, `claude --resume` takes
 * as a name to search for, and Copilot CLI as a new session to start.
 * Cowork, claude.ai, VS Code's Copilot and Cursor chats can't be resumed
 * from a terminal.
 */
export function resumeTarget(session) {
  if (!session || typeof session.id !== 'string') return null;
  if (session.source === 'code') {
    const m = /^code:(.+)\.jsonl$/i.exec(session.id);
    return m && UUID.test(m[1]) ? { app: 'claude', id: m[1] } : null;
  }
  if (session.source === 'copilot-cli') {
    const m = /^copilot-cli:(.+)$/.exec(session.id);
    return m && UUID.test(m[1]) ? { app: 'copilot', id: m[1] } : null;
  }
  return null;
}

/** A path as one POSIX shell word ('…', each ' written '\''), or null when it's empty or holds control characters. */
export function shellQuote(text) {
  const s = String(text ?? '');
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The command to paste, from the session's folder.
 * @param {{app, id}} target  from resumeTarget
 * @param {{found?, folder?, exists?, live?}} info  what the server found
 *   (found: false = the app no longer has it; exists: false = its folder is
 *   gone; live: {where, kind} — it's open right now somewhere), or just
 *   {folder} without it
 * @returns {{command, attach, closeFirst, gone}|null}  always the same session
 *   (never a copy: continuing it is what resuming is for).
 *   closeFirst: it's open in another window right now — close it there
 *     first, since two windows on one session mix their messages into one
 *     transcript; attach: it's running in the background, and resuming opens
 *     that run; gone: its folder no longer exists, so the command runs
 *     wherever it's pasted
 */
export function resumeCommand(target, info = {}) {
  if (!target || !UUID.test(target.id) || info.found === false) return null;
  const live = info.live || null;
  const attach = target.app === 'claude' && !!live && BACKGROUND.test(live.kind || '');
  const closeFirst = !!live && !attach;
  const run = target.app === 'claude' ? `claude --resume ${target.id}` : `copilot --resume=${target.id}`;
  const dir = info.folder ? shellQuote(info.folder) : null;
  if (dir && info.exists !== false) return { command: `cd ${dir} && ${run}`, attach, closeFirst, gone: false };
  return { command: run, attach, closeFirst, gone: !!info.folder && info.exists === false };
}

/**
 * The link that opens this same Claude Code session in Claude desktop
 * (Desktop handles it: `claude --desktop --resume <id>` opens the same one;
 * tried by hand 2026-10-09), or null. Not documented by Anthropic, so a
 * Desktop update could change it; Copy resume command stays beside it.
 */
export function desktopLink(target) {
  return target && target.app === 'claude' && UUID.test(target.id) ? `claude://resume?session=${target.id}` : null;
}

// ---------------------------------------------------------------------------
// Where a chat lives: its own file (the conversation's header copies the path;
// Show in Finder asks the server to show it). The page names the chat — its
// app and its own ID — and the server finds the file; a path never goes the
// other way. claude.ai chats come from an export, whose folder the browser is
// never told.
// ---------------------------------------------------------------------------

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;  // as serve.py's SOURCE_ID: a file name's stem
const SOURCE_PREFIX = { code: /^code:(.+)\.jsonl$/i, cowork: /^cowork:(.+)\.jsonl$/i, copilot: /^copilot:(.+)$/, 'copilot-cli': /^copilot-cli:(.+)$/, cursor: /^cursor:(.+)$/ };

/** {app, id} to ask the server where this chat's file is, or null (claude.ai, an odd ID). */
export function sourceTarget(session) {
  const re = session && typeof session.id === 'string' ? SOURCE_PREFIX[session.source] : null;
  const m = re && re.exec(session.id);
  return m && SOURCE_ID.test(m[1]) ? { app: session.source, id: m[1] } : null;
}

/**
 * What the file line says: {name, title, toast} — the file's name, the full
 * path (and, for a database, which chat in it) on hover, and what copying says.
 * @param {{found, kind, path, key?, kept?}} info  the server's answer
 */
export function sourceText(info) {
  if (!info || !info.found || typeof info.path !== 'string' || !info.path) return null;
  const parts = info.path.split(/[\\/]/);
  // Copilot CLI names every chat's file events.jsonl: its folder (the chat's ID) says which.
  const name = parts.length > 1 && parts[parts.length - 1] === 'events.jsonl' ? parts.slice(-2).join('/') : parts[parts.length - 1];
  if (info.kind === 'database') {
    return {
      name: `${name} (shared database)`,
      title: `${info.path}\nThis app keeps every chat in this one database; this one is ${info.key} inside it. Click to copy the path.`,
      toast: 'Database path copied — this chat is one entry inside it',
    };
  }
  return {
    name,
    title: info.kept
      ? `${info.path}\nThrowbacks’ kept copy (gzipped): Claude Code has deleted the original. Click to copy the path.`
      : `${info.path}\nClick to copy the path. It’s the app’s own live file: look, don’t edit.`,
    toast: info.kept ? 'Path of the kept copy copied' : 'File path copied',
  };
}

/** Claude Code's kinds for a session running in the background (claude agents). */
const BACKGROUND = /^(bg|daemon|daemon-worker)$/;

/** Where a session is open right now, in words ("Claude desktop", "a terminal"). */
export function liveWhere(live) {
  if (live && BACKGROUND.test(live.kind || '')) return 'the background';
  const e = String((live && live.where) || '');
  return /desktop/i.test(e) ? 'Claude desktop' : /vscode|ide|jetbrains|cursor/i.test(e) ? 'your editor' : 'a terminal';
}
