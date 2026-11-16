// commits.js — your git commits on the journal: serve.py lists them per repo
// (POST /api/commits — yours, each tagged by who made it: you, or an AI tool
// whose own record says it ran the commit, or whose mark the commit carries;
// "probably" when its record only shows it ran a commit then), and this
// places them: a day's commits under each of its folders, a folder's commits
// in Sessions → Folder, who made them in Insights. A commit belongs to the
// repo a session folder is in, so a folder inside a repo shows that repo's
// commits. No DOM.

import { dateKey } from './util.js';

/** The AI tools a commit can name, in a fixed order: their names, and the app whose icon shows. */
export const TOOLS = {
  claude: { name: 'Claude', mark: 'code' },
  copilot: { name: 'Copilot', mark: 'copilot' },
  cursor: { name: 'Cursor', mark: 'cursor' },
  codex: { name: 'Codex', mark: 'codex' },
  gemini: { name: 'Gemini' },
  antigravity: { name: 'Antigravity', mark: 'antigravity' },
  aider: { name: 'Aider' },
  opencode: { name: 'OpenCode' },
  devin: { name: 'Devin' },
  ai: { name: 'an AI' },
};
const TOOL_ORDER = Object.keys(TOOLS);

/** The tool a commit's tag names ("claude", "claude?" → "claude"), or null for you. */
export const toolOf = (by) => (by && by !== 'you' ? by.replace(/\?$/, '') : null);

/** Who made a commit, in words: "you", "Claude", "probably Claude"… */
export const COMMIT_BY = {
  you: 'you',
  ...Object.fromEntries(TOOL_ORDER.flatMap((k) => [[k, TOOLS[k].name], [`${k}?`, `probably ${TOOLS[k].name}`]])),
};

const rank = (c) => (c.by === 'you' ? 0 : c.by.endsWith('?') ? 1 : 2) * 2 + (c.session ? 1 : 0);

/**
 * The server's answer (or the sample's), ready to look things up. A commit
 * two repos share (a clone, a worktree) is one commit: its copies agree on
 * the strongest tag and the chat it links to.
 * @param {{folders: {[folder]: string|null}, repos: {[top]: {name, commits: [{id, short, at, subject, ref, by, session}]}}}} data
 * @returns {{byRepo: Map, folderRepo: Map, count: number}|null}
 */
export function indexCommits(data) {
  if (!data || typeof data !== 'object' || !data.repos) return null;
  const byRepo = new Map();
  const byId = new Map();
  for (const [top, repo] of Object.entries(data.repos)) {
    const list = (repo && Array.isArray(repo.commits) ? repo.commits : [])
      .filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.at))
      .map((c) => ({ ...c, by: COMMIT_BY[c.by] ? c.by : 'you', repo: top, repoName: (repo && repo.name) || top, day: dateKey(c.at) }))
      .sort((a, b) => b.at - a.at);
    for (const c of list) {
      const best = byId.get(c.id);
      if (!best || rank(c) > rank(best)) byId.set(c.id, c);
    }
    byRepo.set(top, list);
  }
  for (const list of byRepo.values()) {
    for (const c of list) {
      const best = byId.get(c.id);
      Object.assign(c, { by: best.by, via: best.via || null, app: best.app || null, session: best.session || null, key: c.id });
    }
  }
  // One commit under two IDs in two clones (rebased in one, not yet in the other) keeps its author time and message
  // and gets a new commit time: one commit, made by whoever made the first copy, as serve.py counts copies in a repo.
  // A loop's commits made in one second share both times: they stay apart.
  const copies = new Map();
  for (const list of byRepo.values()) {
    for (const c of list) {
      const k = `${c.at}\0${c.subject}`;
      if (!copies.has(k)) copies.set(k, new Map());
      copies.get(k).set(c.id, c);
    }
  }
  for (const [k, ids] of copies) {
    const times = [...ids.values()].map((c) => c.committed);
    if (ids.size < 2 || times.some((t) => !Number.isFinite(t)) || new Set(times).size < ids.size) continue;
    const first = [...ids.values()].sort((a, b) => a.committed - b.committed)[0];
    for (const list of byRepo.values()) {
      for (const c of list) {
        if (ids.has(c.id)) Object.assign(c, { by: first.by, via: first.via, app: first.app, session: first.session, key: k });
      }
    }
  }
  const count = new Set([...byRepo.values()].flat().map((c) => c.key)).size;
  return { byRepo, folderRepo: new Map(Object.entries(data.folders || {})), count };
}

