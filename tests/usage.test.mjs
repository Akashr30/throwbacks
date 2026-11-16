// usage.test.mjs — the usage meter's numbers as the app shows them: from
// serve.py's /api/usage answer to the plan rings, the plan menus and the
// Settings card. Two sources: the live reading (Claude Code's own /usage
// numbers, per-model limits such as Fable included) and the status line's
// file as the backup — including a window that has reset since its reading,
// a login whose Claude Code reports no plan usage, and a live reading that
// failed (as a sentence for the plan menus, and short for Settings' rows).
// Made-up numbers only.

import { readUsage, planUsage, liveProblem, liveShort, loginNeeded, problemCodes, plansKnown, sourceLabel, ASK_DEFAULTS } from '../js/usage.js';
import { planPct } from '../js/plans.js';
import { eq, ok, done } from './harness.mjs';

const NOW = Date.UTC(2026, 9, 6, 10, 0);
const s = (ms) => Math.floor(ms / 1000);
const snippet = { statusLine: { type: 'command', command: 'python3 /x/statusline.py' } };

const none = readUsage(null, NOW);
eq('no server: unavailable, nothing to show', [none.available, none.claude, none.source, none.live.enabled], [false, null, null, false]);

const off = readUsage({ reading: null, configured: false, ours: false, snippet }, NOW);
eq('not set up', [off.available, off.setup, off.data, off.claude, off.live.enabled], [true, 'off', 'none', null, false]);
eq('…with the line to add', off.snippet, snippet);
eq('another status line is set', readUsage({ reading: null, configured: true, ours: false, command: 'ccline' }, NOW).setup, 'other');
eq('ours, waiting for a first reply', [readUsage({ reading: { seen_at: s(NOW) }, configured: true, ours: true }, NOW).setup,
  readUsage({ reading: { seen_at: s(NOW) }, configured: true, ours: true }, NOW).data], ['on', 'none']);

// ---- The status line (the backup) ----
const reading = {
  at: s(NOW - 4 * 60e3),
  five_hour: { used_percentage: 41.6, resets_at: s(NOW + 2 * 3600e3) },
  seven_day: { used_percentage: 31.2, resets_at: s(NOW + 5 * 864e5) },
};
const okU = readUsage({ reading, configured: true, ours: true }, NOW);
eq('status line: data ok, set up, its source named', [okU.data, okU.setup, okU.source], ['ok', 'on', 'statusline']);
eq('both windows, rounded, reset times in ms', okU.claude.windows.map((w) => [w.id, w.label, w.detail, w.pct, w.resetsAt]),
  [['session', 'Session', '5-hour limit', 42, NOW + 2 * 3600e3], ['week', 'Week', 'all models', 31, NOW + 5 * 864e5]]);
eq('when it was read', okU.claude.asOf, NOW - 4 * 60e3);
eq('the rings get the Claude plan only', Object.keys(planUsage(okU)), ['claude']);
eq('nothing known, no rings', planUsage(off), {});

const later = readUsage({ reading, configured: true, ours: true }, NOW + 3 * 3600e3);
eq('a window past its reset is set aside', [later.claude.windows.map((w) => w.id), later.claude.expired.map((w) => w.id)], [['week'], ['session']]);

const missing = readUsage({ reading: { missing_at: s(NOW), seen_at: s(NOW) }, configured: true, ours: true }, NOW);
eq('Claude Code replied but reported no plan usage', missing.data, 'missing');
const recovered = readUsage({ reading: { ...reading, missing_at: s(NOW - 3600e3) }, configured: true, ours: true }, NOW);
eq('numbers newer than the "missing" note win', recovered.data, 'ok');

const junk = readUsage({ reading: { five_hour: { used_percentage: '40', resets_at: 'soon' } }, configured: false }, NOW);
ok(junk.claude === null && junk.data === 'none', 'values that aren\'t numbers are ignored');

