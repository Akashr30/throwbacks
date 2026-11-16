// marks.test.mjs — where Still going's pins and archives are saved (js/marks.js):
// in ~/.throwbacks through serve.py; in this browser when the server says it
// can't store them or there's no serve.py; the sample's in its tab only — and a
// server that's away for a moment, or from before /api/marks, never sends them
// somewhere the next Refresh won't look. A made-up server and storage only.

import { eq, ok, done } from './harness.mjs';

/** A stand-in for fetch: `answer(method, body)` → {status, json} | 'down'. Records what was sent. */
function server(answer) {
  const sent = [];
  globalThis.fetch = async (path, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ path, method, body, header: (init.headers || {})['X-Throwbacks'] });
    const a = answer(method, body);
    if (a === 'down') throw new TypeError('Failed to fetch');
    const text = typeof a.json === 'string' ? a.json : JSON.stringify(a.json);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => JSON.parse(text) };
  };
  return sent;
}
function storage() {
  const items = new Map();
  globalThis.localStorage = { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)), removeItem: (k) => items.delete(k) };
  return items;
}
let fresh = 0;
const marksModule = () => import(`../js/marks.js?case=${fresh++}`);  // each case its own module state
const fails = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

{
  // The file store, then the server away for a moment (a restart) on Refresh.
  let file = { pinned: { 'code:a': 1 }, archived: { 'code:b': { at: 2, last: 1 } } };
  let up = true;
  const sent = server((method, body) => {
    if (!up) return 'down';
    if (method === 'POST') { file = { ...file, pinned: { ...file.pinned, [body.id]: 9 } }; return { status: 200, json: file }; }
    return { status: 200, json: file };
  });
  const ls = storage();
  const m = await marksModule();
  eq('files: read through serve.py', Object.keys((await m.loadMarks()).pinned), ['code:a']);
  ok(sent.every((x) => x.header === '1'), '…every request carries X-Throwbacks');
  up = false;
  eq('the server away on Refresh: what was read stays', Object.keys((await m.loadMarks()).archived), ['code:b']);
  ok(/isn’t answering/.test(await fails(m.changeMark({ id: 'code:c', pin: true }))), '…a change then says it wasn’t saved');
  eq('…and nothing went to the browser', ls.size, 0);
  up = true;
  eq('back: the change goes to the file', Object.keys((await m.changeMark({ id: 'code:c', pin: true })).pinned).sort(), ['code:a', 'code:c']);
}
{
  // A serve.py from before /api/marks (not restarted yet).
  const sent = server(() => ({ status: 404, json: { error: 'Unknown API route' } }));
  const ls = storage();
  const m = await marksModule();
  await m.loadMarks();
  ok(/restart python3 serve\.py/.test(await fails(m.changeMark({ id: 'code:a', pin: true }))), 'an old serve.py: a change asks for a restart');
  eq('…nothing saved in the browser, nothing posted', [ls.size, sent.filter((x) => x.method === 'POST').length], [0, 0]);
}
for (const [what, status, json] of [['--no-store', 404, { enabled: false }], ['a LAN visitor', 403, { enabled: false, error: 'Local-only API.' }], ['serve.js (no serve.py)', 404, 'Not found']]) {
  const sent = server(() => ({ status, json }));
  const ls = storage();
  const m = await marksModule();
  await m.loadMarks();
  await m.changeMark({ id: 'code:a', pin: true });
  ok(JSON.parse(ls.get('throwbacks-marks')).pinned['code:a'] > 0, `${what}: saved in this browser`);
  eq(`…and read from it again on Refresh`, [Object.keys((await m.loadMarks()).pinned), sent.filter((x) => x.method === 'POST').length], [['code:a'], 0]);
}
{
  // /?sample, and a sample chat beside real ones.
  const sent = server(() => ({ status: 200, json: { pinned: {}, archived: {} } }));
  const ls = storage();
  let m = await marksModule();
  await m.loadMarks({ sample: true });
  await m.changeMark({ id: 'web:sample', pin: true });
  eq('the sample: marked in this tab only — nothing asked, nothing stored', [sent.length, ls.size, Object.keys(m.currentMarks().pinned)], [0, 0, ['web:sample']]);
  m = await marksModule();
  await m.loadMarks();
  await m.changeMark({ id: 'web:made-up', pin: true }, { local: true });
  eq('a sample chat beside real ones: this tab only', [sent.filter((x) => x.method === 'POST').length, Object.keys(m.currentMarks().pinned)], [0, ['web:made-up']]);
}
{
  // A refused change says why.
  server((method) => (method === 'POST' ? { status: 400, json: { error: 'id and pin (true/false), or id and archive ({last} or null), required' } } : { status: 200, json: { pinned: {}, archived: {} } }));
  storage();
  const m = await marksModule();
  await m.loadMarks();
  ok(/^Not saved — id and pin/.test(await fails(m.changeMark({ id: 'code:a', pin: true }))), 'a refused change: the server’s reason');
}

done();
