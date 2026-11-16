#!/usr/bin/env node
// run.mjs — runs every Throwbacks test suite and prints one line each.
//
//   node tests/run.mjs            parsers, model, theme, tiles, server, contrast
//   node tests/run.mjs --live     …plus checks against this Mac's real AI-app data
//   node tests/run.mjs --verbose  show every check, not just failures
//
// The layout checks need a real browser: start the server and open
// http://127.0.0.1:8770/tests/layout.html

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const live = process.argv.includes('--live');
const verbose = process.argv.includes('--verbose');
const python = spawnSync('python3', ['--version']).status === 0;

const suites = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs') && (live || f !== 'live.test.mjs'))
  .sort()
  .map((f) => ({ name: f, cmd: process.execPath, args: [join(HERE, f)] }));
if (python) {
  suites.push({ name: 'test_serve.py', cmd: 'python3', args: ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'] });
  suites.push({ name: 'contrast.py', cmd: 'python3', args: ['-B', join(HERE, 'contrast.py')] });
}

/** One-line result of a suite, from its own output. */
function summary(out) {
  const ran = out.match(/Ran (\d+) tests?/); // unittest
  if (ran) return `${ran[1]} passed${/skipped=(\d+)/.test(out) ? `, ${out.match(/skipped=(\d+)/)[1]} skipped` : ''}`;
  const pairs = [...out.matchAll(/all (\d+) pairs pass/g)].map((m) => Number(m[1])); // contrast.py
  if (pairs.length) return `${pairs.reduce((a, b) => a + b, 0)} color pairs pass`;
  return out.trim().split('\n').pop(); // harness.mjs: "N passed, M skipped"
}

let failed = 0;
for (const s of suites) {
  const started = Date.now();
  const r = spawnSync(s.cmd, s.args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passed = r.status === 0;
  if (!passed) failed++;
  const ms = `${Date.now() - started} ms`.padStart(8);
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${s.name.padEnd(20)}${ms}  ${passed ? summary(out) : ''}`);
  if (!passed || verbose) console.log(out.trimEnd().replace(/^/gm, '      '));
}
if (!python) console.log('skip  python suites — python3 not found');
if (!live) console.log('\nReal-data checks against this Mac: node tests/run.mjs --live');
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
