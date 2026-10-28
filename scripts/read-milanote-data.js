'use strict';

/**
 * Route-B reader (U1.2): Milanote's own board data → the importer's card tree.
 *
 * The source is one capture file: { homeId, responses: { <boardId>: <response> } },
 * each response being what app.milanote.com/api/boards?ids=<boardId> returned
 * (elements keyed by id, plus `comments`). Every element hangs off its parent by
 * location.parentId. section CANVAS = free on the board at position {x, y} in
 * grid units; INBOX = in a list (a column, the board's Unsorted panel or a task
 * list), ordered by position.score; ATTACHED = pinned to a card (comments);
 * TRASH = deleted. The field mapping is written up in docs/next-updates.md (U1.2).
 *
 * Images live behind the Milanote login, so `media` (optional) maps an image's
 * content.image.original URL to a data: URI captured in the browser.
 */

const GU = 10; // px per Milanote grid unit (a 15-unit swatch renders 150 px wide)

const TYPE = {
  CARD: 'note',
  TASK_LIST: 'todo',
  LINK: 'link',
  IMAGE: 'image',
  COLUMN: 'column',
  BOARD: 'board',
  COLOR_SWATCH: 'swatch',
  TABLE: 'table',
  ANNOTATION: 'sketch',
  COMMENT_THREAD: 'comment',
};

// Milanote's default width per type, in grid units, for elements that store none.
const WIDTH = { BOARD: 12, TABLE: 34, COLOR_SWATCH: 15, ANNOTATION: 23 };
const DEFAULT_WIDTH = 30;

// milaclone's palette (style.css :root --c-*), for the nearest match to a hex colour.
const PALETTE = {
  slate: '#565d6b',
  gray: '#c4c7ce',
  teal: '#15a39a',
  green: '#57bb6c',
  brown: '#b07a4f',
  yellow: '#f4c542',
  orange: '#f5862b',
  red: '#ef4b4b',
  pink: '#ff1f8e',
  purple: '#7c4dff',
  blue: '#4aa3ff',
  indigo: '#3a5bd9',
};

/** Hue (degrees), saturation and lightness (0–1) of a #rrggbb colour. */
function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** A Milanote colour (named like "BLUE", hex, or a swatch's { value }) → a milaclone palette name. */
function color(c) {
  const v = String((c && typeof c === 'object' ? c.value : c) || '').trim();
  const named = v.toLowerCase().replace('grey', 'gray');
  if (PALETTE[named]) return named;
  if (!/^#[0-9a-f]{6}$/i.test(v)) return undefined;
  const [h, s, l] = hsl(v);
  // Milanote's board colours are mostly pastels, so match by hue, not by distance:
  // washed-out colours are grey, everything else takes the nearest palette hue.
  if (s < 0.2) return l < 0.55 ? 'slate' : 'gray';
  let best;
  let dist = Infinity;
  for (const [name, hex] of Object.entries(PALETTE)) {
    if (name === 'slate' || name === 'gray') continue;
    const [ph, , pl] = hsl(hex);
    const dh = Math.min(Math.abs(h - ph), 360 - Math.abs(h - ph));
    const d = dh + 60 * Math.abs(l - pl);
    if (d < dist) [best, dist] = [name, d];
  }
  return best;
}

// ---- Rich text ---------------------------------------------------------------

/** Plain text of a ProseMirror node: blocks on their own lines, hard breaks as newlines. */
function plain(n) {
  if (!n || typeof n !== 'object') return typeof n === 'string' ? n : '';
  if (n.type === 'text') return n.text || '';
  if (n.type === 'hardBreak') return '\n';
  const parts = (n.content || []).map(plain);
  const inline = !n.content || n.content.every(c => c.type === 'text' || c.type === 'hardBreak');
  return parts.join(inline ? '' : '\n');
}

// What milaclone's editor (TipTap StarterKit + Highlight) can hold.
const NODES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
]);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'highlight']);

