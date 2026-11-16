// expiring.js — the Expiring page. Claude Code deletes a chat once it hasn't
// been touched for cleanupPeriodDays; this page shows how long that is (your
// setting, a warning when short), the chats it deletes within a week — each
// with Keep a copy — and the copies Throwbacks keeps (on this Mac only, in
// ~/.throwbacks/kept), each with Remove copy. Throwbacks never edits or
// deletes anything in ~/.claude.

import { icon } from './icons.js';
import { dateKey } from './util.js';
import { retentionOf, dueSessions, keptSessions, expiresAt, whenIn, SAFE_DAYS, DUE_WITHIN_DAYS } from './keep.js';
import { h, appMark, showToast, copyText, relDay, plural } from './ui.js';

const SETTING = '"cleanupPeriodDays": 365';

export function expiringPage(app) {
  const page = h('section', { class: 'page page-expiring' });
  if (!app.keep) {
    page.append(h('div', { class: 'card empty-card' }, h('p', null,
      'This needs python3 serve.py: it reads how long Claude Code keeps chats, and when each one was last used.')));
    return page;
  }
  const ret = retentionOf(app.keep);
  const all = app.model.listSessions();
  // What to act on first; the setting on top only when it's the problem (short, or Claude Code's default).
  const safety = safetyCard(app, ret);
  const ok = ret.paused || (ret.set && ret.days >= SAFE_DAYS);
  page.append(...(ok ? [dueSection(app, ret, all), keptSection(app, all), safety] : [safety, dueSection(app, ret, all), keptSection(app, all)]));
  return page;
}

/** How long Claude Code keeps a chat — where that comes from, and what to do when it's short. */
function safetyCard(app, ret) {
  const ok = ret.paused || (ret.set && ret.days >= SAFE_DAYS);
  const whose = { managed: 'your organisation’s setting, which overrides yours', project: 'a project’s setting (Claude Code uses it in every project when it starts in that folder)', user: 'your setting', default: 'Claude Code’s default' }[ret.source] || 'your setting';
  const say = ret.paused
    ? `Claude Code isn’t deleting chats right now: cleanupPeriodDays is 0 or not a whole number in ${whose.replace(/,.*$/, '')}, which pauses its cleanup.`
    : `Claude Code deletes a chat ${plural(ret.days, 'day')} after you last used it — ${whose}.`;
  const card = h('section', { class: `card keep-safety${ok ? '' : ' is-warn'}`, 'aria-label': 'How long Claude Code keeps chats' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon(ok ? 'lock' : 'info', 16), 'History safety')),
    h('p', { class: 'keep-say' }, say),
    app.keep.sample ? h('p', { class: 'set-note' }, 'Sample data: a made-up setting, so this page has something to show.') : null);
  if (!ok && ret.source === 'managed') {
    card.append(h('p', { class: 'set-note' }, 'It comes from your organisation, so changing your own settings won’t help — ask your admin, or keep a copy of the chats you need here.'));
  } else if (!ok) {
    card.append(
      h('p', { class: 'set-note' }, 'To keep them longer, add this line to ',
        h('code', null, ret.source === 'project' ? 'that project’s .claude/settings.json' : '~/.claude/settings.json'),
        ' (Throwbacks never edits Claude Code’s settings):'),
      h('div', { class: 'keep-line' }, h('code', null, SETTING),
        h('button', { type: 'button', class: 'btn btn-small', onclick: async () => showToast((await copyText(SETTING)) ? 'Line copied' : 'Couldn’t copy') },
          icon('copy', 14), 'Copy')));
  }
  card.append(h('p', { class: 'set-note' },
    'Claude Code’s /status lists every settings source that can change this. Only Claude Code deletes chats by itself (not the ones started in Claude desktop); '
    + 'Copilot and Cursor keep theirs until you delete the workspace.'));
  return card;
}

/** "today", "yesterday", else the date. */
function lastUsed(ts) {
  const r = relDay(dateKey(ts));
  return /^(today|yesterday)$/i.test(r) ? r.toLowerCase() : fmtDay(ts);
}

/** "17 Sep 2027" — always with the year: these dates can be months away, or long past. */
const fmtDay = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** One chat's row: open it, and one action on the right. */
function row(app, s, meta, action) {
  return h('div', { class: 'xrow' },
    h('button', {
      type: 'button', class: 'xrow-main', title: `Open “${s.title}”`,
      onclick: () => {
        if (!app.view.getSession(s.id)) app.setFilter(null);  // under a tool filter it isn't on screen: show all tools
        app.openSession(s.id, { part: 'all' });
      },
    },
      appMark(s.source, 'md'),
      h('span', { class: 'xrow-text' }, h('span', { class: 'xrow-title' }, s.title), h('span', { class: 'xrow-meta' }, meta))),
    action);
}

