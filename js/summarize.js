// summarize.js — optional AI summarizer: provider adapters (Groq, Gemini)
// behind one interface, token budgeting, and the map-reduce orchestrator.
// NO DOM here. This module is the ONLY place in the app that may contact
// the network with conversation text, and only via the adapter the user
// activated, and only when summarize() is invoked.

import { apiFetch } from './util.js';

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ],
    // Conservative free-tier budgets; adapters decide batching from these.
    perCallTokens: 5500,
    delayMs: 500,
    async listModels(key, signal) {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      return (json.data || []).map((m) => m.id).filter(Boolean).sort();
    },
    async chat(key, model, system, user, signal) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      }
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw makeApiError(0, 'Empty response from Groq');
      return { text, usage: usageOf({ input: json?.usage?.prompt_tokens, output: json?.usage?.completion_tokens }) };
    },
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5-mini',
    // Static fallback — "Fetch models" pulls the live list.
    models: ['gpt-5-mini', 'gpt-5.1', 'gpt-4o-mini'],
    perCallTokens: 16000,
    delayMs: 300,
    async chat(key, model, system, user, signal) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        // No temperature: several OpenAI families accept only the default.
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      }
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text) throw makeApiError(0, 'Empty response from OpenAI');
      return { text, usage: usageOf({ input: json?.usage?.prompt_tokens, output: json?.usage?.completion_tokens }) };
    },
    async listModels(key, signal) {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      return (json.data || []).map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id)
          && !/(embed|audio|realtime|tts|whisper|image|dall|transcribe|moderation|search)/.test(id))
        .sort();
    },
  },
  claude: {
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'],
    perCallTokens: 12000,
    delayMs: 400,
    async chat(key, model, system, user, signal) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          // Anthropic requires this explicit opt-in for browser-side calls.
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      }
      const text = (json.content || [])
        .filter((c) => c && c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (!text) throw makeApiError(0, 'Empty response from Claude');
      const u = json.usage || {};
      return { text, usage: usageOf({ input: u.input_tokens, output: u.output_tokens, cacheWrite: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens }) };
    },
    async listModels(key, signal) {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      return (json.data || []).map((m) => m.id).filter(Boolean).sort();
    },
  },
  claudecode: {
    label: 'Claude Code (local)',
    noKey: true, // rides the machine's own `claude` login — no API key
    defaultModel: 'default',
    models: ['default', 'sonnet', 'opus', 'haiku'],
    perCallTokens: 12000,
    delayMs: 300,
    async chat(key, model, system, user, signal) {
      // Same-origin bridge served by serve.py --claude (loopback only).
      const res = await apiFetch('/api/claude-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system,
          prompt: user,
          model: model && model !== 'default' ? model : null,
        }),
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw makeApiError(res.status, json?.error || `HTTP ${res.status}`);
      if (!json.text) throw makeApiError(0, 'Empty response from local Claude Code');
      // serve.py passes on what Claude Code said the run used (input, output, cache), when it says.
      return { text: json.text, usage: usageOf(json.usage || {}) };
    },
    async listModels() {
      return ['default', 'sonnet', 'opus', 'haiku'];
    },
  },
  gemini: {
    label: 'Gemini',
    defaultModel: 'gemini-3.6-flash',
    // Static fallback only — "Fetch models" pulls the live list, since
    // Google retires model ids for new users (2.5-flash died that way).
    models: ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    perCallTokens: 24000, // large context: batch several small conversations
    delayMs: 300,
    async listModels(key, signal) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
        { signal },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      return (json.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
    },
    async chat(key, model, system, user, signal) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        }),
        signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw makeApiError(res.status, json?.error?.message || `HTTP ${res.status}`);
      }
      const parts = json?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : null;
      if (!text) throw makeApiError(0, 'Empty response from Gemini');
      // Gemini's prompt count includes its cached part, and a thinking model's thoughts are billed as output.
      const u = json.usageMetadata || {};
      const cached = Number.isFinite(u.cachedContentTokenCount) ? u.cachedContentTokenCount : 0;
      const thoughts = Number.isFinite(u.thoughtsTokenCount) ? u.thoughtsTokenCount : 0;
      return {
        text,
        usage: usageOf({
          input: Number.isFinite(u.promptTokenCount) ? Math.max(0, u.promptTokenCount - cached) : undefined,
          output: Number.isFinite(u.candidatesTokenCount) || thoughts ? (u.candidatesTokenCount || 0) + thoughts : undefined,
          cacheRead: cached || undefined,
        }),
      };
    },
  },
};

function makeApiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Probe the serve.py --claude bridge. Returns its status or {enabled:false}. */
export async function localClaudeStatus() {
  try {
    const res = await apiFetch('/api/claude-status');
    const json = await res.json();
    return res.ok && json && typeof json === 'object' ? json : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

/** Rough token estimate: chars/4. */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/** Middle-truncate a transcript to ~maxTokens. */
export function capTranscript(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2) - 20;
  return `${text.slice(0, half)}\n[… middle truncated …]\n${text.slice(-half)}`;
}

const SYSTEM_PROMPT = 'You summarize a developer\'s AI-chat history. Prefer decisions and '
  + 'outcomes over play-by-play. Say "explored" when something was only discussed and '
  + '"decided" only when it truly was. Keep the user\'s own terms, names and numbers. '
  + 'Never invent open items or facts not present in the text. Be concise.';

/**
 * One tiny call to verify a key/model. Returns the model's reply text;
 * throws with the provider's own error message on failure.
 */
export async function testKey(providerId, key, model, signal) {
  const p = PROVIDERS[providerId];
  // parse.js knows these words (TEST_PROMPT): old test runs saved as sessions are skipped by it.
  const reply = await p.chat(key, model || p.defaultModel, 'Reply with exactly: OK', 'ping', signal);
  return typeof reply === 'string' ? reply : reply.text;
}

/**
 * Greedy-pack sessions into batches that fit the per-call token budget.
 * A session too large for one call is capped, alone in its batch.
 * @param {Array<{id,title,when,text}>} items
 */
export function planBatches(items, perCallTokens) {
  const overhead = 300; // prompt scaffolding
  const perSession = Math.max(1000, perCallTokens - overhead);
  const batches = [];
  let cur = [];
  let curTokens = 0;
  for (const it of items) {
    const capped = { ...it, text: capTranscript(it.text, perSession) };
    const t = estimateTokens(capped.text) + 60;
    if (cur.length && curTokens + t > perCallTokens - overhead) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(capped);
    curTokens += t;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function mapPrompt(batch) {
  const head = 'Summarize EACH conversation below into 3-6 bullets covering: topics '
    + 'explored, decisions made, outcomes. Output STRICTLY this format, in order, '
    + 'nothing else:\n@@S1\n- bullet\n- bullet\n@@S2\n- bullet\n…\n\n';
  const body = batch.map((s, i) =>
    `@@S${i + 1} ${s.title} (${s.when})\n${s.text}`).join('\n\n----\n\n');
  return head + body;
}

/** Parse "@@S<n>" sections back out; returns Map(index -> bullets[]). */
export function parseMapOutput(text, count) {
  const out = new Map();
  const re = /^@@S(\d+)\b.*$/gm;
  const marks = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marks.push({ idx: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined);
    const bullets = chunk.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*•]/.test(l))
      .map((l) => l.replace(/^[-*•]\s*/, ''));
    if (marks[i].idx >= 1 && marks[i].idx <= count && bullets.length) {
      out.set(marks[i].idx, bullets);
    }
  }
  return out;
}

function reducePrompt(rangeLabel, perSession) {
  const head = `These are per-conversation summaries of an AI-chat history for ${rangeLabel}. `
    + 'Write an overall recap: 2-4 sentences (or up to 5 "- " bullets) covering the main '
    + 'threads worked on, big decisions, and anything explicitly left open. Nothing else.\n\n';
  const body = perSession.map((s) =>
    `${s.title} (${s.when}):\n${s.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n');
  return head + body;
}

const RETRY_WAITS = [2500, 6000]; // transient-error backoff, then give up

/** Transient provider trouble: rate limits AND capacity/overload errors. */
function isTransient(e) {
  const msg = e.message || '';
  // Auth problems are never transient — retrying or relabeling them as
  // "overloaded" just hides the real fix (re-login / new key).
  if (e.status === 401 || e.status === 403 || /authenticat|expired.*token|invalid.*key/i.test(msg)) {
    return false;
  }
  // 529 is Anthropic's "overloaded" status.
  return e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503
    || e.status === 529
    || /overloaded|high demand|temporar|try again later/i.test(msg);
}

/** Compact label for a failed batch — never a wall of full titles. */
function batchLabel(batch) {
  const first = String(batch[0].title).slice(0, 48);
  return batch.length === 1 ? first : `${batch.length} conversations (${first}…)`;
}

/**
 * Map-reduce summarizer. Pure orchestration; the caller supplies session
 * texts and receives partial results as they complete.
 *
 * @param {object} o
 *   o.items      [{id, title, when, text}] in time order
 *   o.provider   'groq' | 'gemini'
 *   o.key, o.model
 *   o.rangeLabel human label ("Last 7 days · 1–8 Sept 2026")
 *   o.signal     AbortSignal (cancel)
 *   o.onProgress (done, total) => void
 *   o.onPartial  (sessionResult {id,title,when,bullets}) => void
 *   o.adapter    test override for PROVIDERS[provider]
 *   o.sleep      test override for the delay fn
 * @returns {Promise<{recap: string, perSession: Array, errors: Array<string>}>}
 */
/** One provider call with backoff on transient errors; cancellable. */
function makeCaller(o, adapter, model, system, sleep) {
  return async (user) => {
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw makeCancelled();
      try {
        // A reply is its text, or {text, usage}: the tokens the provider says the call used go to o.onUsage.
        const reply = await adapter.chat(o.key, model, system, user, o.signal);
        if (typeof reply === 'string') return reply;
        if (reply.usage) o.onUsage?.(reply.usage);
        return reply.text;
      } catch (e) {
        if (o.signal?.aborted || e.name === 'AbortError') throw makeCancelled();
        if (isTransient(e) && attempt < RETRY_WAITS.length) {
          await sleep(RETRY_WAITS[attempt]);
          continue;
        }
        if (isTransient(e)) {
          e.message = 'The provider is rate-limited or overloaded right now — wait a minute '
            + `or try a smaller range. (${e.message})`;
        }
        throw e;
      }
    }
  };
}

export async function summarizeRange(o) {
  const adapter = o.adapter || PROVIDERS[o.provider];
  const model = o.model || adapter.defaultModel;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const errors = [];
  const call = makeCaller(o, adapter, model, SYSTEM_PROMPT, sleep);

  const batches = planBatches(o.items, adapter.perCallTokens);
  const perSession = [];
  let done = 0;
  o.onProgress?.(0, o.items.length);

  for (const batch of batches) {
    if (o.signal?.aborted) throw makeCancelled(perSession);
    let parsed = new Map();
    try {
      parsed = parseMapOutput(await call(mapPrompt(batch)), batch.length);
    } catch (e) {
      if (e.cancelled) { e.partial = perSession; throw e; }
      errors.push(`${batchLabel(batch)}: ${e.message}`);
      // a hard provider error mid-run stops the loop; keep what we have
      return { recap: null, perSession, errors };
    }
    // Any session the model failed to mark gets one solo retry.
    for (let i = 0; i < batch.length; i++) {
      const s = batch[i];
      let bullets = parsed.get(i + 1);
      if (!bullets) {
        try {
          await sleep(adapter.delayMs);
          bullets = parseMapOutput(await call(mapPrompt([s])), 1).get(1)
            || ['(could not parse the model’s summary for this conversation)'];
        } catch (e) {
          if (e.cancelled) { e.partial = perSession; throw e; }
          errors.push(`${String(s.title).slice(0, 48)}: ${e.message}`);
          return { recap: null, perSession, errors };
        }
      }
      const result = { id: s.id, title: s.title, when: s.when, bullets };
      perSession.push(result);
      done++;
      o.onPartial?.(result);
      o.onProgress?.(done, o.items.length);
    }
    await sleep(adapter.delayMs);
  }

  // Reduce: overall recap from the per-conversation summaries.
  let recap = null;
  try {
    recap = (await call(reducePrompt(o.rangeLabel, perSession))).trim();
  } catch (e) {
    if (e.cancelled) { e.partial = perSession; throw e; }
    errors.push(`Overall recap: ${e.message}`);
  }
  return { recap, perSession, errors };
}

// ---------------------------------------------------------------------------
// Daily log: work-log lines per chat for one day (only what's new since the
// last time), and a short recap per week from those lines.
// ---------------------------------------------------------------------------

const LOG_SYSTEM = 'You write a developer\'s daily work log from their AI-assistant chats. '
  + 'Each line is short, concrete and in the past tense: what was done, decided or found out. '
  + 'Keep their own names, terms and numbers. Never invent anything that is not in the text. '
  + 'Write "explored" or "discussed" when something was only talked about.';

function dayLogPrompt(dateLabel, batch) {
  const head = `Write work-log lines for ${dateLabel} for EACH conversation below: 1-4 lines `
    + 'each, under 20 words per line, never "the user". Where lines were already written for a '
    + 'conversation, write only what is NEW in the text shown and never repeat them; if nothing '
    + 'new was done, write NONE. Output STRICTLY this format, in order, nothing else:\n'
    + '@@S1\n- line\n- line\n@@S2\n- line\n…\n\n';
  const body = batch.map((p, i) => [
    `@@S${i + 1} ${p.title}${p.project ? ` (project: ${p.project})` : ''}`,
    p.earlier.length ? `Already written:\n${p.earlier.map((l) => `- ${l}`).join('\n')}` : '',
    `${p.earlier.length ? 'New part of the conversation' : 'Conversation'}:\n${p.text}`,
  ].filter(Boolean).join('\n')).join('\n\n----\n\n');
  return head + body;
}

/**
 * Parse "@@S<n>" sections into lines. Unlike the range summary, a section
 * that says NONE is an answer (no new lines), not a failure: it maps to [].
 * Sections the model left out are absent from the Map.
 */
export function parseLogOutput(text, count) {
  const out = new Map();
  const re = /^@@S(\d+)\b.*$/gm;
  const marks = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marks.push({ idx: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const { idx } = marks[i];
    if (idx < 1 || idx > count || out.has(idx)) continue;
    const chunk = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined);
    const lines = chunk.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^none\.?$/i.test(l))
      .map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
    out.set(idx, lines);
  }
  return out;
}

/** Pack parts (each {text, earlier}) into calls that fit the token budget. */
export function planLogBatches(parts, perCallTokens) {
  const overhead = 400;
  const room = Math.max(1000, perCallTokens - overhead);
  const batches = [];
  let cur = [];
  let used = 0;
  for (const p of parts) {
    const capped = { ...p, text: capTranscript(p.text, Math.max(800, room - estimateTokens(p.earlier.join('\n')))) };
    const t = estimateTokens(capped.text) + estimateTokens(capped.earlier.join('\n')) + 60;
    if (cur.length && used + t > room) {
      batches.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(capped);
    used += t;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Work-log lines for one day's chats — only their parts not summarized yet.
 * @param {object} o
 *   o.parts     [{id, title, project, text, earlier: [lines]}]
 *   o.dateLabel "Mon, 5 Oct 2026"
 *   o.provider, o.key, o.model, o.signal, o.adapter, o.sleep (as summarizeRange)
 *   o.onProgress (done, total) => void — chats done
 * @returns {Promise<{results: Map<id, string[]>, errors: string[]}>}
 *   On cancel it throws {cancelled, partial: results so far}.
 */
export async function summarizeDayLog(o) {
  const adapter = o.adapter || PROVIDERS[o.provider];
  const model = o.model || adapter.defaultModel;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const call = makeCaller(o, adapter, model, LOG_SYSTEM, sleep);
  const results = new Map();
  const errors = [];
  let done = 0;
  o.onProgress?.(0, o.parts.length);
  const batches = planLogBatches(o.parts, adapter.perCallTokens);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    try {
      let parsed = parseLogOutput(await call(dayLogPrompt(o.dateLabel, batch)), batch.length);
      for (let i = 0; i < batch.length; i++) {
        // a chat the model skipped gets one call of its own
        if (!parsed.has(i + 1)) {
          await sleep(adapter.delayMs);
          parsed = new Map([...parsed, [i + 1, parseLogOutput(await call(dayLogPrompt(o.dateLabel, [batch[i]])), 1).get(1) || null]]);
        }
        const lines = parsed.get(i + 1);
        if (lines) results.set(batch[i].id, lines);
        else errors.push(`${String(batch[i].title).slice(0, 48)}: couldn't read the model's answer`);
        o.onProgress?.(++done, o.parts.length);
      }
    } catch (e) {
      if (e.cancelled) { e.partial = results; throw e; }
      errors.push(`${batchLabel(batch)}: ${e.message}`);
      return { results, errors }; // a hard provider error stops the run; keep what's done
    }
    if (b + 1 < batches.length) await sleep(adapter.delayMs);
  }
  return { results, errors };
}

/**
 * How a recap is written (since 2026-11-16; 2-4 plain sentences before): one
 * line on the main outcome, then each project's points under its name, then
 * what's still open — the shape js/log.js recapBlocks reads back.
 */
const RECAP_FORMAT = 'Format it exactly like this, nothing else:\n'
  + '<one sentence on the main outcome, under 25 words>\n\n## <project>\n- <point>\n- <point>\n\n## Still open\n- <point>\n\n'
  + 'Group the points by the project named in [brackets] (the same project across days is one group; a short plain name, '
  + 'never a path), busiest first, at most 6 projects and 1-3 points each, every point under 18 words: outcomes and '
  + 'decisions, not activity. [No folder], [Folder not known] and [Added by you] are not projects: put their points under '
  + 'the project they mention, else in one last group "## Other" before "Still open". Unfinished or undecided items go '
  + 'under "Still open" (left out when nothing is open). No bold, no other headings or markup.';

/**
 * A period's update from its days' log lines — a week's, a month's, or any
 * dates' (`o.weekLabel`: "the week of 9 Nov", "October 2026"…): a line, then
 * each project's points, then what's still open (RECAP_FORMAT).
 * @param {object} o  o.weekLabel, o.days [{label, lines, groups?: [{project, lines}]}], provider/key/model/signal/adapter/sleep, onUsage
 * @returns {Promise<string>}
 */
export async function summarizeWeekLog(o) {
  const adapter = o.adapter || PROVIDERS[o.provider];
  const model = o.model || adapter.defaultModel;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const call = makeCaller(o, adapter, model, LOG_SYSTEM, sleep);
  const what = o.kind === 'week' || !o.kind ? 'week' : o.kind === 'month' ? 'month' : 'period';
  const ask = (span, kind) => `This is one developer's work log for ${span}, day by day, each day's lines under `
    + `their project in [brackets]. Write the ${kind}'s update for a status report. ${RECAP_FORMAT}\n\n`;
  const chunks = recapChunks(o.days, adapter.perCallTokens);
  if (chunks.length <= 1) return (await call(ask(o.weekLabel, what) + capTranscript(dayLog(o.days), adapter.perCallTokens - 400))).trim();
  // Too long for one call (a month or a long period): each stretch of days on its own, then — grouped
  // again while they still don't fit one call — one recap of those.
  const room = Math.max(1000, adapter.perCallTokens - 400);
  let parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const span = c.length === 1 ? c[0].label : `${c[0].label} to ${c[c.length - 1].label}`;
    o.onProgress?.(i, chunks.length + 1);
    parts.push({ first: c[0].label, last: c[c.length - 1].label, text: (await call(ask(span, 'stretch') + capTranscript(dayLog(c), room))).trim() });
  }
  const joined = (list) => list.map((p) => `${p.first === p.last ? p.first : `${p.first} to ${p.last}`}:\n${p.text}`).join('\n\n');
  while (parts.length > 1 && estimateTokens(joined(parts)) > room) {
    const groups = fitGroups(parts, (p) => estimateTokens(joined([p])) + 4, room);
    if (groups.length >= parts.length) break;  // no two fit together: the last call reads as much as it can
    const next = [];
    for (const g of groups) {
      if (g.length === 1) { next.push(g[0]); continue; }
      const span = `${g[0].first} to ${g[g.length - 1].last}`;
      next.push({ first: g[0].first, last: g[g.length - 1].last,
        text: (await call(`These are one developer's updates for ${span}, a stretch of days at a time, in order, each with its `
          + `projects under ## headings. Combine them into one update for that span. ${RECAP_FORMAT}\n\n`
          + joined(g))).trim() });
    }
    parts = next;
  }
  o.onProgress?.(chunks.length, chunks.length + 1);
  const prompt = `These are one developer's updates for ${o.weekLabel}, a stretch of days at a time, in order, each with `
    + `its projects under ## headings. Write the ${what}'s update for a status report from them. ${RECAP_FORMAT}\n\n`
    + capTranscript(joined(parts), room);
  return (await call(prompt)).trim();
}

/** Items in order, grouped so each group's size (by `size`) fits `room` (an item too big alone is its own group). */
function fitGroups(items, size, room) {
  const groups = [];
  let cur = [];
  let used = 0;
  for (const it of items) {
    const t = size(it);
    if (cur.length && used + t > room) {
      groups.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(it);
    used += t;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const bullets = (lines) => lines.map((l) => `- ${l}`).join('\n');

/** A recap's days as the log the summarizer reads: each day's lines under their project in [brackets]. */
export function dayLog(days) {
  return days.map((d) => {
    const body = d.groups && d.groups.length
      ? d.groups.map((g) => `[${g.project == null ? 'Folder not known' : g.project || 'No folder'}]\n${bullets(g.lines)}`).join('\n')
      : bullets(d.lines);
    return `${d.label}:\n${body}`;
  }).join('\n\n');
}

/**
 * A recap's days in stretches that each fit one call (oldest first): one
 * stretch is one call; more are one call each, then one for the recap.
 */
export function recapChunks(days, perCallTokens) {
  return fitGroups(days, (d) => estimateTokens(dayLog([d])) + 4, Math.max(1000, perCallTokens - 400));
}

/**
 * About how many calls a recap of these days takes: one; or one per stretch,
 * any to combine stretches that don't fit one call together (each answer
 * taken as ~400 tokens, as RECAP_FORMAT's are), and the recap.
 */
export function recapCalls(days, perCallTokens) {
  let n = recapChunks(days, perCallTokens).length;
  if (n <= 1) return 1;
  const room = Math.max(1000, perCallTokens - 400);
  let calls = n;
  const answer = 400;  // a stretch's answer in RECAP_FORMAT: a line, its projects' points, what's open
  while (n > 1 && n * answer > room) {
    const groups = Math.ceil((n * answer) / room);
    if (groups >= n) break;
    calls += groups;
    n = groups;
  }
  return calls + 1;
}

/**
 * Tokens one call used, as the provider counts them: {input, output,
 * cacheWrite, cacheRead} — plain non-negative numbers only, and null when
 * the provider said nothing.
 */
export function usageOf(raw) {
  const out = {};
  for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) {
    const n = raw && raw[k];
    if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
  }
  return Object.keys(out).length ? out : null;
}

/** Two usages added up (either may be null), with how many calls they cover. */
export function addUsage(a, b) {
  if (!a) return b ? { calls: 1, ...b } : null;
  if (!b) return a;
  const out = { ...a, calls: (a.calls || 1) + (b.calls || 1) };
  for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) if (a[k] != null || b[k] != null) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

/** All the input tokens a usage covers (new, cache writes and cache reads) — what "tokens in" means. */
export const tokensIn = (u) => (u ? (u.input || 0) + (u.cacheWrite || 0) + (u.cacheRead || 0) : 0);

/**
 * Tokens spent by month (`{"2026-11": 18200}`), in and out: what a summary's
 * runs used, each in the month it ran — so a day rewritten in November
 * counts its October tokens in October. `month`: "YYYY-MM" of this run.
 */
export function addSpent(spent, usage, month) {
  const n = tokensIn(usage) + ((usage && usage.output) || 0);
  if (!n) return spent || null;
  return { ...(spent || {}), [month]: ((spent && spent[month]) || 0) + n };
}

function makeCancelled(partial) {
  const e = new Error('Cancelled');
  e.cancelled = true;
  if (partial) e.partial = partial;
  return e;
}

/** Render a finished summary as markdown (for Copy / export hooks). */
export function summaryToMarkdown(rangeLabel, recap, perSession) {
  const L = [`# Summary — ${rangeLabel}`, ''];
  if (recap) L.push('## Overall recap', '', recap, '');
  L.push('> AI-generated and approximate — not a verbatim record.', '');
  for (const s of perSession) {
    L.push(`## ${s.title} (${s.when})`, '', ...s.bullets.map((b) => `- ${b}`), '');
  }
  return L.join('\n');
}
