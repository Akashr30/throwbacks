// plans.test.mjs — how the journal groups tools and days, on the built-in
// sample data: apps by the plan whose limits they share, the tool filter,
// weeks and the day Today opens on, a day's sessions by folder with their
// merged ≈time (parallel work counted once), and saved summaries narrowed
// to the chats on screen.

import { parseExport, parseCodeSessions, parseCopilotFiles, parseCursorData } from '../js/parse.js';
import { buildModel } from '../js/model.js';
import { buildDailyLog } from '../js/log.js';
import { sampleData } from '../js/sample.js';
import { blocksDuration } from '../js/time.js';
import { keyToDate } from '../js/util.js';
import {
  APPS, PLANS, appOf, plansPresent, normalizeFilter, filterKey, matcher, filterLabel,
  addDays, mondayOf, weekKeys, daysBetween, homeDay, stepDay, unionMs, folderGroups, filteredSaved, planPct, dayGroups,
  folderIsOpen, isQuick, stillGoing, isArchived, marksOf, applyMark, MARKS_MAX, dateBand, homeShort, treeSections, viewPrefs, VIEW_VERSION,
} from '../js/plans.js';
import { eq, ok, done } from './harness.mjs';

const { conversations, codeFiles, copilotFiles, cursorData } = sampleData();
const raw = [...parseExport(conversations), ...parseCodeSessions(codeFiles), ...parseCopilotFiles(copilotFiles), ...parseCursorData(cursorData)];
const model = buildModel(raw);
const rows = new Map(buildDailyLog(model).flatMap((w) => w.days).map((d) => [d.key, d]));

// Apps and plans
ok(Object.values(APPS).every((a) => PLANS.some((p) => p.id === a.plan)), 'every app belongs to a plan');
ok(PLANS.every((p) => p.apps.every((id) => APPS[id].plan === p.id)), 'each plan lists exactly its own apps');
eq('Claude Code, Cowork and claude.ai share one plan', ['code', 'cowork', 'web'].map((s) => appOf(s).plan), ['claude', 'claude', 'claude']);
eq('both Copilots share one plan', ['copilot', 'copilot-cli'].map((s) => appOf(s).plan), ['copilot', 'copilot']);
eq('an unknown source is "Other"', appOf('nope').name, 'Other');
eq('plans with chats, in a fixed order', plansPresent(model.listSessions()).map((p) => p.id), ['claude', 'copilot', 'cursor']);
eq('…plus plans the usage meter knows, in the same order', plansPresent(model.listSessions(), { google: true, chatgpt: {} }).map((p) => p.id),
  ['claude', 'copilot', 'cursor', 'chatgpt', 'google']);
eq('Codex and Antigravity have their plans', [appOf('codex').plan, appOf('antigravity').plan], ['chatgpt', 'google']);

// The tool filter
eq('no plan: every tool', normalizeFilter({ plan: 'nope', app: 'code' }), { plan: null, app: null });
eq('an app must belong to its plan', normalizeFilter({ plan: 'copilot', app: 'code' }), { plan: 'copilot', app: null });
eq('filter keys', [filterKey(null), filterKey({ plan: 'claude' }), filterKey({ plan: 'claude', app: 'code' })], ['', 'claude', 'claude/code']);
eq('filter labels', [filterLabel({ plan: 'copilot' }), filterLabel({ plan: 'copilot', app: 'copilot-cli' }), filterLabel(null)],
  ['Copilot apps', 'Copilot CLI', '']);
const all = model.listSessions();
const claude = all.filter(matcher({ plan: 'claude' }));
ok(claude.length && claude.every((s) => ['code', 'cowork', 'web'].includes(s.source)), 'a plan keeps its apps\' sessions');
eq('one app narrows further', all.filter(matcher({ plan: 'claude', app: 'code' })).map((s) => s.source).filter((v, i, a) => a.indexOf(v) === i), ['code']);
eq('no filter keeps everything', all.filter(matcher({ plan: null })).length, all.length);

