// parse.test.mjs — every reader in js/parse.js, on small made-up inputs:
// Claude Code transcripts, Copilot's op logs and snapshots, Cursor's
// composers, Copilot CLI events and Claude Cowork sessions.

import {
  replayCopilotLog, isCopilotLog, isCopilotSession, parseCopilotFiles,
  parseCursorData, parseCodeSessions, parseCopilotCliSessions, parseCoworkSessions,
} from '../js/parse.js';
import { eq, ok, done } from './harness.mjs';

const L = (o) => JSON.stringify(o);

// --- Claude Code ------------------------------------------------------------

const cc = (lines, name = 's.jsonl') => parseCodeSessions([{ name, project: '-Users-me-Dev-app', text: lines.map(L).join('\n') }]);
const t = (min) => new Date(Date.UTC(2026, 8, 1, 10, min)).toISOString();

{
  const [s] = cc([
    { type: 'summary', summary: 'Old summary' },
    { type: 'ai-title', aiTitle: 'First auto name' },
    { type: 'user', timestamp: t(0), cwd: '/Users/me/Dev/app/', message: { content: 'Fix the retry bug' } },
    { type: 'assistant', timestamp: t(1), cwd: '/elsewhere', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'Edit' }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } } },
    { type: 'user', timestamp: t(2), message: { content: [{ type: 'tool_result', content: 'big output' }] } },
    { type: 'assistant', timestamp: t(3), isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }], usage: { output_tokens: 3 } } },
    { type: 'ai-title', aiTitle: 'Latest auto name' },
    'not json',
  ]);
  eq('claude code: latest auto name wins over the summary', s.title, 'Latest auto name');
  eq('claude code: first cwd gives the folder and project', [s.startDir, s.project], ['/Users/me/Dev/app', 'app']);
  eq('claude code: only typed text renders (no thinking, tools or subagents)', s.messages.map((m) => [m.sender, m.text]), [['human', 'Fix the retry bug'], ['assistant', 'Done.']]);
  eq('claude code: tool and subagent lines still count as activity', s.activityTs.length, 4);
  eq('claude code: token usage = input + cache writes, output, cache reads (subagents too)', s.tokenEvents.map(({ i, o, cr }) => [i, o, cr]), [[15, 7, 100], [0, 3, 0]]);
}
{
  // One reply is several lines (its thinking, its text, each tool call), each repeating its usage as it streams.
  const reply = (min, content, out) => ({ type: 'assistant', timestamp: t(min), requestId: 'req_1',
    message: { id: 'msg_1', content, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: out } } });
  const subTokens = [
    { timestamp: t(3), requestId: 'req_9', message: { id: 'msg_9', usage: { input_tokens: 2, output_tokens: 40 } } },
    { timestamp: t(3), requestId: 'req_9', message: { id: 'msg_9', usage: { input_tokens: 2, output_tokens: 41 } } },
    { timestamp: t(4), requestId: 'req_1', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } } },
    'not json',
  ].map(L).join('\n');
  const [s] = parseCodeSessions([{ name: 'x.jsonl', project: 'p', subTokens, text: [
    { type: 'user', timestamp: t(0), message: { content: 'Go' } },
    reply(1, [{ type: 'thinking', thinking: 'hmm' }], 1),
    reply(1, [{ type: 'text', text: 'Done.' }], 12),
    reply(2, [{ type: 'tool_use', name: 'Edit' }], 30),
    { type: 'assistant', timestamp: t(2), message: { content: [{ type: 'text', text: 'An older line, no id' }], usage: { output_tokens: 4 } } },
  ].map(L).join('\n') }]);
  eq('claude code: a reply over several lines counts once, at its largest; a line with no id counts as it is',
    s.tokenEvents.map(({ i, o, cr }) => [i, o, cr]), [[15, 30, 100], [0, 4, 0], [2, 41, 0]]);
  eq('…its subagents’ replies count too (once), never as messages or time', [s.messages.length, s.activityTs.length], [3, 5]);
  eq('…each reply keeps its key, for counting it once across chats', s.tokenEvents.map((e) => e.k || null), ['msg_1|req_1', null, 'msg_9|req_9']);
}
{
  const [s] = cc([
    { type: 'ai-title', aiTitle: 'Auto name' },
    { type: 'custom-title', customTitle: 'My own name' },
    { type: 'user', timestamp: t(0), message: { content: 'hello' } },
  ]);
  eq('claude code: a name the user set beats the auto name', s.title, 'My own name');
  eq('claude code: no title lines → the first message names the session', cc([{ type: 'user', timestamp: t(0), message: { content: '<cmd>x</cmd> Explain   the cache' } }])[0].title, 'x Explain the cache');
  eq('claude code: a transcript of only subagent traffic is not a session', cc([{ type: 'assistant', timestamp: t(0), agentId: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } }]).length, 0);
  eq('claude code: an agent-*.jsonl with no chat is not a session', cc([{ type: 'system', timestamp: t(0) }], 'agent-123.jsonl').length, 0);
  const ran = (cwd) => cc([{ type: 'user', timestamp: t(0), cwd, message: { content: 'Write work-log lines' } }]).length;
  eq('claude code: Throwbacks\' own summarizer runs are not your sessions', ran('/private/var/folders/ab/T/throwbacks-claude-k2j3x/'), 0);
  eq('…but a folder that only mentions the name still is', ran('/Users/me/throwbacks-claude-notes/app'), 1);
  // The oldest runs were saved in serve.py's own folder: one message, the bridge's prompt, then the piped text.
  const bridge = 'Follow the instructions in the piped input exactly. Output only the requested result.';
  const said = (...texts) => cc(texts.map((text, i) => ({ type: i % 2 ? 'assistant' : 'user', timestamp: t(i), cwd: '/Users/me/Dev/throwbacks', message: { content: text } }))).length;
  eq('claude code: an old summarizer run saved in the project folder is not a session', said(`${bridge}\n\nWrite work-log lines for …`, '- Fixed the retry bug'), 0);
  eq('…but a chat that goes on after it still is', said(`${bridge}\n\nWrite …`, 'ok', 'Now explain it'), 1);
  eq('…and so is one that only quotes it', said(`Why does serve.py say “${bridge}”?`, 'Because …'), 1);
  // Its Test key, saved the same way: "Reply with exactly: OK", then "ping" (newlines as the bridge joined them then)
  eq('claude code: an old Test key run is not a session', [said('Reply with exactly: OK\nping\n', 'OK'), said('Reply with exactly: OK\n\nping', 'OK')], [0, 0]);
  eq('…but a chat that asks more is', [said('Reply with exactly: OK\nping', 'OK', 'Thanks — now the real question'), said('Reply with exactly: OK, then explain ping', '…')], [1, 1]);
}
{
  // What Claude Code writes itself as a "user" line isn't yours: it counts for time, never as your message.
  const u = (content, extra = {}) => ({ type: 'user', timestamp: t(0), cwd: '/Users/me/Dev/app', message: { content }, ...extra });
  const [s] = cc([
    u('<task-notification> <task-id>a295fbcc</task-id> <status>completed</status> </task-notification>'),
    u('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>', { isMeta: true }),
    u('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    u('<local-command-stdout>Set model to opus</local-command-stdout>'),
    u('Base directory for this skill: /Users/me/.claude/skills/x', { isMeta: true }),
    u('[Request interrupted by user]'),
    u('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
    u('<bash-input>ls</bash-input>'),
    u('Fix the retry bug'),
  ]);
  eq('claude code: only what you typed is yours — a slash command as you typed it', s.messages.map((m) => m.text), ['/model opus', '! ls', 'Fix the retry bug']);
  eq('…its own lines still count as activity', s.activityTs.length, 9);
  eq('…and never name the session', s.title, '/model opus');
}

// --- GitHub Copilot: op-log replay ------------------------------------------

const log = [
  L({ kind: 0, v: { sessionId: 's1', requests: [] } }),
  L({ kind: 2, k: ['requests'], v: [{ timestamp: 1700000000000, message: { text: 'hi' }, response: [{ value: 'Hel' }] }] }),
  L({ kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ value: 'Hello' }] }), // truncate-then-append rewrites the tail
  L({ kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized' }, { value: 'Done.' }] }),
  L({ kind: 1, k: ['requests', 0, 'result'], v: { timings: { totalElapsed: 4000 } } }),
  L({ kind: 1, k: ['customTitle'], v: 'Greeting' }),
  'not json at all',
  L({ kind: 1, k: ['__proto__', 'polluted'], v: true }), // must be ignored
  L({ kind: 1, k: ['requests', 9, 'x'], v: 1 }), // missing parent: skipped
].join('\n');
const st = replayCopilotLog(log);
eq('copilot replay: truncate-then-append rewrote the tail', st.requests[0].response.map((r) => r.value || r.kind), ['Hello', 'toolInvocationSerialized', 'Done.']);
eq('copilot replay: set applied', st.customTitle, 'Greeting');
eq('copilot replay: no prototype pollution', ({}).polluted, undefined);
eq('copilot replay: an index past the end does not pad', replayCopilotLog([
  L({ kind: 0, v: { requests: [{ response: [{ value: 'a' }] }] } }),
  L({ kind: 2, k: ['requests', 0, 'response'], i: 5, v: [{ value: 'b' }] }),
].join('\n')).requests[0].response.length, 2);
eq('detect: copilot op log', isCopilotLog(log), true);
eq('detect: a Claude Code line is not a copilot log', isCopilotLog(L({ type: 'user', timestamp: 'x', message: { content: 'hi' } })), false);
eq('detect: copilot snapshot object', isCopilotSession({ sessionId: 'x', requests: [] }), true);
eq('detect: a claude.ai export array is not', isCopilotSession([{ uuid: 'u' }]), false);

// --- GitHub Copilot: sessions -----------------------------------------------

{
  const [s] = parseCopilotFiles([{ name: 's1.jsonl', workspace: '/Users/me/Dev/app/', text: log }]);
  eq('copilot: id, source, title', [s.id, s.source, s.title], ['copilot:s1', 'copilot', 'Greeting']);
  eq('copilot: workspace gives the folder and project', [s.startDir, s.project], ['/Users/me/Dev/app', 'app']);
  eq('copilot: human then assistant, text joined across the tool call', s.messages.map((m) => [m.sender, m.text]), [['human', 'hi'], ['assistant', 'Hello\n\nDone.']]);
  eq('copilot: reply stamped at request time + totalElapsed', s.messages[1].ts - s.messages[0].ts, 4000);
}
{
  const long = parseCopilotFiles([{ name: 'l.json', text: L({ sessionId: 'l', requests: [{ timestamp: 1700000000000, message: { text: 'go' }, response: [{ value: 'ok' }], result: { timings: { totalElapsed: 20 * 60e3 } } }] }) }])[0];
  const gaps = long.activityTs.slice(1).map((v, i) => v - long.activityTs[i]);
  eq('copilot: a 20-minute agent run leaves no gap over 15 minutes', gaps.every((g) => g <= 15 * 60e3), true);
}
{
  const inl = parseCopilotFiles([{ name: 'r.json', text: L({ sessionId: 'r', requests: [{ timestamp: 1700000000000, message: { text: 'q' }, response: [
    { value: 'Updated ' }, { kind: 'inlineReference', inlineReference: { fsPath: '/p/src/A.java', path: '/p/src/A.java' } },
    { value: ' and ' }, { kind: 'inlineReference', inlineReference: { name: 'readRow', location: { uri: { path: '/p/src/B.java' } } } }, { value: '.' },
    { kind: 'codeblockUri' }, { value: ' end' }] }] }) }])[0];
  eq('copilot: inline references become paths and names in the sentence', inl.messages[1].text, 'Updated /p/src/A.java and readRow. end');
}
{
  const req = (ts, q) => ({ timestamp: ts, message: { text: q }, response: [{ value: 'a' }] });
  const snap = L({ sessionId: 'd', requests: [req(1700000000000, 'one'), req(1700000100000, 'two')] });
  const dlog = [L({ kind: 0, v: { sessionId: 'd', requests: [req(1700000000000, 'one'), req(1700000100000, 'two')] } }), L({ kind: 2, k: ['requests'], v: [req(1700000200000, 'three')] })].join('\n');
  const dd = parseCopilotFiles([{ name: 'd.json', text: snap }, { name: 'd.jsonl', text: dlog }]);
  eq('copilot: a session stored twice collapses to the fuller copy', [dd.length, dd[0].messages.filter((m) => m.sender === 'human').length], [1, 3]);
  eq('copilot: empty sessions are skipped', parseCopilotFiles([{ name: 'e.jsonl', text: L({ kind: 0, v: { sessionId: 'e', requests: [] } }) }]).length, 0);
}

// --- Cursor -----------------------------------------------------------------

{
  const cur = parseCursorData({
    composers: [
      { composerId: 'c1', name: 'Explaining the config loader', createdAt: 1767225600000, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }] },
      { composerId: 'c2', createdAt: 1767225600000, conversation: [{ type: 1, text: 'old format ask', createdAt: '2026-01-02T10:00:00Z' }, { type: 2, text: 'old reply', timingInfo: { clientStartTime: 12345, clientEndTime: 1767349260000 } }] },
      { composerId: 'c3', createdAt: 1767225600000, fullConversationHeadersOnly: [] },
    ],
    bubbles: { 'c1:b1': { type: 1, text: 'What does the config loader do?' }, 'c1:b2': { type: 2, text: 'It reads and checks the settings file.' } },
    workspaceOf: { c1: '/Users/me/Dev/demo-app' },
  });
  eq('cursor: empty composer skipped', cur.map((x) => x.id), ['cursor:c1', 'cursor:c2']);
  eq('cursor: order and senders', cur[0].messages.map((m) => [m.sender, m.text]), [['human', 'What does the config loader do?'], ['assistant', 'It reads and checks the settings file.']]);
  eq('cursor: made-up times are flagged approximate', [cur[0].approxTimes, cur[0].messages.every((m) => m.approxTs)], [true, true]);
  eq('cursor: first message at createdAt, the next one minute later', [cur[0].messages[0].ts, cur[0].messages[1].ts - cur[0].messages[0].ts], [1767225600000, 60000]);
  eq('cursor: a tool-only bubble still counts as activity', cur[0].activityTs.length, 3);
  eq('cursor: real per-message times are used (relative clocks ignored)', [cur[1].approxTimes, cur[1].messages[1].ts], [false, 1767349260000]);
  eq('cursor: workspace folder and title', [cur[0].project, cur[0].title, cur[1].project], ['demo-app', 'Explaining the config loader', null]);
}

