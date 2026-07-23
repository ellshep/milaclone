'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { isLocked } from './util.js';
import { screenToWorld } from './viewport.js';
import { select, enterEdit } from './editing.js';
import { render } from './cards.js';

// Dragging cards (free-move + in/out of columns) and resizing.

export function onItemPointerDown(e, it, el) {
  if (e.button !== 0) return;
  if (state.armed) return;
  if (e.target.closest('[data-nodrag]')) { e.stopPropagation(); return; }
  if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
  e.stopPropagation();
  select(it.id);
  if (isLocked(it)) return;

  const start = { sx: e.clientX, sy: e.clientY };
  const fromColumn = !!it.parentItemId;
  let moved = false;
  const rect = el.getBoundingClientRect();
  const startWorld = screenToWorld(rect.left, rect.top);
  state.drag = { it, el, start, startWorld, fromColumn, moved: false, dropCol: null };
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - start.sx, dy = ev.clientY - start.sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true; state.drag.moved = true;
      el.classList.add('dragging');
      if (fromColumn) {
        dom.world.appendChild(el);
        el.classList.remove('in-column');
        el.style.width = (it.w || 240) + 'px';
        el.style.zIndex = 99999;
      }
    }
    const wx = startWorld.x + dx / state.cam.scale;
    const wy = startWorld.y + dy / state.cam.scale;
    el.style.left = wx + 'px'; el.style.top = wy + 'px';
    highlightColumn(ev, it);
  };

  const up = (ev) => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    if (!moved) {
      if (it.type !== 'board') maybeEdit(el, ev);
      state.drag = null; return;
    }
    finishDrag(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function maybeEdit(el, ev) {
  if (!el.querySelector('[data-edit]')) return;
  if (!el.classList.contains('editing')) {
    enterEdit(el);
    const f = ev.target.closest('[data-edit]') || el.querySelector('[data-edit]');
    requestAnimationFrame(() => f?.focus());
  }
}

function columnBodyUnder(clientX, clientY, excludeId) {
  const bodies = dom.world.querySelectorAll('.col-body');
  for (const b of bodies) {
    if (b.dataset.colbody === excludeId) continue;
    const r = b.getBoundingClientRect();
    if (clientX >= r.left - 6 && clientX <= r.right + 6 && clientY >= r.top - 6 && clientY <= r.bottom + 30) return b;
  }
  return null;
}

function highlightColumn(ev, it) {
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (it.type === 'column') { state.drag.dropCol = null; return; }
  const body = columnBodyUnder(ev.clientX, ev.clientY, it.id);
  state.drag.dropCol = body ? body.dataset.colbody : null;
  if (body) body.closest('.column').classList.add('drop-target');
}

async function finishDrag(ev) {
  const { it, el } = state.drag;
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (state.drag.dropCol) {
    const order = insertOrder(state.drag.dropCol, ev.clientY, it.id);
    it.parentItemId = state.drag.dropCol;
    it.y = order;
    const sibs = state.view.items.filter(k => k.parentItemId === state.drag.dropCol).sort((a, b) => a.y - b.y);
    sibs.forEach((s, i) => s.y = i);
    await api.patch(it.id, { parentItemId: it.parentItemId, canvasId: state.view.canvas.id });
    await api.patchMany(sibs.map(s => ({ id: s.id, y: s.y })));
    render();
  } else {
    const wx = Math.round(parseFloat(el.style.left));
    const wy = Math.round(parseFloat(el.style.top));
    const wasChild = state.drag.fromColumn;
    it.x = wx; it.y = wy; it.parentItemId = null;
    await api.patch(it.id, { x: wx, y: wy, parentItemId: null });
    if (wasChild) render();
  }
  state.drag = null;
}

function insertOrder(colId, clientY, selfId) {
  const rows = [...dom.world.querySelectorAll(`[data-colbody="${colId}"] > .item`)].filter(r => r.dataset.id !== selfId);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

export function startResize(e, it, el) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startW = it.w || el.offsetWidth;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    let w = startW + (ev.clientX - startX) / state.cam.scale;
    w = Math.max(120, Math.min(900, w));
    el.style.width = w + 'px'; it.w = Math.round(w);
  };
  const up = () => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    api.patch(it.id, { w: it.w });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