/** Milanote's ProseMirror JSON → milaclone's: known nodes and marks kept, Milanote-only attrs dropped. */
function clean(n) {
  if (!n || typeof n !== 'object') return null;
  if (n.type === 'text') {
    if (!n.text) return null;
    const marks = (n.marks || []).flatMap(m => {
      if (m.type === 'link') return m.attrs && m.attrs.href ? [{ type: 'link', attrs: { href: m.attrs.href } }] : [];
      return MARKS.has(m.type) ? [{ type: m.type }] : [];
    });
    return marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text };
  }
  if (!NODES.has(n.type)) {
    // An unknown node keeps its words as a plain paragraph.
    const text = plain(n).trim();
    return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : null;
  }
  const out = { type: n.type };
  if (n.type === 'heading') out.attrs = { level: Math.min(6, Math.max(1, (n.attrs && n.attrs.level) || 2)) };
  if (n.type === 'orderedList' && n.attrs && n.attrs.start > 1) out.attrs = { start: n.attrs.start };
  const content = (n.content || []).map(clean).filter(Boolean);
  if (content.length) out.content = content;
  return out;
}

// A rich card's own plain text, so a line break inside a paragraph stays one in search.
const rich = d => ({ doc: d, text: plain(d).trim() });

function doc(d) {
  const content = d && d.type === 'doc' ? (d.content || []).map(clean).filter(Boolean) : [];
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ---- Elements ----------------------------------------------------------------

/** A task list's tasks, from its document: nesting becomes indent (0–4). */
function tasks(d) {
  const out = [];
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'taskItem') {
      const body = (n.content || []).filter(c => c.type !== 'taskList');
      out.push({
        id: (n.attrs && n.attrs.taskId) || `t${out.length}`,
        text: body.map(plain).join('\n').trim(),
        done: !!(n.attrs && n.attrs.checked),
        indent: Math.min(4, depth),
      });
      for (const c of n.content || []) if (c.type === 'taskList') walk(c, depth + 1);
      return;
    }
    for (const c of n.content || []) walk(c, depth);
  };
  walk(d, 0);
  return out;
}

function listTitle(c) {
  const first = ((c.textContent && c.textContent.content) || []).find(n => n.type === 'taskListTitle');
  if (first) return plain(first).trim();
  if (!c.showTitle) return '';
  return (typeof c.title === 'string' ? c.title : plain(c.title)).trim();
}

/** A freehand ANNOTATION → sketch strokes in milaclone's fixed 400×280 viewBox. */
function strokes(drawing) {
  const d = drawing || {};
  const s = Math.min(400 / (d.width || 400), 280 / (d.height || 280));
  const n = v => Math.round(v * s * 10) / 10;
  return (d.paths || [])
    .filter(p => Array.isArray(p.points) && p.points.length)
    .map(p => ({
      d: 'M' + p.points.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L'),
      size: Math.max(1, n(p.size || 4)),
      color: color(p.color) || null,
    }));
}

const cell = v => (v == null ? '' : typeof v === 'object' ? plain(v).trim() : String(v));

