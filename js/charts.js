// charts.js — hand-rolled charts for the report (no libraries): SVG charts,
// plus the CSS-grid activity heatmap.
// Colors follow the dataviz method: a fixed-order categorical palette
// validated for light and dark surfaces (CVD-safe adjacent pairs, >=3:1
// contrast), defined as --series-* tokens in glass.css so each mode
// gets its own steps; magnitude charts use one hue (--lg-data). Labels always
// wear ink colors, never the series color; every value shown in a tooltip
// is also visible as text.

import { el, dateKey, keyToDate } from './util.js';
import { fmtDuration } from './time.js';

/** Fixed-order categorical slots (never re-ordered). CSS values, so set
 *  them through `style`, not SVG presentation attributes. */
export const SERIES = [1, 2, 3, 4, 5, 6].map((i) => `var(--series-${i})`);
export const OTHER_COLOR = 'var(--series-other)'; // de-emphasis gray for the folded tail

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}

/** Left padding that fits the widest y-axis label (--fs-cap: 0.8125rem,
 *  so it follows the Text size setting). */
function axisPad(ticks) {
  const px = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.8125;
  const longest = Math.max(...ticks.map(([, label]) => label.length));
  return Math.max(36, Math.ceil(longest * px * 0.62) + 12);
}

/** Shared single-tooltip layer per chart root (textContent only). */
function makeTooltip(root) {
  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  root.append(tip);
  return {
    show(x, y, value, label) {
      tip.textContent = '';
      tip.append(el('span', 'chart-tip-val', value), el('span', 'chart-tip-label', label));
      tip.hidden = false;
      const w = root.clientWidth;
      tip.style.left = `${Math.min(Math.max(4, x + 10), Math.max(4, w - tip.offsetWidth - 4))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// ---------------------------------------------------------------------------
// Donut — part-to-whole at a glance, <= 6 segments (top slices + "Other").
// ---------------------------------------------------------------------------

/**
 * @param {Array<{label, value}>} data descending; folded to 5 + Other here
 * @param {number} total the 100% denominator
 * @param {(v:number)=>string} fmt value formatter
 */
export function donutChart(data, total, fmt) {
  const root = el('div', 'donut-wrap');
  const slices = [];
  for (const d of data.slice(0, 5)) slices.push({ ...d, color: SERIES[slices.length] });
  const rest = data.slice(5).reduce((t, d) => t + d.value, 0);
  if (rest > 0) slices.push({ label: 'Other', value: rest, color: OTHER_COLOR });

  const SIZE = 170; const C = SIZE / 2; const R = 70; const R_IN = 42;
  const svg = svgEl('svg', {
    width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`,
    role: 'img', 'aria-label': 'Share of active time by primary topic',
  });
  const tip = makeTooltip(root);

  const arcPoint = (r, frac) => {
    const a = 2 * Math.PI * frac - Math.PI / 2;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  };
  let acc = 0;
  for (const s of slices) {
    const frac = s.value / total;
    const [x0, y0] = arcPoint(R, acc);
    const [x1, y1] = arcPoint(R, acc + frac);
    const [xi1, yi1] = arcPoint(R_IN, acc + frac);
    const [xi0, yi0] = arcPoint(R_IN, acc);
    const large = frac > 0.5 ? 1 : 0;
    const path = svgEl('path', {
      d: `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${R_IN} ${R_IN} 0 ${large} 0 ${xi0} ${yi0} Z`,
      class: 'donut-slice',
    });
    path.style.fill = s.color;
    path.append(svgEl('title', {})); // native fallback tooltip
    path.lastChild.textContent = `${s.label}: ${fmt(s.value)} (${Math.round(frac * 100)}%)`;
    const enter = (ev) => {
      path.classList.add('hot');
      const rect = root.getBoundingClientRect();
      tip.show(ev.clientX - rect.left, ev.clientY - rect.top,
        `${fmt(s.value)} · ${Math.round(frac * 100)}%`, s.label);
    };
    path.addEventListener('pointermove', enter);
    path.addEventListener('pointerleave', () => { path.classList.remove('hot'); tip.hide(); });
    svg.append(path);
    acc += frac;
  }

  const legend = el('div', 'chart-legend');
  for (const s of slices) {
    const row = el('div', 'legend-row');
    const sw = el('span', 'legend-swatch');
    sw.style.background = s.color;
    row.append(sw, el('span', 'legend-label', s.label),
      el('span', 'legend-val', `${fmt(s.value)} · ${Math.round((s.value / total) * 100)}%`));
    legend.append(row);
  }
  root.append(svg, legend);
  return root;
}

