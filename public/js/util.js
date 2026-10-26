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
// `action` = { label, fn } adds a button (e.g. Undo) and keeps the toast up longer.
export function toast(msg, action) {
  const t = dom.toastEl;
  t.textContent = msg;
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.fn(); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2200);
}
