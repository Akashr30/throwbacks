// theme.js — Appearance, for the one design: Liquid Glass. Its colors come
// from the sky (<html data-sky>: Day by default, or dawn · dusk · night ·
// mono, or "live", which follows the clock), <html data-glass="tinted">
// for less transparency, and the mode (<html data-mode>: light by default,
// dark, or none to follow the system). data-text / data-gfont / data-reply
// switch the type tokens the same way. Saved in localStorage only; the boot
// script in throwbacks.html applies it before first paint.
//
// Classic (the second design, with its palettes and pasted tweakcn themes)
// was retired on 2026-10-06; a save from then still opens correctly.

import { el } from './util.js';
import { icon } from './icons.js';
import { showToast } from './ui.js';
import { initGlass } from './glass.js';

const LS_KEY = 'throwbacks-appearance';   // also read by the boot script in throwbacks.html
/** Saves record the version of the defaults they were written under (`v`).
 *  A save stores every setting, defaults included, so when a default
 *  changes, values an older save only held because they were the default
 *  must be read as unset — see normalizeAppearance and the boot script.
 *  v2: the sky's default became Day ("live" in older saves = unset).
 *  v3: one mode; older saves kept Liquid Glass's in `gmode`. */
const SAVE_VERSION = 3;
const LEGACY_KEY = 'throwbacks-theme';    // the retired dark-only presets

/** Skies → <html data-sky>; Day is the default, "live" follows the clock. */
export const SKIES = [
  ['live', 'Live'], ['dawn', 'Dawn'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night'], ['mono', 'Mono'],
];
const MODES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];
const GLASS = [['clear', 'Clear'], ['tinted', 'Tinted']];
/** Text size → <html data-text>; the whole type scale is in rem. */
const TEXT_SIZES = [['default', 'Default'], ['large', 'Large'], ['larger', 'Larger']];
const FONTS = [
  ['onest', 'Onest', '"Onest", sans-serif'],
  ['system', 'System', 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'],
];
const REPLIES = [['sans', 'Sans', '"Onest", sans-serif'], ['serif', 'Serif', '"Newsreader", Georgia, serif']];

/**
 * The sky "live" shows at a local hour (0–23). The boot script in
 * throwbacks.html repeats these hours so the first paint already matches.
 */
export function skyForHour(h) {
  if (h >= 5 && h < 10) return 'dawn';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

/** Saved settings (any shape, any version) → a complete, valid appearance. */
export function normalizeAppearance(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const v = Number(s.v) || 0;
  // Before v2 every save stored "live", the old default sky: read it as unset.
  const sky = v >= 2 || s.sky !== 'live' ? s.sky : undefined;
  // Before v3 there were two designs, each with its own mode; Liquid Glass's was `gmode`.
  const mode = v >= 3 ? s.mode : s.gmode;
  const pick = (options, value, fallback) => (options.some(([o]) => o === value) ? value : fallback);
  return {
    sky: pick(SKIES, sky, 'day'),
    glass: pick(GLASS, s.glass, 'clear'),
    gfont: pick(FONTS, s.gfont, 'onest'),
    mode: pick(MODES, mode, 'light'),
    text: pick(TEXT_SIZES, s.text, 'default'),
    reply: s.reply === 'serif' ? 'serif' : 'sans',
  };
}

function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(LS_KEY));
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* blocked or corrupt — defaults */ }
  return normalizeAppearance(raw);
}

function save(st) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...st, v: SAVE_VERSION }));
  } catch { /* storage blocked — applies to this tab only */ }
}

function apply(st) {
  const root = document.documentElement;
  root.dataset.sky = st.sky === 'live' ? skyForHour(new Date().getHours()) : st.sky;
  const set = (key, value, fallback) => {
    if (value === fallback) delete root.dataset[key];
    else root.dataset[key] = value;
  };
  set('glass', st.glass, 'clear');
  set('gfont', st.gfont, 'onest');
  set('mode', st.mode, 'system');
  set('text', st.text, 'default');
  set('reply', st.reply, 'sans');
  for (const old of ['design', 'palette', 'font']) delete root.dataset[old];
}

