// icons.js — the app's line icons as inline SVG: one 24×24 grid, stroked
// in currentColor, so they take the theme's text colors. Static, trusted
// markup — never built from message content.

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  'arrow-left': '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up-right': '<path d="M7 17 17 7M8 7h9v9"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  more: '<circle cx="12" cy="5.5" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="12" cy="18.5" r=".9"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-4"/><path d="M12 16V6"/><path d="M17 16V10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  sparkles: '<path d="M11 3.5 12.9 9l5.6 1.9-5.6 1.9L11 18.4l-1.9-5.6-5.6-1.9L9.1 9Z"/><path d="M18.5 3v3.5M16.75 4.75h3.5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9H8"/><path d="M12 7.5V12l3 2"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.9-.8 1.9-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1a4.2 4.2 0 0 0 4.2-4.2c0-3.7-4-6.6-9-6.6Z"/><circle cx="7.8" cy="11.2" r=".9"/><circle cx="10.6" cy="7.6" r=".9"/><circle cx="15" cy="7.8" r=".9"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.9 12.5h9.2L17.5 7"/><path d="M10.2 11v5M13.8 11v5"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  'folder-open': '<path d="M3.5 17V7.5a2 2 0 0 1 2-2h3.6l2 2h6.4a2 2 0 0 1 2 2V11"/><path d="M3.5 17l2.3-5.4a1.5 1.5 0 0 1 1.4-.9h13l-2.6 6.4a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1.1Z"/>',
  file: '<path d="M13.5 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5Z"/><path d="M13.5 3.5v5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15V6a2 2 0 0 1 2-2H15"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  message: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l.9-4.5A8.5 8.5 0 1 1 20.5 12Z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  upload: '<path d="M12 20V9"/><path d="m7.5 13 4.5-4.5 4.5 4.5"/><path d="M5 4h14"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.8"/><path d="M2.5 19h19"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7.5 9.5 3 2.5-3 2.5"/><path d="M13 15h3.5"/>',
  flask: '<path d="M9.5 3.5h5"/><path d="M10.5 3.5v5.2L5.7 17.4a2 2 0 0 0 1.8 3.1h9a2 2 0 0 0 1.8-3.1l-4.8-8.7V3.5"/><path d="M8 14.5h8"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M2.8 12h2M19.2 12h2M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1Z"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16v4"/>',
  commit: '<circle cx="12" cy="12" r="3.6"/><path d="M3.5 12h4.9M15.6 12h4.9"/>',
  code: '<path d="m8.5 7.5-4.5 4.5 4.5 4.5"/><path d="m15.5 7.5 4.5 4.5-4.5 4.5"/>',
  briefcase: '<rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M3.5 12.5h17"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
  rewind: '<path d="M11 18.5 3.5 12 11 5.5Z"/><path d="M20.5 18.5 13 12l7.5-6.5Z"/>',
  'corner-down-right': '<path d="M5 5v6a3 3 0 0 0 3 3h11"/><path d="m15 10 4 4-4 4"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  today: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><rect x="8" y="13" width="3.5" height="3.5" rx=".8"/>',
  stack: '<rect x="4" y="4.5" width="16" height="6" rx="2"/><rect x="4" y="13.5" width="16" height="6" rx="2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.9v.1"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/>',
  gauge: '<path d="M4.6 17a8.5 8.5 0 1 1 14.8 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13" r="1.2"/>',
  pin: '<path d="M9 3.5h6"/><path d="M10 3.5v5.2L6.8 12.5h10.4L14 8.7V3.5"/><path d="M12 12.5v8"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.3"/><path d="M5.2 9v8.5a2 2 0 0 0 2 2h9.6a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
};

/** SVG markup for an icon (static, trusted). */
export function iconSvg(name, size = 16) {
  return `<svg class="ico ico-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + 'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" '
    + `aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
}

/** A fresh icon element. */
export function icon(name, size = 16) {
  const t = document.createElement('template');
  t.innerHTML = iconSvg(name, size);
  return t.content.firstChild;
}

/** A <button> holding an icon, then an optional text label. */
export function iconButton(className, name, label, size = 16) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.append(icon(name, size));
  if (label) b.append(label);
  return b;
}

/** The standard modal close (×) button. */
export function closeButton(label = 'Close') {
  const b = iconButton('icon-btn', 'x', null, 18);
  b.setAttribute('aria-label', label);
  return b;
}

/** Swap every <i data-icon="name" [data-size]> placeholder under `root`. */
export function hydrateIcons(root) {
  for (const ph of root.querySelectorAll('i[data-icon]')) {
    const svg = icon(ph.dataset.icon, Number(ph.dataset.size) || 16);
    for (const c of ph.classList) svg.classList.add(c);
    ph.replaceWith(svg);
  }
}