/** The fields of one element; `missing` marks one that can't be imported, with why. */
function convert(el, media) {
  const c = el.content || {};
  const card = { sourceId: el._id, type: TYPE[el.elementType] || `milanote:${el.elementType}` };
  if (!TYPE[el.elementType]) return card;
  const tint = color(c.background && c.background.color);
  if (tint) card.color = tint;

  if (el.elementType === 'CARD') card.data = rich(doc(c.textContent));
  else if (el.elementType === 'TASK_LIST') card.data = { title: listTitle(c), tasks: tasks(c.textContent) };
  else if (el.elementType === 'LINK') {
    const url = (c.link && c.link.url) || c.url;
    if (!url) card.missing = 'link with no URL';
    card.data = { url: url || '', title: (c.link && c.link.title) || c.title || '' };
  } else if (el.elementType === 'IMAGE') {
    const src = c.image && c.image.original;
    if (!src) card.missing = 'image with no file (an empty image slot in Milanote)';
    // Milanote's own media needs the login: without a captured copy, report it
    // rather than make a link card that a later run with --media would skip.
    else if (!(media && media[src]) && src.startsWith('https://app.milanote.com/')) {
      card.missing = 'image file not captured: pass --media (it sits behind the Milanote login)';
    }
    const file = c.file || {};
    const caption = c.showCaption ? plain(c.caption).trim() : '';
    card.data = caption ? { caption } : {};
    card.file = {
      url: (media && media[src]) || src,
      name: file.filename || undefined,
      mime: String(file.mime || '').startsWith('image/') ? file.mime : undefined,
    };
  } else if (el.elementType === 'COLUMN') card.data = { title: c.title || '', collapsed: false };
  else if (el.elementType === 'BOARD') {
    card.data = { title: c.title || 'Untitled board' };
    const tile = color(c.color);
    if (tile) card.color = tile;
  } else if (el.elementType === 'COLOR_SWATCH') {
    const hex = String((c.color && c.color.value) || '').toLowerCase();
    card.data = { hex, text: hex };
  } else if (el.elementType === 'TABLE') {
    const rows = ((c.tableContent && c.tableContent.data) || []).map(r => (r || []).map(x => cell(x && x.value)));
    card.data = { rows, text: rows.map(r => r.map(v => v.trim()).join(' | ')).join('\n') };
  } else if (el.elementType === 'ANNOTATION') card.data = { strokes: strokes(c.drawing) };
  return card;
}

// ---- Layout ------------------------------------------------------------------
// Milanote packs cards tighter than milaclone draws them, so a card that would
// overlap the one above it moves down just enough. Heights are estimates: what
// milaclone renders for that much content at that width.

const GAP = 10;
const EMBED = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|open\.spotify\.com)\//;

function lines(text, w) {
  const perLine = Math.max(10, Math.floor((w - 32) / 7.5));
  return String(text || '')
    .split('\n')
    .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
}

function height(el, card) {
  const d = card.data || {};
  const w = card.w;
  switch (card.type) {
    case 'note':
    case 'comment':
      return 30 + 20 * lines(plain(d.doc), w);
    case 'link':
      return EMBED.test(d.url || '') ? Math.round(w * 0.5625) + 95 : 95;
    case 'todo':
      return 70 + (d.tasks || []).reduce((n, t) => n + 15 + 20 * lines(t.text, w - 40), 0);
    case 'image': {
      const m = (el.content && (el.content.image || el.content.media)) || {};
      return Math.round(m.width && m.height ? (w * m.height) / m.width : w * 0.75) + (d.caption ? 34 : 0);
    }
    case 'column':
      return 60 + (card.items || []).reduce((n, c) => n + height({}, { ...c, w: w - 30 }) + GAP, 0);
    case 'board':
      return 140;
    case 'swatch':
      return Math.round(w * 0.87) + 30;
    case 'table':
      return 20 + 30 * Math.max(1, (d.rows || []).length);
    case 'sketch':
      return Math.round((w * 280) / 400);
    default:
      return 100;
  }
}

/** Moves cards down, in reading order, until none overlaps one above it. */
function settle(placed) {
  const order = [...placed].sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  const done = [];
  for (const [el, card] of order) {
    for (let moved = true; moved;) {
      moved = false;
      for (const [prevEl, prev] of done) {
        const across = card.x < prev.x + prev.w - GAP && prev.x < card.x + card.w - GAP;
        const bottom = prev.y + height(prevEl, prev);
        if (across && card.y >= prev.y && card.y < bottom + GAP) {
          card.y = bottom + GAP;
          moved = true;
        }
      }
    }
    done.push([el, card]);
  }
}

const score = el => Number((el.location && el.location.position && el.location.position.score) || 0);

function read(files, { media = {} } = {}) {
  const fs = require('fs');
  return files.flatMap(f => {
    const capture = JSON.parse(fs.readFileSync(f, 'utf8'));
    return fromCapture(capture, typeof media === 'string' ? JSON.parse(fs.readFileSync(media, 'utf8')) : media);
  });
}

