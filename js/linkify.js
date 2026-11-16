// linkify.js — pure detection of URLs and file paths inside message text.
// No DOM here: detectTokens() returns typed tokens; reader.js turns them
// into chips (as text nodes, so nothing can run as HTML). Deliberately conservative:
// when unsure whether a token is a path, it stays plain text.

// Alternates, tried left-to-right at each position:
//  1. web URL (http/https)
//  2. Windows absolute path        C:\dir\file.ext
//  3. POSIX absolute path w/ ext   /dir/file.ext  (any depth)
//  4. POSIX absolute path, 2+ segments, no ext   /home/me/project
//  5. relative path: needs a '/' (or leading ./ ../) AND a letter-first
//     file extension — so "and/or", "TCP/IP", "1.2/3.4" stay prose.
const SEG = '[\\w.\\-@+~]';
const EXT = '\\.[A-Za-z][A-Za-z0-9]{0,7}';
const TOKEN_RE = new RegExp(
  [
    'https?:\\/\\/[^\\s<>"\'`]+',
    `[A-Za-z]:\\\\(?:${SEG}+\\\\)*${SEG}+`,
    `\\/(?:${SEG}+\\/)*${SEG}*${EXT}(?!\\w)`,
    `\\/(?:${SEG}+\\/)+${SEG}+`,
    `(?:\\.{1,2}\\/)?(?:[\\w\\-@+~]${SEG}*\\/)+${SEG}*${EXT}(?!\\w)`,
  ].join('|'),
  'g',
);

const TRAILING_PUNCT = /[.,;:!?"'\)\]]+$/;

/**
 * Tokenize raw (unescaped) message text.
 * @returns {Array<{type:'text'|'url'|'file', value:string, abs?:boolean}>}
 */
export function detectTokens(text) {
  const tokens = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    let value = m[0];
    let start = m.index;
    // URLs often end a sentence — strip trailing punctuation.
    if (value.startsWith('http')) value = value.replace(TRAILING_PUNCT, '');
    if (!value) continue;
    if (start > last) tokens.push({ type: 'text', value: text.slice(last, start) });
    if (value.startsWith('http')) {
      tokens.push({ type: 'url', value });
    } else {
      tokens.push({ type: 'file', value, abs: /^(?:[A-Za-z]:\\|\/)/.test(value) });
    }
    last = start + value.length;
    TOKEN_RE.lastIndex = last;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

/** Join a relative path onto a session start dir, resolving ./ and ../ . */
export function joinPath(base, rel) {
  const isAbs = base.startsWith('/');
  const combined = `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel.replace(/\\/g, '/')}`;
  const out = [];
  for (const p of combined.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

/** Middle-truncate for display; the full value stays in data/title attrs. */
export function midTruncate(s, max = 48) {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}