// Days and weeks
eq('a Sunday\'s Monday is the day before the weekend', mondayOf('2026-10-04'), '2026-09-28');
eq('a Monday is its own week\'s Monday', mondayOf('2026-10-05'), '2026-10-05');
eq('a week has seven days from Monday', weekKeys('2026-09-28'), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
eq('adding days crosses months and years', [addDays('2026-10-31', 1), addDays('2027-01-01', -1)], ['2026-11-01', '2026-12-31']);
eq('days between, across a clock change', daysBetween('2026-10-20', '2026-11-03'), 14);
eq('Today opens on today when it has chats', homeDay(['2026-10-01', '2026-10-06'], '2026-10-06'), { key: '2026-10-06', moved: false });
eq('…else on the last day before it', homeDay(['2026-10-01', '2026-10-03', '2026-10-09'], '2026-10-06'), { key: '2026-10-03', moved: true });
eq('…and on nothing when there\'s nothing', homeDay([], '2026-10-06'), { key: '2026-10-06', moved: false });
eq('stepping between active days', [stepDay(['a1', 'b2', 'c3'], 'b2', -1), stepDay(['a1', 'b2', 'c3'], 'b2', 1), stepDay(['a1'], 'a1', 1)], ['a1', 'c3', null]);

// Each session keeps its activity blocks per day, matching its ≈time that day.
ok(all.every((s) => s.dayKeys.every((k) => blocksDuration(s.dayBlocks.get(k) || []) === s.dayMs.get(k))),
  'a session\'s blocks on a day add up to its ≈time that day');

// A day's sessions by folder. Sample day 3 has two chats overlapping in time.
const busyKey = model.dayKeys.find((k) => rows.get(k).items.length >= 2
  && unionMs(model, rows.get(k).items.map((it) => it.sessionId), k) < rows.get(k).items.reduce((t, it) => t + it.ms, 0));
ok(busyKey, 'the sample has a day where two chats overlap');
const busy = rows.get(busyKey);
eq('a union over all of a day\'s chats is the day\'s ≈time', unionMs(model, busy.items.map((it) => it.sessionId), busyKey), busy.totalMs);
const folderDay = [...rows.values()].find((r) => r.items.some((it) => it.project) && r.items.some((it) => !it.project));
if (folderDay) {
  const groups = folderGroups(model, folderDay);
  eq('chats without a folder come last', groups[groups.length - 1].name, 'No folder');
  ok(groups.every((g) => g.ms === unionMs(model, g.items.map((it) => it.sessionId), folderDay.key)), 'each folder\'s ≈time is its chats\' union');
  eq('every chat is in exactly one group', groups.reduce((t, g) => t + g.items.length, 0), folderDay.items.length);
}
const fetchKit = [...rows.values()].find((r) => r.items.filter((it) => it.project === 'fetch-kit').length > 1);
if (fetchKit) {
  const g = folderGroups(model, fetchKit).find((x) => x.name === 'fetch-kit');
  ok(g.folder && g.folder.endsWith('fetch-kit') && g.items.length > 1, 'two tools in one folder share its group');
}

// Saved summaries narrowed to what's on screen
const saved = { v: 1, date: busyKey, chats: { [busy.items[0].sessionId]: { lines: ['a'] }, 'other:tool': { lines: ['b'] } } };
eq('a saved day keeps only the chats on the row', Object.keys(filteredSaved(saved, busy).chats), [busy.items[0].sessionId]);
eq('nothing saved stays nothing', filteredSaved(undefined, busy), undefined);

// Usage rings
eq('a plan\'s ring shows its tightest limit', planPct({ windows: [{ pct: 42 }, { pct: 61 }] }), 61);
eq('no windows, no ring', [planPct(null), planPct({ windows: [] })], [null, null]);

ok(keyToDate('2026-10-06').getHours() === 0, 'day keys are local midnights');

// A conversation's days: oldest first, or the newest day on top — a day's own messages always in reading order
const msgs = [['2026-10-07', 'q1'], ['2026-10-07', 'a1'], ['2026-10-08', 'q2'], ['2026-10-08', 'a2'], ['2026-10-09', 'q3']].map(([day, text]) => ({ day, text }));
const shape = (gs) => gs.map((g) => `${g.day}: ${g.messages.map((m) => m.text).join(' ')}`);
eq('oldest first: days and messages in reading order', shape(dayGroups(msgs)), ['2026-10-07: q1 a1', '2026-10-08: q2 a2', '2026-10-09: q3']);
eq('newest day on top: the days turn, each day still reads question → answer', shape(dayGroups(msgs, true)), ['2026-10-09: q3', '2026-10-08: q2 a2', '2026-10-07: q1 a1']);
eq('nothing to show', dayGroups([], true), []);

// The Sessions page
eq('folders of folders start open, the rest closed', [folderIsOpen('/a', true, {}), folderIsOpen('/b', false, {})], [true, false]);
eq('what you opened or closed wins', [folderIsOpen('/a', true, { '/a': false }), folderIsOpen('/b', false, { '/b': true })], [false, true]);
eq('while you filter, everything is open', folderIsOpen('/a', false, { '/a': false }, true), true);

const chat = (o) => ({
  source: 'code', msgCount: 10, totalMs: 30 * 60e3, dayKeys: ['2026-10-20'], lastTs: keyToDate('2026-10-20').getTime() + 36e5,
  messages: [{ sender: 'human', text: `What about ${o.id || 'this'}?`, ts: keyToDate((o.dayKeys || ['2026-10-20'])[0]).getTime() + 6e5 }], ...o,
});
eq('a quick chat: a question and its answer, a few minutes', [isQuick(chat({ msgCount: 2, totalMs: 3 * 60e3 })), isQuick(chat({ msgCount: 3, totalMs: 3 * 60e3 })), isQuick(chat({ msgCount: 2, totalMs: 6 * 60e3 }))], [true, false, false]);
{
  const ts = (k) => keyToDate(k).getTime() + 36e5;
  const old = chat({ id: 'old', dayKeys: ['2026-09-01', '2026-09-20'], lastTs: ts('2026-09-20') });
  const back = chat({ id: 'back', dayKeys: ['2026-10-01', '2026-10-14'], lastTs: ts('2026-10-14') });
  const newest = chat({ id: 'newest', dayKeys: ['2026-10-20', '2026-10-27'], lastTs: ts('2026-10-27') });
  const oneDay = chat({ id: 'one', dayKeys: ['2026-10-27'], lastTs: ts('2026-10-27') });
  const ids = (r) => r.going.map((s) => s.id);
  eq('still going: back on another day, in the last two weeks, newest first', ids(stillGoing([old, back, oneDay, newest], '2026-10-27')), ['newest', 'back']);
  eq('…two weeks counts today', stillGoing([back], '2026-10-28').going.length, 0);

  // Pins and archives (Throwbacks' own: chat IDs and times).
  const pin = (...pinned) => marksOf({ pinned: Object.fromEntries(pinned.map((id, i) => [id, 1000 + i])) });
  eq('a pinned chat stays, first — even a quiet or one-day one', ids(stillGoing([old, back, oneDay, newest], '2026-10-27', pin('old', 'one'))), ['one', 'old', 'newest', 'back']);
  const arch = (id, last, at = last + 60e3) => marksOf({ archived: { [id]: { at, last } } });  // archived a minute after its last message
  {
    const r = stillGoing([back, newest], '2026-10-27', arch('newest', newest.lastTs));
    eq('an archived chat leaves Still going for its fold', [ids(r), r.archived.map((s) => s.id)], [['back'], ['newest']]);
    ok(isArchived(newest, arch('newest', newest.lastTs)), '…and is archived until it changes');
    const again = stillGoing([back, newest], '2026-10-27', arch('newest', newest.lastTs - 1));
    eq('…worked on since (by its own clock, not when it was archived): back in Still going', [ids(again), again.archived.length], [['newest', 'back'], 0]);
    eq('…an archive that has gone quiet leaves the fold too', stillGoing([old], '2026-10-27', arch('old', old.lastTs)).archived.length, 0);
  }
  // Left out: a chat of only commands; a branched chat's other copies.
  const cmds = chat({ id: 'cmd', dayKeys: ['2026-10-20', '2026-10-26'], lastTs: ts('2026-10-26'), messages: [{ sender: 'human', text: '/model opus', ts: ts('2026-10-20') }, { sender: 'assistant', text: 'Set model', ts: ts('2026-10-20') }] });
  const path = chat({ id: 'path', dayKeys: ['2026-10-20', '2026-10-26'], lastTs: ts('2026-10-26'), messages: [{ sender: 'human', text: '/Users/me/app.js fails', ts: ts('2026-10-20') }] });
  const none = chat({ id: 'none', dayKeys: ['2026-10-20', '2026-10-26'], lastTs: ts('2026-10-26'), messages: [{ sender: 'assistant', text: 'Hi', ts: ts('2026-10-20') }] });
  eq('a chat of only slash commands, or none of yours, isn’t a chat to pick up (a path you typed is)', ids(stillGoing([cmds, path, none], '2026-10-27')), ['path']);
  const first = { sender: 'human', text: 'Plan the export', ts: ts('2026-10-20') };
  const branchA = chat({ id: 'ba', dayKeys: ['2026-10-20', '2026-10-25'], lastTs: ts('2026-10-25'), messages: [first] });
  const branchB = chat({ id: 'bb', dayKeys: ['2026-10-20', '2026-10-27'], lastTs: ts('2026-10-27'), messages: [{ ...first }, { sender: 'human', text: 'And then?', ts: ts('2026-10-27') }] });
  const sameWords = chat({ id: 'sw', dayKeys: ['2026-10-21', '2026-10-26'], lastTs: ts('2026-10-26'), messages: [{ ...first, ts: ts('2026-10-21') }] });
  eq('a branched chat (its first message, same moment) shows once: the newest', ids(stillGoing([branchA, branchB, sameWords], '2026-10-27')), ['bb', 'sw']);
  eq('…or the one you pinned', ids(stillGoing([branchA, branchB], '2026-10-27', pin('ba'))), ['ba']);
  eq('…and archiving the one shown doesn’t bring back its copy', [ids(stillGoing([branchA, branchB], '2026-10-27', arch('bb', branchB.lastTs))), stillGoing([branchA, branchB], '2026-10-27', arch('bb', branchB.lastTs)).archived.map((s) => s.id)], [[], ['bb']]);
  {
    // Review 2026-11-12: archiving a pinned older copy, and a chat only there because of its pin.
    const now = ts('2026-10-27') + 7200e3;
    let m = applyMark(null, { id: 'ba', pin: true }, now - 1e7);
    eq('a pinned older copy shows for its chat', ids(stillGoing([branchA, branchB], '2026-10-27', m)), ['ba']);
    m = applyMark(m, { id: 'ba', archive: { last: branchA.lastTs } }, now);
    const r = stillGoing([branchA, branchB], '2026-10-27', m);
    eq('…archived: the newer copy stays out with it, and it waits in the fold', [ids(r), r.archived.map((s) => s.id)], [[], ['ba']]);
    const worked = { ...branchB, lastTs: now + 6e5, dayKeys: [...branchB.dayKeys] };
    eq('…until a copy is worked on after the archive', ids(stillGoing([branchA, worked], '2026-10-27', m)), ['bb']);
    let p = applyMark(null, { id: 'one', pin: true }, now - 1e7);
    p = applyMark(p, { id: 'one', archive: { last: oneDay.lastTs } }, now);
    const q = stillGoing([oneDay, newest], '2026-10-27', p);
    eq('a chat there only by its pin, archived: in the fold, not gone', [ids(q), q.archived.map((s) => s.id)], [['newest'], ['one']]);
    eq('…Restore pins it again: back where it was', ids(stillGoing([oneDay, newest], '2026-10-27', applyMark(p, { id: 'one', archive: null }, now + 1))), ['one', 'newest']);
    eq('…two weeks after the archive, a quiet one leaves the fold', stillGoing([oneDay], '2026-11-12', p).archived.length, 0);
  }
  {
    // Review 2026-11-12 (Cards): a pin from the Cards always lands in Still going.
    eq('a pinned chat of only commands shows (your pin beats the rule)', ids(stillGoing([cmds], '2026-10-27', pin('cmd'))), ['cmd']);
    const both = marksOf({ pinned: { ba: 1 }, archived: { bb: { at: branchB.lastTs + 60e3, last: branchB.lastTs } } });
    const r = stillGoing([branchA, branchB], '2026-10-27', both);
    eq('…a pinned copy shows though its sibling is archived', [ids(r), r.archived.length], [['ba'], 0]);
    eq('…two pinned copies: both', ids(stillGoing([branchA, branchB], '2026-10-27', pin('ba', 'bb'))), ['bb', 'ba']);
  }
  eq('…another app’s chat with the same first message is its own', ids(stillGoing([branchA, { ...branchB, source: 'copilot' }], '2026-10-27')), ['bb', 'ba']);
}
{
  // marksOf / applyMark: what's saved, checked; one change at a time (serve.py's apply_mark does the same).
  eq('marks: nothing saved', marksOf(null), { pinned: {}, archived: {} });
  eq('marks: bad entries dropped', marksOf({ pinned: { a: 1, b: 'x', '': 2, 'c\n': 3, d: -1 }, archived: { e: { at: 1, last: 2 }, f: { at: 1 }, a: { at: 1, last: 1 } } }),
    { pinned: { a: 1 }, archived: { e: { at: 1, last: 2 } } });
  const m1 = applyMark(null, { id: 'code:x', pin: true }, 10);
  eq('pin', m1, { pinned: { 'code:x': 10 }, archived: {} });
  const m2 = applyMark(m1, { id: 'code:x', archive: { last: 7 } }, 20);
  eq('archive unpins (and remembers the pin)', m2, { pinned: {}, archived: { 'code:x': { at: 20, last: 7, pin: 10 } } });
  eq('pin restores', applyMark(m2, { id: 'code:x', pin: true }, 30), { pinned: { 'code:x': 30 }, archived: {} });
  eq('restore pins it again', applyMark(m2, { id: 'code:x', archive: null }, 30), { pinned: { 'code:x': 10 }, archived: {} });
  const m3 = applyMark(null, { id: 'code:y', archive: { last: 7 } }, 20);
  eq('archive (not pinned), restore', [m3, applyMark(m3, { id: 'code:y', archive: null }, 30)], [{ pinned: {}, archived: { 'code:y': { at: 20, last: 7 } } }, { pinned: {}, archived: {} }]);
  eq('unpin', applyMark(m1, { id: 'code:x', pin: false }, 30), { pinned: {}, archived: {} });
  eq('a bad change is refused', [applyMark(m1, { id: 'x' }, 1), applyMark(m1, { id: '', pin: true }, 1), applyMark(m1, { id: 'x', archive: { last: 'no' } }, 1), applyMark(m1, { id: 'x', archive: { last: -1 } }, 1), applyMark(m1, null, 1)], [null, null, null, null, null]);
  let big = null;
  for (let i = 0; i <= MARKS_MAX; i++) big = applyMark(big, { id: `c${i}`, pin: true }, i);
  eq('at most MARKS_MAX pins: the oldest goes', [Object.keys(big.pinned).length, 'c0' in big.pinned, `c${MARKS_MAX}` in big.pinned], [MARKS_MAX, false, true]);
}
// 2026-10-27 is a Tuesday: its week started on Monday the 26th
eq('by Date: this week', dateBand('2026-10-26', '2026-10-27'), { id: 'week', kind: 'week', at: '2026-10-26' });
eq('…the rest of this month', dateBand('2026-10-25', '2026-10-27'), { id: '2026-10', kind: 'rest', at: '2026-10' });
eq('…then each month', dateBand('2025-12-31', '2026-10-27'), { id: '2025-12', kind: 'month', at: '2025-12' });
eq('the home folder as ~', [homeShort('/Users/me/Dev/app'), homeShort('/home/me'), homeShort('/Users/meg-other'), homeShort('/opt/Users/me')], ['~/Dev/app', '~', '~', '/opt/Users/me']);
{
  // ~ (one chat of its own) → ~/Dev (projects, one a folder of folders) and ~/Work; a root elsewhere.
  const n = (path, own, children = []) => ({ name: path.split('/').pop(), path, own, children });
  const lab = n('/Users/me/Dev/lab', 0, [n('/Users/me/Dev/lab/a', 1), n('/Users/me/Dev/lab/b', 1)]);
  const dev = n('/Users/me/Dev', 0, [n('/Users/me/Dev/app', 3), lab, n('/Users/me/Dev/empty', 0)]);
  const work = n('/Users/me/Work', 0, [n('/Users/me/Work/x', 1), n('/Users/me/Work/y', 2)]);
  const home = n('/Users/me', 1, [dev, work, n('/Users/me/scratch', 1)]);
  const own = (x) => x.own;
  const total = (x) => x.own + x.children.reduce((t, c) => t + total(c), 0);
  const shape = (r) => ({ sections: r.sections.map((sec) => [sec.node.path, sec.rows.map((x) => x.name)]), elsewhere: r.elsewhere.map((e) => [e.node.path, e.alone]) });
  eq('sections: folders of folders at the top label their projects; your home folder\'s own chats go Elsewhere',
    shape(treeSections([home, n('/tmp/run', 2)], own, total)), {
      sections: [['/Users/me/Dev', ['app', 'lab']], ['/Users/me/Work', ['x', 'y']]],
      elsewhere: [['/Users/me', true], ['/Users/me/scratch', false], ['/tmp/run', false]],
    });
  eq('…a folder of only such folders hands them down', shape(treeSections([n('/Users/me', 0, [dev, work])], own, total)).sections.map((x) => x[0]), ['/Users/me/Dev', '/Users/me/Work']);
  eq('…a folder with chats of its own over plain projects stays one folder', shape(treeSections([n('/Users/me/Dev', 2, [n('/Users/me/Dev/app', 1)])], own, total)), { sections: [], elsewhere: [['/Users/me/Dev', false]] });
  eq('…and folders with none of the listed chats are left out', shape(treeSections([n('/Users/me', 0, [n('/Users/me/a', 0), n('/Users/me/b', 1)])], own, total)), { sections: [['/Users/me', ['b']]], elsewhere: [] });
}

// The saved view settings
eq('Sessions opens by Folder', viewPrefs(null).group, 'folder');
eq('a save from before v2 (Date was the default, Tool is gone) opens by Folder', [viewPrefs({ group: 'date' }).group, viewPrefs({ group: 'tool' }).group, viewPrefs({ group: 'folder' }).group], ['folder', 'folder', 'folder']);
eq('…a newer save keeps Date', viewPrefs({ v: VIEW_VERSION, group: 'date' }).group, 'date');
eq('…and every other setting carries over', (({ sheetGroup, auto, order, autoSummary, folders }) => ({ sheetGroup, auto, order, autoSummary, folders }))(viewPrefs({ sheetGroup: 'folder', auto: false, order: 'newest', autoSummary: { on: false, at: '18:30' }, folders: { '/a': true, '::quick:/a': true, bad: 'x' } })),
  { sheetGroup: 'folder', auto: false, order: 'newest', autoSummary: { on: false, at: '18:30' }, folders: { '/a': true, '::quick:/a': true } });
eq('saves carry the version', viewPrefs({}).v, VIEW_VERSION);
eq('the apps left out of summaries: none at first; known apps only, once each', [viewPrefs(null).summaryOff, viewPrefs({ summaryOff: ['cursor', 'nope', 'cursor', 3, 'copilot'] }).summaryOff, viewPrefs({ summaryOff: 'cursor' }).summaryOff],
  [[], ['cursor', 'copilot'], []]);

done();
