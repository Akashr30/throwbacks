// ui.js — small DOM helpers shared by every page: an element builder
// (strings always go in as text, never as HTML), app and plan marks with
// the real app icons, usage rings, toasts, copying, downloads, dialog
// titles and the date formats the journal uses.

import { icon } from './icons.js';
import { el, dateKey, keyToDate } from './util.js';
import { appIconUrl } from './sources.js';
import { appOf, addDays, daysBetween } from './plans.js';
import { recapBlocks } from './log.js';

/**
 * Build an element. props: class, text, dataset, style (object of CSS
 * properties, custom ones too), on<event> handlers, other attributes
 * (true = present, null/false = absent). Children: nodes or strings.
 */
/**
 * A recap drawn from its parts (log.js recapBlocks): its line, then each
 * project's points under its name, "Still open" last — or its paragraphs, as
 * recaps written before 2026-11-16 are. Text nodes only. `headings: false`
 * where a recap sits inside another (the Month sheet's weeks): names, not headings.
 */
export function recapView(text, className = '', { headings = true } = {}) {
  const box = h('div', { class: `recap${className ? ` ${className}` : ''}` });
  const blocks = recapBlocks(text);
  const parts = blocks.some((b) => b.type === 'group');  // an older recap's first line is just its paragraph
  let list = null;
  for (const b of blocks) {
    if (b.type === 'point') {
      if (!list) box.append(list = h('ul', { class: 'recap-points' }));
      list.append(h('li', null, b.text));
      continue;
    }
    list = null;
    box.append(b.type === 'group'
      ? h(headings ? 'h3' : 'p', { class: `recap-group${/^still open$/i.test(b.text) ? ' is-open' : ''}` }, b.text)
      : h('p', { class: b.type === 'head' && parts ? 'recap-head' : 'recap-para' }, b.text));
  }
  return box;
}

export function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
      } else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

// ---- App and plan marks ----------------------------------------------------

// Apps that share their plan's icon get a small badge, so they stay apart.
const BADGED = new Set(['code', 'cowork', 'web', 'copilot-cli']);

/** A session's app: the app's own icon (with a badge) or a tinted glyph. */
export function appMark(source, size = 'sm') {
  const app = appOf(source);
  const box = h('span', { class: `app-mark src-${source} is-${size}`, title: app.name });
  const url = app.icon && appIconUrl(app.icon);
  if (url) {
    box.append(h('img', { src: url, alt: '', decoding: 'async' }));
    if (BADGED.has(source)) box.append(h('span', { class: 'app-mark-badge' }, icon(app.glyph, 9)));
  } else {
    box.classList.add('is-glyph');
    box.append(icon(app.glyph, size === 'md' ? 15 : 11));
  }
  return box;
}

/** A plan's own icon. */
export function planMark(planId) {
  const box = h('span', { class: `app-mark plan-${planId} is-sm` });
  const url = appIconUrl(planId === 'google' ? 'antigravity' : planId);  // Google AI's app here is Antigravity
  if (url) box.append(h('img', { src: url, alt: '', decoding: 'async' }));
  else {
    box.classList.add('is-glyph');
    box.append(h('span', { class: 'app-mark-mono' }, planId[0].toUpperCase()));
  }
  return box;
}

// ---- Usage -----------------------------------------------------------------

/** How close a limit is: ok, warn (80%+), over (95%+), none (no number). */
export const levelOf = (pct) => (pct == null ? 'none' : pct >= 95 ? 'over' : pct >= 80 ? 'warn' : 'ok');

/** A ring showing how much of a limit is used; dashed when there's no number. */
export function ring(pct, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const r = 7;
  const c = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, 'svg');
  const attrs = (node, list) => { for (const [k, v] of list) node.setAttribute(k, String(v)); };
  attrs(svg, [['class', `ring is-${levelOf(pct)}`], ['width', size], ['height', size], ['viewBox', '0 0 18 18'], ['aria-hidden', 'true']]);
  const track = document.createElementNS(NS, 'circle');
  attrs(track, [['class', 'ring-track'], ['cx', 9], ['cy', 9], ['r', r]]);
  svg.append(track);
  if (pct != null) {
    const arc = document.createElementNS(NS, 'circle');
    attrs(arc, [['class', 'ring-arc'], ['cx', 9], ['cy', 9], ['r', r],
      ['stroke-dasharray', `${(c * Math.min(100, Math.max(0, pct))) / 100} ${c}`], ['transform', 'rotate(-90 9 9)']]);
    svg.append(arc);
  }
  return svg;
}

