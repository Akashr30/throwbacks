// summarize.test.mjs — the Daily log's AI flows against a stand-in provider
// (no network): reading the model's answer, sending each chat's new part
// with its earlier lines, packing chats into few calls, and keeping what
// finished when a run is cancelled or the provider fails; and the tokens a
// provider says each call used, added up across a run.

import { parseLogOutput, summarizeDayLog, summarizeWeekLog, usageOf, addUsage, tokensIn, addSpent, recapChunks, recapCalls, PROVIDERS, dayLog } from '../js/summarize.js';
import { eq, ok, done } from './harness.mjs';

// Reading the answer
const parsed = parseLogOutput('@@S1\n- Added retries\n* Capped total time\n@@S2\nNONE\n@@S3\n1. Moved config to TOML\n2) Kept JSON working', 3);
eq('bullets of any kind become lines', parsed.get(1), ['Added retries', 'Capped total time']);
eq('NONE means "nothing new" — an answer, not a failure', parsed.get(2), []);
eq('numbered lines are read too', parsed.get(3), ['Moved config to TOML', 'Kept JSON working']);
ok(!parseLogOutput('@@S1\n- a', 2).has(2), 'a chat the model left out is missing (so it gets retried)');
ok(!parseLogOutput('@@S7\n- a', 2).has(7), 'sections that don\'t exist are ignored');

/** A stand-in provider that records prompts and answers from a script. */
function fakeAdapter(answer, perCallTokens = 12000) {
  const calls = [];
  return {
    calls,
    adapter: {
      perCallTokens,
      delayMs: 0,
      async chat(key, model, system, user) {
        calls.push({ system, user });
        return answer(user, calls.length);
      },
    },
  };
}
const sleep = async () => {};
const part = (id, text, earlier = []) => ({ id, title: `Chat ${id}`, project: 'proj', text, earlier });
const echo = (user) => [...user.matchAll(/^@@S(\d+) Chat (\w+)/gm)].map(([, n, id]) => `@@S${n}\n- did ${id}`).join('\n');

{
  const { adapter, calls } = fakeAdapter(echo);
  const progress = [];
  const out = await summarizeDayLog({
    parts: [part('a', 'User: hi'), part('b', 'User: more', ['did a thing earlier'])],
    dateLabel: 'Mon, 5 Oct 2026', adapter, sleep, onProgress: (d, t) => progress.push(`${d}/${t}`),
  });
  eq('small chats share one call', calls.length, 1);
  eq('each chat gets its lines', [out.results.get('a'), out.results.get('b')], [['did a'], ['did b']]);
  ok(calls[0].user.includes('Already written:\n- did a thing earlier') && calls[0].user.includes('New part of the conversation'),
    'a chat summarized before is sent with its earlier lines, as new');
  ok(calls[0].user.includes('Mon, 5 Oct 2026') && /never repeat/.test(calls[0].user), 'the prompt names the day and forbids repeating');
  ok(/work log/i.test(calls[0].system), 'the work-log instructions are the system prompt');
  eq('progress counts chats', progress, ['0/2', '1/2', '2/2']);
}

{
  const big = 'x'.repeat(30000);
  const { adapter, calls } = fakeAdapter(echo, 12000);
  await summarizeDayLog({ parts: [part('a', big), part('b', big), part('c', 'User: small')], dateLabel: 'd', adapter, sleep });
  ok(calls.length >= 2 && calls.every((c) => c.user.length < 12000 * 4 + 2000), 'long chats are split across calls and shortened to fit');
}

{
  // the model skips chat 2 in the shared call; it gets a call of its own
  const { adapter, calls } = fakeAdapter((user, n) => (n === 1 ? '@@S1\n- did a' : '@@S1\n- did b'));
  const out = await summarizeDayLog({ parts: [part('a', 'x'), part('b', 'y')], dateLabel: 'd', adapter, sleep });
  eq('a skipped chat is retried alone', [calls.length, out.results.get('b')], [2, ['did b']]);
}

