// parse.js — every source parser. Each returns the same normalized shape:
//
//   session = {
//     id,          // stable identity (uuid / filename)
//     title,       // display title
//     source,      // 'web' | 'code' | 'copilot' | 'cursor' | 'copilot-cli' | 'cowork'
//     project,     // project name when a folder is known, else null
//     messages: [{ sender: 'human'|'assistant', text, ts }],  // renderable
//     activityTs: [ts, ...],  // EVERY timestamp that counts as activity,
//                             // including non-rendered tool lines (code)
//   }
//
// All schema-defensiveness lives here: any field may be missing, any line
// may be malformed. Pure functions, no DOM.

/** Parse an ISO timestamp; return ms or null if unparsable. */
function parseTs(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Join the text items of a content array ({type:'text', text}). */
function joinContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Source A — claude.ai export (conversations.json)
// ---------------------------------------------------------------------------

/**
 * @param {any} json parsed conversations.json (expected: array of conversations)
 * @returns {Array<session>} normalized sessions (may be empty)
 */
export function parseExport(json) {
  if (!Array.isArray(json)) return [];
  const sessions = [];
  for (const conv of json) {
    if (!conv || typeof conv !== 'object') continue;
    const id = 'web:' + (conv.uuid || conv.name || `conv-${sessions.length}`);
    const title = (typeof conv.name === 'string' && conv.name.trim())
      ? conv.name.trim()
      : 'Untitled conversation';
    const convTs = parseTs(conv.created_at);

    const messages = [];
    const raw = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      let text = (typeof m.text === 'string' && m.text.trim()) ? m.text : '';
      if (!text) text = joinContentText(m.content);
      if (!text) continue; // skip messages with no text
      const ts = parseTs(m.created_at) ?? convTs;
      if (ts == null) continue; // skip if unparsable
      const sender = m.sender === 'human' ? 'human' : 'assistant';
      messages.push({ sender, text, ts });
    }
    if (messages.length === 0) continue;
    messages.sort((a, b) => a.ts - b.ts);
    sessions.push({
      id,
      title,
      source: 'web',
      project: null,
      messages,
      activityTs: messages.map((m) => m.ts),
    });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Source B — Claude Code local sessions (.jsonl files)
// ---------------------------------------------------------------------------

/** Display name for a project folder: last segment of the decoded path. */
function projectDisplayName(folderName) {
  if (!folderName) return 'unknown';
  // Folder names encode the project path with '-' separators,
  // e.g. "-Users-me-dev-my-app". Take the last plausible segment.
  const decoded = folderName.replace(/^-+/, '');
  const parts = decoded.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : folderName;
}

/** Extract renderable text from a jsonl line's message.content. */
/** "User" lines Claude Code writes itself: a background task's notification, a command's output, a hook's. */
const CC_INJECTED = /^<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr|user-prompt-submit-hook)>/;

/**
 * What you typed, of a Claude Code "user" line — or null for one Claude Code wrote
 * itself (a background task's notification, a command's output, a skill's text,
 * "[Request interrupted by user]", a compacted session's summary): those count as
 * activity, never as your message. A slash command you ran shows as you typed it
 * ("/model opus"), a shell command as "! ls".
 */
function typedText(line, text) {
  if (line.isMeta === true || line.isCompactSummary === true) return null;
  if (CC_INJECTED.test(text) || /^\[Request interrupted by user/.test(text)
    || /^This session is being continued from a previous conversation/.test(text)) return null;
  const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return `${cmd[1].trim()} ${args.trim()}`.trim() || null;
  }
  const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  return bash ? `! ${bash[1].trim()}` : text;
}

/** The prompt serve.py's Claude bridge gives `claude -p` (keep the two the same). */
const BRIDGE_PROMPT = 'Follow the instructions in the piped input exactly. Output only the requested result.';
/** What "Test key" sends (summarize.js testKey: its system line, then "ping"), whitespace aside. */
const TEST_PROMPT = 'Reply with exactly: OK ping';
/**
 * Throwbacks' own summarizer runs, saved as sessions before it ran them
 * unsaved (Sept 2026): one message of yours, a summary (the bridge's prompt)
 * or a Test key.
 */
function isBridgeRun(messages) {
  const yours = messages.filter((m) => m.sender === 'human');
  return yours.length === 1 && (yours[0].text.startsWith(BRIDGE_PROMPT) || yours[0].text.trim().split(/\s+/).join(' ') === TEST_PROMPT);
}

/**
 * A line's token usage, added to `list` — each reply once. Claude Code writes
 * one reply as several lines (its text, each tool call…), every one carrying
 * the reply's usage, the output growing as it streams: lines with the same
 * message id and request id are one reply, at their largest counts (`byKey`
 * across a session, its subagents included). Events carry that key as `k`, so
 * a reply copied into a branched or resumed session counts once overall too.
 */
function addTokens(list, byKey, line, ts) {
  const msg = line.message;
  const usage = ts != null && msg && typeof msg === 'object' ? msg.usage : null;
  if (!usage || typeof usage !== 'object') return;
  const cw = usage.cache_creation_input_tokens || 0;
  const i = (usage.input_tokens || 0) + cw;
  const o = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  if (!i && !o && !cr) return;
  const k = typeof msg.id === 'string' && msg.id ? `${msg.id}|${typeof line.requestId === 'string' ? line.requestId : ''}` : null;
  const seen = k ? byKey.get(k) : null;
  if (seen) {
    seen.i = Math.max(seen.i, i);
    seen.cw = Math.max(seen.cw, cw);
    seen.o = Math.max(seen.o, o);
    seen.cr = Math.max(seen.cr, cr);
    return;
  }
  const e = k ? { ts, i, cw, o, cr, k } : { ts, i, cw, o, cr };
  if (k) byKey.set(k, e);
  list.push(e);
}

function extractLineText(line) {
  const msg = line.message;
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  return joinContentText(c);
}

/**
 * @param {Array<{name: string, project: string, text: string, subTokens?: string}>} files
 *   one entry per .jsonl file: filename, parent folder name, raw contents, and
 *   its subagents' lines (their token usage counts toward the session's — never
 *   its messages or its time)
 * @returns {Array<session>} normalized sessions (may be empty)
 */
export function parseCodeSessions(files) {
  const sessions = [];
  for (const file of files) {
    if (!file || typeof file.text !== 'string') continue;
    const id = 'code:' + file.name;
    let project = projectDisplayName(file.project);
    let startDir = null;   // full cwd — session start dir, used to complete relative paths
    let cwdProject = null; // its last segment names the project exactly
    let customTitle = null; // user-set session name (Claude Code shows this)
    let aiTitle = null;     // auto-generated name; regenerated, last one is current
    let summaryTitle = null;
    let hadSidechain = false; // subagent traffic seen in this file
    const messages = [];
    const activityTs = [];
    const tokenEvents = []; // {ts, i: input+cacheWrite, cw: cacheWrite, o: output, cr: cacheRead, k?: the reply's key}
    const tokenKeys = new Map();

    for (const rawLine of file.text.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let line;
      try {
        line = JSON.parse(trimmed);
      } catch {
        continue; // silently skip malformed lines
      }
      if (!line || typeof line !== 'object') continue;

      if (!cwdProject && typeof line.cwd === 'string' && line.cwd) {
        startDir = line.cwd.replace(/[\\/]+$/, '');
        const seg = startDir.split(/[\\/]/).pop();
        if (seg) cwdProject = seg;
      }

      if (line.type === 'custom-title' && typeof line.customTitle === 'string' && line.customTitle.trim()) {
        customTitle = line.customTitle.trim(); // last one wins (renames)
        continue;
      }
      if (line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()) {
        aiTitle = line.aiTitle.trim(); // last one is the current auto-name
        continue;
      }
      if (line.type === 'summary' && typeof line.summary === 'string' && line.summary.trim()) {
        summaryTitle = summaryTitle || line.summary.trim();
        continue;
      }

      const ts = parseTs(line.timestamp);
      // Every timestamped line is activity, rendered or not.
      if (ts != null) activityTs.push(ts);

      // Token usage (assistant lines carry it; sidechain lines too — their
      // consumption is just as real). input + cache writes = new tokens in.
      addTokens(tokenEvents, tokenKeys, line, ts);

      // Subagent (sidechain) traffic is a session's internal tooling — it
      // counts as activity but is never rendered as chat.
      if (line.isSidechain === true || typeof line.agentId === 'string') {
        hadSidechain = true;
        continue;
      }

      if (line.type !== 'user' && line.type !== 'assistant') continue;
      if (ts == null) continue;
      let text = extractLineText(line);
      if (!text) continue; // pure tool traffic: counts for time, not rendered
      const sender = line.type === 'user' ? 'human' : 'assistant';
      if (sender === 'human') {
        text = typedText(line, text);
        if (!text) continue; // Claude Code wrote it: counts for time, never as your message
      }
      messages.push({ sender, text, ts });
    }

    if (messages.length === 0 && activityTs.length === 0) continue;
    // Its subagents' replies (…/<session>/subagents/): tokens only.
    for (const raw of typeof file.subTokens === 'string' ? file.subTokens.split('\n') : []) {
      if (!raw.includes('"usage"')) continue;
      try {
        const line = JSON.parse(raw);
        if (line && typeof line === 'object') addTokens(tokenEvents, tokenKeys, line, parseTs(line.timestamp));
      } catch { /* a malformed line */ }
    }
    // Throwbacks' own summarizer runs (serve.py --claude runs `claude -p` in
    // a throwbacks-claude-… temp folder) are not your chats. Newer CLIs don't
    // save them at all; older ones might.
    if (startDir && /[\\/]throwbacks-claude-[^\\/]*$/.test(startDir)) continue;
    // The oldest ones (Sept 2026, before the temp folder) were saved in the
    // folder serve.py ran in: one message, the bridge's prompt and then the
    // piped text.
    if (isBridgeRun(messages)) continue;
    // A file with no renderable chat that is subagent traffic (or a
    // workflow journal / agent transcript by name) is not a session.
    if (messages.length === 0 && (hadSidechain || /^(agent-|journal\b)/i.test(file.name))) continue;
    if (cwdProject) project = cwdProject;
    messages.sort((a, b) => a.ts - b.ts);
    activityTs.sort((a, b) => a - b);

    // Title priority mirrors what Claude Code itself displays:
    // user-set name > latest auto-name > summary > first message.
    let title = customTitle || aiTitle || summaryTitle;
    if (!title) {
      const firstUser = messages.find((m) => m.sender === 'human');
      title = firstUser
        ? firstUser.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
        : '';
      if (!title) title = file.name.replace(/\.jsonl$/i, '');
    }

    sessions.push({
      id,
      title,
      source: 'code',
      project,
      startDir,
      messages,
      activityTs,
      tokenEvents,
      // When Claude Code last wrote the file (its cleanup goes by this), and whether Throwbacks keeps a copy.
      touchedAt: Number.isFinite(file.mtime) ? file.mtime : null,
      kept: !!file.kept,
      onlyKept: !!file.onlyKept,
      desktop: !!file.desktop,  // started in Claude desktop: Claude Code's cleanup leaves it
    });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Shared helpers for the IDE sources
// ---------------------------------------------------------------------------

function titleFrom(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function folderOf(path) {
  return typeof path === 'string' && path ? path.replace(/[\\/]+$/, '') || null : null;
}

function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

// ---------------------------------------------------------------------------
// Source C — GitHub Copilot Chat (VS Code): chatSessions/*.json snapshots
// and *.jsonl operation logs, either raw (dropped files) or pruned by
// serve.py (same format, bulky payloads removed).
// ---------------------------------------------------------------------------

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Rebuild a session from a Copilot op log. Line kinds: 0 = initial state,
 * 1 = set value at path `k`, 2 = push items `v` to the array at `k` (when
 * `i` is present the array is first truncated to length `i` — streamed
 * text rewrites its tail this way), 3 = delete at `k`.
 */
export function replayCopilotLog(text) {
  let state = null;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let op;
    try {
      op = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!op || typeof op !== 'object') continue;
    if (op.kind === 0) {
      state = op.v && typeof op.v === 'object' ? op.v : null;
      continue;
    }
    const path = Array.isArray(op.k) ? op.k : null;
    if (!state || !path || !path.length) continue;
    if (path.some((p) => UNSAFE_KEYS.has(String(p)))) continue; // no prototype writes
    let parent = state;
    for (let i = 0; i < path.length - 1 && parent; i++) {
      parent = parent[path[i]];
      if (parent === null || typeof parent !== 'object') parent = null;
    }
    if (!parent) continue;
    const key = path[path.length - 1];
    if (op.kind === 1) {
      parent[key] = op.v;
    } else if (op.kind === 2) {
      if (!Array.isArray(parent[key])) parent[key] = [];
      const arr = parent[key];
      if (Number.isInteger(op.i) && op.i >= 0 && op.i < arr.length) arr.length = op.i;
      if (Array.isArray(op.v)) for (const item of op.v) arr.push(item);
    } else if (op.kind === 3) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    }
  }
  return state;
}

/** Does this text look like a Copilot op log (vs. a Claude Code .jsonl)? */
export function isCopilotLog(text) {
  const head = String(text).slice(0, 4096);
  return /^\s*\{\s*"kind"\s*:\s*0\s*,/.test(head) && /"(sessionId|requests|responderUsername)"/.test(head);
}

/** Is this parsed JSON a Copilot chat session snapshot? */
export function isCopilotSession(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && Array.isArray(obj.requests)
    && ('sessionId' in obj || 'responderUsername' in obj || 'requesterUsername' in obj);
}

/** Text for an inline file/symbol reference: a file shows as its full
 *  path (so the bubble turns it into a path chip), a symbol by name. */
function copilotInlineLabel(it) {
  const ref = it.inlineReference && typeof it.inlineReference === 'object' ? it.inlineReference : {};
  const loc = ref.location && typeof ref.location === 'object' ? ref.location : {};
  const path = [ref.fsPath, ref.path, ref.uri && ref.uri.fsPath, ref.uri && ref.uri.path,
    loc.fsPath, loc.path, loc.uri && loc.uri.fsPath, loc.uri && loc.uri.path]
    .find((p) => typeof p === 'string' && p);
  const name = [it.name, ref.name].find((n) => typeof n === 'string' && n.trim());
  if (path && (!name || name === basename(path))) return path;
  return name || path || '';
}

// Response parts that sit BETWEEN paragraphs (tool runs, edits, …).
const COPILOT_BREAK_KINDS = new Set([
  'toolInvocationSerialized', 'prepareToolInvocation', 'textEditGroup',
  'notebookEditGroup', 'progressTaskSerialized', 'progressMessage',
  'confirmation', 'elicitation', 'thinking',
]);

/** Visible reply text: streamed markdown chunks joined, inline references
 *  kept in the sentence, a paragraph break where a tool run intervened. */
function copilotResponseText(items) {
  if (!Array.isArray(items)) return '';
  let out = '';
  let pendingBreak = false;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    let t = null;
    if (it.kind == null && typeof it.value === 'string') t = it.value;
    else if (it.kind === 'markdownContent' && it.content && typeof it.content.value === 'string') t = it.content.value;
    else if (it.kind === 'inlineReference') t = copilotInlineLabel(it);
    if (t) {
      if (pendingBreak && out.trim() && !/\n\s*$/.test(out)) out += '\n\n';
      out += t;
      pendingBreak = false;
    } else if (COPILOT_BREAK_KINDS.has(it.kind)) {
      pendingBreak = true;
    }
  }
  return out.trim();
}

const FILL_STEP_MS = 5 * 60 * 1000;      // below time.js GAP_MIN (15 min)
const MAX_RUN_MS = 3 * 60 * 60 * 1000;   // cap a single response's duration

function copilotSession(obj, id, workspace) {
  const messages = [];
  const activityTs = [];
  for (const r of obj.requests) {
    if (!r || typeof r !== 'object') continue;
    const ts = parseTs(r.timestamp);
    if (ts == null) continue;
    activityTs.push(ts);
    const ask = r.message && typeof r.message.text === 'string' ? r.message.text.trim() : '';
    if (ask) messages.push({ sender: 'human', text: ask, ts });

    const timings = r.result && typeof r.result === 'object' ? r.result.timings : null;
    let ran = Number(timings && timings.totalElapsed);
    if (!(ran > 0)) ran = Number(r.elapsedMs);
    if (!(ran > 0)) ran = 0;
    const end = ts + Math.max(1000, Math.min(ran, MAX_RUN_MS));
    // A long agent run is continuous activity (like tool lines in Claude
    // Code): fill it in below GAP_MIN so it counts as one active block.
    for (let x = ts + FILL_STEP_MS; x < end; x += FILL_STEP_MS) activityTs.push(x);
    activityTs.push(end);

    const reply = copilotResponseText(r.response);
    if (reply) messages.push({ sender: 'assistant', text: reply, ts: end });
  }
  if (!messages.length) return null;
  messages.sort((a, b) => a.ts - b.ts);
  activityTs.sort((a, b) => a - b);
  const startDir = folderOf(workspace);
  const custom = typeof obj.customTitle === 'string' ? obj.customTitle.trim() : '';
  const first = messages.find((m) => m.sender === 'human');
  return {
    id: `copilot:${id}`,
    title: custom || (first && titleFrom(first.text)) || 'Copilot chat',
    source: 'copilot',
    project: startDir ? basename(startDir) : null,
    startDir,
    messages,
    activityTs,
  };
}

/**
 * @param {Array<{name: string, workspace?: string|null, text: string}>} files
 *   Copilot session files (.json snapshot or .jsonl op log) + the folder of
 *   the VS Code workspace they belong to, when known
 * @returns {Array<session>}
 */
export function parseCopilotFiles(files) {
  const best = new Map(); // sessionId -> { obj, workspace, rank }
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.text !== 'string') continue;
    const name = typeof f.name === 'string' ? f.name : '';
    const isLog = /\.jsonl$/i.test(name) || isCopilotLog(f.text);
    let obj = null;
    if (isLog) {
      obj = replayCopilotLog(f.text);
    } else {
      try {
        obj = JSON.parse(f.text);
      } catch {
        obj = null;
      }
    }
    if (!isCopilotSession(obj)) continue;
    const id = String(obj.sessionId || name.replace(/\.jsonl?$/i, '') || `session-${best.size}`);
    // One session can exist twice (an older .json snapshot and the newer
    // .jsonl log): keep the more complete copy, the log on a tie.
    const rank = obj.requests.length * 2 + (isLog ? 1 : 0);
    const prev = best.get(id);
    if (!prev || rank > prev.rank) best.set(id, { obj, workspace: f.workspace, rank });
  }
  const sessions = [];
  for (const [id, { obj, workspace }] of best) {
    const s = copilotSession(obj, id, workspace);
    if (s) sessions.push(s);
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Source D — Cursor: composer records + bubble rows from Cursor's SQLite
// state.vscdb, extracted read-only by serve.py. Cursor versions that keep
// no per-message time get their messages placed from the chat's creation
// time, a minute apart, flagged approxTs / approxTimes (order is exact).
// ---------------------------------------------------------------------------

const EPOCH_2001_MS = 978307200000; // earlier "times" are relative clocks, not dates

function epochTs(v) {
  const t = parseTs(v);
  return t != null && t > EPOCH_2001_MS ? t : null;
}

/**
 * @param {{composers: object[], bubbles: object, workspaceOf: object}} data
 *   composers: composerData records; bubbles: "<composerId>:<bubbleId>" ->
 *   bubble; workspaceOf: composerId -> workspace folder
 * @returns {Array<session>}
 */
export function parseCursorData(data) {
  if (!data || typeof data !== 'object') return [];
  const bubbles = data.bubbles && typeof data.bubbles === 'object' ? data.bubbles : {};
  const wsOf = data.workspaceOf && typeof data.workspaceOf === 'object' ? data.workspaceOf : {};
  const sessions = [];
  for (const c of Array.isArray(data.composers) ? data.composers : []) {
    if (!c || typeof c !== 'object' || typeof c.composerId !== 'string') continue;
    const cid = c.composerId;
    // Newer Cursor: ordered headers + one row per bubble; older: inline list.
    let list = [];
    if (Array.isArray(c.fullConversationHeadersOnly) && c.fullConversationHeadersOnly.length) {
      list = c.fullConversationHeadersOnly
        .filter((h) => h && typeof h === 'object')
        .map((h) => ({ type: h.type, ...(bubbles[`${cid}:${h.bubbleId}`] || {}) }));
    } else if (Array.isArray(c.conversation)) {
      list = c.conversation.filter((b) => b && typeof b === 'object');
    }

    let clock = epochTs(c.createdAt);
    let approx = false;
    const messages = [];
    const activityTs = [];
    for (const b of list) {
      const timing = b.timingInfo && typeof b.timingInfo === 'object' ? b.timingInfo : {};
      let ts = epochTs(b.createdAt) ?? epochTs(timing.clientEndTime) ?? epochTs(timing.clientStartTime);
      const synthesized = ts == null;
      if (synthesized) {
        if (clock == null) continue; // no date to place it by
        ts = activityTs.length ? clock + 60 * 1000 : clock;
        approx = true;
      }
      clock = ts;
      activityTs.push(ts);
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text) continue; // tool-only turn: activity, not a bubble
      const msg = { sender: b.type === 1 ? 'human' : 'assistant', text, ts };
      if (synthesized) msg.approxTs = true;
      messages.push(msg);
    }
    if (!messages.length) continue;
    messages.sort((a, b) => a.ts - b.ts);
    activityTs.sort((a, b) => a - b);
    const startDir = folderOf(wsOf[cid]);
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const first = messages.find((m) => m.sender === 'human');
    sessions.push({
      id: `cursor:${cid}`,
      title: name || (first && titleFrom(first.text)) || 'Cursor chat',
      source: 'cursor',
      project: startDir ? basename(startDir) : null,
      startDir,
      messages,
      activityTs,
      approxTimes: approx,
    });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Source E — GitHub Copilot CLI (~/.copilot): per-session event logs, every
// event timestamped (tool runs count as activity), or — for sessions with
// no log — the turns table of session-store.db.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id, name?, cwd?, events?: string, turns?: object[]}>} list
 * @returns {Array<session>}
 */
export function parseCopilotCliSessions(list) {
  const sessions = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object' || !it.id) continue;
    const messages = [];
    const activityTs = [];
    if (typeof it.events === 'string') {
      for (const raw of it.events.split('\n')) {
        let e;
        try {
          e = JSON.parse(raw);
        } catch {
          continue;
        }
        const ts = e && typeof e === 'object' ? parseTs(e.timestamp) : null;
        if (ts == null) continue;
        activityTs.push(ts);
        const d = e.data && typeof e.data === 'object' ? e.data : {};
        const text = typeof d.content === 'string' ? d.content.trim() : '';
        if (!text) continue;
        // Messages injected by autopilot or a skill aren't things you typed.
        if (e.type === 'user.message' && (d.source == null || d.source === 'user')) {
          messages.push({ sender: 'human', text, ts });
        } else if (e.type === 'assistant.message') {
          messages.push({ sender: 'assistant', text, ts });
        }
      }
    } else if (Array.isArray(it.turns)) {
      for (const t of it.turns) {
        const ts = t && typeof t === 'object' ? parseTs(t.timestamp) : null;
        if (ts == null) continue;
        activityTs.push(ts);
        const q = typeof t.user_message === 'string' ? t.user_message.trim() : '';
        const a = typeof t.assistant_response === 'string' ? t.assistant_response.trim() : '';
        if (q) messages.push({ sender: 'human', text: q, ts });
        if (a) messages.push({ sender: 'assistant', text: a, ts: ts + 1000 });
      }
    }
    if (!messages.length) continue;
    messages.sort((a, b) => a.ts - b.ts);
    activityTs.sort((a, b) => a - b);
    const startDir = folderOf(it.cwd);
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    const first = messages.find((m) => m.sender === 'human');
    sessions.push({
      id: `copilot-cli:${it.id}`,
      title: name || (first && titleFrom(first.text)) || 'Copilot CLI session',
      source: 'copilot-cli',
      project: startDir ? basename(startDir) : null,
      startDir,
      messages,
      activityTs,
    });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Source F — Claude desktop's Cowork: each session is a Claude Code
// transcript (parsed by Source B) plus the title the desktop app shows.
// Its working folder is Cowork's private outputs dir, not a project, so
// these sessions have no folder.
// ---------------------------------------------------------------------------

const PLACEHOLDER_TITLES = new Set(['new chat', 'untitled', 'new task']);

/**
 * @param {Array<{name: string, text: string, title?: string|null}>} list
 * @returns {Array<session>}
 */
export function parseCoworkSessions(list) {
  const sessions = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it.text !== 'string') continue;
    const name = typeof it.name === 'string' && it.name ? it.name : `cowork-${sessions.length}.jsonl`;
    const [s] = parseCodeSessions([{ name, project: '', text: it.text }]);
    if (!s || !s.messages.length) continue;
    const appTitle = typeof it.title === 'string' ? it.title.trim() : '';
    sessions.push({
      ...s,
      id: `cowork:${name}`,
      source: 'cowork',
      title: appTitle && !PLACEHOLDER_TITLES.has(appTitle.toLowerCase()) ? appTitle : s.title,
      project: null,
      startDir: null,
    });
  }
  return sessions;
}
