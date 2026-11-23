'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { isLocked, zRange, snap, autoGrow } from './util.js';
import { screenToWorld } from './viewport.js';
import { select, enterEdit, toggleSelect, selectedItems } from './editing.js';
import { render } from './cards.js';
import { sendUp, sendInto } from './clipboard.js';

// Dragging cards (free-move + in/out of columns, several at once) and resizing.
// Dropping onto a breadcrumb above this board moves the cards up to that board;
// dropping onto a board card moves them into it.

export function onItemPointerDown(e, it, el) {
  if (e.button !== 0) return; // middle-drag falls through to the stage and pans
  if (state.armed || state.spaceDown) return; // space-drag pans too
  if (e.target.closest('[data-nodrag]')) {
    e.stopPropagation();
    return;
  }
  e.stopPropagation(); // else the stage starts a selection box, which ends the edit
  if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
  if (e.shiftKey) {
    // Shift-click would also extend the page's text selection, and a text
    // selection makes cmd+C copy that text instead of the cards.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    toggleSelect(it.id);
    return;
  }
  // Pressing a card that's part of a multi-selection keeps the group for a drag;
  // a plain click (no move) narrows the selection to this card on release.
  const inGroup = state.selection.has(it.id) && state.selection.size > 1;
  if (!inGroup) select(it.id);
  if (isLocked(it)) return;

  const start = { sx: e.clientX, sy: e.clientY };
  const fromColumn = !!it.parentItemId;
  let moved = false;
  const rect = el.getBoundingClientRect();
  const startWorld = screenToWorld(rect.left, rect.top);
  // Free, unlocked companions move by the same delta; cards in columns stay put.
  const others = inGroup
    ? selectedItems()
        .filter(o => o.id !== it.id && o.type !== 'line' && !o.parentItemId && !isLocked(o) && elMap.get(o.id))
        .map(o => ({ it: o, el: elMap.get(o.id), x: o.x, y: o.y }))
    : [];
  state.drag = { it, el, start, startWorld, fromColumn, moved: false, dropCol: null, others };
  el.setPointerCapture(e.pointerId);

  const move = ev => {
    const dx = ev.clientX - start.sx,
      dy = ev.clientY - start.sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true;
      state.drag.moved = true;
      el.classList.add('dragging');
      // Dragging raises the cards above everything else, keeping their own order.
      let z = zRange(state.view.items)[1];
      for (const c of [...others.map(o => o.it), it].sort((a, b) => (a.z || 0) - (b.z || 0))) c.z = ++z;
      for (const o of others) o.el.style.zIndex = o.it.z;
      el.style.zIndex = fromColumn ? 99999 : it.z;
      if (fromColumn) {
        dom.world.appendChild(el);
        el.classList.remove('in-column');
        el.style.width = (it.w || 240) + 'px';
      }
    }
    // The dragged card lands on the grid; the rest of the group keeps its offsets.
    const wx = snap(startWorld.x + dx / state.cam.scale, ev.shiftKey);
    const wy = snap(startWorld.y + dy / state.cam.scale, ev.shiftKey);
    el.style.left = wx + 'px';
    el.style.top = wy + 'px';
    for (const o of others) {
      o.el.style.left = o.x + wx - startWorld.x + 'px';
      o.el.style.top = o.y + wy - startWorld.y + 'px';
    }
    state.drag.dropCrumb = highlightCrumb(ev);
    state.drag.dropBoard = state.drag.dropCrumb ? null : highlightBoard(ev);
    el.classList.toggle('dropping-in', !!state.drag.dropBoard);
    if (!others.length && !state.drag.dropCrumb && !state.drag.dropBoard) highlightColumn(ev, it);
    else clearColumnHighlight();
  };

  const up = ev => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    if (!moved) {
      if (inGroup) select(it.id);
      if (it.type !== 'board') maybeEdit(el, ev);
      state.drag = null;
      return;
    }
    finishDrag(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function maybeEdit(el, ev) {
  if (!el.querySelector('[data-edit]')) return;
  // An image's only field is its caption: clicking the picture just selects it
  // (so Delete / copy still act on the card); Enter or a click on the caption edits.
  if (el.classList.contains('image') && !ev.target.closest('[data-edit]')) return;
  if (!el.classList.contains('editing')) {
    enterEdit(el);
    const f = ev.target.closest('[data-edit]') || el.querySelector('[data-edit]');
    requestAnimationFrame(() => f?.focus());
  }
}

function columnBodyUnder(clientX, clientY, excludeId) {
  const bodies = dom.world.querySelectorAll('.col-body');
  for (const b of bodies) {
    if (b.dataset.colbody === excludeId || b.closest('.collapsed')) continue; // hidden: a 0×0 rect at the origin
    const r = b.getBoundingClientRect();
    if (clientX >= r.left - 6 && clientX <= r.right + 6 && clientY >= r.top - 6 && clientY <= r.bottom + 30) return b;
  }
  return null;
}

function highlightColumn(ev, it) {
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (it.type === 'column') {
    state.drag.dropCol = null;
    return;
  }
  const body = columnBodyUnder(ev.clientX, ev.clientY, it.id);
  state.drag.dropCol = body ? body.dataset.colbody : null;
  if (body) body.closest('.column').classList.add('drop-target');
}

// The breadcrumb under the pointer, if it names a board above this one.
function highlightCrumb(ev) {
  let hit = null;
  dom.crumbs.querySelectorAll('.crumb').forEach((b, i) => {
    const r = b.getBoundingClientRect();
    const on =
      !b.classList.contains('current') &&
      ev.clientX >= r.left &&
      ev.clientX <= r.right &&
      ev.clientY >= r.top - 6 &&
      ev.clientY <= r.bottom + 6;
    b.classList.toggle('drop-target', on);
    if (on) hit = state.view.breadcrumb[i];
  });
  return hit;
}

// The topmost free board card under the pointer that isn't being dragged.
function highlightBoard(ev) {
  const dragged = new Set([state.drag.it.id, ...state.drag.others.map(o => o.it.id)]);
  let hit = null;
  for (const b of state.view.items) {
    if (b.type !== 'board' || b.parentItemId || dragged.has(b.id)) continue;
    const r = elMap.get(b.id)?.getBoundingClientRect();
    const on = r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    if (on && (!hit || (b.z || 0) >= (hit.z || 0))) hit = b;
  }
  dom.world.querySelectorAll('.board.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (hit) elMap.get(hit.id).classList.add('drop-target');
  return hit;
}

function clearColumnHighlight() {
  state.drag.dropCol = null;
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
}

async function finishDrag(ev) {
  const { it, el, dropCrumb, dropBoard, others } = state.drag;
  el.classList.remove('dropping-in');
  dom.world.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));
  dom.crumbs.querySelectorAll('.crumb.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (dropCrumb) {
    state.drag = null;
    await sendUp([it.id, ...others.map(o => o.it.id)], dropCrumb);
    return;
  }
  if (dropBoard) {
    state.drag = null;
    await sendInto([it.id, ...others.map(o => o.it.id)], dropBoard);
    return;
  }
  if (state.drag.dropCol) {
    const order = insertOrder(state.drag.dropCol, ev.clientY, it.id);
    it.parentItemId = state.drag.dropCol;
    it.y = order;
    const sibs = state.view.items.filter(k => k.parentItemId === state.drag.dropCol).sort((a, b) => a.y - b.y);
    sibs.forEach((s, i) => (s.y = i));
    await api.patch(it.id, { parentItemId: it.parentItemId, z: it.z });
    await api.patchMany(sibs.map(s => ({ id: s.id, y: s.y })));
    render();
  } else {
    const wx = Math.round(parseFloat(el.style.left));
    const wy = Math.round(parseFloat(el.style.top));
    const wasChild = state.drag.fromColumn;
    it.x = wx;
    it.y = wy;
    it.parentItemId = null;
    const { others } = state.drag;
    for (const o of others) {
      o.it.x = Math.round(parseFloat(o.el.style.left));
      o.it.y = Math.round(parseFloat(o.el.style.top));
    }
    await api.patchMany([
      { id: it.id, x: wx, y: wy, z: it.z, parentItemId: null },
      ...others.map(o => ({ id: o.it.id, x: o.it.x, y: o.it.y, z: o.it.z })),
    ]);
    if (wasChild) render();
  }
  state.drag = null;
}

