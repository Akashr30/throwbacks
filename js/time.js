// time.js — the ≈hours activity-block heuristic. Pure functions, no DOM.
//
// The export records timestamps, not presence, so time is ESTIMATED:
// consecutive activity with gaps <= GAP_MIN minutes forms one active block;
// block duration = (last - first) + TAIL_MIN minutes of reading tail.
// Every figure derived here is displayed with a "≈" prefix by the callers.

export const GAP_MIN = 15;   // minutes; a longer gap starts a new block
export const TAIL_MIN = 2;   // minutes of reading tail added to each block

const GAP_MS = GAP_MIN * 60 * 1000;
const TAIL_MS = TAIL_MIN * 60 * 1000;

/**
 * Build activity blocks from a list of timestamps (ms). Input need not be
 * sorted. Returns [{start, end}] sorted by start; a single-timestamp block
 * spans TAIL_MIN minutes.
 */
export function buildBlocks(timestamps) {
  if (!timestamps || timestamps.length === 0) return [];
  const ts = [...timestamps].sort((a, b) => a - b);
  const blocks = [];
  let start = ts[0];
  let last = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - last > GAP_MS) {
      blocks.push({ start, end: last + TAIL_MS });
      start = ts[i];
    }
    last = ts[i];
  }
  blocks.push({ start, end: last + TAIL_MS });
  return blocks;
}

/** Total duration (ms) of a list of blocks. */
export function blocksDuration(blocks) {
  return blocks.reduce((sum, b) => sum + (b.end - b.start), 0);
}

/**
 * Merge several block lists into their wall-clock UNION, so parallel
 * sessions overlapping in time are not double-counted. Returns merged
 * blocks sorted by start.
 */
export function mergeBlocks(blockLists) {
  const all = blockLists.flat().sort((a, b) => a.start - b.start);
  if (all.length === 0) return [];
  const merged = [{ ...all[0] }];
  for (let i = 1; i < all.length; i++) {
    const top = merged[merged.length - 1];
    if (all[i].start <= top.end) {
      top.end = Math.max(top.end, all[i].end);
    } else {
      merged.push({ ...all[i] });
    }
  }
  return merged;
}

/** Convenience: estimated active ms for a list of timestamps. */
export function estimateMs(timestamps) {
  return blocksDuration(buildBlocks(timestamps));
}

/**
 * Format an estimated duration as "≈2h 40m" / "≈45m" / "≈3h".
 * Anything under a minute rounds up to "≈1m" (we never claim zero for
 * real activity).
 */
export function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `≈${m}m`;
  if (m === 0) return `≈${h}h`;
  return `≈${h}h ${m}m`;
}