// --- Copilot CLI ------------------------------------------------------------

{
  const ev = [
    L({ type: 'session.start', timestamp: '2026-07-01T10:00:00Z' }),
    L({ type: 'user.message', timestamp: '2026-07-01T10:00:05Z', data: { content: 'Why is the retry flaky?', source: 'user' } }),
    L({ type: 'tool.execution_start', timestamp: '2026-07-01T10:04:00Z' }),
    L({ type: 'assistant.message', timestamp: '2026-07-01T10:09:00Z', data: { content: '' } }), // tool-only turn
    L({ type: 'user.message', timestamp: '2026-07-01T10:09:30Z', data: { content: '<skill-context name="x">', source: 'skill-x' } }),
    L({ type: 'user.message', timestamp: '2026-07-01T10:09:40Z', data: { content: '', source: 'autopilot' } }),
    L({ type: 'assistant.message', timestamp: '2026-07-01T10:10:00Z', data: { content: 'Timers were real; switched to fake timers.' } }),
    'garbage line',
  ].join('\n');
  const [a] = parseCopilotCliSessions([{ id: 's1', name: 'Retry flake', cwd: '/Users/me/Dev/kit/', events: ev }]);
  eq('copilot cli: id, source, title, folder', [a.id, a.source, a.title, a.project, a.startDir], ['copilot-cli:s1', 'copilot-cli', 'Retry flake', 'kit', '/Users/me/Dev/kit']);
  eq('copilot cli: only typed messages and real replies render', a.messages.map((m) => [m.sender, m.text]), [['human', 'Why is the retry flaky?'], ['assistant', 'Timers were real; switched to fake timers.']]);
  eq('copilot cli: every event counts as activity (tools, injected, empty)', a.activityTs.length, 7);
  const [b] = parseCopilotCliSessions([{ id: 's2', cwd: null, turns: [{ user_message: 'first ask here', assistant_response: 'reply', timestamp: '2026-07-02T09:00:00Z' }] }]);
  eq('copilot cli: database-turns fallback, titled by the first ask', [b.title, b.messages.map((m) => m.sender), b.messages[1].ts - b.messages[0].ts, b.project], ['first ask here', ['human', 'assistant'], 1000, null]);
  eq('copilot cli: sessions with no text are skipped', parseCopilotCliSessions([{ id: 'e', events: L({ type: 'session.start', timestamp: '2026-07-01T10:00:00Z' }) }]).length, 0);
}

// --- Claude Cowork ----------------------------------------------------------

{
  const text = [
    L({ type: 'ai-title', aiTitle: 'Transcript title' }),
    L({ type: 'user', timestamp: '2026-07-18T08:00:00Z', cwd: '/x/outputs', message: { content: 'hi cowork' } }),
    L({ type: 'assistant', timestamp: '2026-07-18T08:01:00Z', message: { content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n');
  const cw = parseCoworkSessions([{ name: 'c1.jsonl', text, title: 'Planning the offsite' }, { name: 'c2.jsonl', text, title: 'New chat' }]);
  eq('cowork: the desktop title wins; the "New chat" placeholder falls back', cw.map((s) => s.title), ['Planning the offsite', 'Transcript title']);
  eq('cowork: source, and no folder (its cwd is a sandbox)', cw.map((s) => [s.id, s.source, s.project, s.startDir]), [['cowork:c1.jsonl', 'cowork', null, null], ['cowork:c2.jsonl', 'cowork', null, null]]);
}

ok(true, 'parse.js imports and runs in Node without a browser');
done();
