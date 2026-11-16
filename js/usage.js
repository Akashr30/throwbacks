// usage.js — the usage meter's numbers as the app shows them, for every
// plan. serve.py's /api/usage hands them over:
//  - Claude, live (with `python3 serve.py --claude`): the app asks when you
//    open it and when you come back, and the server asks this Mac's Claude
//    Code for the numbers /usage shows — every limit, per-model ones such as
//    Fable included. When it can't (its login lapsed), the newest numbers
//    saved on this Mac stand in, with their age: the status line's file
//    (statusline.py, from your terminal replies), Claude Code's own copy of
//    its last check, or Claude desktop's record of its own checks;
//  - Copilot, live: Copilot CLI's quota — the monthly premium allowance;
//  - ChatGPT (Codex): its session files (as of Codex's last reply, no
//    network), or live from Codex's app-server when you turn that on;
//  - Google AI (Antigravity): live from Google's agy CLI, when turned on;
//  - Cursor: only its plan name — Cursor shares no usage with other apps.
// This turns them into what the plan rings, the plan menus, Insights and
// Settings show. Pure, no DOM.

const STATUS_LINE = [['five_hour', 'session'], ['seven_day', 'weekly_all']];

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
/** "1,240" · "12.5" — a count as people write it. */
const count = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US');

/** One limit as the app shows it: {id, label, detail, pct, resetsAt}. */
function windowOf(kind, group, name, pct, resetsAt, extra = {}) {
  if (kind === 'session') return { id: 'session', label: 'Session', detail: '5-hour limit', pct, resetsAt };
  if (kind === 'weekly_all') return { id: 'week', label: 'Week', detail: 'all models', pct, resetsAt };
  if (kind === 'premium' || kind === 'chat' || kind === 'completions') {
    const unit = extra.unit === 'credits' || extra.unit === 'requests' ? extra.unit : null;
    const label = kind === 'premium' ? (unit === 'credits' ? 'AI credits' : unit === 'requests' ? 'Premium requests' : 'Premium')
      : kind === 'chat' ? 'Chat' : 'Completions';
    const used = num(extra.used) && num(extra.limit) ? `${count(extra.used)} of ${count(extra.limit)}${unit ? ` ${unit}` : ''}` : 'this month';
    const over = num(extra.overage) && extra.overage > 0 ? ` · ${count(extra.overage)} over` : '';
    return { id: kind, label, detail: `${used}${over}`, pct, resetsAt };
  }
  const base = group === 'session' || kind.startsWith('session') ? 'Session'
    : group === 'weekly' || kind.startsWith('weekly') ? 'Week' : 'Limit';
  return {
    id: `${kind}:${(name || '').toLowerCase()}`,
    label: name ? `${base} · ${name}` : base,
    detail: base === 'Session' ? '5-hour limit' : name ? `${name} only` : kind.replace(/_/g, ' '),
    pct,
    resetsAt,
  };
}

/** When a window ended at the latest: its reset, else (no reset time known) its length after the reading. */
const endOf = (w) => w.resetsAt ?? w.until ?? null;

/** Windows still running, and those whose reset time has passed (they say nothing about now). */
function split(list, now) {
  return {
    windows: list.filter((w) => endOf(w) == null || endOf(w) > now),
    expired: list.filter((w) => endOf(w) != null && endOf(w) <= now),
  };
}

const HOUR = 3600e3;
const WEEK = 7 * 24 * HOUR;

/**
 * A server reading's windows ({kind, group?, name?, pct, resets_at, …}) as the app shows them.
 * A window with no reset time (Claude desktop's record) has reset at the latest one window
 * length after the reading (`until`): 5 hours for a session, 7 days for a week.
 */
function windowsOf(reading) {
  const at = reading && num(reading.at) ? reading.at * 1000 : null;
  return (reading && Array.isArray(reading.windows) ? reading.windows : [])
    .filter((w) => w && typeof w.kind === 'string' && num(w.pct))
    .map((w) => {
      const win = windowOf(w.kind, w.group, str(w.name), Math.round(w.pct), num(w.resets_at) ? w.resets_at * 1000 : null, w);
      const hours = win.label.startsWith('Session') ? 5 : win.label.startsWith('Week') ? 7 * 24 : null;
      if (win.resetsAt == null && at != null && hours) win.until = at + hours * HOUR;
      return win;
    });
}