{
  // the provider fails on the second call: what finished is kept
  const { adapter } = fakeAdapter((user, n) => {
    if (n === 2) { const e = new Error('invalid key'); e.status = 401; throw e; }
    return echo(user);
  }, 1200);
  const out = await summarizeDayLog({ parts: [part('a', 'x'.repeat(3000)), part('b', 'y'.repeat(3000))], dateLabel: 'd', adapter, sleep });
  eq('a hard error stops the run but keeps finished chats', [out.results.has('a'), out.results.has('b')], [true, false]);
  ok(out.errors.length === 1 && out.errors[0].includes('invalid key'), '…and says what went wrong');
}

{
  // cancelling mid-run hands back what's done
  const controller = new AbortController();
  const { adapter } = fakeAdapter((user, n) => {
    if (n === 1) { setTimeout(() => controller.abort(), 0); return echo(user); }
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }, 1200);
  let caught = null;
  try {
    await summarizeDayLog({ parts: [part('a', 'x'.repeat(3000)), part('b', 'y'.repeat(3000))], dateLabel: 'd', adapter, sleep: () => new Promise((r) => setTimeout(r, 5)), signal: controller.signal });
  } catch (e) {
    caught = e;
  }
  ok(caught && caught.cancelled && caught.partial.has('a') && !caught.partial.has('b'), 'cancelling keeps the chats already done');
}

{
  const { adapter, calls } = fakeAdapter(() => '  Shipped retries; Jest fixed.  ');
  const text = await summarizeWeekLog({
    weekLabel: 'the week of 28 Sept 2026',
    days: [{ label: 'Mon, 28 Sept', lines: ['Added retries'] }, { label: 'Tue, 29 Sept', lines: ['Fixed Jest'] }],
    adapter, sleep,
  });
  eq('the week summary is one call over the days\' lines', [calls.length, text], [1, 'Shipped retries; Jest fixed.']);
  ok(calls[0].user.includes('Mon, 28 Sept:\n- Added retries') && calls[0].user.includes('## <project>') && calls[0].user.includes('## Still open'),
    '…day by day, asking for a line, then each project\'s points, then what\'s still open');
}
{
  // Each day's lines under their project, so the recap can group by it.
  const log = dayLog([{ label: 'Mon, 28 Sept', lines: ['a', 'b', 'c', 'e'], groups: [{ project: 'etl', lines: ['a', 'b'] }, { project: '', lines: ['c'] }, { project: null, lines: ['e'] }] },
    { label: 'Tue, 29 Sept', lines: ['d'] }]);
  eq('the day log: each day\'s lines under their project (none, or not known); a day saved without them, as before', log,
    'Mon, 28 Sept:\n[etl]\n- a\n- b\n[No folder]\n- c\n[Folder not known]\n- e\n\nTue, 29 Sept:\n- d');
}

{
  // A month's or a period's recap names its period, not "the week".
  const { adapter, calls } = fakeAdapter(() => 'A busy month.');
  await summarizeWeekLog({ weekLabel: 'October 2026', kind: 'month', days: [{ label: 'Thu, 1 Oct', lines: ['x'] }], adapter, sleep });
  await summarizeWeekLog({ weekLabel: '2 Oct – 14 Oct', kind: 'period', days: [{ label: 'Fri, 2 Oct', lines: ['y'] }], adapter, sleep });
  ok(calls[0].user.includes('the month\'s update') && calls[1].user.includes('the period\'s update') && !calls[0].user.includes('week'), 'a month\'s and a period\'s recap name their period');
}

{
  // A recap too long for one call (a month, a long period): a stretch of days at a time, then one recap of
  // those — never its middle days cut out.
  const days = Array.from({ length: 30 }, (_, i) => ({ label: `Day ${i + 1}`, lines: Array.from({ length: 12 }, (_, j) => `Line ${j} of day ${i + 1}: a made-up task, long enough to count.`) }));
  const { adapter, calls } = fakeAdapter((user, n) => `Recap ${n}.`, 5500);
  const chunks = recapChunks(days, 5500);
  const text = await summarizeWeekLog({ weekLabel: 'October 2026', kind: 'month', days, adapter, sleep });
  ok(chunks.length > 1 && chunks.flat().length === 30, 'a long log is split into stretches of whole days, every day in one');
  eq('…a call per stretch, then the recap of them', [calls.length, recapCalls(days, 5500), text], [chunks.length + 1, chunks.length + 1, `Recap ${chunks.length + 1}.`]);
  ok(calls.slice(0, -1).every((c) => !c.user.includes('middle truncated')) && calls.at(-1).user.includes('Recap 1.') && calls.at(-1).user.includes('the month\'s update'),
    '…no stretch is cut, and the last call writes the month\'s update from theirs');
  ok(calls.some((c) => c.user.includes('Line 0 of day 15:')), '…the middle days are read');
  eq('a short one is one call', recapCalls(days.slice(0, 2), 5500), 1);
}

