'use strict';

import { state, dom, elMap } from './state.js';
import { colorVar, toast } from './util.js';
import { screenToWorld } from './viewport.js';
import { api } from './api.js';
import { select, toggleSelect, saveData } from './editing.js';
import { openCtx } from './menus.js';

// Lines (F6.1): straight connectors in one SVG layer at the back of #world.
// Each end is `{ id }` (attached to a card: the line runs between the cards'
// edges and follows them) or a free `{ x, y }` world point. A line whose card
// is gone (trashed, or not on this board) is simply not drawn. data: from, to,
// arrow ('end' | 'both' | 'none'), dashed, label (+ text = label, for search).

const NS = 'http://www.w3.org/2000/svg';
let layer = null;

const svg = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// World-space box of a rendered card (cards in columns included).
function rectOf(id) {
  const el = elMap.get(id);
  if (!el || !el.isConnected || el instanceof SVGElement) return null;
  let r = el.getBoundingClientRect();
  // A card in a collapsed column has no box (display: none): end at the column.
  if (!r.width && !r.height) {
    const col = el.parentElement?.closest('.item');
    if (!col) return null;
    r = col.getBoundingClientRect();
  }
  const p = screenToWorld(r.left, r.top);
  return { x: p.x, y: p.y, w: r.width / state.cam.scale, h: r.height / state.cam.scale };
}

const centre = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

// Where the ray from the box's centre towards `to` leaves the box.
export function edgePoint(r, to) {
  const c = centre(r);
  const dx = to.x - c.x,
    dy = to.y - c.y;
  const t = Math.min(1, dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function ends(it) {
  const a = it.data.from || {},
    b = it.data.to || {};
  const ra = a.id ? rectOf(a.id) : null,
    rb = b.id ? rectOf(b.id) : null;
  if ((a.id && !ra) || (b.id && !rb)) return null;
  const ca = ra ? centre(ra) : a,
    cb = rb ? centre(rb) : b;
  return [ra ? edgePoint(ra, cb) : a, rb ? edgePoint(rb, ca) : b];
}

function arrowHead(tip, from) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const pt = d => `${tip.x - 12 * Math.cos(ang + d)},${tip.y - 12 * Math.sin(ang + d)}`;
  return svg('polygon', { class: 'line-head', points: `${tip.x},${tip.y} ${pt(0.45)} ${pt(-0.45)}` });
}

function drawOne(it) {
  const pts = ends(it);
  if (!pts) return null;
  const [a, b] = pts;
  const g = svg('g', { class: 'line', 'data-id': it.id });
  g.classList.toggle('selected', state.selection.has(it.id));
  g.style.color = it.color ? colorVar(it.color) : 'var(--ink-soft)';
  const seg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  g.appendChild(svg('line', { class: 'line-hit', ...seg }));
  const stroke = svg('line', { class: 'line-stroke', ...seg });
  if (it.data.dashed) stroke.setAttribute('stroke-dasharray', '7 6');
  g.appendChild(stroke);
  const arrow = it.data.arrow || 'end';
  if (arrow !== 'none') g.appendChild(arrowHead(b, a));
  if (arrow === 'both') g.appendChild(arrowHead(a, b));
  if (it.data.label) {
    const t = svg('text', { class: 'line-label', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6 });
    t.textContent = it.data.label;
    g.appendChild(t);
  }
  g.addEventListener('pointerdown', e => {
    if (e.button !== 0 || state.armed) return;
    e.stopPropagation(); // not a selection box
    if (e.shiftKey) toggleSelect(it.id);
    else select(it.id);
  });
  g.addEventListener('contextmenu', e => openCtx(e, it));
  g.addEventListener('dblclick', e => {
    e.stopPropagation();
    editLabel(it);
  });
  return g;
}

// (Re)draws every line on this board. Cheap enough to run on any change.
export function drawLines() {
  if (!layer || layer.parentNode !== dom.world) {
    layer = svg('svg', { id: 'lines' });
    dom.world.prepend(layer);
  }
  layer.replaceChildren();
  for (const it of state.view.items) {
    if (it.type !== 'line') continue;
    elMap.delete(it.id);
    const g = drawOne(it);
    if (!g) continue;
    layer.appendChild(g);
    elMap.set(it.id, g);
  }
}

// Cards move (drag, nudge, column reflow), resize and grow while typing: redraw
// once per frame after any change inside #world that isn't the layer itself or
// the camera transform.
// ponytail: rebuilds every line per frame of activity — fine for tens of lines;
// update x1/y1/x2/y2 in place if boards grow hundreds.
let frame = 0;
export function initLines() {
  new MutationObserver(muts => {
    if (frame || !state.view.items?.some(i => i.type === 'line')) return;
    if (muts.every(m => m.target === dom.world || (layer && layer.contains(m.target)))) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawLines();
    });
  }).observe(dom.world, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
}