// ---- Live: Claude Code's own /usage numbers ----
const liveReading = {
  at: s(NOW - 60e3),
  plan: 'team',
  windows: [
    { kind: 'session', group: 'session', pct: 12, resets_at: s(NOW + 3600e3) },
    { kind: 'weekly_all', group: 'weekly', pct: 48, resets_at: s(NOW + 2 * 864e5) },
    { kind: 'weekly_scoped', group: 'weekly', name: 'Fable', pct: 39.4, resets_at: s(NOW + 2 * 864e5) },
  ],
};
const liveU = readUsage({ reading, configured: true, ours: true, live: { enabled: true, reading: liveReading } }, NOW);
eq('live numbers win over the status line', [liveU.source, liveU.data, liveU.claude.asOf], ['live', 'ok', NOW - 60e3]);
eq('every limit, the per-model one named', liveU.claude.windows.map((w) => [w.id, w.label, w.detail, w.pct]), [
  ['session', 'Session', '5-hour limit', 12],
  ['week', 'Week', 'all models', 48],
  ['weekly_scoped:fable', 'Week · Fable', 'Fable only', 39],
]);
eq('the ring shows the fullest limit', planPct(planUsage(liveU).claude), 48);
eq('a live reading has no problem to report', liveProblem(liveU), null);

const scopedFull = readUsage({ live: { enabled: true, reading: { ...liveReading, windows: [
  { kind: 'session', pct: 20, resets_at: s(NOW + 3600e3) }, { kind: 'weekly_scoped', group: 'weekly', name: 'Fable', pct: 91, resets_at: s(NOW + 864e5) },
] } } }, NOW);
eq('…even when that is the Fable-only one', planPct(planUsage(scopedFull).claude), 91);

const odd = readUsage({ live: { enabled: true, reading: { at: s(NOW), windows: [
  { kind: 'monthly_spend', pct: 5, resets_at: null },
  { kind: 'weekly_scoped', group: 'weekly', name: 'Cowork', pct: 3 },
  { kind: 'session', pct: '12' },
  null,
] } } }, NOW);
eq('limits it doesn\'t know get a plain label; junk is dropped', odd.claude.windows.map((w) => [w.label, w.detail, w.resetsAt]),
  [['Limit', 'monthly spend', null], ['Week · Cowork', 'Cowork only', null]]);

const liveLater = readUsage({ live: { enabled: true, reading: liveReading } }, NOW + 2 * 3600e3);
eq('a live window past its reset is set aside too', liveLater.claude.expired.map((w) => w.id), ['session']);

// ---- Live readings that failed ----
const failed = (error, extra = {}) => readUsage({ reading, configured: true, ours: true,
  live: { enabled: true, reading: { at: s(NOW), error, ...extra } } }, NOW);
const noPlan = failed('no_plan');
eq('a failed live reading falls back to the status line', [noPlan.source, noPlan.live.error], ['statusline', 'no_plan']);
ok(/claude auth login/.test(liveProblem(noPlan)), 'logged out: says how to log in');
ok(/isn’t installed/.test(liveProblem(failed('no_cli'))), 'no Claude Code: says so');
ok(/essential traffic only/.test(liveProblem(failed('essential_only'))), 'essential-traffic-only mode: names the setting');
ok(/It said: boom/.test(liveProblem(failed('cli_error', { detail: 'boom' }))), 'an error from Claude Code: passes on what it said');
ok(liveProblem(failed('something_new')).length > 0, 'an unknown error still reads as a sentence');
eq('live off (no --claude): no problem reported', liveProblem(readUsage({ reading, live: { enabled: false, reading: null } }, NOW)), null);
const nothing = readUsage({ reading: null, live: { enabled: true, reading: { at: s(NOW), error: 'unavailable' } } }, NOW);
eq('failed with no backup: nothing to show', [nothing.claude, nothing.source, nothing.data], [null, null, 'none']);

