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

// A text field or rich-text body has the keyboard: canvas shortcuts stand down.
// A rich body counts while its editor is still loading, so early keys don't arm tools.
export function isTyping() {
  const ae = document.activeElement;
  return (
    !!ae &&
    (ae.isContentEditable ||
      (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.readOnly) ||
      !!ae.closest('.editing [data-rich]'))
  );
}

// ---- Rich text --------------------------------------------------------------
// The static view of a TipTap doc (a note or comment that isn't being edited),
// built as DOM nodes, never innerHTML, so stored text can't inject markup.
// Unknown nodes keep their children; links only ever get http(s)/mailto hrefs.
const BLOCK_TAGS = {
  paragraph: 'p',
  blockquote: 'blockquote',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  taskList: 'ul',
  horizontalRule: 'hr',
  hardBreak: 'br',
};
const MARK_TAGS = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', code: 'code', highlight: 'mark' };
const safeHref = h => (/^(https?:|mailto:)/i.test(String(h || '')) ? String(h) : null);

// A body with nothing in it (a lone empty paragraph) shows its placeholder.
export function isEmptyDoc(doc) {
  const c = (doc && doc.content) || [];
  return !c.length || (c.length === 1 && c[0].type === 'paragraph' && !(c[0].content || []).length);
}

export function docToDom(node) {
  if (!node) return document.createDocumentFragment();
  if (node.type === 'text') {
    let el = document.createTextNode(node.text || '');
    for (const m of node.marks || []) {
      const tag = m.type === 'link' ? 'a' : MARK_TAGS[m.type];
      if (!tag) continue;
      const w = document.createElement(tag);
      if (tag === 'a') {
        const href = safeHref(m.attrs && m.attrs.href);
        if (href) w.href = href;
        w.target = '_blank';
        w.rel = 'noopener noreferrer';
      }
      w.appendChild(el);
      el = w;
    }
    return el;
  }
  const level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) || 1));
  let el, inner;
  if (node.type === 'doc') el = inner = document.createDocumentFragment();
  else if (node.type === 'heading') el = inner = document.createElement('h' + level);
  else if (node.type === 'codeBlock') {
    el = document.createElement('pre');
    inner = el.appendChild(document.createElement('code'));
  } else if (node.type === 'taskItem') {
    el = document.createElement('li');
    el.dataset.checked = String(!!(node.attrs && node.attrs.checked));
    const box = el.appendChild(document.createElement('input'));
    box.type = 'checkbox';
    box.checked = el.dataset.checked === 'true';
    box.disabled = true;
    inner = el.appendChild(document.createElement('div'));
  } else el = inner = document.createElement(BLOCK_TAGS[node.type] || 'div');
  if (node.type === 'taskList') el.dataset.type = 'taskList';
  if (node.type === 'orderedList' && node.attrs && node.attrs.start > 1) el.start = node.attrs.start;
  for (const c of node.content || []) inner.appendChild(docToDom(c));
  return el;
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

// '#ff8800' / '#F80' → '#ff8800'; anything else → null.
export function hexColor(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return '#' + h.toLowerCase();
}

export const wordCount = s => (String(s || '').match(/\S+/g) || []).length;
export const wordLabel = s => {
  const n = wordCount(s);
  return `${n} word${n === 1 ? '' : 's'}`;
};

// A table's cells as plain text, one row per line, for search and export.
export const tableText = rows => (rows || []).map(r => r.map(c => String(c || '').trim()).join(' | ')).join('\n');

// ---- Due dates (Quick notes sets them; the canvas to-do card shows them) ----
const DAY = 86400000;
const parseISO = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
export function daysUntil(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  const now = new Date();
  return Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY);
}
function relDays(n) {
  if (n === 0) return 'due today';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(n);
  if (abs < 7) return rtf.format(n, 'day');
  if (abs < 30) return rtf.format(Math.round(n / 7), 'week');
  return rtf.format(Math.round(n / 30), 'month');
}
export function dueInfo(iso) {
  const n = daysUntil(iso);
  if (n === null) return null;
  const short = parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const near = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : null;
  return {
    label: near || short,
    full: near || 'Due ' + short,
    sub: relDays(n),
    color: n <= 0 ? 'var(--qn-due)' : 'var(--qn-muted)',
    n,
  };
}

// Keep a task list's nesting valid after an indent change, reorder or delete:
// the first task is top-level and none sits more than one level under the one
// above. Mutates in place; returns the tasks whose indent changed.
export function clampIndents(tasks, max = 4) {
  const changed = [];
  let prev = -1;
  for (const t of tasks) {
    const want = Math.max(0, Math.min(max, prev + 1, t.indent || 0));
    if (want !== (t.indent || 0)) {
      t.indent = want;
      changed.push(t);
    }
    prev = want;
  }
  return changed;
}

// A label's colour comes from its name, so the same label looks the same on
// every card and board without a label registry.
export function labelColor(name) {
  let h = 0;
  for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
