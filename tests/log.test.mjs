// log.test.mjs — the sheet on the built-in sample data: days grouped into
// Monday-first weeks, each day's chats in the order they started, the
// sheet's rows (one per task, by folder), editing them, the version a Rewrite keeps,
// and the two exports (rows for any spreadsheet, CSV) — including the guard
// that stops a chat title from running as a spreadsheet formula; the apps
// left out of summaries; and the Summaries page's list and recaps' days.

import { parseExport, parseCodeSessions, parseCopilotFiles, parseCursorData } from '../js/parse.js';
import { buildModel } from '../js/model.js';
import { sampleData } from '../js/sample.js';
import {
  buildDailyLog, sheetRows, sheetTsv, sheetCsv, csvCell, weekOf, pendingParts, daySummaryState, chatsByFolder,
  mergeDaySummary, daySummaryLines, weekSummaryState, editSheetRow, addSheetRow, dayStamp, editedByHand, newerSummaries,
  summaryList, recapDays, appOfChat, daySummaryGroups, recapBlocks, recapPlain, RECAP_MAX_DAYS,
} from '../js/log.js';
import { keyToDate } from '../js/util.js';
import { eq, ok, done } from './harness.mjs';

const { conversations, codeFiles, copilotFiles, cursorData } = sampleData();
const m = buildModel([
  ...parseExport(conversations), ...parseCodeSessions(codeFiles),
  ...parseCopilotFiles(copilotFiles), ...parseCursorData(cursorData),
]);
const weeks = buildDailyLog(m);
const days = weeks.flatMap((w) => w.days);

// Weeks and days
eq('every active day appears once, oldest first', days.map((d) => d.key), m.dayKeys);
ok(weeks.every((w) => keyToDate(w.week).getDay() === 1), 'weeks start on a Monday');
ok(weeks.every((w) => w.days.every((d) => weekOf(d.key) === w.week)), 'each day sits in its own week');
eq('a Sunday belongs to the week before', weekOf('2026-10-04'), '2026-09-28');
eq('a Monday starts its own week', weekOf('2026-10-05'), '2026-10-05');
ok(weeks.every((w) => w.totalMs === w.days.reduce((t, d) => t + d.totalMs, 0)), 'a week\'s time is its days\' time');
ok(days.every((d) => d.totalMs === m.getDay(d.key).totalMs), 'a day\'s time is the model\'s (parallel chats not double counted)');

// One day's chats
ok(days.every((d) => d.items.length === m.getDay(d.key).sessionIds.size), 'each day lists every chat active that day');
ok(days.every((d) => d.items.every((it, i, a) => !i || a[i - 1].from <= it.from)), 'chats are listed in the order they started');
ok(days.every((d) => d.from <= d.to && d.items.every((it) => it.from >= d.from && it.to <= d.to)), 'a day\'s from–to spans its chats');
ok(days.every((d) => d.items.every((it) => it.ms === m.getSession(it.sessionId).dayMs.get(d.key))), 'each chat\'s time is its time that day');
const pg = days.find((d) => d.items.some((it) => it.title === 'Postgres query profiling'));
const pgItem = pg.items.find((it) => it.title === 'Postgres query profiling');
eq('the first thing asked that day comes along', pgItem.prompt, 'How do I profile a slow SQL query in Postgres?');
ok(pgItem.firstMsgId && m.getSession(pgItem.sessionId).messages.some((x) => x.id === pgItem.firstMsgId),
  'an item links to its first message that day');

// The sheet before anything is summarized: a day's chats as placeholder rows
const fixed = { date: (k) => k, time: () => 'T', duration: (ms) => `${Math.round(ms / 60000)}m` };
const two = days.filter((d) => d.items.length > 1).slice(0, 2);
const plainRows = sheetRows(two[0], undefined);
eq('not summarized: one row per chat, as its title, not editable', [plainRows.length, plainRows.every((r) => r.pending && !r.edit)],
  [two[0].items.length, true]);