// ---- The other plans: Copilot, ChatGPT (Codex), Google AI (Antigravity), Cursor ----
const H = s(NOW + 3600e3);
const W = s(NOW + 2 * 864e5);
const plans = {
  copilot: { found: true, enabled: true, reading: { at: s(NOW - 30e3), pooled: false, unlimited: ['chat'], windows: [
    { kind: 'premium', pct: 100, resets_at: W, limit: 3000, used: 3000, unit: 'credits', overage: 739.5 }] } },
  chatgpt: { found: true, enabled: false, reading: null, local: { at: s(NOW - 600e3), plan: 'plus', windows: [
    { kind: 'session', group: 'session', pct: 12.5, resets_at: H },
    { kind: 'weekly_all', group: 'weekly', pct: 48, resets_at: W },
    { kind: 'session_scoped', group: 'session', name: 'GPT-5.3-Codex-Spark', pct: 3, resets_at: H }] } },
  google: { found: true, enabled: true, reading: { at: s(NOW), windows: [
    { kind: 'weekly_scoped', group: 'weekly', name: 'Gemini', pct: 40, resets_at: W },
    { kind: 'session_scoped', group: 'session', name: 'Claude & GPT', pct: 24.5, resets_at: H }] } },
  cursor: { found: true, plan: 'pro_plus', seenAt: s(NOW - 864e5) },
};
const all = readUsage({ reading: null, live: { enabled: true, reading: null }, plans }, NOW);
eq('Copilot: AI credits over the allowance', all.plans.copilot.usage.windows.map((w) => [w.label, w.detail, w.pct]),
  [['AI credits', '3,000 of 3,000 credits · 739.5 over', 100]]);
eq('Codex without asking: its session files, labelled so', [all.plans.chatgpt.source, sourceLabel(all, 'chatgpt'), all.plans.chatgpt.usage.asOf],
  ['local', 'From your Codex sessions', NOW - 600e3]);
eq('…its 5-hour, weekly and per-model limits', all.plans.chatgpt.usage.windows.map((w) => [w.label, w.detail]),
  [['Session', '5-hour limit'], ['Week', 'all models'], ['Session · GPT-5.3-Codex-Spark', '5-hour limit']]);
eq('Antigravity: a 5-hour and a weekly limit per model group', all.plans.google.usage.windows.map((w) => [w.label, w.detail, w.pct]),
  [['Week · Gemini', 'Gemini only', 40], ['Session · Claude & GPT', '5-hour limit', 25]]);
eq('Cursor: just its plan name', [all.plans.cursor.plan, all.plans.cursor.seenAt], ['Pro+', NOW - 864e5]);
eq('rings for every plan with numbers', Object.keys(planUsage(all)).sort(), ['chatgpt', 'copilot', 'google']);
eq('…and Cursor shows too, for its plan', Object.keys(plansKnown(all)).sort(), ['chatgpt', 'copilot', 'cursor', 'google']);
eq('the rings follow each plan\'s fullest limit', ['copilot', 'chatgpt', 'google'].map((id) => planPct(planUsage(all)[id])), [100, 48, 40]);

const liveCodex = readUsage({ plans: { chatgpt: { ...plans.chatgpt, enabled: true, reading: { at: s(NOW), plan: 'plus', windows: [
  { kind: 'session', group: 'session', pct: 20, resets_at: H }] } } } }, NOW);
eq('asking Codex beats its session files', [liveCodex.plans.chatgpt.source, sourceLabel(liveCodex, 'chatgpt'), liveCodex.plans.chatgpt.usage.windows[0].pct],
  ['live', 'From Codex', 20]);

const pooled = readUsage({ plans: { copilot: { found: true, enabled: true, reading: { at: s(NOW), windows: [], pooled: true, unlimited: [] } } } }, NOW);
eq('Copilot pooled by the organisation: no ring, but the plan shows', [planUsage(pooled).copilot, plansKnown(pooled).copilot, pooled.plans.copilot.pooled],
  [undefined, true, true]);