// ---------------------------------------------------------------------------
// Column chart — magnitude over time, one hue. Bins to weeks past ~120 days.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{key, label, value, onClick?}>} points in time order
 * @param {(v:number)=>string} fmt
 * @returns {{root: HTMLElement, draw: () => void}} call draw() after attach
 */
export function columnChart(points, fmt) {
  const root = el('div', 'colchart');
  const tip = makeTooltip(root);
  const H = 150; const PAD_B = 18; const PAD_T = 8;

  let lastW = 0;
  const draw = () => {
    const W = Math.max(280, root.clientWidth || 600);
    if (root.querySelector('svg') && Math.abs(W - lastW) < 2) return;
    lastW = W;
    const old = root.querySelector('svg');
    if (old) old.remove();
    const svg = svgEl('svg', {
      width: '100%', height: H, viewBox: `0 0 ${W} ${H}`,
      role: 'img', 'aria-label': 'Estimated active time per day',
    });
    const max = Math.max(1, ...points.map((p) => p.value));
    const ticks = [0.5, 1].map((f) => [f, fmt(max * f).replace('≈', '')]);
    const PAD_L = axisPad(ticks);
    const plotW = W - PAD_L - 6;
    const plotH = H - PAD_T - PAD_B;

    // Recessive gridlines + axis labels (ink tokens, never series color).
    for (const [f, label] of ticks) {
      const y = PAD_T + plotH * (1 - f);
      svg.append(svgEl('line', { x1: PAD_L, y1: y, x2: W - 4, y2: y, class: 'grid-line' }));
      const t = svgEl('text', { x: PAD_L - 6, y: y + 3, class: 'axis-label', 'text-anchor': 'end' });
      t.textContent = label;
      svg.append(t);
    }
    svg.append(svgEl('line', { x1: PAD_L, y1: PAD_T + plotH, x2: W - 4, y2: PAD_T + plotH, class: 'axis-line' }));

    const n = points.length;
    const step = plotW / n;
    const barW = Math.max(2, Math.min(26, step - 2)); // 2px gap between bars
    const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / 64)));

    points.forEach((p, i) => {
      const x = PAD_L + i * step + (step - barW) / 2;
      const h = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * plotH);
      const y = PAD_T + plotH - h;
      if (p.value > 0) {
        const r = Math.min(4, barW / 2, h);
        // rounded data-end at the top, flat at the baseline
        const bar = svgEl('path', {
          d: `M ${x} ${y + h} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + barW - r} Q ${x + barW} ${y} ${x + barW} ${y + r} V ${y + h} Z`,
          class: 'col-bar',
        });
        svg.append(bar);
      }
      // hit target wider than the mark
      const hit = svgEl('rect', { x: PAD_L + i * step, y: PAD_T, width: step, height: plotH, class: 'col-hit' });
      hit.addEventListener('pointermove', (ev) => {
        const rect = root.getBoundingClientRect();
        tip.show(ev.clientX - rect.left, ev.clientY - rect.top,
          p.value > 0 ? fmt(p.value) : 'no activity', p.label);
        svg.querySelectorAll('.col-bar.hot').forEach((b) => b.classList.remove('hot'));
        const bar = hit.previousElementSibling;
        if (bar && bar.classList.contains('col-bar')) bar.classList.add('hot');
      });
      hit.addEventListener('pointerleave', () => {
        tip.hide();
        svg.querySelectorAll('.col-bar.hot').forEach((b) => b.classList.remove('hot'));
      });
      if (p.onClick) {
        hit.classList.add('clickable');
        hit.addEventListener('click', p.onClick);
      }
      svg.append(hit);
      if (i % labelEvery === 0) {
        const t = svgEl('text', { x: PAD_L + i * step + step / 2, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' });
        t.textContent = p.shortLabel || p.label;
        svg.append(t);
      }
    });
    root.prepend(svg);
  };
  // Redraw whenever the container's real width changes (first layout,
  // pane resizes, hidden->visible transitions).
  new ResizeObserver(draw).observe(root);
  return { root, draw };
}