/** The repos these session folders are in. */
export const reposOf = (index, folders) => new Set(index ? folders.map((f) => index.folderRepo.get(f)).filter(Boolean) : []);

/** Your commits in these repos (each commit once), newest first; `day` narrows to one day. */
export function commitsOfRepos(index, repos, day = null) {
  if (!index) return [];
  const seen = new Set();
  const out = [];
  for (const repo of repos) {
    for (const c of index.byRepo.get(repo) || []) {
      if ((day && c.day !== day) || seen.has(c.key || c.id)) continue;
      seen.add(c.key || c.id);
      out.push(c);
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Your commits in the repos of these session folders (each once), newest first; `day` narrows to one day. */
export const commitsFor = (index, folders, day = null) => commitsOfRepos(index, reposOf(index, folders), day);

/** A day's commits in repos none of these folders is in — work you committed without a chat there that day. */
export function otherCommits(index, folders, day) {
  if (!index) return [];
  const covered = reposOf(index, folders);
  const shown = new Set(commitsOfRepos(index, covered, day).map((c) => c.key || c.id));
  return commitsOfRepos(index, [...index.byRepo.keys()].filter((r) => !covered.has(r)), day).filter((c) => !shown.has(c.key || c.id));
}

/**
 * Which group lists which repo's commits, so a repo shows once on a page:
 * the group whose own folder is the repo's top, else the first group in it.
 * @param {Array<{folder: string|null, folders: string[]}>} groups
 * @returns {Array<string[]>} each group's repos
 */
export function assignRepos(index, groups) {
  const owner = new Map();
  groups.forEach((g, i) => {
    for (const repo of reposOf(index, g.folders)) {
      if (!owner.has(repo) || g.folder === repo) owner.set(repo, i);
    }
  });
  return groups.map((_, i) => [...owner].filter(([, at]) => at === i).map(([repo]) => repo));
}

/** Merge two answers (your repos and the sample's), the later one winning per repo. */
export function mergeCommitData(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return { folders: { ...a.folders, ...b.folders }, repos: { ...a.repos, ...b.repos } };
}

/** How the journal names a session of each app (parse.js). */
const SESSION_ID = {
  code: (s) => `code:${s}.jsonl`, cowork: (s) => `cowork:${s}.jsonl`, copilot: (s) => `copilot:${s}`, 'copilot-cli': (s) => `copilot-cli:${s}`,
};

/** The chat a commit links to (the one whose record ran it), as the journal names it, or null. */
export const commitSessionId = (c) => (c && c.session ? (SESSION_ID[c.app] || SESSION_ID.code)(c.session) : null);

/** Every commit once (across repos), newest first; `from` / `to` (day keys, both included) narrow it. */
export function allCommits(index, from = null, to = null) {
  if (!index) return [];
  const seen = new Map();
  for (const list of index.byRepo.values()) {
    for (const c of list) if (!seen.has(c.key || c.id) && (!from || c.day >= from) && (!to || c.day <= to)) seen.set(c.key || c.id, c);
  }
  return [...seen.values()].sort((a, b) => b.at - a.at);
}

/**
 * Who made these commits: how many are yours, and per tool (in a fixed
 * order) how many it made and how many of those only probably.
 * @returns {{total: number, you: number, tools: Array<{tool: string, name: string, n: number, maybe: number}>}}
 */
export function whoMade(commits) {
  const per = new Map();
  let you = 0;
  for (const c of commits) {
    const tool = toolOf(c.by);
    if (!tool || !TOOLS[tool]) { you++; continue; }
    const t = per.get(tool) || { tool, name: TOOLS[tool].name, n: 0, maybe: 0 };
    t.n++;
    if (c.by.endsWith('?')) t.maybe++;
    per.set(tool, t);
  }
  return { total: commits.length, you, tools: TOOL_ORDER.filter((k) => per.has(k)).map((k) => per.get(k)) };
}

/** "2 by Claude (1 probably), 1 by Copilot" — '' when you made them all. */
export const whoText = (who) => who.tools.map((t) => `${t.n} by ${t.name}${t.maybe ? ` (${t.maybe === t.n ? 'probably' : `${t.maybe} probably`})` : ''}`).join(', ');

/** "5 commits · 2 by Claude" for a day, a week or a month — '' with none. */
export function commitsLine(commits) {
  if (!commits.length) return '';
  const who = whoText(whoMade(commits));
  return `${commits.length} commit${commits.length === 1 ? '' : 's'}${who ? ` · ${who}` : ''}`;
}

/** "18" — the share of `part` in `total` as a whole percent; "<1" and ">99" rather than a 0 or 100 that isn't true. */
export function sharePct(part, total) {
  if (!total) return '0';
  const p = Math.round((part / total) * 100);
  return part && p === 0 ? '<1' : part < total && p === 100 ? '>99' : String(p);
}

/**
 * The Commits page's filters: `who` — 'all', 'you', or a tool ("claude"
 * takes its "probably" ones too); `repo` — one repo's top folder, or '' for
 * every repo; `q` — words in the message, the repo's name or the branch, or
 * the start of the commit ID.
 */
export function matchCommit(c, { who = 'all', repo = '', q = '' } = {}) {
  if (repo && c.repo !== repo) return false;
  if (who !== 'all' && (who === 'you' ? toolOf(c.by) : toolOf(c.by) !== who)) return false;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${c.subject || ''} ${c.repoName || ''} ${c.ref || ''}`.toLowerCase();
  return words.every((w) => text.includes(w) || c.id.startsWith(w));
}

/**
 * Newest-first commits in bands, as Sessions' cards are: `bandOf(day)` names
 * each day's band ({id, kind, at} — plans.js dateBand). Each band holds its
 * days, newest first, each with its commits.
 * @returns {Array<{id, kind, at, n: number, days: Array<{key: string, commits: object[]}>}>}
 */
export function commitBands(commits, bandOf) {
  const bands = new Map();
  for (const c of commits) {
    const b = bandOf(c.day);
    if (!bands.has(b.id)) bands.set(b.id, { ...b, n: 0, days: [] });
    const band = bands.get(b.id);
    const last = band.days[band.days.length - 1];
    if (last && last.key === c.day) last.commits.push(c);
    else band.days.push({ key: c.day, commits: [c] });
    band.n++;
  }
  return [...bands.values()];
}

/**
 * The day a link to the Commits page lands on: `key`, a day ("2026-11-02")
 * or a month ("2026-10"), names the newest day with commits on or before it
 * (a week's line links its Sunday, a month's its last day); else the oldest
 * day after it. Null with no commits.
 */
export function commitDayFor(commits, key) {
  if (!commits.length || !key) return null;
  const until = /^\d{4}-\d{2}$/.test(key) ? `${key}-31` : key;
  const hit = commits.find((c) => c.day <= until);
  return hit ? hit.day : commits[commits.length - 1].day;
}

/** Month by month, newest first: [{month: "YYYY-MM", commits, who}]. */
export function commitsByMonth(index) {
  const months = new Map();
  for (const c of allCommits(index)) {
    const m = c.day.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(c);
  }
  return [...months].map(([month, commits]) => ({ month, commits, who: whoMade(commits) }));
}
