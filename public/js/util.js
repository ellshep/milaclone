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

export function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 'px';
}
export function isLocked(it) {
  return !!(it.data && it.data.locked);
}
export function rid() {
  return Math.random().toString(36).slice(2, 10);
}
export function normalizeUrl(u) {
  if (!u) return '#';
  return /^https?:\/\//.test(u) ? u : 'https://' + u;
}

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
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => {
      t.classList.remove('show');
      action.fn();
    };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2200);
}

// ---- Capture helpers (pure; unit-tested in test/ui/util.test.mjs) ----------

// Lowest and highest stacking order among the free cards on this board.
export function zRange(items) {
  const zs = items.filter(i => !i.parentItemId).map(i => i.z || 0);
  return [Math.min(0, ...zs), Math.max(0, ...zs)];
}

// Cards snap to a 10 px grid while dragged; `free` (shift held) turns it off.
export const GRID = 10;
export const snap = (v, free) => (free ? v : Math.round(v / GRID) * GRID);

export const isUrl = s => /^https?:\/\/\S+$/i.test(String(s || '').trim());

// YouTube, Vimeo and Spotify links play inline as an iframe; null for anything
// else. Built from the URL alone: the server never fetches it.
export function embedUrl(u) {
  let url;
  try {
    url = new URL(String(u || '').trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  const seg = url.pathname.split('/').filter(Boolean);
  const id = s => (s && /^[\w-]+$/.test(s) ? s : null);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v =
      url.pathname === '/watch' ? url.searchParams.get('v') : ['shorts', 'embed', 'live'].includes(seg[0]) && seg[1];
    return id(v) ? 'https://www.youtube-nocookie.com/embed/' + v : null;
  }
  if (host === 'youtu.be') return id(seg[0]) ? 'https://www.youtube-nocookie.com/embed/' + seg[0] : null;
  if (host === 'vimeo.com' && /^\d+$/.test(seg[0] || '')) return 'https://player.vimeo.com/video/' + seg[0];
  if (host === 'open.spotify.com') {
    const kinds = ['track', 'album', 'playlist', 'episode', 'show', 'artist'];
    const i = seg[0] && seg[0].startsWith('intl-') ? 1 : 0; // /intl-de/track/…
    if (kinds.includes(seg[i]) && id(seg[i + 1])) return `https://open.spotify.com/embed/${seg[i]}/${seg[i + 1]}`;
  }
  return null;
}

// A lucide icon name for a file card, by MIME type first, then extension.
export function fileIcon(name, mime) {
  const m = String(mime || '');
  const ext = (String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (m.startsWith('image/')) return 'file-image';
  if (m.startsWith('audio/')) return 'file-audio';
  if (m.startsWith('video/')) return 'file-video';
  const byExt = {
    pdf: 'file-text',
    doc: 'file-text',
    docx: 'file-text',
    txt: 'file-text',
    md: 'file-text',
    xls: 'file-spreadsheet',
    xlsx: 'file-spreadsheet',
    csv: 'file-spreadsheet',
    ppt: 'presentation',
    pptx: 'presentation',
    zip: 'file-archive',
    json: 'file-json',
  };
  return byExt[ext] || 'file';
}

// Copying a card puts this marker on the system clipboard, so cmd+V of it (even
// in another tab) still deep-copies the card instead of pasting text.
// Several selected cards travel as a comma-separated id list.
const CLIP = 'milaclone:item:';
export const clipMarker = (ids, cut) => `${CLIP}${[].concat(ids).join(',')}:${cut ? 'cut' : 'copy'}`;
export function parseClipMarker(text) {
  const m = new RegExp(`^${CLIP}([\\w-]+(?:,[\\w-]+)*):(copy|cut)$`).exec(String(text || '').trim());
  return m ? { ids: m[1].split(','), cut: m[2] === 'cut' } : null;
}