/** The tools the app can ask for live numbers, by plan — what Settings lists and main.js asks. */
export const LIVE_TOOLS = {
  claude: { app: 'Claude Code', ask: 'Ask Claude Code' },
  copilot: { app: 'Copilot CLI', ask: 'Ask Copilot CLI' },
  chatgpt: { app: 'Codex', ask: 'Ask Codex' },
  google: { app: 'the Antigravity CLI (agy)', ask: 'Ask the Antigravity CLI' },
};
/** Whether each is asked, until you change it: the two you said yes to on. */
export const ASK_DEFAULTS = { claude: true, copilot: true, chatgpt: false, google: false };

const PROBLEMS = {
  claude: {
    no_cli: 'Claude Code isn’t installed on this Mac (the claude command), so there’s no live reading.',
    no_plan: 'Claude Code isn’t logged in to a Claude plan — run claude auth login in Terminal.',
    unavailable: 'Claude Code couldn’t get your usage just now. Throwbacks asks again when you come back.',
    essential_only: 'Claude Code is set to essential traffic only (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC), which blocks the usage request.',
    timeout: 'Claude Code didn’t answer in time. Throwbacks asks again when you come back.',
    no_answer: 'Claude Code closed without answering — run claude once in Terminal to check it starts.',
    unsupported: 'This Claude Code is too old to report usage — update it.',
    cli_error: 'Claude Code couldn’t report usage.',
  },
  copilot: {
    no_cli: 'Copilot CLI isn’t installed on this Mac (the copilot command), so there’s no reading.',
    no_login: 'Copilot CLI isn’t logged in — run copilot login in Terminal.',
    no_access: 'GitHub says this account has no Copilot (403) — check its Copilot plan on github.com, or log Copilot CLI in with the account that has it.',
    unsupported: 'This Copilot CLI can’t report its quota — update it (copilot update).',
    timeout: 'Copilot CLI didn’t answer in time. Throwbacks asks again when you come back.',
    no_answer: 'Copilot CLI closed without answering — run copilot once in Terminal to check it starts.',
    cli_error: 'Copilot CLI couldn’t report your quota.',
  },
  chatgpt: {
    no_cli: 'Codex isn’t installed on this Mac (the codex command).',
    no_plan: 'Codex has no plan limits to report — it’s logged in with an API key, or not at all: run codex login in Terminal.',
    unsupported: 'This Codex is too old to report its limits — update it.',
    timeout: 'Codex didn’t answer in time. Throwbacks asks again when you come back.',
    no_answer: 'Codex closed without answering — run codex once in Terminal to check it starts.',
    cli_error: 'Codex couldn’t report its limits.',
  },
  google: {
    no_cli: 'The Antigravity CLI (agy) isn’t installed on this Mac.',
    unsupported: 'This agy is older than 1.1.11, which can’t report usage without asking the model — update it.',
    not_local: 'agy’s /usage answer wasn’t the usage rows Throwbacks reads (it may have gone to the model), so Throwbacks stopped asking it until the server restarts.',
    unavailable: 'agy listed no limits.',
    timeout: 'agy didn’t answer in time. Throwbacks asks again when you come back.',
    no_answer: 'agy closed without answering — run agy once in Terminal to check it starts.',
    cli_error: 'agy couldn’t report your usage.',
  },
};

/**
 * The same problems for Settings' rows: a few words, and the one thing to do
 * (`code` in backticks; null when there's nothing to do but wait). Every
 * PROBLEMS case has one (usage.test.mjs checks).
 */
