// roundtrip.test.mjs — serve.py trims Claude Code and Copilot files before
// sending them to the browser. On made-up files full of the bulk it strips
// (thinking, tool calls and output, images, edits, attachments), the trimmed
// copy must parse to exactly the same sessions as the raw file.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodeSessions, parseCopilotFiles } from '../js/parse.js';
import { eq, ok, skip, note, done } from './harness.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'bridge.py');
const L = (o) => JSON.stringify(o);
const big = (ch, n) => ch.repeat(n);

let python = true;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  python = false;
}

const dir = mkdtempSync(join(tmpdir(), 'throwbacks-test-'));
const prune = (cmd, path) => JSON.parse(execFileSync('python3', [BRIDGE, cmd, path], { encoding: 'utf8', maxBuffer: 1 << 28 })).text;

try {
  if (!python) {
    skip('trimmed files parse like the raw ones', 'python3 is not installed');
  } else {
    // --- Claude Code transcript ------------------------------------------
    const ts = (min) => new Date(Date.UTC(2026, 8, 1, 9, min)).toISOString();
    const transcript = [
      L({ type: 'summary', summary: 'Earlier summary', leafUuid: 'u0' }),
      L({ type: 'custom-title', customTitle: 'Résumé ✨ parser', sessionId: 's' }),
      L({ type: 'user', timestamp: ts(0), cwd: '/Users/me/Dev/app', sessionId: 's', uuid: 'u1', gitBranch: 'main', message: { role: 'user', content: 'Fix the parser — ünïcode 🚀' } }),
      L({ type: 'assistant', timestamp: ts(1), cwd: '/Users/me/Dev/app', requestId: 'req_1', message: { id: 'm1', model: 'claude', role: 'assistant', content: [{ type: 'thinking', thinking: big('t', 3000) }],
        usage: { input_tokens: 12, cache_creation_input_tokens: 30, cache_read_input_tokens: 4000, output_tokens: 3 } } }),
      L({ type: 'assistant', timestamp: ts(1), cwd: '/Users/me/Dev/app', requestId: 'req_1', message: { id: 'm1', model: 'claude', role: 'assistant', content: [
        { type: 'thinking', thinking: big('t', 5000), signature: 'sig' },
        { type: 'text', text: 'Looking at it.' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a', blob: big('y', 20000) } },
      ], usage: { input_tokens: 12, cache_creation_input_tokens: 30, cache_read_input_tokens: 4000, output_tokens: 90, service_tier: 'standard', server_tool_use: { web_search_requests: 0 } } } }),
      L({ type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: big('z', 50000) }] }, toolUseResult: { stdout: big('q', 30000) } }),
      L({ type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: { '/a': big('b', 20000) } } }),
      L({ type: 'assistant', timestamp: ts(3), isSidechain: true, message: { content: [{ type: 'text', text: 'subagent talk' }], usage: { output_tokens: 5 } } }),
      L({ type: 'assistant', timestamp: ts(4), message: { content: [{ type: 'text', text: 'Fixed it.' }, { type: 'image', source: { data: big('iVBOR', 10000) } }], usage: { output_tokens: 20 } } }),
      'not json',
      L({ type: 'system', timestamp: ts(5), subtype: 'compact_boundary', content: big('c', 5000) }),
      L({ type: 'ai-title', aiTitle: 'Auto name' }),
    ].join('\n');
    const ccPath = join(dir, 'session-abc.jsonl');
    writeFileSync(ccPath, transcript);
    const ccTrimmed = prune('prune-claude-code', ccPath);
    const ccRaw = parseCodeSessions([{ name: 'session-abc.jsonl', project: '-Users-me-Dev-app', text: transcript }]);
    const ccSrv = parseCodeSessions([{ name: 'session-abc.jsonl', project: '-Users-me-Dev-app', text: ccTrimmed }]);
    eq('claude code: the trimmed transcript parses to the identical session', ccSrv, ccRaw);
    eq('claude code: the user-set name and non-English text survive', [ccSrv[0].title, ccSrv[0].messages[0].text], ['Résumé ✨ parser', 'Fix the parser — ünïcode 🚀']);
    eq('claude code: a reply over two lines is still one reply after trimming', ccSrv[0].tokenEvents.map((e) => [e.o, e.k || null]), [[90, 'm1|req_1'], [5, null], [20, null]]);
    ok(ccTrimmed.length < transcript.length * 0.05, `claude code: trimming drops the bulk (${transcript.length} → ${ccTrimmed.length} chars)`);

    // --- Copilot op log (.jsonl) ------------------------------------------
    const opLog = [
      L({ kind: 0, v: {
        version: 3, sessionId: 'cp1', creationDate: 1767000000000, customTitle: 'Ünïcode ✨ chat', requesterUsername: 'me', initialLocation: 'panel',
        inputState: { attachments: [big('a', 10000)] },
        requests: [{
          requestId: 'r1', timestamp: 1767000000000, modelId: 'gpt',
          message: { text: 'Explain the retry ✨', parts: [{ text: big('p', 8000) }] },
          variableData: { variables: [{ value: big('v', 20000) }] },
          response: [{ value: 'Partial' }],
          result: { timings: { firstProgress: 100, totalElapsed: 5000 }, metadata: { toolCallRounds: [big('m', 20000)] } },
          agent: { description: big('g', 5000) },
        }],
      } }),
      L({ kind: 1, k: ['inputState', 'inputText'], v: 'typing…' }),
      L({ kind: 2, k: ['requests', 0, 'response'], i: 0, v: [
        { value: 'Rewritten answer about ' },
        { kind: 'inlineReference', inlineReference: { name: 'readRow', location: { uri: { path: '/p/B.java', scheme: 'file' }, range: { startLineNumber: 3 } } } },
        { value: ' — done.' },
        { kind: 'toolInvocationSerialized', invocationMessage: { value: big('x', 10000) }, resultDetails: { output: big('o', 10000) } },
        { kind: 'textEditGroup', edits: [[{ text: big('e', 10000) }]] },
        { value: 'After the edit.' },
      ] }),
      L({ kind: 1, k: ['requests', 0, 'response', 1, 'resultDetails'], v: { output: big('r', 10000) } }),
      L({ kind: 1, k: ['requests', 0, 'result'], v: { timings: { totalElapsed: 6000 }, metadata: { rounds: big('d', 10000) } } }),
      L({ kind: 2, k: ['requests'], v: [{ requestId: 'r2', timestamp: 1767000600000, message: { text: 'Second ask' }, response: [{ kind: 'markdownContent', content: { value: 'Second reply', isTrusted: true } }] }] }),
      L({ kind: 1, k: ['customTitle'], v: 'Explaining retries ✨' }),
      'garbage line',
    ].join('\n');
    const logPath = join(dir, 'cp1.jsonl');
    writeFileSync(logPath, opLog);
    const logTrimmed = prune('prune-copilot', logPath);
    const logRaw = parseCopilotFiles([{ name: 'cp1.jsonl', workspace: '/Users/me/Dev/kit', text: opLog }]);
    const logSrv = parseCopilotFiles([{ name: 'cp1.jsonl', workspace: '/Users/me/Dev/kit', text: logTrimmed }]);
    eq('copilot log: the trimmed log replays to the identical session', logSrv, logRaw);
    eq('copilot log: rewrites, in-sentence references, a paragraph break at the tool call, later requests',
      logSrv[0].messages.map((m) => m.text),
      ['Explain the retry ✨', 'Rewritten answer about readRow — done.\n\nAfter the edit.', 'Second ask', 'Second reply']);
    ok(logTrimmed.length < opLog.length * 0.1, `copilot log: trimming drops the bulk (${opLog.length} → ${logTrimmed.length} chars)`);

    // --- Copilot snapshot (.json) -----------------------------------------
    const snapshot = L({
      version: 3, sessionId: 'cp2', customTitle: 'Snapshot chat', inputState: { attachments: [big('a', 5000)] },
      requests: [{ requestId: 'q1', timestamp: 1767100000000, message: { text: 'Snapshot ask', parts: [big('p', 5000)] },
        response: [{ value: 'Snapshot reply ' }, { kind: 'codeblockUri', uri: { path: '/x' } }, { kind: 'toolInvocationSerialized', resultDetails: big('t', 8000) }, { value: 'end.' }],
        result: { timings: { totalElapsed: 2500 }, metadata: big('m', 8000) } }],
    });
    const snapPath = join(dir, 'cp2.json');
    writeFileSync(snapPath, snapshot);
    const snapTrimmed = prune('prune-copilot', snapPath);
    eq('copilot snapshot: the trimmed snapshot parses to the identical session',
      parseCopilotFiles([{ name: 'cp2.json', workspace: null, text: snapTrimmed }]),
      parseCopilotFiles([{ name: 'cp2.json', workspace: null, text: snapshot }]));
    note(`made-up files written to ${dir} and removed afterwards`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
