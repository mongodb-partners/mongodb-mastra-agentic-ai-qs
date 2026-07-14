// Mono-line icon set — replaces emoji so the HUD renders identically on every OS/projector.
// All icons are stroke-based, inherit currentColor, and share one visual grammar.

const paths = {
  // capabilities
  vector: '<circle cx="12" cy="12" r="8"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  fulltext: '<path d="M4 6h16M4 11h10M4 16h13"/><path d="M18.5 13.5l2 5M20.5 13.5l-2 5" stroke-width="1.3"/>',
  hybrid: '<path d="M13 2L5 13h5l-1 9 8-11h-5l1-9z"/>',
  graph: '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8.2 7l7.4 .8M7.2 8.1l3.6 7.7M16.8 10.1l-3.4 5.8"/>',
  memory: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 6V3.5M15 6V3.5M9 20.5V18M15 20.5V18M6 9H3.5M6 15H3.5M20.5 9H18M20.5 15H18"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
  governance: '<path d="M12 4v16M6 20h12M12 6h7M12 6H5"/><path d="M5 6l-2.6 6a3 3 0 0 0 5.2 0L5 6zM19 6l-2.6 6a3 3 0 0 0 5.2 0L19 6z"/>',
  durable: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/>',
  audit: '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2.2 2.2L15.5 9.8"/>',
  // steps & actors
  triage: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
  retrieve: '<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v6c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-6"/><path d="M5 11.5v6c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-6"/>',
  reason: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 12h6M12 9v6"/>',
  recall: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2.5"/>',
  govern: '<path d="M12 4v16M6 20h12M12 6h7M12 6H5"/><path d="M5 6l-2.6 6a3 3 0 0 0 5.2 0L5 6zM19 6l-2.6 6a3 3 0 0 0 5.2 0L19 6z"/>',
  suspend: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7M14 8.5v7"/>',
  commit: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.2l2.7 2.7L16 9.4"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v3.7h3.7"/>',
  human: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-4 3.6-6 7-6s6.2 2 7 6"/>',
  launch: '<path d="M8 5.5v13l11-6.5-11-6.5z"/>',
  policy: '<path d="M7 3.5h7l4 4V20.5H7v-17z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
  warn: '<path d="M12 4L2.8 19.5h18.4L12 4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  flow: '<path d="M4 12h13M13.5 7.5L18 12l-4.5 4.5"/>',
};

/** Inline SVG for a named icon. `size` in px; stroke inherits currentColor. */
export function icon(name, size = 16, cls = '') {
  const body = paths[name] ?? paths.reason;
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