const SHORT = {
  claude: {
    no_cli: ['Claude Code isn’t installed', null],
    no_plan: ['Not logged in to a Claude plan', 'Run `claude auth login` in Terminal — an API key has no plan limits.'],
    unavailable: ['Couldn’t get your usage just now', 'Throwbacks asks again when you come back.'],
    essential_only: ['Blocked by essential-traffic-only mode', 'Claude Code’s `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` setting refuses the usage request.'],
    timeout: ['Didn’t answer in time', 'Throwbacks asks again when you come back.'],
    no_answer: ['Closed without answering', 'Run `claude` once in Terminal to check it starts.'],
    unsupported: ['Too old to report usage', 'Update Claude Code.'],
    cli_error: ['Couldn’t report usage', null],
  },
  copilot: {
    no_cli: ['Copilot CLI isn’t installed', null],
    no_login: ['Not logged in', 'Run `copilot login` in Terminal.'],
    no_access: ['No Copilot on this account', 'Check its Copilot plan on github.com.'],
    unsupported: ['Can’t report its quota', 'Update it: `copilot update`.'],
    timeout: ['Didn’t answer in time', 'Throwbacks asks again when you come back.'],
    no_answer: ['Closed without answering', 'Run `copilot` once in Terminal to check it starts.'],
    cli_error: ['Couldn’t report your quota', null],
  },
  chatgpt: {
    no_cli: ['Codex isn’t installed', null],
    no_plan: ['No plan limits', 'Codex uses an API key or isn’t signed in: run `codex login` in Terminal.'],
    unsupported: ['Too old to report its limits', 'Update Codex.'],
    timeout: ['Didn’t answer in time', 'Throwbacks asks again when you come back.'],
    no_answer: ['Closed without answering', 'Run `codex` once in Terminal to check it starts.'],
    cli_error: ['Couldn’t report its limits', null],
  },
  google: {
    no_cli: ['agy isn’t installed', null],
    unsupported: ['Older than 1.1.11', 'Update agy: older versions would send /usage to the model, so they’re never asked.'],
    not_local: ['Stopped asking', 'agy’s answer wasn’t its usage rows (it may have gone to the model); it’s asked again after the server restarts.'],
    unavailable: ['No limits listed', null],
    timeout: ['Didn’t answer in time', 'Throwbacks asks again when you come back.'],
    no_answer: ['Closed without answering', 'Run `agy` once in Terminal to check it starts.'],
    cli_error: ['Couldn’t report your usage', null],
  },
};

/** The problem that means a tool's own login is missing, and the one command that fixes it. */
export const LOGINS = {
  claude: { error: 'no_plan', app: 'Claude Code', command: 'claude auth login' },
  copilot: { error: 'no_login', app: 'Copilot CLI', command: 'copilot login' },
  chatgpt: { error: 'no_plan', app: 'Codex', command: 'codex login' },
};

/**
 * The command that logs this plan's tool in again, when its last ask said it isn't; else null.
 * Claude Code's "no plan" also covers a login whose plan it named but whose limits it doesn't
 * report (logging in again wouldn't change that): no command then.
 */
export function loginNeeded(u, planId = 'claude') {
  const fix = LOGINS[planId];
  if (!fix || !liveProblem(u, planId)) return null;
  const live = planId === 'claude' ? u.live : u.plans[planId].live;
  return live.error === fix.error && !(planId === 'claude' && live.plan) ? fix : null;
}

/** Every problem a plan's reading can name, with both wordings — for the tests. */
export const problemCodes = () => Object.fromEntries(Object.keys(PROBLEMS).map((id) => [id, { long: Object.keys(PROBLEMS[id]), short: Object.keys(SHORT[id] || {}) }]));