/** Busy while it runs, so a second click can't keep (or remove) twice; afterwards the keyboard lands on the list's heading. */
function actionButton(label, aria, cls, iconName, run, focusTo) {
  const b = h('button', { type: 'button', class: `btn btn-small ${cls}`, 'aria-label': aria }, icon(iconName, 14), label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await run(); } finally {
      if (b.isConnected) b.disabled = false;
      const to = document.querySelector(`[data-focus="${focusTo}"]`);
      if (to && !b.isConnected) to.focus({ preventScroll: true });
    }
  });
  return b;
}

function dueSection(app, ret, all) {
  const due = dueSessions(all, ret);
  const box = h('section', { class: 'keep-block', 'aria-label': 'Deleted within a week' },
    h('h2', { class: 'section-title', tabindex: '-1', 'data-focus': 'keep-due' }, 'Deleted within a week', h('span', { class: 'count' }, String(due.length))));
  if (!all.some((x) => x.source === 'code' && Number.isFinite(x.touchedAt))) {
    box.append(h('div', { class: 'card empty-card' }, h('p', null,
      'Throwbacks can’t tell which chats are close: it reads when each one was last used through python3 serve.py '
      + '(not from a chosen folder or dropped files).')));
    return box;
  }
  if (ret.paused) {
    box.append(h('div', { class: 'card empty-card' }, h('p', null, 'Nothing — Claude Code’s cleanup is paused (see History safety).')));
    return box;
  }
  if (!due.length) {
    const next = all.map((s) => ({ s, at: expiresAt(s, ret) })).filter((x) => x.at != null && !x.s.kept).sort((a, b) => a.at - b.at)[0];
    box.append(h('div', { class: 'card empty-card' }, h('p', null,
      `Nothing is deleted in the next ${DUE_WITHIN_DAYS} days.`,
      next ? ` The next chat Claude Code will delete is “${next.s.title}”, on about ${fmtDay(next.at)} — `
        + `${plural(ret.days, 'day')} after you last used it (it’s deleted the first time Claude Code starts after that date).` : '')));
    return box;
  }
  box.append(h('p', { class: 'set-note' },
    `Claude Code deletes these when it next starts after the date. Keep a copy and Throwbacks holds on to it on this Mac — it stays here, with its summaries, after the original is gone.`));
  box.append(h('div', { class: 'card xrows' }, due.map(({ session: s, at, inDays }) => row(app, s,
    [s.project, `last used ${lastUsed(s.touchedAt)}`, `deleted ${whenIn(inDays)} (${fmtDay(at)})`].filter(Boolean).join(' · '),
    actionButton('Keep a copy', `Keep a copy of “${s.title}”`, 'btn-primary', 'download', () => app.keepCopy(s), 'keep-due')))));
  return box;
}

function keptSection(app, all) {
  const kept = keptSessions(all);
  const box = h('section', { class: 'keep-block', 'aria-label': 'Kept copies' },
    h('h2', { class: 'section-title', tabindex: '-1', 'data-focus': 'keep-kept' }, 'Kept by Throwbacks', h('span', { class: 'count' }, String(kept.length))));
  if (!kept.length) {
    box.append(h('div', { class: 'card empty-card' }, h('p', null, 'No copies kept yet. Copies stay on this Mac, in ',
      h('code', null, app.keep.dir ? app.keep.dir.replace(/^\/Users\/[^/]+/, '~') : '~/.throwbacks/kept'), '.')));
    return box;
  }
  const savedAt = new Map((app.keep.kept || []).map((k) => [k.id, k.firstSavedAt || k.savedAt]));
  box.append(h('div', { class: 'card xrows' }, kept.map((s) => {
    const id = s.id.replace(/^code:/, '').replace(/\.jsonl$/, '');
    const when = savedAt.get(id);
    return row(app, s,
      [s.project, s.onlyKept ? 'only here now — Claude Code deleted the original' : 'the original is still in Claude Code',
        when ? `kept ${fmtDay(when)}` : null].filter(Boolean).join(' · '),
      actionButton('Remove copy', `Remove the kept copy of “${s.title}”`, 'btn-ghost', 'trash', () => app.removeCopy(s), 'keep-kept'));
  })));
  return box;
}