const tsv = sheetTsv(two, {}, fixed).split('\n');
eq('Copy rows starts with the sheet\'s columns', tsv[0].split('\t'), ['Date', 'Time', '#', 'Task', 'Folder', 'App', '≈Time']);
const firstRow = tsv[1].split('\t');
eq('a day\'s first row: date · time · 1 · task', [firstRow[0], firstRow[1].endsWith('· T–T'), firstRow[2]], [two[0].key, true, '1']);
eq('later rows of a day leave date and time empty', tsv[2].split('\t').slice(0, 3), ['', '', '2']);
ok(tsv.every((row) => row.split('\t').length === 7), 'every row has seven cells, never a stray tab');
ok(sheetTsv([{ key: 'k', totalMs: 60000, from: 0, to: 0, items: [{ sessionId: 'x', title: 'two\nlines\tand a tab', project: '', ms: 0, source: 'code' }] }], {}, fixed)
  .split('\n').length === 2, 'line breaks and tabs inside a title are flattened');

// The sheet groups a day's chats by folder: folders in the order their first
// chat started, chats without a folder last, each folder's chats in the day's order.
const it = (id, project) => ({ sessionId: id, project });
eq('chats by folder', chatsByFolder([it('n1', ''), it('b1', 'b'), it('a1', 'a'), it('n2', ''), it('b2', 'b')]).map((x) => x.sessionId),
  ['b1', 'b2', 'a1', 'n1', 'n2']);
const mixed = days.find((d) => new Set(d.items.map((x) => x.project || '')).size > 2);
ok(mixed && mixed.items.some((x, i) => i && (x.project || '') !== (mixed.items[i - 1].project || '')), 'the sample has a day whose folders interleave');
const mixedRows = sheetRows(mixed, undefined);
const runs = mixedRows.map((r) => r.item.project || '').filter((p, i, a) => !i || p !== a[i - 1]);
eq('…its rows: each folder once, together, no folder last', [new Set(runs).size === runs.length, runs.at(-1)], [true, '']);
eq('…numbered 1 to n down the day', mixedRows.map((r) => r.n), mixedRows.map((_, i) => i + 1));
const mixedSaved = { chats: Object.fromEntries(mixed.items.map((x) => [x.sessionId, { lines: [`${x.title} line`] }])) };
eq('…and Copy rows follows the same order', sheetTsv([mixed], { days: { [mixed.key]: mixedSaved } }, fixed).split('\n').slice(1).map((r) => r.split('\t')[3]),
  daySummaryLines(mixed, mixedSaved));

