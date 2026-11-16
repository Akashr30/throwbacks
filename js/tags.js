// tags.js — local, keyword-based topic tagging. Pure functions, no DOM and
// no network: tags are heuristic guesses computed entirely inside this tab.
//
// A keyword ending in '*' matches as a prefix ("profil*" → profiling,
// profiler); everything else must match as a whole word.

const RAW_TAGS = [
  ['Debugging', ['debug*', 'bug', 'bugs', 'error', 'errors', 'stack trace', 'traceback', 'crash*', 'exception', 'failing', 'broken', 'reproduce']],
  ['Databases', ['sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'database*', 'mongodb', 'redis', 'query', 'queries', 'index', 'migration*']],
  ['DevOps & infra', ['kubernetes', 'k8s', 'docker', 'container*', 'deploy*', 'terraform', 'aws', 'gcp', 'azure', 'nginx', 'pipeline', 'ci/cd', 'rollout', 'helm', 'pod', 'cluster']],
  ['Git', ['git', 'merge', 'rebase', 'commit*', 'branch', 'pull request', 'bisect', 'cherry-pick', 'stash']],
  ['Frontend & UI', ['css', 'flexbox', 'grid', 'react', 'vue', 'angular', 'dom', 'html', 'tailwind', 'responsive', 'layout', 'component*', 'viewport', 'svelte']],
  ['JavaScript & Node', ['javascript', 'typescript', 'node', 'nodejs', 'npm', 'promise*', 'async', 'es module*', 'webpack', 'vite', 'deno']],
  ['Python', ['python', 'pip', 'django', 'flask', 'pandas', 'numpy', 'pytest', 'venv', 'jupyter']],
  ['Testing', ['test', 'tests', 'testing', 'unit test*', 'jest', 'coverage', 'mock*', 'e2e', 'flaky', 'assertion*']],
  ['Performance', ['performance', 'latency', 'slow', 'optimiz*', 'profil*', 'benchmark*', 'p99', 'memory leak', 'throughput', 'cache', 'caching']],
  ['Security & auth', ['security', 'auth', 'oauth', 'token*', 'xss', 'csrf', 'vulnerab*', 'jwt', 'password*', 'encrypt*', 'tls', 'certificate*']],
  ['APIs & backend', ['api', 'apis', 'endpoint*', 'rest', 'graphql', 'http', 'webhook*', 'microservice*', 'server', 'rate limit*', 'backend']],
  ['Networking', ['dns', 'tcp', 'udp', 'websocket*', 'proxy', 'socket*', 'firewall', 'port', 'localhost']],
  ['AI & LLMs', ['llm*', 'machine learning', 'embedding*', 'prompt*', 'dataset*', 'training', 'claude', 'gpt', 'inference', 'fine-tun*']],
  ['Mobile', ['ios', 'android', 'swift', 'kotlin', 'react native', 'simulator', 'xcode']],
  ['Shell & CLI', ['bash', 'shell', 'cli', 'terminal', 'cron', 'zsh', 'stdin', 'stdout', 'ctrl-c']],
  ['Regex & parsing', ['regex*', 'regexp*', 'parser*', 'parsing', 'tokeniz*', 'grammar', 'semver']],
  ['Architecture', ['architecture', 'design pattern*', 'refactor*', 'schema*', 'scalab*', 'distributed', 'queue*', 'event-driven', 'idempotent']],
  ['Docs & writing', ['readme', 'documentation', 'docs', 'blog', 'summariz*', 'draft*', 'write-up', 'email', 'standup', 'postmortem']],
  ['Config & build', ['config*', 'toml', 'yaml', 'json', 'jsonl', 'build', 'bundler', 'makefile', 'env var*', 'dotfile*']],
  ['Game development', ['unity', 'unreal', 'godot', 'sprite*', 'shader*', 'gameplay', 'collision*', 'game loop', 'pygame', 'phaser', 'game engine', 'level design', 'hitbox*', 'framerate']],
  ['Feature development', ['implement*', 'feature*', 'prototype*', 'mvp', 'add support', 'new endpoint', 'integrat*', 'ship', 'shipped', 'shipping', 'toggle', 'wire up']],
  ['Learning & questions', ['what is', 'what are', 'how does', 'how do i', 'explain*', 'difference between', 'why does', 'tutorial*', 'best practice*', 'best way', 'meaning of', 'learn*', 'walkthrough']],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiled once at module load: [{name, res: [RegExp, ...]}] */
const TAGS = RAW_TAGS.map(([name, keywords]) => ({
  name,
  res: keywords.map((kw) => {
    if (kw.endsWith('*')) return new RegExp(`\\b${esc(kw.slice(0, -1))}\\w*`, 'gi');
    return new RegExp(`\\b${esc(kw)}\\b`, 'gi');
  }),
}));

const MIN_SCORE = 2;  // a tag needs at least this many keyword hits
const MAX_TAGS = 4;   // a session carries at most this many tags

/**
 * Tag a session from a text sample (title + message excerpts).
 * @returns {string[]} tag names, strongest first (possibly empty)
 */
export function computeTags(sample) {
  if (!sample) return [];
  const scored = [];
  for (const tag of TAGS) {
    let score = 0;
    for (const re of tag.res) {
      const m = sample.match(re);
      if (m) score += m.length;
    }
    if (score >= MIN_SCORE) scored.push({ name: tag.name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_TAGS).map((t) => t.name);
}

/** Build the (bounded) text sample a session is tagged from. */
export function tagSample(title, messages) {
  const parts = [title];
  for (const m of messages.slice(0, 200)) parts.push(m.text.slice(0, 300));
  return parts.join(' ').slice(0, 40000);
}
