'use strict';

import { COLORS, dom } from './state.js';

export const colorVar = c => `var(--c-${COLORS.includes(c) ? c : 'slate'})`;

export function lucideEl(name) {
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  return i;
}

// `lucide` is a global provided by the CDN <script>. If it failed to load we
// silently skip icon rendering rather than throwing.
export function refreshIcons(root) {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons(root ? { nodes: [root] } : undefined);
  }
}

export function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
export function isLocked(it) { return !!(it.data && it.data.locked); }
export function rid() { return Math.random().toString(36).slice(2, 10); }
export function normalizeUrl(u) { if (!u) return '#'; return /^https?:\/\//.test(u) ? u : 'https://' + u; }

export function imageSize(src) {
  return new Promise(r => {
    const i = new Image();
    i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => r({ w: 1, h: 1 });
    i.src = src;
  });
}

let toastTimer;
export function toast(msg) {
  dom.toastEl.textContent = msg;
  dom.toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toastEl.classList.remove('show'), 2200);
}
