// harness.mjs — the smallest possible test helper: named checks, a summary
// line, and a non-zero exit code when anything failed.

let failures = 0;
let passes = 0;
let skips = 0;

const show = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/** Deep-equal check (via JSON), printing both values on failure. */
export function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    passes++;
    console.log(`ok    ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}\n        got  ${show(got)}\n        want ${show(want)}`);
  }
}

/** Truthiness check. */
export function ok(condition, name) {
  if (condition) {
    passes++;
    console.log(`ok    ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}`);
  }
}

export function skip(name, why) {
  skips++;
  console.log(`skip  ${name} — ${why}`);
}

export function note(text) {
  console.log(`      ${text}`);
}

/** Print the summary and exit (1 if any check failed). */
export function done() {
  console.log(`\n${failures ? `${failures} FAILED, ` : ''}${passes} passed${skips ? `, ${skips} skipped` : ''}`);
  process.exit(failures ? 1 : 0);
}
