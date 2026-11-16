// glass.js — small presentational helpers for the Liquid Glass look
// (glass.css). Nothing here reads or changes chat data or app state:
//   - a page, the conversation or a summary that has scrolled marks its
//     pane or dialog [data-scrolled], so the bar above it gets a soft edge;
//   - glass surfaces catch the light where the mouse is (--lg-mx/--lg-my),
//     and the front page's app tiles tilt a little toward it.
// Started once by theme.js.

/** Surfaces that catch the light under a mouse pointer. */
const SHINE = '.app-tile:not(:disabled), .btn, .chip, .chip-wrap, .scard, .srow, .srow2, .rep-card, .lg-sky-pick';

let started = false;

export function initGlass() {
  if (started || typeof document === 'undefined') return;
  started = true;
  watchScroll();
  watchPointer();
}

function watchScroll() {
  document.addEventListener('scroll', (e) => {
    const box = e.target;
    if (!(box instanceof Element) || !box.matches('.page-scroll, .reader-body, .sum-body')) return;
    const host = box.closest('.main, .reader, .sum-panel');
    if (host) host.toggleAttribute('data-scrolled', box.scrollTop > 2);
  }, { capture: true, passive: true });
}

function watchPointer() {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lit = null;
  let last = null;
  let frame = 0;
  const release = () => {
    if (!lit) return;
    lit.style.removeProperty('--lg-rx');
    lit.style.removeProperty('--lg-ry');
    lit = null;
  };
  const paint = () => {
    frame = 0;
    const e = last;
    const t = e.target instanceof Element ? e.target.closest(SHINE) : null;
    if (t !== lit) release();
    if (!t) return;
    const r = t.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    t.style.setProperty('--lg-mx', `${Math.round(x)}px`);
    t.style.setProperty('--lg-my', `${Math.round(y)}px`);
    if (t.classList.contains('app-tile') && !still.matches) {
      t.style.setProperty('--lg-rx', `${(((y / r.height) - 0.5) * -5).toFixed(2)}deg`);
      t.style.setProperty('--lg-ry', `${(((x / r.width) - 0.5) * 7).toFixed(2)}deg`);
    }
    lit = t;
  };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    last = e;
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) release(); });
}