// A free point, or the card under the pointer.
function endAt(e) {
  const card = document.elementFromPoint(e.clientX, e.clientY)?.closest('.item[data-id]');
  if (card) return { id: card.dataset.id };
  const p = screenToWorld(e.clientX, e.clientY);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// The armed Line tool: press, drag, release. Either end snaps to the card under it.
export function startLine(e) {
  const from = endAt(e);
  const p0 = screenToWorld(e.clientX, e.clientY);
  if (!layer) drawLines();
  const ghost = svg('line', { class: 'line-ghost', x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y });
  layer.appendChild(ghost);
  dom.stage.setPointerCapture(e.pointerId);
  const move = ev => {
    const p = screenToWorld(ev.clientX, ev.clientY);
    ghost.setAttribute('x2', p.x);
    ghost.setAttribute('y2', p.y);
  };
  const stop = () => {
    dom.stage.removeEventListener('pointermove', move);
    dom.stage.removeEventListener('pointerup', up);
    dom.stage.removeEventListener('pointercancel', stop);
    ghost.remove();
  };
  const up = async ev => {
    stop();
    const to = endAt(ev);
    const p = screenToWorld(ev.clientX, ev.clientY);
    if ((from.id && from.id === to.id) || Math.hypot(p.x - p0.x, p.y - p0.y) < 8) {
      toast('Drag from one card or point to another to draw a line');
      return;
    }
    const it = await api.create({
      canvasId: state.view.canvas.id,
      type: 'line',
      x: Math.round(p0.x),
      y: Math.round(p0.y),
      w: 0,
      data: { from, to, arrow: 'end', dashed: false, label: '', text: '' },
    });
    if (!it || it.error) return;
    state.view.items.push(it);
    drawLines();
    select(it.id);
  };
  dom.stage.addEventListener('pointermove', move);
  dom.stage.addEventListener('pointerup', up);
  dom.stage.addEventListener('pointercancel', stop); // touch gesture, OS interruption: no line
}

export function setLine(it, patch) {
  saveData(it, patch);
  drawLines();
}

// An inline field over the line's midpoint; Enter or blur saves, Escape cancels.
export function editLabel(it) {
  const pts = ends(it);
  if (!pts) return;
  const [a, b] = pts;
  const f = document.createElement('input');
  f.className = 'line-label-edit';
  f.value = it.data.label || '';
  f.placeholder = 'Label';
  f.style.left = (a.x + b.x) / 2 + 'px';
  f.style.top = (a.y + b.y) / 2 + 'px';
  let done = false;
  const finish = keep => {
    if (done) return;
    done = true;
    const label = f.value.trim();
    f.remove();
    if (keep && label !== (it.data.label || '')) setLine(it, { label, text: label });
  };
  f.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  f.addEventListener('blur', () => finish(true));
  f.addEventListener('pointerdown', e => e.stopPropagation());
  dom.world.appendChild(f);
  f.focus();
}
