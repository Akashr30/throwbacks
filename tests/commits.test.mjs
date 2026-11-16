// commits.test.mjs — your git commits on the journal: indexing serve.py's
// answer, a day's commits per folder, commits in folders without a chat that
// day, merging the sample's, the chat a commit links to, who made them
// (per tool, a day's or a month's), and the Commits page's filters, bands
// and the day a link lands on.

import {
  indexCommits, commitsFor, otherCommits, mergeCommitData, commitSessionId, COMMIT_BY, assignRepos, commitsOfRepos,
  toolOf, allCommits, whoMade, whoText, commitsLine, commitsByMonth, matchCommit, commitBands, commitDayFor, sharePct,
} from '../js/commits.js';
import { dateBand } from '../js/plans.js';
import { sampleData } from '../js/sample.js';
import { dateKey } from '../js/util.js';
import { eq, ok, done } from './harness.mjs';

const t = (day, h) => new Date(`2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00`).getTime();
const c = (id, day, h, by = 'you', session = null) => ({ id: id.padEnd(40, '0'), short: id, at: t(day, h), subject: `msg ${id}`, ref: 'main', by, session });
const data = {
  folders: { '/w/app': '/w/app', '/w/app/sub': '/w/app', '/w/lib': '/w/lib', '/w/plain': null },
  repos: {
    '/w/app': { name: 'app', commits: [c('a1', 8, 10), c('a2', 9, 15, 'claude', 'uuid-1'), c('a3', 9, 11, 'claude?')] },
    '/w/lib': { name: 'lib', commits: [c('l1', 9, 9), c('l2', 7, 9, 'nonsense')] },
  },
};
const ix = indexCommits(data);

eq('every commit indexed, newest first per repo', [ix.count, ix.byRepo.get('/w/app').map((x) => x.short)], [5, ['a2', 'a3', 'a1']]);
eq('each knows its local day and repo', [ix.byRepo.get('/w/app')[0].day, ix.byRepo.get('/w/app')[0].repoName], [dateKey(t(9, 15)), 'app']);
eq('an unknown "by" is read as you', ix.byRepo.get('/w/lib')[1].by, 'you');
eq('nothing to index', [indexCommits(null), indexCommits({})], [null, null]);

eq('a folder\'s commits come from its repo', commitsFor(ix, ['/w/app']).map((x) => x.short), ['a2', 'a3', 'a1']);
eq('…a subfolder of the repo too, and each commit once', commitsFor(ix, ['/w/app', '/w/app/sub']).map((x) => x.short), ['a2', 'a3', 'a1']);
eq('…narrowed to a day', commitsFor(ix, ['/w/app'], dateKey(t(9, 0))).map((x) => x.short), ['a2', 'a3']);
eq('a folder outside any repo, or none: no commits', [commitsFor(ix, ['/w/plain']), commitsFor(ix, []), commitsFor(null, ['/w/app'])], [[], [], []]);
eq('two repos together, newest first', commitsFor(ix, ['/w/app', '/w/lib']).map((x) => x.short), ['a2', 'a3', 'l1', 'a1', 'l2']);

eq('a day\'s commits in repos without a chat that day', otherCommits(ix, ['/w/app'], dateKey(t(9, 0))).map((x) => x.short), ['l1']);
eq('…none when every repo had a chat', otherCommits(ix, ['/w/app', '/w/lib'], dateKey(t(9, 0))), []);

eq('the chat a Claude commit links to', [commitSessionId(ix.byRepo.get('/w/app')[0]), commitSessionId(ix.byRepo.get('/w/app')[2])], ['code:uuid-1.jsonl', null]);
eq('who made it, in words', [COMMIT_BY.you, COMMIT_BY.claude, COMMIT_BY['claude?']], ['you', 'Claude', 'probably Claude']);

const merged = mergeCommitData(data, { folders: { '/s': '/s' }, repos: { '/s': { name: 's', commits: [c('s1', 9, 8)] } } });
eq('the sample\'s commits join yours', [Object.keys(merged.repos).length, merged.folders['/s']], [3, '/s']);
eq('…either side may be missing', [mergeCommitData(null, data), mergeCommitData(data, null)], [data, data]);

