// live.test.mjs — checks against the AI-app data actually on THIS machine,
// read at run time through tests/bridge.py (serve.py's own readers). Only
// counts are printed and nothing is saved. Each tool that isn't here is
// skipped. Run with:  node tests/run.mjs --live   (or this file directly)

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCodeSessions, parseCopilotFiles, parseCopilotCliSessions, parseCoworkSessions, parseCursorData,
} from '../js/parse.js';
import { buildModel } from '../js/model.js';
import { eq, ok, skip, note, done } from './harness.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'bridge.py');
const bridge = (cmd) => JSON.parse(execFileSync('python3', [BRIDGE, cmd], { encoding: 'utf8', maxBuffer: 1 << 30 }));
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const all = [];

// --- Claude Code: what the server sends == the raw files == the folder reader
{
  const files = bridge('claude-code-files');
  if (!files.length) {
    skip('Claude Code', 'no ~/.claude/projects sessions on this machine');
  } else {
    // A session's subagent files (<session>/subagents/**), and each cut to its usage the way the
    // browser's folder reader cuts it (js/main.js usageLines; serve.py's cc_usage_line).
    const subFiles = (path) => {
      const out = [];
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (name.endsWith('.jsonl')) out.push(p);
        }
      };
      const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
      if (existsSync(dir)) walk(dir);
      return out.sort();
    };
    const usageLines = (text) => text.split('\n').filter((l) => l.includes('"usage"')).map((l) => {
      try {
        const x = JSON.parse(l);
        const m = x && x.message;
        return m && m.usage && typeof m.usage === 'object' && typeof x.timestamp === 'string'
          ? JSON.stringify({ timestamp: x.timestamp, requestId: x.requestId, message: { id: m.id, usage: m.usage } }) : '';
      } catch { return ''; }
    }).filter(Boolean).join('\n');
    const subagents = (path) => {
      const texts = subFiles(path).map((p) => usageLines(readFileSync(p, 'utf8'))).filter(Boolean);
      return texts.length ? texts.join('\n') : undefined;
    };
    // A session still being written (this very run's, a workflow's agents) changes between the
    // reads: such sessions are left out of the comparisons, and counted.
    const sig = (path) => [path, ...subFiles(path)].map((p) => {
      try { const st = statSync(p); return `${st.size}:${st.mtimeMs}`; } catch { return 'gone'; }
    }).join('|');
    const before = new Map(files.map((f) => [`code:${f.name}`, sig(f.path)]));
    const raw = parseCodeSessions(files.map((f) => ({ name: f.name, project: f.project, text: readFileSync(f.path, 'utf8'), subTokens: subagents(f.path) })));
    const viaServer = parseCodeSessions(bridge('claude-code').files);
    const moving = new Set(files.filter((f) => sig(f.path) !== before.get(`code:${f.name}`)).map((f) => `code:${f.name}`));
    if (moving.size) note(`${moving.size} session${moving.size === 1 ? '' : 's'} changed while being read: left out of the comparisons`);
    const byId = (list) => new Map(list.map((s) => [s.id, s]));
    const srv = byId(viaServer);
    // What the server adds about the file itself (when it was last written, whether Claude desktop
    // started it, a kept copy) isn't in a raw read; the chats must match.
    const chat = (s) => s && JSON.stringify({ ...s, touchedAt: null, desktop: null, kept: null });
    const differing = raw.filter((s) => !moving.has(s.id) && chat(s) !== chat(srv.get(s.id))).map((s) => s.id);
    eq(`Claude Code: the trimmed import parses identically to the raw files (${raw.length - moving.size} sessions)`, differing, []);
    ok(viaServer.length === raw.length, 'Claude Code: same number of sessions both ways');

    // The browser's folder reader: every .jsonl but subagents/ as a session; a session's
    // subagents (the folder above subagents/ names it) as its token usage only.
    const root = dirname(dirname(files[0].path));
    const walked = [];
    const subs = new Map();
    const walk = (d, project, sid = null) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, name === 'subagents' ? project : name, name === 'subagents' ? (sid || basename(d)) : sid);
        else if (!name.endsWith('.jsonl')) continue;
        else if (sid) (subs.get(sid) || subs.set(sid, []).get(sid)).push(usageLines(readFileSync(p, 'utf8')));
        else walked.push({ name, project, path: p });
      }
    };
    for (const project of readdirSync(root)) if (statSync(join(root, project)).isDirectory()) walk(join(root, project), project);
    const folder = parseCodeSessions(walked.map((f) => {
      const lines = subs.get(f.name.replace(/\.jsonl$/, ''));
      return { name: f.name, project: f.project, text: readFileSync(f.path, 'utf8'), subTokens: lines ? lines.filter(Boolean).join('\n') : undefined };
    }));
    eq('Claude Code: the one-click import finds the same sessions as "Choose folder"', raw.map((s) => s.id).sort(), folder.map((s) => s.id).sort());
    const tokensOf = (s) => s && JSON.stringify(s.tokenEvents);
    eq('Claude Code: "Choose folder" counts the same tokens, subagents included, as the one-click import',
      folder.filter((s) => !moving.has(s.id) && tokensOf(s) !== tokensOf(srv.get(s.id))).map((s) => s.id), []);
    ok(raw.every((s) => s.messages.every((m, i, a) => i === 0 || a[i - 1].ts <= m.ts)), 'Claude Code: messages are in time order');
    note(`${files.length} files → ${raw.length} sessions, ${sum(raw, (s) => s.messages.length)} messages, ${sum(raw, (s) => s.tokenEvents.length)} usage records`);
    all.push(...raw);
  }
}