/** Cursor's plan names, as Cursor stores them. */
const CURSOR_PLANS = { free: 'Free', free_trial: 'Free trial', pro: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra', team: 'Teams', business: 'Teams', enterprise: 'Enterprise' };
export const CURSOR_USAGE_URL = 'https://cursor.com/dashboard?tab=usage';

function liveOf(info) {
  const r = info && info.reading && typeof info.reading === 'object' ? info.reading : null;
  return {
    found: !!(info && info.found !== false),
    enabled: !!(info && info.enabled === true),
    at: r && num(r.at) ? r.at * 1000 : null,
    error: r ? str(r.error) : null,
    detail: r ? str(r.detail) : null,
    plan: r ? str(r.plan) : null,
    reading: r,
  };
}

/** Copilot, ChatGPT (Codex), Google AI and Cursor, from /api/usage's `plans`. */
function otherPlans(plans, now) {
  const p = plans && typeof plans === 'object' ? plans : {};
  const out = {};
  for (const id of ['copilot', 'chatgpt', 'google']) {
    const info = p[id];
    if (!info || typeof info !== 'object') continue;
    const live = liveOf(info);
    let list = windowsOf(live.reading);
    let source = list.length ? 'live' : null;
    let asOf = live.at;
    // Codex: its session files when there's no live answer — or when they're newer than it.
    const local = id === 'chatgpt' && info.local && typeof info.local === 'object' ? windowsOf(info.local) : [];
    const localAt = local.length && num(info.local.at) ? info.local.at * 1000 : null;
    if (local.length && (!list.length || (localAt || 0) > (live.at || 0))) {
      list = local;
      source = 'local';
      asOf = localAt;
    }
    out[id] = {
      found: live.found,
      cli: info.cli !== false && live.found,
      enabled: live.enabled,
      live: { at: live.at, error: live.error, detail: live.detail },
      // It answered, without numbers (all unlimited, or pooled):
      answered: !!(live.reading && live.at && !live.error && !windowsOf(live.reading).length),
      unlimited: live.reading && Array.isArray(live.reading.unlimited) ? live.reading.unlimited.filter((k) => typeof k === 'string') : [],
      source,
      usage: list.length ? { asOf, ...split(list, now) } : null,
      pooled: id === 'copilot' && !!(live.reading && live.reading.pooled) && !list.length,
    };
  }
  if (p.cursor && typeof p.cursor === 'object' && p.cursor.found) {
    const raw = str(p.cursor.plan);
    out.cursor = {
      found: true,
      signedOut: p.cursor.signedOut === true,
      plan: raw && p.cursor.signedOut !== true ? CURSOR_PLANS[raw] || raw.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : null,
      seenAt: num(p.cursor.seenAt) ? p.cursor.seenAt * 1000 : null,
    };
  }
  return out;
}

/**
 * @param {object|null} status /api/usage's answer; null when there's no server
 * @param {number} [now] ms
 * @returns {{
 *   available: boolean,
 *   source: 'live'|'statusline'|'claudecode'|'desktop'|null,  // where `claude` comes from
 *   live: {enabled: boolean, at: number|null, error: string|null, detail: string|null},
 *   setup: 'on'|'other'|'off',         // the status line runs our script / another one / none
 *   data: 'none'|'ok'|'missing',       // numbers / none / Claude Code reports no plan usage
 *   claude: null | {asOf, windows: [{id, label, detail, pct, resetsAt}], expired: [...]},
 *   plans: {copilot?, chatgpt?, google?: {found, cli, enabled, live, answered, unlimited, source, usage, pooled},
 *           cursor?: {found, signedOut, plan, seenAt}},
 *   ask: {claude, copilot, chatgpt, google: boolean}, sample: boolean,
 *   seenAt, command, snippet, settingsFile,
 * }}
 */
export function readUsage(status, now = Date.now()) {
  if (!status || typeof status !== 'object') {
    return { available: false, sample: false, ask: { ...ASK_DEFAULTS }, source: null, live: { enabled: false, at: null, error: null, detail: null, plan: null }, setup: 'off', data: 'none', claude: null, plans: {} };
  }
  const ask = { ...ASK_DEFAULTS };
  if (status.ask && typeof status.ask === 'object') {
    for (const id of Object.keys(ASK_DEFAULTS)) if (typeof status.ask[id] === 'boolean') ask[id] = status.ask[id];
  }
  const info = status.live && typeof status.live === 'object' ? status.live : {};
  const live = liveOf({ ...info, found: true });
  const liveList = windowsOf(live.reading);

  const r = status.reading && typeof status.reading === 'object' ? status.reading : null;
  const lineList = [];
  for (const [key, kind] of STATUS_LINE) {
    const w = r && r[key];
    if (!w || !num(w.used_percentage) || !num(w.resets_at)) continue;
    lineList.push(windowOf(kind, null, null, Math.round(w.used_percentage), w.resets_at * 1000));
  }

  // Saved by the Claude apps themselves: Claude Code's last check, Claude desktop's.
  const saved = status.saved && typeof status.saved === 'object' ? status.saved : {};
  const savedOf = (s) => (s && typeof s === 'object' ? { list: windowsOf(s), at: num(s.at) ? s.at * 1000 : null } : { list: [], at: null });
  const code = savedOf(saved.code);
  const desktop = savedOf(saved.desktop);
  // Claude's week resets at the same time every week: a week with no reset time of its own
  // (Claude desktop's) has reset by the first such time after its reading, if any reading knows it.
  const anchor = [...liveList, ...lineList, ...code.list].find((w) => w.label.startsWith('Week') && w.resetsAt != null);
  for (const w of desktop.list) {
    if (anchor && w.until != null && w.label.startsWith('Week') && desktop.at != null) {
      w.until = Math.min(w.until, anchor.resetsAt + Math.ceil((desktop.at - anchor.resetsAt) / WEEK) * WEEK);
    }
  }

  let claude = null;
  let source = null;
  if (liveList.length) {
    claude = { asOf: live.at, ...split(liveList, now) };
    source = 'live';
  } else {
    // No live numbers: the newest reading saved on this Mac, whole — never mixed.
    const found = [
      ['statusline', { list: lineList, at: r && r.at ? r.at * 1000 : null }],
      ['claudecode', code],
      ['desktop', desktop],
    ].filter(([, s]) => s.list.length);
    const [id, best] = found.reduce((a, b) => ((b[1].at || 0) > (a[1].at || 0) ? b : a), found[0] || [null, null]);
    if (best) {
      claude = { asOf: best.at, ...split(best.list, now) };
      source = id;
    }
  }
  let data = claude ? 'ok' : 'none';
  if (!liveList.length && r && r.missing_at && (!r.at || r.missing_at > r.at)) data = 'missing';
  return {
    available: true,
    sample: status.sample === true,  // /?sample: the meter is off, nothing real is read
    ask,                             // which tools may be asked — kept by the server
    source,
    live: { enabled: live.enabled, at: live.at, error: live.error, detail: live.detail, plan: live.plan },
    setup: status.ours ? 'on' : status.configured ? 'other' : 'off',
    data,
    claude,
    plans: otherPlans(status.plans, now),
    seenAt: r && r.seen_at ? r.seen_at * 1000 : null,
    command: status.command || null,
    snippet: status.snippet || null,
    settingsFile: status.settingsFile || null,
  };
}

/** Why a plan's live reading has no numbers, in a sentence; null when it has them (or isn't asked). */
export function liveProblem(u, planId = 'claude') {
  if (!u) return null;
  const live = planId === 'claude' ? u.live : u.plans && u.plans[planId] && u.plans[planId].live;
  const enabled = planId === 'claude' ? u.live && u.live.enabled : u.plans && u.plans[planId] && u.plans[planId].enabled;
  if (!live || !enabled || !live.error || (u.ask && u.ask[planId] === false)) return null;
  const texts = PROBLEMS[planId] || PROBLEMS.claude;
  const text = texts[live.error] || texts.cli_error;
  return live.error === 'cli_error' && live.detail ? `${text} It said: ${live.detail}` : text;
}

/**
 * The same problem as liveProblem, short: {text, fix} for a Settings row
 * (`fix` may hold `code` in backticks), or null in the same cases.
 */
export function liveShort(u, planId = 'claude') {
  if (!liveProblem(u, planId)) return null;
  const live = planId === 'claude' ? u.live : u.plans[planId].live;
  const texts = SHORT[planId] || SHORT.claude;
  const [text, fix] = texts[live.error] || texts.cli_error;
  return { text, fix: live.error === 'cli_error' && live.detail ? `It said: ${live.detail}` : fix };
}

const CLAUDE_SOURCES = {
  live: 'From Claude Code',
  statusline: 'From the status line',
  claudecode: 'From Claude Code’s last check',
  desktop: 'From Claude desktop',
};

/** Where a plan's numbers come from, for "From … · 3 min ago". */
export function sourceLabel(u, planId) {
  if (planId === 'claude') return CLAUDE_SOURCES[u.source] || CLAUDE_SOURCES.statusline;
  const p = u.plans && u.plans[planId];
  if (planId === 'chatgpt') return p && p.source === 'local' ? 'From your Codex sessions' : 'From Codex';
  return planId === 'copilot' ? 'From Copilot CLI' : planId === 'google' ? 'From the Antigravity CLI' : '';
}

/** Plan id -> its usage, for the rings ({} when nothing is known). */
export function planUsage(u) {
  const out = u && u.claude ? { claude: u.claude } : {};
  for (const [id, p] of Object.entries((u && u.plans) || {})) if (p.usage) out[id] = p.usage;
  return out;
}

/** The plans the usage meter shows a chip for even with no chats loaded from
 *  them: numbers, a pooled allowance, Cursor's plan name — and Codex and
 *  Antigravity always, as placeholders until they're installed (a dashed
 *  ring; their menu says what's missing). */
export function plansKnown(u) {
  const out = planUsage(u);
  for (const [id, p] of Object.entries((u && u.plans) || {})) {
    if (p.pooled || p.answered || (id === 'cursor' && p.plan) || id === 'chatgpt' || id === 'google') out[id] = out[id] || true;
  }
  return out;
}
