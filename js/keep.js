// keep.js — the chats Claude Code is about to delete, and the copies
// Throwbacks keeps of them. Claude Code deletes a session once it hasn't
// been touched for cleanupPeriodDays (30 unless you set it; serve.py reads
// the setting and when each file was last written). No DOM.

import { dateKey } from './util.js';
import { daysBetween } from './plans.js';

const DAY = 24 * 60 * 60 * 1000;
export const DUE_WITHIN_DAYS = 7;     // the Expiring tab lists what goes within a week
export const SAFE_DAYS = 90;          // a shorter setting gets a warning

/**
 * The retention setting as the server reads it: {days, set, source: 'managed' |
 * 'project' | 'user' | 'default', paused} — paused: Claude Code isn't sweeping (a 0 or
 * a value it can't read), so nothing expires. Claude Code's default when unknown.
 */
export function retentionOf(keep) {
  const r = keep && keep.retention;
  if (r && r.paused) return { days: null, set: true, source: r.source || 'user', paused: true };
  return r && Number.isFinite(r.days)
    ? { days: r.days, set: !!r.set, source: r.source || (r.set ? 'user' : 'default'), paused: false }
    : { days: 30, set: false, source: 'default', paused: false };
}

/** When Claude Code will delete this session (ms), or null: not a Claude Code file, kept only by Throwbacks, or unknown. */
export function expiresAt(session, retention) {
  if (!session || session.source !== 'code' || session.onlyKept || session.desktop || !Number.isFinite(session.touchedAt)) return null;
  if (retention.paused || !Number.isFinite(retention.days)) return null;
  return session.touchedAt + retention.days * DAY;
}

/**
 * The sessions Claude Code deletes within `days` (not already kept), soonest first.
 * @returns {Array<{session, at: number, inDays: number}>}
 */
export function dueSessions(sessions, retention, now = Date.now(), days = DUE_WITHIN_DAYS) {
  const out = [];
  for (const s of sessions) {
    const at = expiresAt(s, retention);
    if (at == null || s.kept || at > now + days * DAY) continue;
    // Calendar days, so "tomorrow" always matches the date shown beside it.
    out.push({ session: s, at, inDays: Math.max(0, daysBetween(dateKey(now), dateKey(at))) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The sessions Throwbacks keeps a copy of: the ones whose original is gone first, then by last use. */
export function keptSessions(sessions) {
  return sessions.filter((s) => s.kept).sort((a, b) => (Number(!!b.onlyKept) - Number(!!a.onlyKept)) || ((b.touchedAt || 0) - (a.touchedAt || 0)));
}

/** "today", "tomorrow", "in 3 days" — when it's deleted. */
export const whenIn = (inDays) => (inDays <= 0 ? 'today' : inDays === 1 ? 'tomorrow' : `in ${inDays} days`);
