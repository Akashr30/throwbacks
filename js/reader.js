// reader.js — the conversation that opens beside the day: one session
// (that day's part, or all of it) or a whole folder as one chat. Your
// messages are bubbles; the AI's replies are full-width prose, so long
// answers read like a document. Everything goes in as text nodes: code
// fences become code blocks, light Markdown (headings, lists, **bold**,
// `code`) is shaped, and paths and URLs become chips — a URL opens in a new
// tab, a file inside the folder opened with "Choose folder" opens a
// read-only preview, any other path is copied. Paths in code are left alone.

import { detectTokens, joinPath, midTruncate } from './linkify.js';
import { icon, iconButton, closeButton } from './icons.js';
import { el, dateKey } from './util.js';
import { fmtDuration } from './time.js';
import { appOf, dayGroups } from './plans.js';
import { liveWhere, sourceText } from './resume.js';
import { h, appMark, showToast, copyText, modalTitle, fmtShort, fmtClock } from './ui.js';

const CHUNK = 160;     // messages drawn at once; earlier ones on request
const LONG = 3000;     // characters shown before "Show all"

// ---------------------------------------------------------------------------
// File chips: preview when the file is inside the opened folder, else copy
// ---------------------------------------------------------------------------

const chipServices = { resolveFile: null };

/** main.js provides the resolver (it owns the picked folder's handle). */
export function configureChips(services) {
  Object.assign(chipServices, services);
}

async function openFileChip(path) {
  if (chipServices.resolveFile) {
    let file = null;
    try {
      file = await chipServices.resolveFile(path);
    } catch { /* fall back to copying */ }
    if (file) {
      showFilePreview(path, file);
      return;
    }
  }
  showToast((await copyText(path)) ? 'Path copied' : 'Couldn’t copy');
}

const PREVIEW_CAP = 400000; // characters shown; larger files are cut

