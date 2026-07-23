'use strict';

import { state, elMap } from './state.js';
import { api } from './api.js';
import { render, renderCrumbs } from './cards.js';
import { closePalette, closeCtx } from './menus.js';

// Selection, inline-edit mode, debounced saves, and deletion.

export function select(id) {
  if (state.selectedId === id) return;
  if (state.editingId && state.editingId !== id) exitEdit();
  if (state.selectedId && elMap.get(state.selectedId)) elMap.get(state.selectedId).classList.remove('selected');
  state.selectedId = id;
  if (id && elMap.get(id)) elMap.get(id).classList.add('selected');
  closePalette();
  closeCtx();
}

export function deselect() { select(null); if (state.editingId) exitEdit(); }

export function enterEdit(el) {
  if (state.editingId && state.editingId !== el.dataset.id) exitEdit();
  state.editingId = el.dataset.id;
  el.classList.add('editing');
  el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = false; f.tabIndex = 0; });
}

export function exitEdit() {
  if (!state.editingId) return;
  const el = elMap.get(state.editingId);
  if (el) { el.classList.remove('editing'); el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = true; f.tabIndex = -1; f.blur(); }); }
  state.editingId = null;
}

export function renameSelected() {
  if (!state.selectedId) return;
  const el = elMap.get(state.selectedId);
  if (!el || !el.querySelector('[data-edit]')) return;
  enterEdit(el);
  const f = el.querySelector('[data-edit]');
  requestAnimationFrame(() => { f?.focus(); if (f && f.select) f.select(); });
}

const saveTimers = new Map();
export function saveData(it, patch) {
  Object.assign(it.data, patch);
  if (it.type === 'board' && patch.title != null) it._childTitle = patch.title;
  if (it.type === 'board' && patch.icon != null) it._childIcon = patch.icon;
  clearTimeout(saveTimers.get(it.id));
  saveTimers.set(it.id, setTimeout(() => {
    api.patch(it.id, { data: patch });
    if (it.type === 'board' && patch.title != null) renderCrumbs();
  }, 400));
}

export async function deleteItem(id) {
  await api.remove(id);
  state.view.items = state.view.items.filter(x => x.parentItemId !== id && x.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  closeCtx();
  render();
}
