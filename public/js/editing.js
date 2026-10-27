'use strict';

import { state, elMap } from './state.js';
import { api } from './api.js';
import { toast, hexColor } from './util.js';
import { render, renderCrumbs, refreshItem } from './cards.js';
import { closePalette, closeCtx } from './menus.js';
import { updateSelectionChrome } from './boardchrome.js';
import { reloadView } from './main.js';
import { startRich, stopRich } from './rich.js';

// Selection, inline-edit mode, debounced saves, and deletion.

function paintSelection() {
  for (const [id, el] of elMap) el.classList.toggle('selected', state.selection.has(id));
}

// Replace the selection. `primary` (default: the last id) is what rename and
// the board chrome act on.
export function selectIds(ids, primary = ids[ids.length - 1] ?? null) {
  if (state.editingId && !(ids.length === 1 && ids[0] === state.editingId)) exitEdit();
  state.selection = new Set(ids);
  state.selectedId = primary;
  paintSelection();
  closePalette();
  closeCtx();
  updateSelectionChrome();
}

export function select(id) {
  if (state.selectedId === id && state.selection.size === (id ? 1 : 0)) return;
  selectIds(id ? [id] : []);
}

// Shift-click: add a card to the selection, or take it out.
export function toggleSelect(id) {
  const ids = [...state.selection];
  if (state.selection.has(id)) selectIds(ids.filter(x => x !== id));
  else selectIds([...ids, id]);
}

// Selected cards, minus any inside a column that is itself selected (the
// column carries them along).
export function selectedItems() {
  const items = state.view.items.filter(i => state.selection.has(i.id));
  return items.filter(i => !i.parentItemId || !state.selection.has(i.parentItemId));
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
  const it = state.view.items.find(i => i.id === el.dataset.id);
  el.querySelectorAll('[data-rich]').forEach(f => startRich(f, it));
}

export function exitEdit() {
  if (!state.editingId) return;
  const el = elMap.get(state.editingId);
  const it = state.view.items.find(i => i.id === state.editingId);
  if (el) {
    el.querySelectorAll('[data-rich]').forEach(f => stopRich(f, it));
    el.classList.remove('editing');
    el.querySelectorAll('[data-edit]').forEach(f => {
      f.readOnly = true;
      f.tabIndex = -1;
      f.blur();
    });
  }
  state.editingId = null;
  // A new note that holds nothing but a hex code becomes a colour swatch (only a
  // new one: an existing note reading '#decade' or '#c0ffee' stays a note).
  const hex = it && it._fresh && it.type === 'note' && hexColor(it.data.text);
  if (it) delete it._fresh;
  if (hex) {
    // One PATCH carries any queued body edit too, so a later flush can't undo the hex.
    const p = pending.get(it.id);
    pending.delete(it.id);
    clearTimeout(saveTimers.get(it.id));
    it.type = 'swatch';
    Object.assign(it.data, { hex, text: hex });
    refreshItem(it);
    api.patch(it.id, { type: 'swatch', data: { ...p?.patch, hex, text: hex } }).then(saved => {
      if (saved) return;
      it.type = 'note'; // the server still has a note
      refreshItem(it);
    });
  }
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

// keepalive (64 KB body cap) is only needed while the page is going away.
export function flushAllSaves(keepalive = true) {
  return Promise.all([...pending.keys()].map(id => flushSave(id, keepalive)));
}
// Send queued edits before the tab is closed, reloaded or backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAllSaves();
});
window.addEventListener('pagehide', flushAllSaves);

// Deleting moves items to the server-side trash; Undo (toast or cmd+Z)
// restores them with everything that was inside them. Each undo entry is the
// list of ids one delete action trashed.
const trashed = [];
export async function deleteItems(ids) {
  if (!ids.length) return;
  await Promise.all(ids.map(id => flushSave(id))); // keep last-second edits so Undo brings them back too
  await Promise.all(ids.map(id => api.remove(id)));
  const entry = [...ids];
  trashed.push(entry);
  const gone = new Set(ids);
  state.view.items = state.view.items.filter(x => !gone.has(x.id) && !gone.has(x.parentItemId));
  state.selection = new Set([...state.selection].filter(id => !gone.has(id)));
  if (gone.has(state.selectedId)) state.selectedId = [...state.selection].pop() ?? null;
  closeCtx();
  render();
  updateSelectionChrome();
  const msg = ids.length === 1 ? 'Moved to trash' : `Moved ${ids.length} cards to trash`;
  toast(msg, { label: 'Undo', fn: () => undoDelete(entry) });
}
export const deleteItem = id => deleteItems([id]);
export const deleteSelection = () => deleteItems(selectedItems().map(i => i.id));

// The Trash sheet restored or purged it: cmd+Z must not try again. No id = all.
export function forgetUndo(id) {
  if (id === undefined) trashed.length = 0;
  for (const entry of trashed) if (entry.includes(id)) entry.splice(entry.indexOf(id), 1);
  // an emptied entry would make the next cmd+Z a no-op (a stale toast Undo still finds nothing to do)
  for (let i = trashed.length - 1; i >= 0; i--) if (!trashed[i].length) trashed.splice(i, 1);
}

export async function undoDelete(entry = trashed[trashed.length - 1]) {
  const i = trashed.indexOf(entry);
  if (i === -1) return; // already undone
  trashed.splice(i, 1);
  if (!entry.length) return; // everything in it was restored or purged from the Trash sheet
  const restored = await Promise.all(entry.map(id => api.restore(id)));
  if (restored.some(Boolean)) {
    await reloadView();
    toast('Restored');
  }
}
