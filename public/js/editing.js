'use strict';

import { state, elMap } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { render, renderCrumbs, refreshItem } from './cards.js';
import { closePalette, closeCtx } from './menus.js';
import { updateSelectionChrome } from './boardchrome.js';
import { reloadView } from './main.js';

// Selection, inline-edit mode, debounced saves, and deletion.

export function select(id) {
  if (state.selectedId === id) return;
  if (state.editingId && state.editingId !== id) exitEdit();
  if (state.selectedId && elMap.get(state.selectedId)) elMap.get(state.selectedId).classList.remove('selected');
  state.selectedId = id;
  if (id && elMap.get(id)) elMap.get(id).classList.add('selected');
  closePalette();
  closeCtx();
  updateSelectionChrome();
}

export function deselect() {
  select(null);
  if (state.editingId) exitEdit();
}

export function enterEdit(el) {
  if (state.editingId && state.editingId !== el.dataset.id) exitEdit();
  state.editingId = el.dataset.id;
  el.classList.add('editing');
  el.querySelectorAll('[data-edit]').forEach(f => {
    f.readOnly = false;
    f.tabIndex = 0;
  });
}

export function exitEdit() {
  if (!state.editingId) return;
  const el = elMap.get(state.editingId);
  if (el) {
    el.classList.remove('editing');
    el.querySelectorAll('[data-edit]').forEach(f => {
      f.readOnly = true;
      f.tabIndex = -1;
      f.blur();
    });
  }
  state.editingId = null;
}

export function renameSelected() {
  if (!state.selectedId) return;
  const el = elMap.get(state.selectedId);
  if (!el || !el.querySelector('[data-edit]')) return;
  enterEdit(el);
  // focus synchronously so keystrokes right after the rename shortcut land in
  // the field instead of falling through to the document
  const f = el.querySelector('[data-edit]');
  if (f) {
    f.focus();
    if (f.select) f.select();
  }
}

// Edits are debounced per item. Every field changed during the debounce window
// is accumulated, so typing a title and then a body sends both, not just the last.
const saveTimers = new Map();
const pending = new Map(); // item id -> { it, patch }
const clone = v => JSON.parse(JSON.stringify(v));

export function saveData(it, patch) {
  Object.assign(it.data, patch);
  if (it.type === 'board' && patch.title != null) it._childTitle = patch.title;
  if (it.type === 'board' && patch.icon != null) it._childIcon = patch.icon;
  const p = pending.get(it.id) || { it, patch: {} };
  Object.assign(p.patch, patch);
  pending.set(it.id, p);
  clearTimeout(saveTimers.get(it.id));
  saveTimers.set(
    it.id,
    setTimeout(() => flushSave(it.id), 400)
  );
}

// Remember the task list as the server last confirmed it; edits are sent along
// with it so the server can merge instead of overwriting another device's changes.
export function trackTasks(it) {
  if (it.type === 'todo' && !it._baseTasks) it._baseTasks = clone(it.data.tasks || []);
}

async function flushSave(id, keepalive = false) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(saveTimers.get(id));
  const { it, patch } = p;
  const body = { data: patch };
  if (patch.tasks) body.baseTasks = it._baseTasks || [];
  const saved = await api.patch(id, body, keepalive);
  if (it.type === 'board' && patch.title != null) renderCrumbs();
  if (!saved || !patch.tasks) return;
  it._baseTasks = clone(saved.data.tasks || []);
  // Another device changed this list meanwhile: show the merged result
  // (unless more local edits are already queued; they'll merge on their save).
  if (!pending.has(id) && JSON.stringify(saved.data.tasks) !== JSON.stringify(it.data.tasks)) {
    it.data.tasks = saved.data.tasks;
    refreshItem(it);
  }
}

export function flushAllSaves() {
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: flushSave deletes from pending
  for (const id of [...pending.keys()]) flushSave(id, true);
}
// Send queued edits before the tab is closed, reloaded or backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAllSaves();
});
window.addEventListener('pagehide', flushAllSaves);

// Deleting moves the item to the server-side trash; Undo (toast or cmd+Z)
// restores it with everything that was inside it.
const trashed = [];
export async function deleteItem(id) {
  await flushSave(id); // keep last-second edits so Undo brings them back too
  await api.remove(id);
  trashed.push(id);
  state.view.items = state.view.items.filter(x => x.parentItemId !== id && x.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  closeCtx();
  render();
  updateSelectionChrome();
  toast('Moved to trash', { label: 'Undo', fn: () => undoDelete(id) });
}

export async function undoDelete(id = trashed[trashed.length - 1]) {
  if (!id) return;
  trashed.splice(trashed.indexOf(id), 1);
  if (await api.restore(id)) {
    await reloadView();
    toast('Restored');
  }
}