/** Called once at boot: re-apply the saved appearance, start the glass
 *  helpers, and let a "live" sky follow the clock while the tab is open. */
export function applySavedTheme() {
  apply(loadState());
  initGlass();
  const tick = () => {
    if (loadState().sky === 'live') document.documentElement.dataset.sky = skyForHour(new Date().getHours());
  };
  setInterval(tick, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

// ---------------------------------------------------------------------------
// The controls (Settings → Appearance)
// ---------------------------------------------------------------------------

/** "Day · Light" — the sky and mode (as saved, unless the settings just chosen are given; Settings' overview). */
export function appearanceLine(st = loadState()) {
  const name = (list, id) => (list.find(([v]) => v === id) || [id, id])[1];
  return `${name(SKIES, st.sky)} · ${name(MODES, st.mode)}`;
}

/** Draw the appearance controls into `box`; every change applies and saves (then `onChange(settings)`). */
export function renderAppearance(box, { onChange = null } = {}) {
  let st = loadState();
  const draw = () => {
    const focusKey = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    box.textContent = '';
    const row = (label, control, hint) => {
      const r = el('div', 'set-row');
      r.append(el('span', 'set-label', label), control);
      box.append(r);
      if (hint) box.append(el('p', 'set-hint', hint));
    };
    const segmented = (field, ariaLabel, options, current, toast) => {
      const seg = el('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', ariaLabel);
      for (const [value, label, ic, family] of options) {
        const on = current === value;
        const b = el('button', `seg-btn${on ? ' is-on' : ''}`);
        b.type = 'button';
        if (ic) b.append(icon(ic, 14));
        b.append(label);
        if (family) b.style.fontFamily = family;
        b.dataset.key = `${field}:${value}`;
        b.setAttribute('aria-pressed', String(on));
        if (!on) b.addEventListener('click', () => update({ [field]: value }, `${toast}: ${label}`));
        seg.append(b);
      }
      return seg;
    };
    const skies = el('div', 'lg-sky-grid');
    skies.setAttribute('role', 'group');
    skies.setAttribute('aria-label', 'Sky');
    for (const [id, name] of SKIES) {
      const on = st.sky === id;
      const b = el('button', 'lg-sky-pick');
      b.type = 'button';
      b.dataset.key = `sky:${id}`;
      b.setAttribute('aria-pressed', String(on));
      const dot = el('span', 'lg-sky-dot');
      dot.dataset.sky = id;
      b.append(dot, el('span', 'lg-sky-name', name));
      if (!on) b.addEventListener('click', () => update({ sky: id }, `Sky: ${name}`));
      skies.append(b);
    }
    row('Sky', skies, 'Live follows the clock: dawn, day, dusk and night.');
    row('Mode', segmented('mode', 'Light or dark', MODES, st.mode, 'Mode'));
    row('Glass', segmented('glass', 'Glass', GLASS, st.glass, 'Glass'));
    row('Text size', segmented('text', 'Text size', TEXT_SIZES, st.text, 'Text size'));
    row('Interface font', segmented('gfont', 'Interface font', FONTS.map(([v, l, f]) => [v, l, null, f]), st.gfont, 'Font'));
    row('Replies', segmented('reply', 'Reply font', REPLIES.map(([v, l, f]) => [v, l, null, f]), st.reply, 'Replies'));
    if (focusKey) {
      const again = box.querySelector(`[data-key="${focusKey}"]`);
      if (again) again.focus();
    }
  };
  const update = (patch, msg) => {
    st = { ...st, ...patch };
    apply(st);
    save(st);
    draw();
    if (msg) showToast(msg);
    if (onChange) onChange(st);
  };
  draw();
}
