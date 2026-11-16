// util.js — shared helpers: escaping, date/time formatting, DOM helpers.
// No app logic here.

/** Escape a string for safe insertion into HTML text content or attributes. */
export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Local date key "YYYY-MM-DD" for a timestamp (ms). Local timezone. */
export function dateKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse a "YYYY-MM-DD" key back into a Date at local midnight. */
export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Mon, 25 Aug 2026" */
export function fmtDayLong(key) {
  return keyToDate(key).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

/** "25 Aug" */
export function fmtDayShort(key) {
  return keyToDate(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "25 Aug 2026" */
export function fmtDayMed(key) {
  return keyToDate(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "14:05" or locale equivalent, for a timestamp (ms). */
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Aug 2026" month header. */
export function fmtMonth(year, month) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Create an element with a class and optional text. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Debounce a function. */
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Display names for each source, in their fixed identity order. */
export const SOURCE_LABELS = {
  web: 'Web', code: 'Code', copilot: 'Copilot', cursor: 'Cursor',
  'copilot-cli': 'Copilot CLI', cowork: 'Cowork',
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || 'Other';
}

/** fetch() for this app's own local /api/* bridges. The server refuses any
 *  API call without this header (it forces a CORS preflight — never
 *  granted — on cross-origin callers). */
export function apiFetch(path, init = {}) {
  return fetch(path, { ...init, headers: { ...(init.headers || {}), 'X-Throwbacks': '1' } });
}

/** "842" / "12.4k" / "1.3M" — compact token counts. */
export function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '')}M`;
  return `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0).replace(/\.0$/, '')}B`;
}

/** Truncate a string to n chars with an ellipsis. */
export function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