// ---------------------------------------------------------------------------
// Dot (lollipop) chart — one dot per day, e.g. token consumption over time.
// Same axes/binning conventions as the column chart; markers >= 9px with
// wide hit targets, a 2px surface ring, and a multi-line hover tooltip.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{label, shortLabel, value, detail?, onClick?}>} points
 * @param {(v:number)=>string} fmt
 * @returns {{root: HTMLElement, draw: () => void}} call draw() after attach
 */
export function dotChart(points, fmt) {
  const root = el('div', 'colchart');
  const tip = makeTooltip(root);
  const H = 150; const PAD_B = 18; const PAD_T = 10;

  let lastW = 0;
  const draw = () => {
    const W = Math.max(280, root.clientWidth || 600);
    if (root.querySelector('svg') && Math.abs(W - lastW) < 2) return;
    lastW = W;
    const old = root.querySelector('svg');
    if (old) old.remove();
    const svg = svgEl('svg', {
      width: '100%', height: H, viewBox: `0 0 ${W} ${H}`,
      role: 'img', 'aria-label': 'Token consumption per day',
    });
    const max = Math.max(1, ...points.map((p) => p.value));
    const ticks = [0.5, 1].map((f) => [f, fmt(Math.round(max * f))]);
    const PAD_L = axisPad(ticks);
    const plotW = W - PAD_L - 8;
    const plotH = H - PAD_T - PAD_B;

    for (const [f, label] of ticks) {
      const y = PAD_T + plotH * (1 - f);
      svg.append(svgEl('line', { x1: PAD_L, y1: y, x2: W - 4, y2: y, class: 'grid-line' }));
      const t = svgEl('text', { x: PAD_L - 6, y: y + 3, class: 'axis-label', 'text-anchor': 'end' });
      t.textContent = label;
      svg.append(t);
    }
    svg.append(svgEl('line', { x1: PAD_L, y1: PAD_T + plotH, x2: W - 4, y2: PAD_T + plotH, class: 'axis-line' }));

    const n = points.length;
    const step = plotW / n;
    const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / 64)));

    points.forEach((p, i) => {
      const cx = PAD_L + i * step + step / 2;
      const baseY = PAD_T + plotH;
      let dot = null;
      if (p.value > 0) {
        const cy = PAD_T + plotH - (p.value / max) * plotH;
        svg.append(svgEl('line', { x1: cx, y1: baseY, x2: cx, y2: cy, class: 'dot-stem' }));
        dot = svgEl('circle', { cx, cy, r: 4.5, class: 'dot-mark' });
        svg.append(dot);
      }
      const hit = svgEl('rect', { x: PAD_L + i * step, y: PAD_T, width: step, height: plotH, class: 'col-hit' });
      hit.addEventListener('pointermove', (ev) => {
        const rect = root.getBoundingClientRect();
        tip.show(ev.clientX - rect.left, ev.clientY - rect.top,
          p.value > 0 ? fmt(p.value) : 'no tokens',
          p.detail ? `${p.label}\n${p.detail}` : p.label);
        svg.querySelectorAll('.dot-mark.hot').forEach((d) => d.classList.remove('hot'));
        if (dot) dot.classList.add('hot');
      });
      hit.addEventListener('pointerleave', () => {
        tip.hide();
        if (dot) dot.classList.remove('hot');
      });
      if (p.onClick) {
        hit.classList.add('clickable');
        hit.addEventListener('click', p.onClick);
      }
      svg.append(hit);
      if (i % labelEvery === 0) {
        const t = svgEl('text', { x: cx, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' });
        t.textContent = p.shortLabel || p.label;
        svg.append(t);
      }
    });
    root.prepend(svg);
  };
  new ResizeObserver(draw).observe(root);
  return { root, draw };
}