{
  // So long that even the stretches' updates don't fit one call (a small-context provider, a long period):
  // they're combined a group at a time first, so the last call still reads every stretch, nothing cut.
  const days = Array.from({ length: 180 }, (_, i) => ({ label: `Day ${i + 1}`, lines: Array.from({ length: 80 }, (_, j) => `Line ${j} of day ${i + 1}: a made-up task.`) }));
  const { adapter, calls } = fakeAdapter((user, n) => (/Combine them/.test(user) ? `Combined ${n}.` : /stretch's update/.test(user) ? `Stretch ${n}: ${'x'.repeat(1500)}` : 'The period.'), 5500);
  const text = await summarizeWeekLog({ weekLabel: 'half a year', kind: 'period', days, adapter, sleep });
  const combined = calls.filter((c) => /Combine them/.test(c.user));
  eq('…grouped again: every stretch combined, then the recap', [text, combined.length > 0, calls.filter((c) => /stretch's update/.test(c.user)).length], ['The period.', true, recapChunks(days, 5500).length]);
  ok(!calls.at(-1).user.includes('middle truncated') && combined.every((c) => !c.user.includes('middle truncated')), '…and nothing is cut out of what they read');
  ok(Math.abs(recapCalls(days, 5500) - calls.length) <= Math.max(3, calls.length / 5), `…the plan's count is about right (${recapCalls(days, 5500)} for ${calls.length})`);
}

// Gemini: its prompt count includes the cached part, and a thinking model's thoughts are output
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 200 } }) });
  try {
    const reply = await PROVIDERS.gemini.chat('k', 'm', 's', 'u');
    eq('Gemini: cached tokens once, thoughts as output', reply.usage, { input: 400, output: 250, cacheRead: 600 });
  } finally {
    globalThis.fetch = real;
  }
}

// Tokens by month: each run counts in the month it ran
eq('tokens by month: a run adds to its month, the others stay', addSpent(addSpent(null, { input: 900, output: 100 }, '2026-10'), { input: 40, cacheRead: 50, output: 10 }, '2026-11'),
  { '2026-10': 1000, '2026-11': 100 });
eq('…a run that said nothing changes nothing', [addSpent({ '2026-10': 5 }, null, '2026-11'), addSpent(null, null, '2026-11')], [{ '2026-10': 5 }, null]);

// Tokens: a reply may say what it used; each call's adds up, plain numbers only
eq('usage: plain non-negative numbers only, null when nothing', [usageOf({ input: 12.4, output: -1, cacheRead: 'x', cacheWrite: NaN }), usageOf({}), usageOf(null)], [{ input: 12 }, null, null]);
eq('…added up with the calls they cover', addUsage(addUsage(null, { input: 100, output: 5 }), { input: 50, cacheRead: 900 }), { calls: 2, input: 150, output: 5, cacheRead: 900 });
eq('…a saved total plus a run', addUsage({ input: 1, calls: 3 }, { input: 2, calls: 2 }), { input: 3, calls: 5 });
eq('tokens in: new, cache writes and cache reads', [tokensIn({ input: 10, cacheWrite: 5, cacheRead: 100, output: 7 }), tokensIn(null)], [115, 0]);
{
  let seen = null;
  const { adapter } = fakeAdapter((user, n) => ({ text: `@@S1\n- line ${n}`, usage: { input: 1000 * n, output: 20 } }));
  const out = await summarizeDayLog({ parts: [part('a', 'User: x')], dateLabel: 'd', adapter, sleep, onUsage: (u) => { seen = addUsage(seen, u); } });
  eq('a reply with its usage: the text is used, the usage reported', [out.results.get('a'), seen], [['line 1'], { calls: 1, input: 1000, output: 20 }]);
}

done();