function insertOrder(colId, clientY, selfId) {
  const rows = [...dom.world.querySelectorAll(`[data-colbody="${colId}"] > .item`)].filter(
    r => r.dataset.id !== selfId
  );
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

// Arrow keys: move the free, unlocked selected cards by (dx, dy), onto the grid.
// Key-repeat fires fast, so moves are saved in one bulk PATCH once the keys rest
// (parallel requests could land out of order and keep an older position).
const nudged = new Map();
let nudgeTimer = 0;
export function nudgeSelection(dx, dy) {
  // ponytail: lines are drawn from their ends, not x/y, so free-ended ones stay put
  const items = selectedItems().filter(i => i.type !== 'line' && !i.parentItemId && !isLocked(i));
  for (const it of items) {
    it.x = snap(it.x + dx);
    it.y = snap(it.y + dy);
    const el = elMap.get(it.id);
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    nudged.set(it.id, it);
  }
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    const updates = [...nudged.values()].map(i => ({ id: i.id, x: i.x, y: i.y }));
    nudged.clear();
    if (updates.length) api.patchMany(updates);
  }, 300);
}

export function startResize(e, it, el) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX,
    startW = it.w || el.offsetWidth;
  el.setPointerCapture(e.pointerId);
  const move = ev => {
    let w = startW + (ev.clientX - startX) / state.cam.scale;
    w = Math.max(120, Math.min(900, w));
    el.style.width = w + 'px';
    it.w = Math.round(w);
    el.querySelectorAll('textarea').forEach(autoGrow); // wrapped text reflows to the new width
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