// ---------------------------------------------------------------------------
// Stacked share bar — part-to-whole for a couple of segments (Web vs Code).
// ---------------------------------------------------------------------------

export function shareBar(data, total, fmt) {
  const root = el('div', 'sharebar-wrap');
  const pct = wholePercents(data.map((d) => d.value), total);
  const track = el('div', 'sharebar');
  data.forEach((d, i) => {
    const seg = el('div', 'sharebar-seg');
    seg.style.flexGrow = String(Math.max(d.value, 1));
    seg.style.background = d.color || SERIES[i] || OTHER_COLOR;
    seg.title = `${d.label}: ${fmt(d.value)} (${pct[i]}%)`;
    track.append(seg);
  });
  const legend = el('div', 'chart-legend legend-inline');
  data.forEach((d, i) => {
    const row = el('div', 'legend-row');
    const sw = el('span', 'legend-swatch');
    sw.style.background = d.color || SERIES[i] || OTHER_COLOR;
    row.append(sw, el('span', 'legend-label', d.label),
      el('span', 'legend-val', `${fmt(d.value)} · ${pct[i]}%`));
    legend.append(row);
  });
  root.append(track, legend);
  return root;
}

/** Whole percents that add up to 100 (largest remainders get the leftover points). Pure. */
export function wholePercents(values, total) {
  if (!total) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  let left = Math.round(values.reduce((t, v) => t + v, 0) / total * 100) - out.reduce((t, v) => t + v, 0);
  for (const i of exact.map((v, i) => i).sort((a, b) => (exact[b] - out[b]) - (exact[a] - out[a]))) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heatmap — GitHub-style: a square per day, a column per week (Monday on
// top), shaded in four steps by the quartiles of the active days, so one
// huge day can't wash out all the others.
// ---------------------------------------------------------------------------

/** Shade 0–4 per value: 0 = idle, then by quartile of the non-zero values;
 *  the busiest days always get the darkest step. Pure. */
export function heatLevels(values) {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!active.length) return values.map(() => 0);
  const at = (p) => {
    const i = p * (active.length - 1);
    const lo = Math.floor(i);
    const hi = Math.min(lo + 1, active.length - 1);
    return active[lo] + (active[hi] - active[lo]) * (i - lo);
  };
  const q1 = at(0.25);
  const q2 = at(0.5);
  const q3 = at(0.75);
  const max = active[active.length - 1];
  return values.map((v) => {
    if (v <= 0) return 0;
    if (v >= max || v > q3) return 4;
    if (v > q2) return 3;
    return v > q1 ? 2 : 1;
  });
}

/** Monday-first weeks covering [startKey, endKey]: each week is 7 slots
 *  (Mon…Sun) holding a day key, or null outside the range. Pure. */
export function weekColumns(startKey, endKey) {
  const start = keyToDate(startKey);
  const end = keyToDate(endKey);
  const d = new Date(start);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const weeks = [];
  while (d <= end) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(d >= start && d <= end ? dateKey(d.getTime()) : null);
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** The longest run of consecutive non-zero values. Pure. */
export function longestRun(values) {
  let best = 0;
  let run = 0;
  for (const v of values) {
    run = v > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * @param {Array<{key, value, label, onClick?}>} days every day of the
 *   range, oldest first (value 0 = idle); `label` goes in the tooltip
 * @param {(v:number)=>string} fmt value formatter
 * @param {{todayKey?: string, summary?: string, label?: string, none?: string}} opts
 *   `none`: the tooltip of an idle day ("no activity")
 * @returns {HTMLElement}
 */
export function heatmapChart(days, fmt, opts = {}) {
  const root = el('div', 'heatmap');
  const tip = makeTooltip(root);
  const levels = heatLevels(days.map((d) => d.value));
  const byKey = new Map(days.map((d, i) => [d.key, { ...d, level: levels[i] }]));
  const weeks = weekColumns(days[0].key, days[days.length - 1].key);

  const scroller = el('div', 'heatmap-scroll');
  const grid = el('div', 'heatmap-grid');
  grid.style.setProperty('--weeks', String(weeks.length));
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', opts.label || 'Activity by day');

  // Month names over the week each month starts in; a cut-off first month
  // is dropped when the next name would crowd it.
  const marks = [];
  weeks.forEach((week, w) => {
    const first = week.find((k) => k && k.endsWith('-01'));
    if (first) marks.push([w, first]);
  });
  if (!marks.length || marks[0][0] > 2) marks.unshift([0, weeks[0].find(Boolean)]);
  let lastCol = -3;
  for (const [w, key] of marks) {
    if (w - lastCol < 3) continue;
    const m = el('span', 'heatmap-month', keyToDate(key).toLocaleDateString(undefined, { month: 'short' }));
    m.style.gridColumn = `${w + 2} / span 3`;
    m.style.gridRow = '1';
    grid.append(m);
    lastCol = w;
  }
  for (const [row, name] of [[2, 'Mon'], [4, 'Wed'], [6, 'Fri']]) {
    const wd = el('span', 'heatmap-wd');
    wd.append(el('span', null, name));
    wd.style.gridRow = String(row);
    wd.style.gridColumn = '1';
    grid.append(wd);
  }

  weeks.forEach((week, w) => week.forEach((key, i) => {
    if (!key) return;
    const d = byKey.get(key);
    const cell = el('span', `heatmap-cell lv-${d.level}`);
    if (key === opts.todayKey) cell.classList.add('is-today');
    if (d.onClick) cell.classList.add('clickable');
    cell.dataset.key = key;
    cell.style.gridColumn = String(w + 2);
    cell.style.gridRow = String(i + 2);
    grid.append(cell);
  }));

  // One set of listeners for the whole grid (a year is ~370 squares).
  const dayAt = (ev) => {
    const cell = ev.target.closest && ev.target.closest('.heatmap-cell');
    return cell ? byKey.get(cell.dataset.key) : null;
  };
  grid.addEventListener('pointermove', (ev) => {
    const d = dayAt(ev);
    if (!d) { tip.hide(); return; }
    const rect = root.getBoundingClientRect();
    tip.show(ev.clientX - rect.left, ev.clientY - rect.top, d.value > 0 ? fmt(d.value) : opts.none || 'no activity', d.label);
  });
  grid.addEventListener('pointerleave', () => tip.hide());
  grid.addEventListener('click', (ev) => {
    const d = dayAt(ev);
    if (d && d.onClick) d.onClick();
  });

  scroller.append(grid);
  // When the year is wider than the card, start at the latest weeks.
  let placed = false;
  new ResizeObserver(() => {
    if (placed || !scroller.clientWidth) return;
    placed = true;
    scroller.scrollLeft = scroller.scrollWidth;
  }).observe(scroller);

  const foot = el('div', 'heatmap-foot');
  const legend = el('span', 'heatmap-legend');
  legend.setAttribute('aria-hidden', 'true');
  legend.append(el('span', null, 'Less'));
  for (let lv = 0; lv <= 4; lv++) legend.append(el('span', `heatmap-cell lv-${lv}`));
  legend.append(el('span', null, 'More'));
  foot.append(el('span', 'heatmap-sum', opts.summary || ''), legend);

  root.append(scroller, foot);
  return root;
}
