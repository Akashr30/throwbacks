// commitview.js — how a commit looks on the journal: its message, who made
// it (you, or an AI tool — Claude, Copilot, Cursor… — or "probably" one),
// when, its branch and short ID (click to copy). A commit an AI tool's
// record shows it ran links to the chat that ran it. Commit messages are
// only ever text.

import { icon } from './icons.js';
import { COMMIT_BY, TOOLS, toolOf, commitSessionId } from './commits.js';
import { SERIES, OTHER_COLOR } from './charts.js';
import { appOf } from './plans.js';
import { h, appMark, showToast, copyText, fmtShort, fmtClock } from './ui.js';

/** Commits' colors follow the tool, as the apps' do; another AI tool in ink, you in gray. */
const TOOL_COLOR = { claude: SERIES[1], copilot: SERIES[2], cursor: SERIES[3] };
const OTHER_AI = 'var(--lg-ink-2)';

/**
 * Who made these commits (commits.js whoMade) as a share bar's parts: you,
 * then Claude, Copilot and Cursor in their own colors, and any other AI
 * tool together in one.
 */
export function whoShares(who) {
  const own = who.tools.filter((t) => TOOL_COLOR[t.tool]);
  const rest = who.tools.filter((t) => !TOOL_COLOR[t.tool]);
  const other = rest.length ? { name: rest.length === 1 ? rest[0].name : 'Other AI tools', n: rest.reduce((x, t) => x + t.n, 0), maybe: rest.reduce((x, t) => x + t.maybe, 0) } : null;
  return [{ label: 'You', value: who.you, color: OTHER_COLOR },
    ...own.map((t) => ({ label: t.maybe ? `${t.name} (${t.maybe} probably)` : t.name, value: t.n, color: TOOL_COLOR[t.tool] })),
    ...(other ? [{ label: other.maybe ? `${other.name} (${other.maybe} probably)` : other.name, value: other.n, color: OTHER_AI }] : [])]
    .filter((d) => d.value);
}

/** Why the tag says who it says. */
function byWhy(c) {
  const tool = toolOf(c.by);
  if (!tool) return 'No sign an AI made it: you, in a terminal or an editor';
  const name = TOOLS[tool] ? TOOLS[tool].name : tool;
  const app = c.app ? appOf(c.app).name : name;
  switch (c.via) {
    case 'record': return `${app}’s own record says it ran this commit`;
    case 'copy': return `${app}’s own record says it made this commit, amended or rebased since`;
    case 'time': return `Committed while ${app} ran a git commit here (it printed no commit ID, so this is a guess)`;
    case 'author': return `${name} is its author: an AI tool’s own commit that names you`;
    default: return `Its message names ${name} (a co-author line)`;
  }
}

/** Who made it, as a small tag. */
function byTag(c) {
  const tool = toolOf(c.by);
  const mark = tool ? (c.app && (tool === 'copilot' || tool === 'claude') ? c.app : TOOLS[tool] && TOOLS[tool].mark) : null;
  return h('span', { class: `ctag is-${!tool ? 'you' : c.by.endsWith('?') ? 'maybe' : tool}`, title: byWhy(c) },
    mark ? appMark(mark) : null, COMMIT_BY[c.by] || c.by);
}

/**
 * One commit. `date`: show the day too (a folder's list), not only the time.
 * `cols`: in columns that line up down a page — message (and branch) · who ·
 * repo (`repo`: shown) · time · ID — as the Commits page lists them.
 * A commit linked to a chat that's loaded opens it.
 */
export function commitRow(app, c, { date = false, cols = false, repo = false } = {}) {
  const sid = commitSessionId(c);
  const chat = sid && app.view.getSession(sid) ? sid : null;
  const text = h('span', { class: 'crow-subject' }, c.subject || '(no message)');
  const when = h('span', { class: 'crow-when' }, date ? `${fmtShort(c.day)} · ${fmtClock(c.at)}` : fmtClock(c.at));
  const id = h('button', {
    type: 'button', class: 'crow-id', title: `Copy the commit ID (${c.id.slice(0, 12)}…)`, 'aria-label': `Copy commit ID ${c.short}`,
    onclick: async (e) => { e.stopPropagation(); showToast((await copyText(c.id)) ? 'Commit ID copied' : 'Couldn’t copy'); },
  }, c.short);
  const main = chat
    ? h('button', { type: 'button', class: 'crow-main is-link', title: 'Open the chat where this commit was made, at that moment', onclick: () => app.openCommit(chat, c) },
      icon('commit', 15), text)
    : h('span', { class: 'crow-main' }, icon('commit', 15), text);
  const ref = c.ref && !/^(main|master)$/.test(c.ref) ? h('span', { class: 'crow-ref', title: `Branch ${c.ref}` }, c.ref) : null;
  if (cols) {
    return h('div', { class: `crow is-cols${repo ? ' has-repo' : ''}` },
      h('span', { class: 'crow-msg' }, main, ref), h('span', { class: 'crow-who' }, byTag(c)),
      repo ? h('span', { class: 'crow-repo', title: c.repo }, icon('folder', 13), h('span', null, c.repoName)) : null,
      when, id);
  }
  return h('div', { class: 'crow' }, main, byTag(c), ref, when, id);
}

/** A list of commits under a heading ("Commits · 3"), the newest first; long ones fold after `cap`. */
export function commitList(app, commits, { title = 'Commits', date = false, cap = 8 } = {}) {
  if (!commits.length) return null;
  const box = h('div', { class: 'crows' });
  const draw = (n) => {
    box.textContent = '';
    box.append(...commits.slice(0, n).map((c) => commitRow(app, c, { date })));
    if (commits.length > n) {
      box.append(h('button', { type: 'button', class: 'link-btn crows-more', onclick: () => draw(commits.length) },
        `Show all ${commits.length} commits`));
    }
  };
  draw(cap);
  return h('div', { class: 'commits' },
    h('div', { class: 'commits-head' }, icon('commit', 14), h('span', null, title), h('span', { class: 'count' }, String(commits.length))),
    box);
}
