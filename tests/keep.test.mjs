// keep.test.mjs — the chats Claude Code is about to delete (its cleanup goes
// by when a session's file was last written, plus cleanupPeriodDays) and the
// copies Throwbacks keeps.

import { retentionOf, expiresAt, dueSessions, keptSessions, whenIn } from '../js/keep.js';
import { sampleData } from '../js/sample.js';
import { parseCodeSessions } from '../js/parse.js';
import { buildModel } from '../js/model.js';
import { eq, ok, done } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 11, 12);
const s = (id, daysAgo, extra = {}) => ({ id: `code:${id}.jsonl`, source: 'code', title: id, touchedAt: now - daysAgo * DAY, ...extra });

eq('the setting as read, else Claude Code\'s default', [retentionOf({ retention: { days: 365, set: true, source: 'user' } }), retentionOf(null), retentionOf({})],
  [{ days: 365, set: true, source: 'user', paused: false }, { days: 30, set: false, source: 'default', paused: false }, { days: 30, set: false, source: 'default', paused: false }]);
eq('a paused sweep (0, or a value Claude Code can\'t read): nothing expires', [retentionOf({ retention: { days: null, paused: true, source: 'managed' } }).paused,
  expiresAt({ id: 'x', source: 'code', touchedAt: 1 }, retentionOf({ retention: { paused: true } }))], [true, null]);
eq('started in Claude desktop: Claude Code\'s cleanup leaves it', expiresAt({ id: 'x', source: 'code', touchedAt: 1, desktop: true }, { days: 30 }), null);

const r30 = { days: 30, set: false };
eq('deleted 30 days after it was last written', expiresAt(s('a', 10), r30), now + 20 * DAY);
eq('…not other apps\' chats, a kept-only copy, or one with no date', [
  expiresAt({ ...s('b', 10), source: 'copilot' }, r30), expiresAt(s('c', 10, { onlyKept: true }), r30), expiresAt(s('d', 0, { touchedAt: null }), r30)],
[null, null, null]);

const list = [s('in6', 24), s('in1', 29), s('overdue', 31), s('in8', 22), s('kept', 29, { kept: true }), { ...s('cop', 29), source: 'copilot' }];
eq('due within a week, soonest first — not later ones, kept ones or other apps', dueSessions(list, r30, now).map((x) => [x.session.title, x.inDays]),
  [['overdue', 0], ['in1', 1], ['in6', 6]]);
eq('…a longer setting: nothing due', dueSessions(list, { days: 365, set: true }, now), []);
eq('in words', [whenIn(0), whenIn(1), whenIn(5)], ['today', 'tomorrow', 'in 5 days']);
// Late in the evening, a chat due early tomorrow morning is "tomorrow" (calendar days), not "today" (hours)
const evening = new Date(2026, 9, 11, 23, 0).getTime();
const early = { id: 'e', source: 'code', title: 'e', touchedAt: new Date(2026, 9, 12, 1, 0).getTime() - 30 * DAY };
eq('"tomorrow" matches the date shown', dueSessions([early], r30, evening)[0].inDays, 1);

const kept = keptSessions([s('k1', 3, { kept: true }), s('k2', 1, { kept: true }), s('gone', 40, { kept: true, onlyKept: true }), s('no', 1)]);
eq('kept copies: the ones whose original is gone first, then by last use', kept.map((x) => x.title), ['gone', 'k2', 'k1']);

// The sample: two Claude Code sessions written days ago, a short made-up setting: both due this week
const sd = sampleData();
const model = buildModel(parseCodeSessions(sd.codeFiles));
const due = dueSessions(model.listSessions(), retentionOf(sd.keep));
ok(due.length === 2 && sd.keep.sample, 'the sample has two chats due this week, from a made-up setting');
ok(model.listSessions().every((x) => Number.isFinite(x.touchedAt) && x.kept === false), 'each session carries when its file was last written, and whether it\'s kept');

done();