function showFilePreview(path, file) {
  const overlay = el('div', 'modal-overlay');
  const modal = h('div', { class: 'modal modal-wide', role: 'dialog', 'aria-modal': 'true' });
  const copyBtn = iconButton('btn btn-small', 'copy', 'Copy path', 14);
  copyBtn.addEventListener('click', async () => showToast((await copyText(path)) ? 'Path copied' : 'Couldn’t copy'));
  const closeBtn = closeButton('Close preview');
  const pre = el('pre', 'preview-pre');
  pre.textContent = file.text.length > PREVIEW_CAP
    ? `${file.text.slice(0, PREVIEW_CAP)}\n\n… cut at ${PREVIEW_CAP.toLocaleString()} of ${file.text.length.toLocaleString()} characters — read-only preview`
    : file.text;
  modal.append(
    h('div', { class: 'modal-head' }, modalTitle('file', file.name), h('div', { class: 'preview-actions' }, copyBtn, closeBtn)),
    el('div', 'preview-path', path), pre,
    el('div', 'preview-note', 'Read-only preview of the file as it is on disk now.'));
  overlay.append(modal);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

/** Prose with URL and file chips (relative paths completed from the session's folder). */
function chips(text, startDir) {
  const frag = document.createDocumentFragment();
  for (const tok of detectTokens(text)) {
    if (tok.type === 'url') {
      frag.append(h('a', {
        class: 'chip-inline chip-url', href: tok.value, target: '_blank', rel: 'noopener noreferrer', title: tok.value,
      }, h('span', { class: 'chip-glyph' }, icon('link', 12)), midTruncate(tok.value)));
    } else if (tok.type === 'file') {
      const full = tok.abs || !startDir ? tok.value : joinPath(startDir, tok.value);
      frag.append(h('button', {
        type: 'button', class: 'chip-inline chip-file', title: `${full} — click to open or copy`,
        onclick: (e) => { e.stopPropagation(); openFileChip(full); },
      }, h('span', { class: 'chip-glyph' }, icon('file', 12)), midTruncate(full)));
    } else {
      frag.append(document.createTextNode(tok.value));
    }
  }
  return frag;
}

/** One line: `code` spans, **bold**, and chips in the rest. */
function inline(line, startDir) {
  const frag = document.createDocumentFragment();
  for (const seg of line.split(/(`[^`\n]+`)/)) {
    if (!seg) continue;
    if (/^`[^`\n]+`$/.test(seg)) {
      frag.append(h('code', null, seg.slice(1, -1)));
      continue;
    }
    seg.split(/(\*\*[^*\n]+\*\*)/).forEach((part) => {
      if (/^\*\*[^*\n]+\*\*$/.test(part)) frag.append(h('strong', null, chips(part.slice(2, -2), startDir)));
      else if (part) frag.append(chips(part, startDir));
    });
  }
  return frag;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/** Message text as paragraphs, headings, lists and code blocks — never as HTML. */
export function formatText(text, startDir = null) {
  const frag = document.createDocumentFragment();
  String(text).split('```').forEach((part, i) => {
    if (i % 2 === 1) {
      let code = part;
      let lang = '';
      const nl = code.indexOf('\n');
      if (nl !== -1 && /^[\w+#.-]{0,24}$/.test(code.slice(0, nl).trim())) {
        lang = code.slice(0, nl).trim();
        code = code.slice(nl + 1);
      }
      frag.append(h('pre', { class: 'code' }, lang ? h('span', { class: 'code-lang' }, lang) : null,
        h('code', null, code.replace(/\n+$/, ''))));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      const t = para.replace(/^\n+|\s+$/g, '');
      if (!t.trim()) continue;
      const lines = t.split('\n');
      if (lines.every((l) => BULLET.test(l))) {
        const ordered = /^\s*\d/.test(lines[0]);
        frag.append(h(ordered ? 'ol' : 'ul', null, lines.map((l) => h('li', null, inline(l.replace(BULLET, ''), startDir)))));
        continue;
      }
      if (lines.length === 1 && HEADING.test(lines[0])) {
        frag.append(h('p', { class: 'md-h' }, inline(lines[0].replace(HEADING, ''), startDir)));
        continue;
      }
      const p = h('p');
      lines.forEach((l, j) => {
        if (j) p.append(h('br'));
        p.append(inline(l, startDir));
      });
      frag.append(p);
    }
  });
  return frag;
}

function messageBody(m) {
  const box = h('div', { class: 'msg-text' });
  if (m.text.length <= LONG) {
    box.append(formatText(m.text, m.startDir));
    return box;
  }
  box.append(formatText(`${m.text.slice(0, LONG).trimEnd()}…`, m.startDir));
  const more = h('button', { type: 'button', class: 'link-btn show-all', text: `Show all (${Math.round(m.text.length / 1000)}k characters)` });
  more.addEventListener('click', () => {
    box.textContent = '';
    box.append(formatText(m.text, m.startDir));
  });
  box.append(more);
  return box;
}

function messageNode(m) {
  const you = m.sender === 'human';
  const time = h('time', { class: 'msg-time' }, `${m.approxTs ? '~' : ''}${fmtClock(m.ts)}`);
  if (m.approxTs) time.title = 'Approximate: this app stored no time for this message';
  return h('div', { class: `msg ${you ? 'is-you' : 'is-ai'}`, dataset: { mid: m.id } },
    h('div', { class: you ? 'bubble' : 'prose' }, messageBody(m)), time);
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** What to say above a resumable session, or null when there's nothing to warn about. */
function resumeNoteText(info, appName) {
  if (!info) return null;
  if (info.found === false) return `${appName} no longer has this session on this Mac, so it can’t be resumed.`;
  if (info.live && /^(bg|daemon|daemon-worker)$/.test(info.live.kind || '')) {
    return 'It’s running in the background right now. Copy resume command opens that run.';
  }
  if (info.live && liveWhere(info.live) === 'Claude desktop') {
    return 'It’s open right now in Claude desktop. To continue it in Terminal instead, close it there first — '
      + 'two windows on one session mix their messages.';
  }
  if (info.live) {
    return `It’s open right now in ${liveWhere(info.live)}. Close it there first, before you open it anywhere else — `
      + 'two windows on one session mix their messages.';
  }
  if (info.folder && info.exists === false) return `Its folder (${info.folder}) is gone, so the command runs in whatever folder you paste it in.`;
  return null;
}

/**
 * @param {HTMLElement} root the reader pane
 * @param {object} ctx {
 *   model, summaries: {days, sample?}, match(session),
 *   reader: {kind:'session', id, day?, part:'day'|'all', msgId?} | {kind:'folder', path},
 *   canSummarize, onSummarize(id), onClose, onPart(part), onOpenDay(key), onOpenSession(id),
 *   resume(session) → {app, info(): Promise, copy()} | null,
 *   order: 'oldest' | 'newest', onOrder(order) }
 */
export function renderReader(root, ctx) {
  root.textContent = '';
  const { model, reader } = ctx;
  let title = '';
  const meta = [];
  let messages = [];
  let tools = null;
  let lead = null;
  const actions = [];

  if (reader.kind === 'folder') {
    const f = model.getFolder(reader.path);
    if (!f) return;
    const sessions = f.sessions.filter(ctx.match);
    const ids = new Set(sessions.map((s) => s.id));
    messages = f.messages.filter((m) => ids.has(m.sessionId));
    title = f.node.name.split('/').pop();
    meta.push(folderButton(f.node.path), `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${fmtDuration(f.totalMs)}`);
  } else {
    const s = model.getSession(reader.id);
    if (!s) return;
    const app = appOf(s.source);
    const dayPart = reader.part === 'day' && reader.day && s.dayKeys.includes(reader.day);
    messages = dayPart ? s.messages.filter((m) => m.day === reader.day) : s.messages;
    title = s.title;
    let anchor = h('span', { class: 'reader-meta-item' }, appMark(s.source), app.name);
    meta.push(anchor);
    if (s.startDir) {
      anchor = folderButton(s.startDir, s.project);
      meta.push(anchor);
    }
    // Where it lives: the chat's own file (copy the path; Show in Finder), once the server has found it.
    const where = ctx.source ? ctx.source(s) : null;
    if (where) {
      // The last answer is drawn with the header (no jump on a redraw); a fresh one that says
      // something else replaces it once the header is on the page.
      const last = where.last();
      const said = sourceText(last);
      let item = said ? sourceItem(last, said, where) : null;
      if (item) meta.push(item);  // right after the folder: the items below are pushed later
      where.info().then((info) => {
        if (!info || !anchor.isConnected || JSON.stringify(info) === JSON.stringify(last)) return;
        const fresh = sourceText(info);
        const next = fresh ? sourceItem(info, fresh, where) : null;
        if (item && item.isConnected) {
          if (next) item.replaceWith(next);
          else {
            if (item.previousElementSibling && item.previousElementSibling.classList.contains('sep')) item.previousElementSibling.remove();
            item.remove();  // the file is gone now
          }
        } else if (next) {
          anchor.after(h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), next);
        }
        item = next;
      });
    } else if (s.exportName) {
      meta.push(h('span', { class: 'reader-meta-item', title: 'From your claude.ai export. The browser isn’t told which folder that file was in.' },
        icon('file', 13), s.exportName));
    }
    if (s.kept) {
      meta.push(h('span', { class: 'reader-meta-item is-kept', title: s.onlyKept
        ? 'Claude Code has deleted the original; Throwbacks keeps this copy on this Mac (Expiring)'
        : 'Throwbacks keeps a copy on this Mac (Expiring)' }, icon('lock', 12), s.onlyKept ? 'Kept copy only' : 'Kept'));
    }
    meta.push(dayPart
      ? `${fmtDuration(s.dayMs.get(reader.day) || 0)} on ${fmtShort(reader.day)}`
      : `${fmtDuration(s.totalMs)}${s.dayKeys.length > 1 ? ` over ${s.dayKeys.length} days` : ''} · ${s.msgCount} messages`);
    // Pick it up again where it lives: a command to paste, never run by Throwbacks.
    const resume = ctx.resume ? ctx.resume(s) : null;
    let resumeNote = null;
    if (resume && resume.desktop) {
      actions.push(h('a', {
        class: 'btn btn-small', href: resume.desktop, 'aria-label': 'Open in Claude desktop',
        title: 'Opens this same session in Claude desktop (Chrome asks the first time).',
      }, icon('monitor', 14), h('span', { class: 'btn-label' }, 'Open in Claude desktop')));
    }
    if (resume) {
      actions.push(h('button', {
        type: 'button', class: 'btn btn-small', 'aria-label': 'Copy resume command',
        title: `Copies a command for Terminal that continues this same session in ${app.name}. `
          + 'Continuing uses your plan, and a long session’s history is sent again with your first message.',
        onclick: resume.copy,
      }, icon('terminal', 14), h('span', { class: 'btn-label' }, 'Copy resume command')));
      resumeNote = h('p', { class: 'reader-note', hidden: true });
      resume.info().then((info) => {
        const say = resumeNoteText(info, app.name);
        if (!say || !resumeNote.isConnected) return;
        const box = resumeNote.closest('.reader-body');
        const at = box ? box.scrollTop : 0;
        resumeNote.append(icon('info', 14), h('span', null, say));
        resumeNote.hidden = false;
        // It arrives after the view has scrolled to the latest day: keep that day where it was.
        if (box && at > 0) box.scrollTop = at + resumeNote.offsetHeight;
      });
    }
    if (ctx.canSummarize) {
      actions.push(h('button', {
        type: 'button', class: 'btn btn-small btn-brand', 'aria-label': 'Summarize', title: 'Summarize this whole session (AI)',
        onclick: () => ctx.onSummarize(s.id),
      }, icon('sparkles', 14), h('span', { class: 'btn-label' }, 'Summarize')));
    }

    if (reader.day && s.dayKeys.length > 1) {
      tools = h('div', { class: 'reader-tools' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
          h('button', { type: 'button', class: `seg-btn${dayPart ? ' is-on' : ''}`, 'aria-pressed': String(dayPart), onclick: () => ctx.onPart('day') }, `${fmtShort(reader.day)} only`),
          h('button', { type: 'button', class: `seg-btn${dayPart ? '' : ' is-on'}`, 'aria-pressed': String(!dayPart), onclick: () => ctx.onPart('all') }, 'Whole session')),
        h('div', { class: 'reader-days' }, s.dayKeys.map((k) => h('button', {
          type: 'button', class: `day-pill${k === reader.day ? ' is-on' : ''}`, title: `Open ${fmtShort(k)}`,
          onclick: () => ctx.onOpenDay(k),
        }, fmtShort(k)))));
    }

    // What the day summaries say about this session
    const said = (dayPart ? [reader.day] : s.dayKeys).map((k) => {
      const c = ctx.summaries.days[k] && ctx.summaries.days[k].chats && ctx.summaries.days[k].chats[s.id];
      return c && c.lines && c.lines.length ? { key: k, lines: c.lines } : null;
    }).filter(Boolean);
    const parts = [];
    if (resumeNote) parts.push(resumeNote);
    // The chat's own whole-session summary (its Summarize button), newest, when there is one.
    const own = !dayPart && ctx.chatSummary ? ctx.chatSummary(s.id) : null;
    if (own && (own.entry.recap || (own.entry.perSession || []).length)) {
      const bullets = (own.entry.perSession || []).flatMap((p) => p.bullets || []);
      parts.push(h('section', { class: 'reader-lead' },
        h('div', { class: 'reader-lead-head' }, icon('sparkles', 14), 'Summary of this chat',
          h('span', { class: 'reader-lead-when' }, `· ${fmtShort(dateKey(own.entry.at))}`),
          ctx.onOpenSummary ? h('button', { type: 'button', class: 'link-btn reader-lead-open', onclick: () => ctx.onOpenSummary(own.id) }, 'On the Summaries page') : null),
        own.entry.recap ? h('p', { class: 'reader-lead-recap' }, own.entry.recap) : null,
        !own.entry.recap && bullets.length ? h('ul', null, bullets.map((b) => h('li', null, b))) : null));
    }
    if (said.length) {
      parts.push(h('section', { class: 'reader-lead' },
        h('div', { class: 'reader-lead-head' }, icon('sparkles', 14), 'From the day summary'),
        said.map((d) => h('div', { class: 'reader-lead-day' },
          said.length > 1 || !dayPart ? h('div', { class: 'reader-lead-date' }, fmtShort(d.key)) : null,
          h('ul', null, d.lines.map((l) => h('li', null, l)))))));
    }
    if (s.approxTimes) {
      parts.push(h('p', { class: 'reader-note' }, icon('info', 14),
        `${app.name} didn’t save message times, so they’re spaced a minute apart (marked ~).`));
    }
    lead = parts.length ? h('div', null, parts) : null;
  }

  const close = h('button', { type: 'button', class: 'icon-btn reader-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: ctx.onClose },
    h('span', { class: 'only-wide' }, icon('x', 18)), h('span', { class: 'only-narrow' }, icon('arrow-left', 18)));
  // The title gets the whole width (two lines at most), then what it is and where it lives on one
  // line, then its buttons on a row of their own — so none of them squeezes the others.
  const head = h('header', { class: 'reader-head' },
    close,
    h('div', { class: 'reader-titles' },
      h('h2', { class: 'reader-title', title }, title),
      h('div', { class: 'reader-meta' }, meta.map((m, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '·') : null, m])),
      actions.length ? h('div', { class: 'reader-actions' }, actions) : null));
  // Oldest first (reading order, opening at the latest day) or the newest day
  // on top — offered when what's shown spans more than one day; remembered.
  const multiDay = new Set(messages.map((m) => m.day)).size > 1;
  const newest = multiDay && ctx.order === 'newest';
  if (multiDay && ctx.onOrder) {
    const orderSeg = h('div', { class: 'seg reader-order', role: 'group', 'aria-label': 'Order' },
      [['oldest', 'Oldest first'], ['newest', 'Newest first']].map(([id, label]) => {
        const on = (id === 'newest') === newest;
        return h('button', { type: 'button', class: `seg-btn${on ? ' is-on' : ''}`, 'aria-pressed': String(on), onclick: () => !on && ctx.onOrder(id) }, label);
      }));
    if (tools) tools.prepend(orderSeg);
    else tools = h('div', { class: 'reader-tools' }, orderSeg);
  }
  const list = h('div', { class: 'msgs' });
  const scroller = h('div', { class: 'reader-body' }, lead, list);
  root.append(...[head, tools, scroller].filter(Boolean));

  // Draw from `start`; earlier messages on request.
  let start = reader.kind === 'session' && reader.part === 'day' ? 0 : Math.max(0, messages.length - CHUNK);
  if (reader.msgId) {
    const at = messages.findIndex((m) => m.id === reader.msgId);
    if (at !== -1) start = Math.min(start, Math.max(0, at - 20));
  }
  // Opened from a commit: a marker after the last message before it was made (before the first, if none).
  const commit = reader.kind === 'session' && reader.commit ? reader.commit : null;
  let afterId = null;
  if (commit) {
    let at = -1;
    messages.forEach((m, i) => { if (m.ts <= commit.at + 1000) at = i; });
    afterId = at === -1 ? null : messages[at].id;
    start = Math.min(start, Math.max(0, at - 20));
  }
  const commitMark = () => h('div', { class: 'msg-commit', role: 'note' },
    icon('commit', 14), h('b', null, 'This commit was made here'),
    h('span', { class: 'msg-commit-subject' }, commit.subject || '(no message)'),
    h('code', { class: 'msg-commit-id' }, commit.short), h('span', { class: 'msg-commit-when' }, fmtClock(commit.at)));
  const draw = () => {
    list.textContent = '';
    // Older messages on request: above (oldest first) or below (newest day on top).
    const more = start > 0 ? h('button', {
      type: 'button', class: 'btn btn-small earlier',
      onclick: () => { start = Math.max(0, start - CHUNK); draw(); },
    }, `Show ${Math.min(CHUNK, start)} ${newest ? 'older' : 'earlier'} messages`) : null;
    if (more && !newest) list.append(more);
    let lastSession = null;
    for (const g of dayGroups(messages.slice(start), newest)) {
      if (multiDay) {
        list.append(h('div', { class: 'msg-day' }, h('button', {
          type: 'button', class: 'day-pill', title: `Open ${fmtShort(g.day)}`, onclick: () => ctx.onOpenDay(g.day),
        }, fmtShort(g.day))));
      }
      if (newest) lastSession = null;  // days out of order: each one says whose messages follow
      for (const m of g.messages) {
        if (reader.kind === 'folder' && m.sessionId !== lastSession) {
          const s = model.getSession(m.sessionId);
          list.append(h('button', {
            type: 'button', class: 'msg-session', title: 'Open this session', onclick: () => ctx.onOpenSession(s.id),
          }, appMark(s.source), h('span', null, s.title), icon('chevron-right', 13)));
          lastSession = m.sessionId;
        }
        if (commit && afterId === null && !list.querySelector('.msg-commit')) list.append(commitMark());
        list.append(messageNode(m));
        if (commit && m.id === afterId) list.append(commitMark());
      }
    }
    if (more && newest) list.append(more);
    if (!messages.length) list.append(h('p', { class: 'empty-note' }, 'Nothing to show under the current tool filter.'));
  };
  draw();

  // Where it opens: a search hit; a day's part, or the newest day on top,
  // from the top; otherwise (oldest first) the latest day — its date at the
  // top, its messages below — since the latest messages are what's drawn
  // (the 160 before them would hide today's).
  // setTimeout, not rAF: rAF pauses in hidden tabs.
  setTimeout(() => {
    const mark = list.querySelector('.msg-commit');
    if (mark) {
      mark.classList.add('is-hit');
      mark.scrollIntoView({ block: 'center' });
      return;
    }
    const hit = reader.msgId && list.querySelector(`[data-mid="${CSS.escape(reader.msgId)}"]`);
    if (hit) {
      hit.classList.add('is-hit');
      hit.scrollIntoView({ block: 'center' });
      return;
    }
    scroller.scrollTop = 0;
    if (newest || (reader.kind === 'session' && reader.part === 'day')) return;  // the top is where to start
    const days = list.querySelectorAll('.msg-day');
    if (days.length > 1) {
      const latest = days[days.length - 1];
      scroller.scrollTop = latest.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
    } else if (!days.length && start > 0) {
      scroller.scrollTop = scroller.scrollHeight;  // one long day, cut: open at its end
    }
  });
}

/** The chat's own file: its name (click to copy the full path) and, on a Mac, Show in Finder. */
function sourceItem(info, said, where) {
  return h('span', { class: 'reader-meta-item reader-source' },
    h('button', {
      type: 'button', class: 'reader-folder', title: said.title, 'aria-label': `Copy the path of ${said.name}`,
      onclick: async () => showToast((await copyText(info.path)) ? said.toast : 'Couldn’t copy'),
    }, icon('file', 13), h('span', { class: 'reader-meta-text' }, midTruncate(said.name, 44))),
    info.reveal ? h('button', {
      type: 'button', class: 'reader-reveal', title: 'Show in Finder', 'aria-label': `Show ${said.name} in Finder`, onclick: where.reveal,
    }, icon('folder-open', 13)) : null);
}

/** The session's folder: click to copy its full path. */
function folderButton(path, name) {
  return h('button', {
    type: 'button', class: 'reader-meta-item reader-folder', title: `${path} — click to copy`,
    onclick: async () => showToast((await copyText(path)) ? 'Folder path copied' : 'Couldn’t copy'),
  }, icon('folder', 13), h('span', { class: 'reader-meta-text' }, name || midTruncate(path, 48)));
}