/** The card tree for one capture: Home's cards, everything else nested under them. */
function fromCapture(capture, media = {}) {
  const els = new Map();
  const comments = [];
  for (const resp of Object.values(capture.responses || {})) {
    for (const [key, el] of Object.entries(resp.elements || {})) els.set(el._id || key, { _id: key, ...el });
    comments.push(...Object.values(resp.comments || {}));
  }
  const kids = new Map();
  for (const el of els.values()) {
    const loc = el.location || {};
    if (!loc.parentId || loc.section === 'TRASH') continue;
    if (!kids.has(loc.parentId)) kids.set(loc.parentId, []);
    kids.get(loc.parentId).push(el);
  }
  const reached = new Set([capture.homeId]);

  // A comment thread pinned to a card becomes a comment card beside it.
  const pinned = (el, anchor) =>
    (kids.get(el._id) || [])
      .filter(k => k.location.section === 'ATTACHED' && k.elementType === 'COMMENT_THREAD')
      .map(t => {
        reached.add(t._id);
        const said = comments.filter(m => m.threadId === t._id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const body = said.map(m => plain(m.text).trim()).filter(Boolean);
        return {
          sourceId: t._id,
          type: 'comment',
          x: anchor.x + anchor.w + 20,
          y: anchor.y,
          w: 220,
          data: rich(
            doc({
              type: 'doc',
              content: body
                .flatMap(text => text.split('\n'))
                .map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
            })
          ),
        };
      });

  const place = (el, x, y) => {
    reached.add(el._id);
    const card = convert(el, media);
    const c = el.content || {};
    Object.assign(card, {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round((c.width || WIDTH[el.elementType] || DEFAULT_WIDTH) * GU),
    });
    if (el.elementType === 'BOARD') card.items = board(el._id);
    if (el.elementType === 'COLUMN') {
      // The API keeps column cards in score order; y is only that order here.
      card.items = (kids.get(el._id) || [])
        .filter(k => k.location.section === 'INBOX')
        .sort((a, b) => score(a) - score(b))
        .map((k, i) => place(k, card.x, card.y + (i + 1) * 10));
    }
    // Its TASK elements are the same tasks as the list's document holds.
    if (el.elementType === 'TASK_LIST') for (const t of card.data.tasks) reached.add(t.id);
    return card;
  };

  const board = bid => {
    const here = kids.get(bid) || [];
    const placed = here
      .filter(k => k.location.section === 'CANVAS')
      .map(el => {
        const p = el.location.position || {};
        return [el, place(el, (Number(p.x) || 0) * GU, (Number(p.y) || 0) * GU)];
      });
    settle(placed);
    // Unsorted has an order but no position: stack it to the right of the board.
    const right = Math.max(0, ...placed.map(([, c]) => c.x + c.w)) + 40;
    let y = placed.length ? Math.min(...placed.map(([, c]) => c.y)) : 0;
    for (const el of here.filter(k => k.location.section === 'INBOX').sort((a, b) => score(a) - score(b))) {
      const card = place(el, right, y);
      placed.push([el, card]);
      y += height(el, card) + GAP;
    }
    const pins = placed.flatMap(([el, card]) => [
      ...pinned(el, card),
      // A comment on a card inside a column sits beside the column.
      ...(el.elementType === 'COLUMN' ? card.items.flatMap(inner => pinned(els.get(inner.sourceId), card)) : []),
    ]);
    return [...placed.map(([, card]) => card), ...pins];
  };

  const out = board(capture.homeId);
  // Never drop anything silently: an element nothing above reached is reported.
  for (const el of els.values()) {
    if (reached.has(el._id) || (el.location && el.location.section === 'TRASH')) continue;
    out.push({
      sourceId: el._id,
      type: TYPE[el.elementType] || `milanote:${el.elementType}`,
      x: 0,
      y: 0,
      missing: 'not reachable from Home',
    });
  }
  return out;
}

module.exports = { name: 'milanote', read, fromCapture, color, doc, tasks, strokes, plain, GU };