const plain = readUsage({ plans: { copilot: { found: true, enabled: true, reading: { at: s(NOW), windows: [
  { kind: 'premium', pct: 41.3, resets_at: W, limit: 300, used: 124 }] } } } }, NOW);
eq('Copilot in requests, when the CLI doesn\'t say', plain.plans.copilot.usage.windows.map((w) => [w.label, w.detail, w.pct]), [['Premium', '124 of 300', 41]]);

const fail = (id, error, enabled = true) => readUsage({ ask: { [id]: true }, plans: { [id]: { found: true, enabled, reading: { at: s(NOW), error } } } }, NOW);
ok(/copilot login/.test(liveProblem(fail('copilot', 'no_login'), 'copilot')), 'Copilot logged out: says how to log in');
ok(/API key/.test(liveProblem(fail('chatgpt', 'no_plan'), 'chatgpt')), 'Codex on an API key: says why there are no limits');
ok(/stopped asking/.test(liveProblem(fail('google', 'not_local'), 'google')), 'agy answering through the model: says it stopped asking');
ok(/older than 1\.1\.11/.test(liveProblem(fail('google', 'unsupported'), 'google')), 'an old agy: says why it is never asked');
eq('not asked (no --claude): no problem reported', liveProblem(fail('copilot', 'no_login', false), 'copilot'), null);
// Settings' rows: the same problems, short — a few words and the one thing to do
const codes = problemCodes();
eq('every problem has its short wording, and nothing else does', Object.values(codes).map((c) => [...c.long].sort().join() === [...c.short].sort().join()), [true, true, true, true]);
eq('short: logged out (or on an API key), and how to log in', liveShort(noPlan), { text: 'Not logged in to a Claude plan', fix: 'Run `claude auth login` in Terminal — an API key has no plan limits.' });
eq('…Copilot and Codex', [liveShort(fail('copilot', 'no_login'), 'copilot').text, liveShort(fail('chatgpt', 'no_plan'), 'chatgpt').fix], ['Not logged in', 'Codex uses an API key or isn’t signed in: run `codex login` in Terminal.']);
eq('…what the tool said, when it said something', liveShort(failed('cli_error', { detail: 'boom' })), { text: 'Couldn’t report usage', fix: 'It said: boom' });
ok(liveShort(failed('something_new')).text.length > 0, '…an unknown error still says something');
eq('…and nothing whenever the sentence says nothing', [liveShort(liveU), liveShort(fail('copilot', 'no_login', false), 'copilot')], [null, null]);

eq('the tools asked until you change it: the two approved', ASK_DEFAULTS, { claude: true, copilot: true, chatgpt: false, google: false });
eq('junk plans are ignored', Object.keys(readUsage({ plans: { copilot: 'x', cursor: { found: false }, nope: {} } }, NOW).plans), []);

// ---- After the review: newer Codex numbers win, answered-without-limits, Cursor signed out, the switches ----
const both = readUsage({ plans: { chatgpt: { found: true, cli: true, enabled: true,
  reading: { at: s(NOW - 3600e3), windows: [{ kind: 'session', pct: 5, resets_at: H }] },
  local: { at: s(NOW - 60e3), windows: [{ kind: 'session', pct: 30, resets_at: H }] } } } }, NOW);
eq('Codex: its newer session files beat an older live answer', [both.plans.chatgpt.source, both.plans.chatgpt.usage.windows[0].pct], ['local', 30]);
const freshLive = readUsage({ plans: { chatgpt: { found: true, cli: true, enabled: true,
  reading: { at: s(NOW), windows: [{ kind: 'session', pct: 9, resets_at: H }] },
  local: { at: s(NOW - 60e3), windows: [{ kind: 'session', pct: 30, resets_at: H }] } } } }, NOW);
eq('…and a newer live answer beats the files', freshLive.plans.chatgpt.source, 'live');