// CSV
const csv = sheetCsv(days).trim().split('\r\n');
eq('CSV has a header row and a row per task', csv.length, 1 + days.reduce((t, d) => t + sheetRows(d, undefined).length, 0));
ok(csv[0].startsWith('Date,Weekday,From,To,Active minutes (day),#,Task'), 'CSV header');
ok(/^\d{4}-\d{2}-\d{2},[A-Z][a-z]{2},\d{2}:\d{2},\d{2}:\d{2},\d+,1,/.test(csv[1]), 'CSV rows: ISO date, weekday, 24-hour times, minutes');
ok(csv[1].endsWith(',not summarized yet'), 'each row says what it is');
eq('commas and quotes are escaped', csvCell('say "hi", then'), '"say ""hi"", then"');
for (const evil of ['=HYPERLINK("x")', '+1', '-1', '@SUM(A1)', '\tx']) {
  ok(csvCell(evil).replace(/^"/, '').startsWith("'"), `a cell starting ${JSON.stringify(evil[0])} can't run as a formula`);
}
eq('ordinary text passes through', csvCell('Fetch-kit retry hardening'), 'Fetch-kit retry hardening');
eq('numbers stay numbers', csvCell(42), '42');

// The AI column's bookkeeping: what a saved day covers, what's new since
const busy = days.find((d) => d.items.filter((it) => it.msgs > 1).length >= 2);
const fresh = pendingParts(busy, m, null);
eq('nothing saved: every chat with text is to do', fresh.map((p) => p.id), busy.items.filter((it) => it.msgs).map((it) => it.sessionId));
ok(fresh.every((p) => p.text.startsWith('User: ') || p.text.startsWith('Assistant: ')), 'a chat goes to the AI as plain User / Assistant lines');
eq('state with nothing saved', daySummaryState(busy, m, undefined).state, 'none');
const meta = { now: 1000, provider: 'claudecode', model: 'default' };
const results = new Map(fresh.map((p) => [p.id, [`did ${p.title}`]]));
const saved = mergeDaySummary(undefined, busy.key, fresh, results, meta);
eq('a saved day records its date, when and by which AI', [saved.date, saved.updatedAt, saved.provider], [busy.key, 1000, 'claudecode']);
eq('…and is current right after', daySummaryState(busy, m, saved).state, 'current');
eq('…with nothing left to do', pendingParts(busy, m, saved).length, 0);
// Apps left out in Settings: their chats are never sent, and never "new" either
{
  const mixed = days.find((d) => new Set(d.items.filter((it) => it.msgs).map((it) => it.source)).size >= 2);
  const left = mixed.items.find((it) => it.msgs).source;
  const skip = new Set([left]);
  const sourceOf = (p) => mixed.items.find((it) => it.sessionId === p.id).source;
  const every = pendingParts(mixed, m, null);
  const sent = pendingParts(mixed, m, null, { skip });
  eq('a left-out app\'s chats are never sent; the others still are', [sent.some((p) => sourceOf(p) === left), sent.length], [false, every.filter((p) => sourceOf(p) !== left).length]);
  const without = mergeDaySummary(undefined, mixed.key, sent, new Map(sent.map((p) => [p.id, ['x']])), meta);
  eq('…and a day summarized without them is current, not "new since"', [daySummaryState(mixed, m, without, { skip }).state, daySummaryState(mixed, m, without).state], ['current', 'stale']);
  // A chat that's never sent by itself (the sample's, beside your real summaries): the same, by its id.
  const one = every[0].id;
  eq('a skipped chat is never sent; the rest still are', pendingParts(mixed, m, null, { skip: new Set([one]) }).map((p) => p.id), every.slice(1).map((p) => p.id));
}
eq('its lines follow the sheet\'s order (by folder)', daySummaryLines(busy, saved), chatsByFolder(busy.items).filter((it) => it.msgs).map((it) => `did ${it.title}`));

// A chat continues after the summary: only its new messages are to do.
const [first] = fresh;
const lastMsg = m.getSession(first.id).messages.filter((x) => x.day === busy.key).at(-1);
const older = { ...saved, chats: { ...saved.chats, [first.id]: { ...saved.chats[first.id], upTo: lastMsg.ts - 1, covered: saved.chats[first.id].covered - 1 } } };
const st = daySummaryState(busy, m, older);
eq('new messages in one chat make the day out of date', [st.state, st.newChats], ['stale', 1]);
const more = pendingParts(busy, m, older);
eq('…and only that chat is sent', more.map((p) => p.id), [first.id]);
ok(more[0].text === `${lastMsg.sender === 'human' ? 'User' : 'Assistant'}: ${lastMsg.text}`, '…with just its new message');
eq('…along with what was already written for it', more[0].earlier, [`did ${first.title}`]);
const added = mergeDaySummary(older, busy.key, more, new Map([[first.id, ['and then more']]]), { ...meta, now: 2000 });
eq('new lines are added under that chat, not rewritten', added.chats[first.id].lines, [`did ${first.title}`, 'and then more']);
ok(daySummaryLines(busy, added).indexOf('and then more') === 1, '…so they stay next to its earlier lines');
eq('the other chats are untouched', JSON.stringify(Object.entries(added.chats).filter(([id]) => id !== first.id)),
  JSON.stringify(Object.entries(older.chats).filter(([id]) => id !== first.id)));
const failed = mergeDaySummary(older, busy.key, more, new Map(), { ...meta, now: 3000 });
eq('a chat that failed keeps its old state, so it still shows as to do', daySummaryState(busy, m, failed).state, 'stale');

// Rewrite: everything again, replacing the chats it redid, keeping the rest.
const all = pendingParts(busy, m, saved, { rewrite: true });
eq('rewrite sends every chat again, without the old lines', [all.length, all.every((p) => !p.earlier.length)], [fresh.length, true]);
const withOther = { ...saved, chats: { ...saved.chats, 'cursor:not-loaded': { title: 'Elsewhere', upTo: 1, covered: 1, lines: ['kept'] } } };
const rewritten = mergeDaySummary(withOther, busy.key, all, new Map(all.map((p) => [p.id, ['new wording']])), meta, { rewrite: true });
ok(Object.entries(rewritten.chats).filter(([id]) => id !== 'cursor:not-loaded').every(([, c]) => c.lines.join() === 'new wording'),
  'rewrite replaces the lines of the chats it redid');
eq('…and keeps chats from an app that isn\'t loaded now', rewritten.chats['cursor:not-loaded'].lines, ['kept']);
eq('chats not loaded now still show, after the loaded ones', daySummaryLines(busy, rewritten).at(-1), 'kept');

// The week's summary goes out of date when a day's summary changes.
const wk = weeks.find((w) => w.days.includes(busy));
const recap = { text: 'A week', basedOn: { [busy.key]: saved.updatedAt } };
eq('no week summary yet', weekSummaryState(wk, {}, undefined).state, 'none');
eq('week summary current', weekSummaryState(wk, { [busy.key]: saved }, recap).state, 'current');
eq('…stale once a day is updated', weekSummaryState(wk, { [busy.key]: added }, recap).state, 'stale');

// The sheet with a summary: its lines, editable, under each chat
const rowsAi = sheetRows(busy, added);
const lineRows = rowsAi.filter((r) => r.edit && r.edit.kind === 'line');
eq('a summarized day: one editable row per summary line', lineRows.map((r) => r.text), daySummaryLines(busy, added));
eq('…by folder, as chatsByFolder orders the chats', rowsAi.filter((r) => r.chatFirst && r.item).map((r) => r.item.sessionId), chatsByFolder(busy.items).map((it) => it.sessionId));
eq('…a chat\'s folder and time only on its first line', rowsAi.filter((r) => r.item && r.item.sessionId === first.id).map((r) => r.chatFirst), [true, false]);

// Editing
const firstLine = lineRows[0];
const edited = editSheetRow(added, busy.key, firstLine.edit, '  reworded   by me ', 5000);
eq('an edit changes just that line, tidied', [edited.chats[firstLine.edit.chatId].lines[0], edited.editedAt], ['reworded by me', 5000]);
ok(added.chats[firstLine.edit.chatId].lines[0] !== 'reworded by me', '…as a new object');
eq('…and shows as edited by hand', [editedByHand(edited), editedByHand(added)], [true, false]);
eq('a stale edit (that line was reworded since) changes nothing', editSheetRow(edited, busy.key, firstLine.edit, 'again', 5500), null);
const removed = editSheetRow(edited, busy.key, { ...firstLine.edit, text: 'reworded by me' }, '', 6000);
eq('emptying a line removes it', removed.chats[firstLine.edit.chatId].lines.length, edited.chats[firstLine.edit.chatId].lines.length - 1);
// Rows that moved: the edit finds its line by the text it showed
const four = { ...added, chats: { ...added.chats, x: { title: 'X', upTo: 1, covered: 1, lines: ['a1', 'a2', 'a3', 'a4'] } } };
const drop2 = editSheetRow(four, busy.key, { kind: 'line', chatId: 'x', index: 1, text: 'a2' }, '', 1);
eq('removing a line shifts the rest…', drop2.chats.x.lines, ['a1', 'a3', 'a4']);
eq('…and an edit drawn before that still lands on its own line', editSheetRow(drop2, busy.key, { kind: 'line', chatId: 'x', index: 2, text: 'a3' }, 'a3 edited', 2).chats.x.lines, ['a1', 'a3 edited', 'a4']);
eq('…a line that\'s gone is never guessed', [editSheetRow(drop2, busy.key, { kind: 'line', chatId: 'x', index: 1, text: 'a2' }, 'b', 3),
  editSheetRow(drop2, busy.key, { kind: 'line', chatId: 'nope', index: 0, text: 'a1' }, 'b', 3),
  editSheetRow(drop2, busy.key, { kind: 'manual', id: 'nope' }, 'b', 3)], [null, null, null]);
const mine = addSheetRow(removed, busy.key, 'Planning call with the team', 7000, 'm1');
eq('a row of your own, at the end of the day', sheetRows(busy, mine).at(-1), { n: sheetRows(busy, mine).length, text: 'Planning call with the team', edit: { kind: 'manual', id: 'm1' }, item: null, chatFirst: true, manual: true });
eq('…editable, and removable', [editSheetRow(mine, busy.key, { kind: 'manual', id: 'm1' }, 'Planning call', 8000).manual[0].text,
  editSheetRow(mine, busy.key, { kind: 'manual', id: 'm1' }, '', 8000).manual.length], ['Planning call', 0]);
eq('a blank row isn\'t added', addSheetRow(mine, busy.key, '   ', 9000, 'm2'), mine);
const onEmpty = addSheetRow(undefined, '2026-01-02', 'A day with no summary yet', 1, 'm3');
eq('…even on a day with no summary yet (which still counts as not summarized)', [onEmpty.manual.length, daySummaryState(busy, m, onEmpty).state], [1, 'none']);

// Add new and Rewrite keep what you did
const more2 = pendingParts(busy, m, mine);
const fresh2 = mergeDaySummary(mine, busy.key, more2, new Map(more2.map((p) => [p.id, ['later line']])), { ...meta, now: 10000 });
eq('Add new keeps your edits and rows', [fresh2.manual, fresh2.editedAt], [mine.manual, mine.editedAt]);
const all2 = pendingParts(busy, m, mine, { rewrite: true });
const re = mergeDaySummary(mine, busy.key, all2, new Map(all2.map((p) => [p.id, ['fresh wording']])), { ...meta, now: 11000 }, { rewrite: true });
eq('Rewrite keeps the version it replaces, with your edits', [re.previous.length, re.previous[0].at, re.previous[0].chats], [1, dayStamp(mine), mine.chats]);
eq('…and your own rows', re.manual, mine.manual);
let chain = re;
for (let i = 0; i < 4; i++) chain = mergeDaySummary(chain, busy.key, all2, new Map(all2.map((p) => [p.id, [`v${i}`]])), { ...meta, now: 12000 + i }, { rewrite: true });
eq('…up to three earlier versions', chain.previous.length, 3);
eq('daySummaryLines includes your rows', daySummaryLines(busy, mine).at(-1), 'Planning call with the team');

// Reading the saved summaries again (another tab): the newer copy of each day wins
const mem = { where: 'files', days: { a: { updatedAt: 5 }, b: { updatedAt: 1, editedAt: 9 }, mineOnly: { updatedAt: 1 } }, weeks: { w: { updatedAt: 2 } } };
const disk = { where: 'files', days: { a: { updatedAt: 7 }, b: { updatedAt: 8 }, diskOnly: { updatedAt: 1 } }, weeks: { w: { updatedAt: 2, editedAt: 3 } } };
const both = newerSummaries(mem, disk);
eq('newer per day: theirs, mine (edited later), only mine, only theirs', [both.days.a, both.days.b, both.days.mineOnly, both.days.diskOnly],
  [disk.days.a, mem.days.b, mem.days.mineOnly, disk.days.diskOnly]);
eq('…and per week', both.weeks.w, disk.weeks.w);

// The week's summary goes stale when you edit a day too
const recapNow = { text: 'A week', basedOn: { [busy.key]: dayStamp(added) } };
eq('an edit makes the week summary stale', weekSummaryState(wk, { [busy.key]: edited }, recapNow).state, 'stale');

// Copying with summaries: the day's lines, and the week's summary as its own row
const tsvAi = sheetTsv([busy], { days: { [busy.key]: mine }, weeks: { [weekOf(busy.key)]: recap } }, fixed).split('\n');
eq('a summarized day copies its lines and your rows', tsvAi.slice(1, -1).map((r) => r.split('\t')[3]), daySummaryLines(busy, mine));
eq('…the week summary ends the week, in its own row', tsvAi.at(-1).split('\t').slice(0, 4), ['Week summary', '', '', 'A week']);
const tsvParts = sheetTsv([busy], { days: { [busy.key]: mine }, weeks: { [weekOf(busy.key)]: { text: 'A week.\n\n## etl\n- Fixed it\n- Shipped it' } } }, fixed).split('\n');
eq('…a recap in parts copies as one cell, one row', tsvParts.at(-1).split('\t').slice(0, 4), ['Week summary', '', '', 'A week. · etl: Fixed it; Shipped it']);
const csvAi = sheetCsv([busy], { days: { [busy.key]: mine } }).trim().split('\r\n');
ok(csvAi.at(-1).endsWith(',Planning call with the team,,,,,added by you'), 'the CSV marks your own rows');

// The Summaries page: days, recaps and chats, newest first by the day each reaches
{
  const all = summaryList({
    days: { '2026-11-03': { chats: { a: { lines: ['x'] } }, updatedAt: 5 }, '2026-11-04': { chats: { b: { lines: [] } } } },
    weeks: { '2026-11-02': { text: 'w', updatedAt: 6 } }, months: { '2026-10': { text: 'm' } }, periods: { '2026-10-01_2026-10-14': { text: 'p' } },
  }, [{ id: 'r1', at: new Date('2026-11-05T10:00').getTime(), rangeLabel: 'Session · X', perSession: [{ id: 'code:a.jsonl' }] },
    { id: 'r2', at: new Date('2026-09-01T10:00').getTime(), rangeLabel: 'Last 7 days · …', perSession: [] }], '2026-11-06');
  eq('every kind, newest first (a week reaches today at most), a day with no lines left out', all.map((e) => [e.type, e.group, e.covers]),
    [['week', 'recap', '2026-11-06'], ['chat', 'chat', '2026-11-05'], ['day', 'day', '2026-11-03'], ['month', 'recap', '2026-10-31'], ['period', 'recap', '2026-10-14'], ['range', 'recap', '2026-09-01']]);
  eq('…a chat\'s summary knows its chat (older ones by their one session)', all.find((e) => e.type === 'chat').sessionId, 'code:a.jsonl');
  eq('a recap\'s days: a week, a month, any dates', [recapDays('week', '2026-11-02').length, recapDays('month', '2026-02').at(-1), recapDays('period', '2026-10-30_2026-11-02')],
    [7, '2026-02-28', ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']]);
  eq('a long period isn\'t cut short (only past ten years)', [recapDays('period', '2025-06-01_2026-11-14').length, recapDays('period', '2026-11-14_2026-11-13').length,
    recapDays('period', 'nonsense').length, recapDays('period', '1990-01-01_2026-11-14').length], [532, 0, 0, RECAP_MAX_DAYS]);
  eq('a chat\'s app, from its id', ['copilot-cli:abc', 'code:x.jsonl', 'web:s-1', 'nocolon'].map(appOfChat), ['copilot-cli', 'code', 'web', '']);
  // A recap's lines: every saved chat's (loaded or not) and your rows — never a left-out app's, nor a skipped chat's.
  const saved = { chats: { 'code:a.jsonl': { lines: ['code line'] }, 'cursor:b': { lines: ['cursor line'] }, 'web:c': { lines: ['web line'] } }, manual: [{ text: 'mine' }] };
  eq('…with no row (its chats not loaded): all of them', daySummaryLines(null, saved), ['code line', 'cursor line', 'web line', 'mine']);
  eq('…leaving out an app and a chat', daySummaryLines(null, saved, { skip: new Set(['cursor', 'web:c']) }), ['code line', 'mine']);
  eq('reading again keeps months and periods too', Object.keys(newerSummaries({ days: {}, weeks: {}, months: {}, periods: {} }, { days: {}, weeks: {}, months: { '2026-10': { text: 'm' } }, periods: { a: { text: 'p' } } })).filter((k) => k !== 'where'),
    ['days', 'weeks', 'months', 'periods']);
}

// A recap is written from the day lines under their project — the folder as loaded, else as saved with the lines.
{
  const day = { key: '2026-11-10', items: [{ sessionId: 'a', project: 'etl' }, { sessionId: 'b', project: 'etl' }, { sessionId: 'c', project: '' }] };
  const kept = { chats: { a: { lines: ['a1'] }, b: { lines: ['b1', 'b2'] }, c: { lines: ['c1'] }, gone: { lines: ['g1'], project: 'notes-app' } },
    manual: [{ id: 'm1', text: 'my own row' }] };
  eq('a day\'s lines under their project, in the sheet\'s order; a chat not loaded by the folder saved with it; your rows last',
    daySummaryGroups(day, kept), [{ project: 'etl', lines: ['a1', 'b1', 'b2'] }, { project: '', lines: ['c1'] }, { project: 'notes-app', lines: ['g1'] }, { project: 'Added by you', lines: ['my own row'] }]);
  eq('…the same lines, in the same order, as the sheet\'s', daySummaryLines(day, kept), ['a1', 'b1', 'b2', 'c1', 'g1', 'my own row']);
  eq('…a left-out chat leaves its group', daySummaryGroups(day, kept, { skip: new Set(['c']) }).map((g) => g.project), ['etl', 'notes-app', 'Added by you']);
  const older = { chats: { c: { lines: ['c1'] }, old: { lines: ['o1'] } } };
  eq('a chat not loaded, saved before its folder was kept: its folder isn\'t known, never "no folder"',
    daySummaryGroups(day, older), [{ project: '', lines: ['c1'] }, { project: null, lines: ['o1'] }]);
  const merged = mergeDaySummary(undefined, '2026-11-10', [{ id: 'x', title: 'T', project: 'etl', upTo: 5, covered: 1 }, { id: 'y', title: 'U', project: '', upTo: 6, covered: 1 }],
    new Map([['x', ['l1']], ['y', ['l2']]]), meta);
  eq('a summarized chat keeps its folder with its lines (none when it has none)', [merged.chats.x.project, 'project' in merged.chats.y], ['etl', false]);
}
// A recap read back: its line, each project's name and points — or the paragraphs of an older one.
{
  const text = 'Shipped notes-app 1.0.8.\n\n## notes-app\n- Multi-line entries\n- **Batch** archive\n\n## **Still open**\n- Push 1.0.8';
  eq('a recap\'s parts', recapBlocks(text), [{ type: 'head', text: 'Shipped notes-app 1.0.8.' }, { type: 'group', text: 'notes-app' },
    { type: 'point', text: 'Multi-line entries' }, { type: 'point', text: 'Batch archive' }, { type: 'group', text: 'Still open' }, { type: 'point', text: 'Push 1.0.8' }]);
  eq('…an older recap is its paragraph', recapBlocks('Did a thing. Then another.'), [{ type: 'head', text: 'Did a thing. Then another.' }]);
  eq('…as one line for a spreadsheet cell', recapPlain(text), 'Shipped notes-app 1.0.8. · notes-app: Multi-line entries; Batch archive · Still open: Push 1.0.8');
  eq('…an older one unchanged', recapPlain('Did a thing.'), 'Did a thing.');
  eq('the ways a model may mark it up: a preamble, a fence, **bold** names with a colon, [brackets], "None" still open', recapBlocks(
    "Here's the week's update:\n```\nShipped it.\n**api-gateway:**\n- Limiter done\n### [etl]\n- Fixed\n## Still open:\n- None\n```"),
  [{ type: 'head', text: 'Shipped it.' }, { type: 'group', text: 'api-gateway' }, { type: 'point', text: 'Limiter done' }, { type: 'group', text: 'etl' }, { type: 'point', text: 'Fixed' }]);
}

done();