// A commit two repos share (a clone, a worktree) is one commit, with the strongest tag
const shared = indexCommits({
  folders: { '/w/a': '/w/a', '/w/a-clone': '/w/a-clone' },
  repos: {
    '/w/a': { name: 'a', commits: [c('s1', 9, 10, 'you'), c('s2', 9, 11)] },
    '/w/a-clone': { name: 'a-clone', commits: [c('s1', 9, 10, 'claude', 'uuid-9')] },
  },
});
eq('a shared commit counts once', shared.count, 2);
eq('…and every copy says Claude made it, with its chat', [shared.byRepo.get('/w/a')[1].by, shared.byRepo.get('/w/a')[1].session], ['claude', 'uuid-9']);
eq('…listed once when both folders show', commitsFor(shared, ['/w/a', '/w/a-clone']).map((x) => x.short), ['s2', 's1']);
eq('…and not again under "other folders"', otherCommits(shared, ['/w/a'], dateKey(t(9, 0))), []);

// A day's folder groups: each repo's commits under one group
const groups = [
  { folder: '/w/app/sub', folders: ['/w/app/sub'] },   // a folder inside the repo, listed first
  { folder: '/w/app', folders: ['/w/app'] },           // the repo's own folder: it owns them
  { folder: '/w/lib', folders: ['/w/lib'] },
  { folder: null, folders: [] },                       // "No folder"
];
eq('the repo\'s own folder owns its commits; others list nothing twice', assignRepos(ix, groups), [[], ['/w/app'], ['/w/lib'], []]);
eq('…without the repo\'s own folder, the first group in it', assignRepos(ix, [groups[0], groups[2]]), [['/w/app'], ['/w/lib']]);
eq('commits of chosen repos, on a day', commitsOfRepos(ix, ['/w/lib'], dateKey(t(9, 0))).map((x) => x.short), ['l1']);

// Every AI tool's tags, and the chat each app's record links to
eq('every tool, sure or probably, in words', [COMMIT_BY.copilot, COMMIT_BY['copilot?'], COMMIT_BY.cursor, COMMIT_BY.aider, COMMIT_BY.ai],
  ['Copilot', 'probably Copilot', 'Cursor', 'Aider', 'an AI']);
eq('the tool a tag names', [toolOf('you'), toolOf('claude'), toolOf('copilot?')], [null, 'claude', 'copilot']);
const linked = (app) => commitSessionId({ session: 'abc', app });
eq('the chat each app\'s record links to', [linked('code'), linked(null), linked('cowork'), linked('copilot'), linked('copilot-cli')],
  ['code:abc.jsonl', 'code:abc.jsonl', 'cowork:abc.jsonl', 'copilot:abc', 'copilot-cli:abc']);
const viaApp = indexCommits({ folders: {}, repos: {
  '/w/a': { name: 'a', commits: [{ ...c('v1', 9, 10, 'copilot'), via: 'record', app: 'copilot-cli', session: 'cli-1' }] },
  '/w/b': { name: 'b', commits: [{ ...c('v1', 9, 10, 'copilot'), via: 'line', app: 'copilot' }] },
} });
eq('a shared commit keeps the copy that links a chat, and its app', ['/w/a', '/w/b'].map((r) => [viaApp.byRepo.get(r)[0].app, viaApp.byRepo.get(r)[0].session]),
  [['copilot-cli', 'cli-1'], ['copilot-cli', 'cli-1']]);

// One commit under two IDs in two clones (rebased in one): counted once, made by whoever made the first copy
const cl = (id, committed, by, session = null) => ({ ...c(id, 9, 10, by, session), subject: 'retry', committed });
const clones = indexCommits({ folders: {}, repos: {
  '/w/a': { name: 'a', commits: [{ ...cl('r1', t(9, 12), 'you') }] },
  '/w/b': { name: 'b', commits: [{ ...cl('o1', t(9, 10), 'claude', 'uuid-3'), via: 'record', app: 'code' }] },
} });
eq('a commit copied across clones counts once', [clones.count, allCommits(clones).length], [1, 1]);
eq('…as its first copy\'s maker, in both', ['/w/a', '/w/b'].map((r) => clones.byRepo.get(r)[0].by), ['claude', 'claude']);
const sameSecond = indexCommits({ folders: {}, repos: { '/w/a': { name: 'a', commits: [cl('s1', t(9, 10), 'you'), cl('s2', t(9, 10), 'you')] } } });
eq('…but commits made in one second stay apart', sameSecond.count, 2);

