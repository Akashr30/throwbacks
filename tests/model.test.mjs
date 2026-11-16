// model.test.mjs — the in-memory model on the built-in sample data (every
// source mixed together), plus the summarizer's orchestration and the
// path/URL detector.

import { parseExport, parseCodeSessions, parseCopilotFiles, parseCursorData } from '../js/parse.js';
import { buildModel } from '../js/model.js';
import { fmtTokens } from '../js/util.js';
import { sampleData } from '../js/sample.js';
import { summarizeRange } from '../js/summarize.js';
import { detectTokens } from '../js/linkify.js';
import { eq, ok, done } from './harness.mjs';

const { conversations, codeFiles, copilotFiles, cursorData } = sampleData();
const web = parseExport(conversations);
const code = parseCodeSessions(codeFiles);
const cop = parseCopilotFiles(copilotFiles);
const cur = parseCursorData(cursorData);

eq('sample: copilot session parses', cop.map((s) => [s.title, s.project, s.messages.length]), [['Jest timeouts in retry tests', 'fetch-kit', 4]]);
eq('sample: copilot streamed rewrite applied (no stale tail)', cop[0].messages[1].text.startsWith('The backoff waits on real timers'), true);
eq('sample: copilot inline reference became a full path', cop[0].messages[1].text.includes('/Users/dev/projects/fetch-kit/test/retry.test.js'), true);
eq('sample: cursor session parses, times flagged approximate', cur.map((s) => [s.title, s.project, s.messages.length, s.approxTimes]), [['Refactor TOML config parser', 'config-loader', 4, true]]);

const m = buildModel([...web, ...code, ...cop, ...cur]);
eq('model: every source is in the stats', m.sourceStats.map((s) => s.label).sort(), ['Code', 'Copilot', 'Cursor', 'Web']);
eq('model: projects span all tools', m.projects, ['config-loader', 'fetch-kit']);
const fk = m.dirTree.roots[0].children.find((c) => c.name === 'fetch-kit');
eq('model: one folder holds Claude Code and Copilot sessions', fk.sessions.map((id) => m.getSession(id).source).sort(), ['code', 'copilot']);
eq('model: folder tree root', m.dirTree.roots[0].name, 'Users/dev/projects');
eq('model: approximate times survive on the session', m.getSession('cursor:sample-cursor-1').approxTimes, true);
eq('model: approximate times survive on each message', m.getSession('cursor:sample-cursor-1').messages.every((x) => x.approxTs), true);
eq('model: a Copilot agent run counts toward active time', m.getSession('copilot:sample-copilot-1').totalMs > 3 * 60e3, true);
eq('model: search finds text from any tool', m.search('useFakeTimers').length > 0, true);
eq('model: project filter includes other tools', m.listSessions('config-loader').map((s) => s.source).sort(), ['code', 'cursor']);
eq('model: project filter shown when folders exist', m.hasCodeSessions, true);
eq('model: primary topics partition the sessions exactly', m.primaryTagStats.reduce((t, s) => t + s.sessions.length, 0), m.sessionCount);
eq('model: day totals are the sum of per-day unions (never double counted)', m.totalActiveMs, m.listDays().reduce((t, d) => t + d.totalMs, 0));
{
  // Two chats in one folder at the same hour: the folder's ≈time counts that hour once.
  const at = (min) => new Date(Date.UTC(2026, 8, 1, 10, min)).toISOString();
  const chat = (name, from) => ({ name, project: '-Users-me-Dev-app', text: [0, 10, 20].map((min, i) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', timestamp: at(from + min), cwd: '/Users/me/Dev/app', message: { content: `step ${i}` } })).join('\n') });
  const pm = buildModel(parseCodeSessions([chat('a.jsonl', 0), chat('b.jsonl', 5)]));
  const app = pm.projectStats.find((p) => p.label === 'app');
  eq('model: a folder\'s ≈time in Insights is its chats\' union, parallel ones counted once', app.ms, pm.totalActiveMs);
  ok(app.ms < pm.listSessions().reduce((t, x) => t + x.totalMs, 0), '…less than the chats\' times added up');
}
{
  // A branched or resumed chat repeats the replies it came from: Insights counts each reply's tokens once.
  const at = (min) => new Date(Date.UTC(2026, 8, 1, 10, min)).toISOString();
  const reply = (id, min, out) => JSON.stringify({ type: 'assistant', timestamp: at(min), requestId: `req_${id}`, message: { id: `msg_${id}`, content: 'ok', usage: { input_tokens: 100, output_tokens: out } } });
  const first = { name: 'a.jsonl', project: 'p', text: [reply(1, 0, 10), reply(2, 1, 20)].join('\n') };
  const branch = { name: 'b.jsonl', project: 'p', text: [reply(1, 0, 10), reply(2, 1, 20), reply(3, 5, 30)].join('\n') };
  const tm = buildModel(parseCodeSessions([first, branch]));
  eq('model: a reply copied into a branched chat counts once in the token totals', [tm.totalTokens, tm.tokenByDay.get('2026-09-01').o], [360, 60]);
  // Every kind counts, as Claude Code's own stats count them: input, cache writes, cache reads, output.
  const cached = JSON.stringify({ type: 'assistant', timestamp: at(9), requestId: 'req_c', message: { id: 'msg_c', content: 'ok',
    usage: { input_tokens: 3, cache_creation_input_tokens: 20, cache_read_input_tokens: 5000, output_tokens: 7 } } });
  const cm = buildModel(parseCodeSessions([{ name: 'c.jsonl', project: 'p', text: cached }]));
  const day = cm.tokenByDay.get('2026-09-01');
  eq('model: tokens are all four kinds, cache reads included, with the split kept', [cm.totalTokens, day.total, day.cr, day.cw, day.i - day.cw, day.o, cm.listSessions()[0].tokens.total],
    [5030, 5030, 5000, 20, 3, 7, 5030]);
  eq('tokens read as people say them, billions included', [999, 12345, 2.5e6, 383.6e6, 9.53e9, 15.99e9].map(fmtTokens), ['999', '12k', '2.5M', '384M', '9.5B', '16B']);
}

// Summarizer orchestration, with a fake provider (no network).
const fake = { perCallTokens: 5500, delayMs: 0, chat: async (_k, _m, _s, user) => (user.startsWith('These are') ? 'recap' : '@@S1\n- b') };
const r = await summarizeRange({ items: [{ id: 'a', title: 'A', when: 'd', text: 'x' }], provider: 'groq', key: 'k', rangeLabel: 'T', adapter: fake, sleep: async () => {} });
eq('summarizer: per-session bullets, then the overall recap', [r.recap, r.perSession[0].bullets], ['recap', ['b']]);

// The path/URL detector stays conservative.
eq('linkify: "and/or" is not a path, docs/Foo.md is', detectTokens('and/or docs/Foo.md').filter((x) => x.type !== 'text').map((x) => x.value), ['docs/Foo.md']);
ok(detectTokens('see https://example.com/a?b=1 now').some((x) => x.type === 'url' && x.value === 'https://example.com/a?b=1'), 'linkify: URLs are detected without trailing words');

done();