const unlimitedOnly = readUsage({ plans: { copilot: { found: true, enabled: true, reading: { at: s(NOW), windows: [], pooled: false, unlimited: ['premium', 'chat'] } } } }, NOW);
eq('Copilot answered with no limits: known, not "asking"', [unlimitedOnly.plans.copilot.answered, unlimitedOnly.plans.copilot.unlimited, plansKnown(unlimitedOnly).copilot],
  [true, ['premium', 'chat'], true]);

const signedOut = readUsage({ plans: { cursor: { found: true, plan: 'free', signedOut: true, seenAt: s(NOW) } } }, NOW);
eq('Cursor signed out: no plan claimed, no chip from it alone', [signedOut.plans.cursor.signedOut, signedOut.plans.cursor.plan, plansKnown(signedOut).cursor], [true, null, undefined]);

const switches = readUsage({ ask: { copilot: false, chatgpt: true, nope: true, google: 'yes' }, plans: { copilot: { found: true, enabled: true, reading: { at: s(NOW), error: 'no_login' } } } }, NOW);
eq('the switches come from the server; junk is ignored', switches.ask, { claude: true, copilot: false, chatgpt: true, google: false });
eq('a tool turned off reports no problem', [liveProblem(switches, 'copilot'), liveShort(switches, 'copilot')], [null, null]);
const notInstalled = readUsage({ plans: { chatgpt: { found: false, cli: false, enabled: false, reading: null, local: null },
  google: { found: false, cli: false, enabled: false, reading: null } } }, NOW);
eq('Codex and Antigravity get placeholder chips before they are installed', [Object.keys(plansKnown(notInstalled)).sort(), planUsage(notInstalled)],
  [['chatgpt', 'google'], {}]);
eq('…but the sample shows none', Object.keys(plansKnown(readUsage({ sample: true, plans: {} }, NOW))), []);
eq('sample mode says so', [readUsage({ sample: true, plans: {} }, NOW).sample, readUsage({ plans: {} }, NOW).sample], [true, false]);

// ---- A lapsed login: the one command that fixes it ----
eq('Claude logged out: claude auth login', loginNeeded(noPlan), { error: 'no_plan', app: 'Claude Code', command: 'claude auth login' });
eq('Copilot and Codex logged out: their own commands', [loginNeeded(fail('copilot', 'no_login'), 'copilot').command, loginNeeded(fail('chatgpt', 'no_plan'), 'chatgpt').command],
  ['copilot login', 'codex login']);
eq('…not for other problems, a tool turned off, or live readings off', [loginNeeded(failed('timeout')), loginNeeded(switches, 'copilot'),
  loginNeeded(readUsage({ reading, live: { enabled: false, reading: { at: s(NOW), error: 'no_plan' } } }, NOW)), loginNeeded(readUsage({ ask: { claude: false }, live: { enabled: true, reading: { at: s(NOW), error: 'no_plan' } } }, NOW))],
  [null, null, null, null]);
eq('…nor for a plan with no login of its own to fix', [loginNeeded(fail('google', 'unavailable'), 'google'), loginNeeded(noPlan, 'cursor')], [null, null]);
eq('Claude Code named a plan but reports no limits: no login to fix, the sentence still says why',
  [loginNeeded(failed('no_plan', { plan: 'enterprise' })), /isn’t logged in to a Claude plan/.test(liveProblem(failed('no_plan', { plan: 'enterprise' })))], [null, true]);
eq('Copilot with no licence (403): says so, offers no login', [/no Copilot/.test(liveProblem(fail('copilot', 'no_access'), 'copilot')),
  liveShort(fail('copilot', 'no_access'), 'copilot').text, loginNeeded(fail('copilot', 'no_access'), 'copilot')], [true, 'No Copilot on this account', null]);