// Who made them: a day's, a week's, a month's
const mix = indexCommits({ folders: {}, repos: { '/w/m': { name: 'm', commits: [
  c('m1', 8, 9), c('m2', 9, 9, 'claude'), c('m3', 9, 10, 'claude?'), c('m4', 9, 11, 'copilot'), c('m5', 9, 12),
  { ...c('m6', 1, 9), at: new Date('2026-09-30T09:00:00').getTime() },
] } } });
eq('every commit once, narrowed by day', [allCommits(mix).length, allCommits(mix, dateKey(t(9, 0)), dateKey(t(9, 0))).map((x) => x.short)], [6, ['m5', 'm4', 'm3', 'm2']]);
const who = whoMade(allCommits(mix));
eq('who made them, tools in a fixed order', [who.total, who.you, who.tools.map((x) => [x.tool, x.n, x.maybe])], [6, 3, [['claude', 2, 1], ['copilot', 1, 0]]]);
eq('…in words', whoText(who), '2 by Claude (1 probably), 1 by Copilot');
eq('a day\'s line', [commitsLine(allCommits(mix, dateKey(t(8, 0)), dateKey(t(8, 0)))), commitsLine([])], ['1 commit', '']);
eq('…with AI tools', commitsLine(allCommits(mix, dateKey(t(9, 0)), dateKey(t(9, 0)))), '4 commits · 2 by Claude (1 probably), 1 by Copilot');
eq('month by month, newest first', commitsByMonth(mix).map((m) => [m.month, m.who.total]), [['2026-10', 5], ['2026-09', 1]]);
eq('all probably', whoText(whoMade([c('p', 9, 9, 'claude?')])), '1 by Claude (probably)');

// The Commits page: Made by, a repo, words
const page = allCommits(mix).concat(allCommits(ix));
const pick = (f) => page.filter((x) => matchCommit(x, f)).map((x) => x.short).sort();
eq('Made by: you', pick({ who: 'you' }), ['a1', 'l1', 'l2', 'm1', 'm5', 'm6']);
eq('…a tool, with its "probably" ones', pick({ who: 'claude' }), ['a2', 'a3', 'm2', 'm3']);
eq('…a repo', pick({ repo: '/w/lib' }), ['l1', 'l2']);
eq('words: each in the message, repo or branch', [pick({ q: 'MSG  m4' }), pick({ q: 'lib' }), pick({ q: 'msg zz' })], [['m4'], ['l1', 'l2'], []]);
eq('…or the start of the ID', [pick({ q: 'a20' }), pick({ q: '0000a2' })], [['a2'], []]);
eq('…all at once', pick({ who: 'you', repo: '/w/app', q: 'a' }), ['a1']);
eq('a share that isn\'t 0 or 100 never says so', [sharePct(1, 300), sharePct(299, 300), sharePct(1, 4), sharePct(0, 0)], ['<1', '>99', '25', '0']);

// Bands: this week, earlier this month, then a month each; each day once, newest first
const today = '2026-10-21';  // a Wednesday
const day = (k, h, id) => ({ id: id.padEnd(40, '0'), short: id, day: k, at: new Date(`${k}T${String(h).padStart(2, '0')}:00:00`).getTime() });
const timeline = [day('2026-10-21', 9, 'w2'), day('2026-10-19', 15, 'w1b'), day('2026-10-19', 10, 'w1'), day('2026-10-02', 9, 'r1'), day('2026-09-30', 9, 's1'), day('2026-08-04', 9, 'g1')];
const bands = commitBands(timeline, (k) => dateBand(k, today));
eq('bands, newest first', bands.map((b) => [b.id, b.kind, b.n]), [['week', 'week', 3], ['2026-10', 'rest', 1], ['2026-09', 'month', 1], ['2026-08', 'month', 1]]);
eq('…a day\'s commits together, newest first', bands[0].days.map((d) => [d.key, d.commits.map((x) => x.short)]), [['2026-10-21', ['w2']], ['2026-10-19', ['w1b', 'w1']]]);

// The day a link lands on: the newest with commits on or before it (a week's Sunday, a month's last day)
eq('a day with commits', commitDayFor(timeline, '2026-10-19'), '2026-10-19');
eq('…a week by its Sunday, a month by its days', [commitDayFor(timeline, '2026-10-25'), commitDayFor(timeline, '2026-09'), commitDayFor(timeline, '2026-10')], ['2026-10-21', '2026-09-30', '2026-10-21']);
eq('…a quiet day: the one before', commitDayFor(timeline, '2026-09-15'), '2026-08-04');
eq('…before them all: the first', [commitDayFor(timeline, '2026-01-01'), commitDayFor([], '2026-10-19')], ['2026-08-04', null]);

const sample = indexCommits(sampleData().commits);
ok(sample.count === 8 && ['claude', 'claude?', 'copilot', 'cursor', 'you'].every((by) => [...sample.byRepo.values()].flat().some((x) => x.by === by)),
  'the sample has commits by Claude, probably Claude, Copilot, Cursor and you');

done();
