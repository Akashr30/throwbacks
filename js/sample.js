// sample.js — generates ~10 days of fake programmer-flavored history so the
// app can be demoed without an export. Returns data in the RAW source
// shapes (a conversations.json-style array, fake .jsonl files, a Copilot
// op log, a Cursor extract) so it exercises the real parsers. Deliberately
// includes:
//   - two sessions spanning 2-3 days (cross-day navigation)
//   - two sessions overlapping in the same wall-clock hour (merged-union math)
//   - a session that pauses, is interrupted, then resumes the same day
//   - a >15-minute gap inside one session (time excludes the gap)
//   - a >700-char message, a <script> injection probe, fenced code blocks
//   - code sessions with tool-only lines between text bubbles

const LOREM = 'The quick brown fox jumps over the lazy dog while the build pipeline hums along. ';

function iso(d) { return new Date(d).toISOString(); }

/** Build one export-style message. */
function msg(sender, text, ts) {
  return { sender, text, content: [{ type: 'text', text }], created_at: iso(ts) };
}

/** Day at local hour:minute, n days before today. */
function at(daysAgo, h, m = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function sampleData() {
  const conversations = [];
  const MIN = 60 * 1000;

  // --- 1. Multi-day session #1: spans 3 days (9, 8, 7 days ago). ----------
  {
    const msgs = [];
    let t = at(9, 20, 12);
    msgs.push(msg('human', 'How do I profile a slow SQL query in Postgres?', t));
    msgs.push(msg('assistant', 'Start with EXPLAIN ANALYZE:\n```sql\nEXPLAIN ANALYZE SELECT * FROM orders WHERE status = \'open\';\n```\nLook for sequential scans on large tables.', t += 2 * MIN));
    msgs.push(msg('human', 'It shows a seq scan on 2M rows. Index time?', t += 3 * MIN));
    msgs.push(msg('assistant', 'Yes — a partial index fits here:\n```sql\nCREATE INDEX orders_open_idx ON orders (created_at) WHERE status = \'open\';\n```', t += 2 * MIN));
    t = at(8, 9, 30);
    msgs.push(msg('human', 'Back again — the index helped but the planner ignores it after bulk inserts.', t));
    msgs.push(msg('assistant', 'Run ANALYZE after bulk loads so statistics catch up, or tune autovacuum_analyze_scale_factor for that table.', t += 4 * MIN));
    t = at(7, 22, 5);
    msgs.push(msg('human', 'Final follow-up: how do I see index bloat?', t));
    msgs.push(msg('assistant', 'Use pgstattuple or the community bloat query; REINDEX CONCURRENTLY when bloat passes ~40%.', t += 3 * MIN));
    conversations.push({ uuid: 's-postgres', name: 'Postgres query profiling', created_at: iso(at(9, 20)), chat_messages: msgs });
  }

  // --- 2. Multi-day session #2: spans 2 days (5 → 4 days ago). ------------
  //     On day 5 it PAUSES, another session intervenes, then it RESUMES
  //     (the "contd." chip), with a >15-min gap inside the day
  //     (so its day time excludes the gap).
  {
    const msgs = [];
    let t = at(5, 14, 0);
    msgs.push(msg('human', 'Design a rate limiter for our public API — token bucket or sliding window?', t));
    msgs.push(msg('assistant', 'Token bucket if you want burst tolerance; sliding window log if you need exact fairness. For an API gateway, token bucket in Redis is the usual pick.', t += 2 * MIN));
    msgs.push(msg('human', 'Sketch the Redis version?', t += 2 * MIN));
    msgs.push(msg('assistant', 'Atomic via Lua:\n```lua\nlocal tokens = redis.call("GET", KEYS[1]) or ARGV[1]\nif tonumber(tokens) > 0 then\n  redis.call("DECR", KEYS[1])\n  return 1\nend\nreturn 0\n```\nRefill with a scheduled INCRBY capped at bucket size.', t += 2 * MIN));
    // pause ~50 min (interrupted by session 3 below), then resume same day
    t = at(5, 15, 0);
    msgs.push(msg('human', 'Resuming the rate limiter thread — what about distributed clock skew?', t));
    msgs.push(msg('assistant', 'Keep all timing decisions inside Redis (TIME command) so app-server clocks never matter.', t += 3 * MIN));
    // continues next day
    t = at(4, 10, 10);
    msgs.push(msg('human', 'Day two: load-tested it, p99 latency doubled. Thoughts?', t));
    msgs.push(msg('assistant', 'Pipeline the Lua call with your auth lookup, and check if Redis is hitting its single-thread CPU ceiling — cluster by API key prefix if so.', t += 4 * MIN));
    conversations.push({ uuid: 's-ratelimit', name: 'API rate limiter design', created_at: iso(at(5, 14)), chat_messages: msgs });
  }

  // --- 3. The interrupting session (same day 5, between the pause). --------
  //     Also OVERLAPS session 4 in the same wall-clock hour on day 3.
  {
    const msgs = [];
    let t = at(5, 14, 20);
    msgs.push(msg('human', 'Urgent: prod deploy failing with "ImagePullBackOff".', t));
    msgs.push(msg('assistant', 'Check the image tag exists and the pull secret is attached:\n```bash\nkubectl describe pod api-7f9c -n prod | grep -A5 Events\n```', t += 2 * MIN));
    msgs.push(msg('human', 'Typo in the tag. Fixed, rolling out now.', t += 5 * MIN));
    // reappears on day 3, 16:00-16:40 (overlapping session 4)
    t = at(3, 16, 0);
    msgs.push(msg('human', 'Same cluster, new issue: HPA never scales past 3 replicas.', t));
    msgs.push(msg('assistant', 'Look at `kubectl get hpa -o yaml` — if currentMetrics is <unknown>, metrics-server is down and HPA freezes at the last known scale.', t += 6 * MIN));
    msgs.push(msg('human', 'metrics-server was OOMKilled. Bumped its limits, scaling works.', t += 34 * MIN));
    conversations.push({ uuid: 's-k8s', name: 'Kubernetes prod firefighting', created_at: iso(at(5, 14, 20)), chat_messages: msgs });
  }

  // --- 4. Overlapping session (day 3, starts 16:04 — while #3's 16:00
  //     block is still open, so the day union is < the per-session sum). ---
  //     Includes the >700-char message and the <script> probe.
  {
    const long = ('I pasted the full stack trace below so you have every frame. ' + LOREM.repeat(14)).slice(0, 950);
    const msgs = [];
    let t = at(3, 16, 4);
    msgs.push(msg('human', 'While that deploy bakes: review this stack trace from the worker?', t));
    msgs.push(msg('human', long, t += 1 * MIN));
    msgs.push(msg('assistant', 'The root frame is a None being passed into json.dumps — guard the serializer input or default it to {}.', t += 4 * MIN));
    msgs.push(msg('human', 'Also, does this render as HTML? <script>alert(1)</script>', t += 3 * MIN));
    msgs.push(msg('assistant', 'That should always be shown as text, never executed — a viewer that runs it has an XSS bug.', t += 2 * MIN));
    msgs.push(msg('human', 'Good. Patched the worker, tests green.', t += 30 * MIN));
    conversations.push({ uuid: 's-worker', name: 'Worker crash triage', created_at: iso(at(3, 16, 10)), chat_messages: msgs });
  }

  // --- 5-8. Single-day filler sessions across other days. ------------------
  const fillers = [
    [8, 12, 'Regex for semver parsing', 'What regex matches a semver string with optional pre-release tag?',
      'Use the official one from semver.org:\n```\n^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)))?$\n```'],
    [6, 18, 'Git bisect walkthrough', 'A perf regression landed somewhere in the last 60 commits. Fastest way to find it?',
      'git bisect with an automated check:\n```bash\ngit bisect start HEAD HEAD~60\ngit bisect run ./bench.sh\n```'],
    [2, 11, 'CSS grid centering', 'Why does place-items: center not center my absolutely positioned child?',
      'Absolute positioning removes the child from grid flow — either drop position:absolute or use inset:0 with margin:auto.'],
    [1, 9, 'Unicode filename bug', 'Filenames with emoji break our upload path on Linux but not macOS.',
      'macOS normalizes to NFD, Linux stores bytes as-is. Normalize to NFC at the boundary and compare normalized forms only.'],
    [7, 13, 'Godot sprite collision', 'My player sprite clips through walls in Godot — the collision shapes look correct in the editor.',
      'A fast sprite tunnels past thin colliders at low physics FPS — enable continuous collision detection on the RigidBody2D and re-check the collision layer masks. If the sprite still looks offset, the tilemap shader may be shifting visuals only, not the collision.'],
    [2, 19, 'Event loop explained', 'Explain the difference between microtasks and macrotasks — what is the best way to think about the event loop?',
      'Explained simply: microtasks (promise callbacks) drain completely after every task, while macrotasks (setTimeout) run one per loop turn — so promises always jump the queue.'],
    [0, 8, 'Morning standup notes', 'Summarize yesterday: shipped rate limiter, fixed HPA, patched worker crash.',
      'Nice run! Today: watch the limiter dashboards and write the postmortem for the metrics-server OOM.'],
  ];
  fillers.forEach(([daysAgo, hour, name, q, a], i) => {
    let t = at(daysAgo, hour, 5);
    conversations.push({
      uuid: `s-fill-${i}`, name, created_at: iso(t),
      chat_messages: [
        msg('human', q, t),
        msg('assistant', a, t + 3 * MIN),
        msg('human', 'Thanks, that unblocked me.', t + 6 * MIN),
      ],
    });
  });

  // --- Fake Claude Code .jsonl sessions (Source B shape). -------------------
  // Session with tool-only lines FILLING the gap between two text bubbles:
  // ≈time must exceed what the text bubbles alone would give.
  const codeFiles = [];
  {
    const lines = [];
    let t = at(2, 15, 0);
    lines.push({ type: 'summary', summary: 'Migrate config loader to TOML' });
    lines.push({ type: 'user', timestamp: iso(t), cwd: '/Users/dev/projects/config-loader', message: { content: 'Migrate our config loader from JSON to TOML, keep backwards compat.' } });
    // 25 minutes of pure tool traffic — no text, but it IS activity
    for (let i = 1; i <= 5; i++) {
      lines.push({
        type: 'assistant',
        timestamp: iso(t + i * 5 * MIN),
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: {} }],
          usage: { input_tokens: 40, cache_creation_input_tokens: 5200, cache_read_input_tokens: 21000, output_tokens: 900 },
        },
      });
    }
    lines.push('this line is deliberately not JSON and must be skipped');
    lines.push({ type: 'assistant', timestamp: iso(t + 27 * MIN), message: { content: [{ type: 'text', text: 'Done — loader now reads config.toml with a JSON fallback, 14 tests added:\n```toml\n[server]\nport = 8770\nbind = "127.0.0.1"\n```' }] } });
    // …and back to it the next day, so it's still going (Sessions → Still going)
    const back = at(1, 11, 0);
    lines.push({ type: 'user', timestamp: iso(back), message: { content: 'One more: warn once when a JSON config is loaded.' } });
    lines.push({ type: 'assistant', timestamp: iso(back + 4 * MIN), message: { content: [{ type: 'text', text: 'Added a one-time deprecation warning with the file’s path.' }] } });
    codeFiles.push({
      mtime: back + 4 * MIN,  // when Claude Code last wrote it (its cleanup goes by this)
      name: 'a1b2c3d4.jsonl',
      project: '-Users-dev-projects-config-loader',
      text: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    });
  }
  {
    const lines = [];
    let t = at(1, 19, 30);
    lines.push({ type: 'ai-title', aiTitle: 'Retry logic exploration' });
    lines.push({ type: 'custom-title', customTitle: 'Fetch-kit retry hardening' });
    // A long path in the first message, as real ones often have: the day's card keeps it inside (tests/layout.html)
    lines.push({ type: 'user', timestamp: iso(t), cwd: '/Users/dev/projects/fetch-kit', message: { content: 'Add retry with exponential backoff to the fetch wrapper in /Users/dev/projects/fetch-kit/src/transport/retryPolicy/exponentialBackoffWithJitter.js.' } });
    lines.push({ type: 'assistant', timestamp: iso(t + 2 * MIN), message: { content: [{ type: 'text', text: 'Added retries (3 attempts, 200ms base, jitter). Non-idempotent methods are excluded.' }], usage: { input_tokens: 60, cache_creation_input_tokens: 8400, cache_read_input_tokens: 12000, output_tokens: 1400 } } });
    lines.push({ type: 'user', timestamp: iso(t + 6 * MIN), message: { content: 'Also cap total retry time at 10s.' } });
    lines.push({ type: 'assistant', timestamp: iso(t + 9 * MIN), message: { content: [{ type: 'text', text: 'Capped with an overall deadline — updated src/retry.js and docs/backoff.md, and/or see https://developer.mozilla.org/en-US/docs/Web/API/AbortController for the abort pattern. Full log at /var/log/fetch-kit/test.log.\n```bash\n# paths in fences stay plain:\ntail -f /var/log/fetch-kit/test.log\n```' }] } });
    // …picked up again today: still going, with its folder and the resume buttons
    const again = at(0, 9, 40);
    lines.push({ type: 'user', timestamp: iso(again), message: { content: 'Add a test for the 10s cap.' } });
    lines.push({ type: 'assistant', timestamp: iso(again + 3 * MIN), message: { content: [{ type: 'text', text: 'Added one with fake timers: it gives up after 10s.' }] } });
    codeFiles.push({
      mtime: again + 3 * MIN,
      name: '7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47.jsonl',  // a UUID, like Claude Code's own: it can be resumed
      project: '-Users-dev-projects-fetch-kit',
      text: lines.map((l) => JSON.stringify(l)).join('\n'),
    });
  }

  // --- A Copilot chat (VS Code op-log format), same folder as fetch-kit, so
  // the Folders tab shows two tools side by side. Includes a streamed tail
  // rewrite (push with `i`) that replay must apply as truncate-then-append.
  const copilotFiles = [];
  {
    const t = at(2, 15, 40);
    const ops = [
      { kind: 0, v: { version: 3, sessionId: 'sample-copilot-1', responderUsername: 'GitHub Copilot', requests: [] } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: t, message: { text: 'Why does the jest test for the retry wrapper time out?' }, response: [{ value: 'The backoff uses real' }] }] },
      { kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ value: 'The backoff waits on real timers, so 3 retries at 200ms+ blow past jest’s 5s limit.' }] },
      { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized' }, { value: 'Switch the test to `jest.useFakeTimers()` and advance with `jest.runAllTimersAsync()` — edited ' }, { kind: 'inlineReference', inlineReference: { path: '/Users/dev/projects/fetch-kit/test/retry.test.js' } }, { value: '.' }] },
      { kind: 1, k: ['requests', 0, 'result'], v: { timings: { totalElapsed: 95000 } } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r2', timestamp: t + 6 * MIN, message: { text: 'Green now. Should the wrapper expose the attempt count?' }, response: [{ value: 'Yes — return it on the error as `err.attempts`; callers can log it without re-running.' }], result: { timings: { totalElapsed: 12000 } } }] },
      { kind: 1, k: ['customTitle'], v: 'Jest timeouts in retry tests' },
    ];
    copilotFiles.push({
      name: 'sample-copilot-1.jsonl',
      workspace: '/Users/dev/projects/fetch-kit',
      text: ops.map((o) => JSON.stringify(o)).join('\n'),
    });
  }

  // --- A Cursor chat (server-extracted shape). Cursor often keeps no
  // per-message times, so these land a minute apart, flagged approximate.
  const cursorData = {
    composers: [{
      composerId: 'sample-cursor-1',
      name: 'Refactor TOML config parser',
      createdAt: at(4, 16, 30),
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 },
        { bubbleId: 'b3', type: 1 }, { bubbleId: 'b4', type: 2 },
      ],
    }],
    bubbles: {
      'sample-cursor-1:b1': { type: 1, text: 'Split config/loader.js — parsing and validation are tangled.' },
      'sample-cursor-1:b2': { type: 2, text: 'Moved parsing to config/parse.js and validation to config/validate.js; loader.js now just composes them.' },
      'sample-cursor-1:b3': { type: 1, text: 'Keep the JSON fallback path?' },
      'sample-cursor-1:b4': { type: 2, text: 'Kept — it lives in parse.js behind a single `format` switch.' },
    },
    workspaceOf: { 'sample-cursor-1': '/Users/dev/projects/config-loader' },
  };

  // --- Your commits in the two sample repos, in the shape serve.py answers
  // (POST /api/commits): Claude's (its own record matched the commit ID),
  // one "probably Claude" (it ran a commit just then, with no ID), Copilot's
  // (Copilot in VS Code's record), Cursor's (its co-author line), the rest
  // yours — one on a day without a chat in that folder ("other folders").
  const repo = (name) => `/Users/dev/projects/${name}`;
  const commit = (short, when, subject, by, via = null, app = null, session = null) => ({
    id: `${short}${'0'.repeat(40 - short.length)}`, short, at: when, subject, ref: 'main', by, via, app, session,
  });
  const commits = {
    folders: { [repo('config-loader')]: repo('config-loader'), [repo('fetch-kit')]: repo('fetch-kit') },
    repos: {
      [repo('fetch-kit')]: {
        name: 'fetch-kit',
        commits: [
          commit('4f2a9c1', at(1, 19, 40), 'Add retry with exponential backoff and a 10s overall deadline', 'claude', 'record', 'code', '7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47'),
          commit('b81e0d7', at(1, 21, 5), 'Bump version to 2.3.0', 'you'),
          commit('09c3f55', at(2, 15, 44), 'Fix flaky Jest timeouts in retry tests', 'copilot', 'record', 'copilot', 'sample-copilot-1'),
          commit('3e61a08', at(6, 10, 15), 'Add a changelog entry for the retry work', 'you'),
        ],
      },
      [repo('config-loader')]: {
        name: 'config-loader',
        commits: [
          commit('d4e7a20', at(2, 15, 28), 'Read config.toml with a JSON fallback', 'claude?', 'time', 'code', 'a1b2c3d4'),
          commit('7aa1c3e', at(1, 11, 20), 'Document the TOML keys in the README', 'you'),
          commit('c2f8b91', at(3, 16, 5), 'Move TOML parsing into its own module', 'cursor', 'line', 'cursor'),
          commit('5c90b2f', at(4, 11, 0), 'Add the parser\'s first tests', 'you'),
        ],
      },
    },
  };

  // Claude Code's cleanup in the sample: a short, made-up setting, so the
  // Expiring tab has something to show (both sample sessions go within days).
  const keep = { retention: { days: 4, set: true }, kept: [], sample: true };

  // --- Made-up summaries for the Summaries page and the day cards (kept in
  // the tab only: /?sample never reads yours): three days, a whole-chat
  // summary — with the tokens a summarizer would report.
  const dayKey = (n) => {
    const d = new Date(at(n, 12));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const chat = (title, n, lines) => ({ title, upTo: at(n, 23, 59), covered: lines.length * 2, lines });
  const summaries = {
    days: {
      [dayKey(5)]: {
        v: 1, date: dayKey(5), updatedAt: at(5, 19, 4), provider: 'claudecode', model: 'sonnet', usage: { input: 9400, output: 230, calls: 1 },
        chats: {
          'web:s-ratelimit': chat('API rate limiter design', 5, ['Designed a token-bucket rate limiter in Redis with an atomic Lua script', 'Kept every timing decision inside Redis so app-server clocks never matter']),
          'web:s-k8s': chat('Kubernetes prod firefighting', 5, ['Traced the pod restarts to the worker running out of memory', 'Raised its memory limit and added a readiness probe']),
        },
      },
      [dayKey(3)]: {
        v: 1, date: dayKey(3), updatedAt: at(3, 19, 2), provider: 'claudecode', model: 'sonnet', usage: { input: 6100, output: 140, calls: 1 },
        chats: { 'web:s-worker': chat('Worker crash triage', 3, ['Found the worker crash: a None passed into json.dumps', 'Guarded the serializer input; tests green']) },
        manual: [{ id: 'm-sample', text: 'Told the team the worker fix ships tomorrow' }], editedAt: at(3, 19, 30),
      },
      [dayKey(1)]: {
        v: 1, date: dayKey(1), updatedAt: at(1, 22, 10), provider: 'claudecode', model: 'sonnet', usage: { input: 11800, output: 260, calls: 2 },
        chats: { 'code:7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47.jsonl': chat('Fetch-kit retry hardening', 1, ['Added retry with exponential backoff to fetch-kit', 'Capped the overall retry time at 10 s and documented it',
          'Moved the policy into /Users/sample/Dev/fetch-kit/src/transport/retry/exponentialBackoffPolicyWithOverallDeadline.ts']) },
        previous: [{ at: at(1, 20, 0), provider: 'claudecode', model: 'sonnet', chats: { 'code:7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47.jsonl': chat('Fetch-kit retry hardening', 1, ['Worked on fetch-kit retries']) }, manual: [] }],
      },
    },
    weeks: {},
    months: {},
    periods: {},
    chats: [{
      id: 'sample-chat-1', at: at(1, 22, 30), rangeLabel: 'Session · Fetch-kit retry hardening', sessionId: 'code:7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47.jsonl',
      provider: 'claudecode', model: 'sonnet', status: 'done', usage: { input: 7300, output: 310, calls: 2 },
      recap: 'Retries for the fetch wrapper, built step by step: exponential backoff, a 10-second cap on the total time, and a test for the cap.',
      perSession: [{ id: 'code:7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47.jsonl', title: 'Fetch-kit retry hardening', when: 'two days', bullets: ['Backoff with a doubling delay', 'A 10 s overall deadline', 'A fake-timer test for the cap'] }],
    }],
  };

  // Two recaps, so the page draws them: the last week's (written from the three days, up to date)
  // and the week of 5 days ago's, written before that day was edited (out of date).
  const stamp = (k) => Math.max(summaries.days[k].updatedAt || 0, summaries.days[k].editedAt || 0);
  const from = dayKey(6);
  summaries.periods[`${from}_${dayKey(0)}`] = {
    v: 1, kind: 'period', key: `${from}_${dayKey(0)}`, from, to: dayKey(0), updatedAt: at(0, 9, 15), provider: 'claudecode', model: 'sonnet',
    // In the shape a recap is written in since 2026-11-16: a line, each project's points, what's still open.
    text: 'Hardened two services and a library in a week of fixes.\n\n## api-gateway\n- Redis token-bucket rate limiter, atomic via Lua\n'
      + '- Limits per API key, refilled on a schedule\n\n## k8s-workers\n- Found the crashing worker\'s memory leak; fix ready\n\n'
      + '## fetch-kit\n- Retries with exponential backoff and a 10-second cap\n- A fake-timer test for the cap\n\n'
      + '## Still open\n- Ship the worker fix\n- Load-test the rate limiter',
    basedOn: Object.fromEntries([dayKey(5), dayKey(3), dayKey(1)].map((k) => [k, stamp(k)])), daysUsed: [dayKey(5), dayKey(3), dayKey(1)],
    usage: { input: 900, output: 70, calls: 1 },
  };
  const d5 = new Date(at(5, 12));
  const monday = dayKey(5 + ((d5.getDay() + 6) % 7));
  summaries.weeks[monday] = {
    v: 1, kind: 'week', key: monday, week: monday, from: monday, updatedAt: at(5, 19, 10), provider: 'claudecode', model: 'sonnet',
    text: 'Designed the API rate limiter and steadied the Kubernetes workers.',
    basedOn: { [dayKey(5)]: stamp(dayKey(5)) - 60000 }, daysUsed: [dayKey(5)],
  };

  return { conversations, codeFiles, copilotFiles, cursorData, commits, keep, summaries };
}