// ---- No live numbers: the newest reading the Claude apps saved on this Mac ----
const codeSaved = { at: s(NOW - 30 * 60e3), windows: [
  { kind: 'session', group: 'session', pct: 9, resets_at: s(NOW + 2 * 3600e3) },
  { kind: 'weekly_all', group: 'weekly', pct: 40, resets_at: s(NOW + 3 * 86400e3) },
  { kind: 'weekly_scoped', group: 'weekly', name: 'Fable', pct: 6, resets_at: s(NOW + 3 * 86400e3) }] };
const deskSaved = { at: s(NOW - 10 * 60e3), windows: [
  { kind: 'session', group: 'session', pct: 19, resets_at: null }, { kind: 'weekly_all', group: 'weekly', pct: 42, resets_at: null }] };
const loggedOut = { live: { enabled: true, reading: { at: s(NOW), error: 'no_plan' } } };
const fromDesk = readUsage({ ...loggedOut, reading: { ...reading, at: s(NOW - 2 * 3600e3) }, saved: { code: codeSaved, desktop: deskSaved } }, NOW);
eq('logged out: the newest saved reading shows, whole (Claude desktop’s, 10 min ago)', [fromDesk.source, fromDesk.claude.asOf, fromDesk.claude.windows.map((w) => [w.id, w.pct])],
  ['desktop', NOW - 10 * 60e3, [['session', 19], ['week', 42]]]);
eq('…said where from, beside why it isn’t live', [sourceLabel(fromDesk, 'claude'), loginNeeded(fromDesk).command], ['From Claude desktop', 'claude auth login']);
const fromCode = readUsage({ ...loggedOut, saved: { code: codeSaved, desktop: { ...deskSaved, at: s(NOW - 3600e3) } } }, NOW);
eq('Claude Code’s last check when it’s newer — Fable and reset times included', [fromCode.source, sourceLabel(fromCode, 'claude'), fromCode.claude.windows.length, fromCode.claude.windows[0].resetsAt],
  ['claudecode', 'From Claude Code’s last check', 3, NOW + 2 * 3600e3]);
eq('the status line when it’s newest (4 min ago)', readUsage({ ...loggedOut, reading, saved: { code: codeSaved, desktop: deskSaved } }, NOW).source, 'statusline');
eq('live numbers always win over saved ones', readUsage({ live: { enabled: true, reading: liveReading }, saved: { code: codeSaved, desktop: deskSaved } }, NOW).source, 'live');
const deskLater = readUsage({ ...loggedOut, saved: { desktop: deskSaved } }, NOW + 6 * 3600e3);
eq('no reset time saved: a session has reset at the latest 5 hours after the reading, a week 7 days', [deskLater.claude.windows.map((w) => w.id), deskLater.claude.expired.map((w) => w.id)],
  [['week'], ['session']]);
eq('…and by then it rings only for what may still run', planPct(planUsage(deskLater).claude), 42);
eq('a week from Claude desktop sets itself aside after 7 days', readUsage({ ...loggedOut, saved: { desktop: deskSaved } }, NOW + 8 * 86400e3).claude.windows, []);
// Claude Code's last check knows when the week resets (every week at that time): desktop's week is set aside then.
const weekResets = NOW + 2 * 3600e3;
const anchored = (now) => readUsage({ ...loggedOut, saved: { desktop: deskSaved, code: { at: s(NOW - 9 * 86400e3), windows: [
  { kind: 'weekly_all', group: 'weekly', pct: 70, resets_at: s(weekResets - 7 * 86400e3) }] } } }, now);
eq('a week with no reset time of its own resets with Claude’s weekly reset', [anchored(NOW).source, anchored(NOW).claude.windows.map((w) => w.id),
  anchored(NOW).claude.windows.find((w) => w.id === 'week').until, anchored(weekResets + 60e3).claude.windows.map((w) => w.id)],
  ['desktop', ['session', 'week'], weekResets, ['session']]);
eq('junk saved readings are ignored', readUsage({ ...loggedOut, saved: { code: 'x', desktop: { at: 'soon', windows: [{ kind: 'session', pct: 'lots' }] } } }, NOW).claude, null);

done();