// --- GitHub Copilot (VS Code): trimmed == raw ---------------------------------
{
  const files = bridge('copilot-files');
  if (!files.length) {
    skip('Copilot', 'no VS Code Copilot chats on this machine');
  } else {
    const raw = parseCopilotFiles(files.map((f) => ({ name: basename(f.path), workspace: f.workspace, text: readFileSync(f.path, 'utf8') })));
    const viaServer = parseCopilotFiles(bridge('copilot').files);
    const key = (list) => JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : 1)));
    ok(key(viaServer) === key(raw), `Copilot: the trimmed import parses identically to the raw files (${raw.length} sessions)`);
    note(`${files.length} files → ${raw.length} sessions, ${sum(raw, (s) => s.messages.length)} messages`);
    all.push(...raw);
  }
}

// --- Copilot CLI: nothing typed is lost ---------------------------------------
{
  const cli = parseCopilotCliSessions(bridge('copilot-cli').sessions);
  if (!cli.length) {
    skip('Copilot CLI', 'no Copilot CLI sessions on this machine');
  } else {
    const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const typed = new Set(cli.flatMap((s) => s.messages.filter((m) => m.sender === 'human').map((m) => `${s.id.slice('copilot-cli:'.length)}|${norm(m.text)}`)));
    const turns = bridge('copilot-cli-turns');
    const missing = turns.filter((r) => !norm(r.user_message).startsWith('<') && norm(r.user_message) && !typed.has(`${r.session_id}|${norm(r.user_message)}`));
    eq('Copilot CLI: every message typed in the CLI appears in its chat', missing.length, 0);
    ok(turns.filter((r) => norm(r.user_message).startsWith('<')).every((r) => norm(r.user_message).startsWith('<skill-context')),
      'Copilot CLI: the only hidden turns are injected skill blocks');
    note(`${cli.length} sessions, ${sum(cli, (s) => s.messages.length)} messages, ${turns.length} database turns checked`);
    all.push(...cli);
  }
}

// --- Claude Cowork --------------------------------------------------------------
{
  const cow = parseCoworkSessions(bridge('cowork').sessions);
  if (!cow.length) {
    skip('Cowork', 'no Cowork sessions on this machine');
  } else {
    ok(cow.every((s) => s.title && s.messages.length), 'Cowork: every session has a title and messages');
    note(`${cow.length} sessions, ${sum(cow, (s) => s.messages.length)} messages`);
    all.push(...cow);
  }
}

// --- Cursor ------------------------------------------------------------------
{
  const data = bridge('cursor');
  const cur = parseCursorData(data);
  if (!cur.length) {
    skip('Cursor', 'no Cursor chats on this machine');
  } else {
    ok(cur.every((s) => s.messages.length), 'Cursor: every session has messages');
    ok(cur.every((s) => s.approxTimes || !s.messages.some((m) => m.approxTs)),
      'Cursor: a session with any approximate time is marked (so its header shows the note)');
    note(`${(data.composers || []).length} composers → ${cur.length} sessions, ${sum(cur, (s) => s.messages.length)} messages`);
    all.push(...cur);
  }
}

// --- Everything together ----------------------------------------------------------
if (all.length) {
  const m = buildModel(all);
  eq('model: day totals are the sum of per-day unions', m.totalActiveMs, m.listDays().reduce((t, d) => t + d.totalMs, 0));
  eq('model: primary topics partition the sessions exactly', m.primaryTagStats.reduce((t, s) => t + s.sessions.length, 0), m.sessionCount);
  note(`${m.sessionCount} sessions over ${m.dayKeys.length} days, ${m.sourceStats.map((s) => s.label).join(', ')}`);
}

done();