/** A thin bar for one usage window. */
export function usageBar(pct) {
  return h('span', { class: `ubar is-${levelOf(pct)}` },
    h('span', { class: 'ubar-fill', style: { width: `${Math.min(100, Math.max(0, pct))}%` } }));
}

// ---- Toasts, copying, downloads, dialog titles -----------------------------

let toastTimer = null;
/** A short confirmation at the bottom; `long`: a problem to read (stays longer). */
export function showToast(msg, { long = false } = {}) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = el('div', 'toast');
    toast.setAttribute('role', 'status');
    document.body.append(toast);
  }
  toast.textContent = msg;
  toast.classList.toggle('is-long', long);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), long ? 7000 : 2200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A dialog heading: icon + title. `brand` marks AI dialogs. */
export function modalTitle(iconName, text, brand = false) {
  const t = el('span', `modal-title${brand ? ' is-brand' : ''}`);
  t.title = text;
  t.append(icon(iconName, 17), el('span', null, text));
  return t;
}

// ---- Dates -----------------------------------------------------------------

export const todayKey = () => dateKey(Date.now());

const fmt = (o) => (key) => keyToDate(key).toLocaleDateString(undefined, o);
/** "Tuesday 6 October" */
export const fmtLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
/** "Tue 6 Oct" */
export const fmtShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
/** "6 Oct" */
export const fmtDM = fmt({ day: 'numeric', month: 'short' });
const thisYear = (key) => key.slice(0, 4) === todayKey().slice(0, 4);
const fmtShortY = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtDMY_ = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
/** "6 Oct", or "6 Oct 2025" when it isn't this year. */
export const fmtDMY = (key) => (thisYear(key) ? fmtDM(key) : fmtDMY_(key));
/** "Tue" */
export const fmtWd = fmt({ weekday: 'short' });
/** "October 2026" */
export const fmtMonthYear = fmt({ month: 'long', year: 'numeric' });
/** "October" */
export const fmtMonth = fmt({ month: 'long' });

/** "Today" / "Yesterday" / "Tue 6 Oct" (with the year when it isn't this year) */
export function relDay(key) {
  const t = todayKey();
  if (key === t) return 'Today';
  if (key === addDays(t, -1)) return 'Yesterday';
  return thisYear(key) ? fmtShort(key) : fmtShortY(key);
}

/** Above a day's title: "Today" · "Yesterday" · "5 days ago" · "September 2026". */
export function eyebrowFor(key) {
  const rel = relDay(key);
  if (rel === 'Today' || rel === 'Yesterday') return rel;
  const n = daysBetween(key, todayKey());
  if (n > 0 && n < 14) return `${n} days ago`;
  return fmtMonthYear(key);
}

export const fmtClock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "resets 19:05" today, "resets Mon 09:00" within a week, else "resets 1 Nov". */
export function fmtReset(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return `resets ${fmtClock(ts)}`;
  if (ts - Date.now() < 7 * 864e5) return `resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${fmtClock(ts)}`;
  return `resets ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/** "just now" · "4 min ago" · "3 h ago" · "2 d ago" */
export function fmtAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

/**
 * Pick a chat up again (`act` = app.resume(s)): Open in Claude desktop and
 * Copy resume command, as small buttons beside a card or a row (never inside it).
 */
export function resumeButtons(s, act, cls = 'scard-actions') {
  return h('div', { class: cls },
    act.desktop ? h('a', {
      class: 'scard-act', href: act.desktop, title: 'Open in Claude desktop', 'aria-label': `Open “${s.title}” in Claude desktop`,
    }, icon('monitor', 15)) : null,
    h('button', {
      type: 'button', class: 'scard-act', title: 'Copy resume command (for Terminal)', 'aria-label': `Copy the resume command for “${s.title}”`,
      onclick: () => act.copy(),
    }, icon('terminal', 15)));
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
