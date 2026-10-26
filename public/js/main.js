'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { refreshIcons, toast } from './util.js';
import { loadCam, applyCam, initViewport } from './viewport.js';
import { render, renderCrumbs } from './cards.js';
import { deselect, renameSelected, deleteItem, exitEdit, undoDelete, flushAllSaves } from './editing.js';
import { closePalette, closeCtx } from './menus.js';
import { duplicateSelected } from './clipboard.js';
import { arm, disarm, initTools } from './tools.js';
import { initMobile, updateMobileChrome } from './mobile.js';
import { initBoardChrome, updateSelectionChrome } from './boardchrome.js';
import { initQuickNotes, isQuickNotesOpen } from './quicknotes.js';
import { initTrash } from './trash.js';
import { initCapture } from './capture.js';
import { initLightbox } from './lightbox.js';

// Entry point: canvas loading/navigation, global keyboard + pointer handling,
// and boot. Wiring for the viewport and toolbar lives in their own modules and
// is activated here.

// Each board visit is a history entry, so browser Back/Forward walk between
// boards. `replace` is for the initial load and fallbacks that shouldn't add one.
export async function openCanvas(id, { replace = false } = {}) {
  state.view = await api.canvas(id);
  if (state.view.error) {
    if (id !== state.rootCanvasId) return openCanvas(state.rootCanvasId, { replace: true });
    toast('Board not found');
    return;
  }
  state.cam = loadCam(id);
  state.selectedId = null;
  state.editingId = null;
  closeCtx();
  renderCrumbs();
  updateMobileChrome();
  updateSelectionChrome();
  render();
  applyCam();
  if (location.hash.slice(1) !== id) history[replace ? 'replaceState' : 'pushState'](null, '', '#' + id);
}

// Re-fetch the current board after a server-side change (paste, restore) without
// moving the camera.
export async function reloadView() {
  const v = await api.canvas(state.view.canvas.id);
  if (v.error) return;
  state.view = v;
  render();
  updateSelectionChrome();
}

document.addEventListener('keydown', e => {
  if (isQuickNotesOpen()) return; // Quick notes owns the keyboard while it's up
  if (document.querySelector('dialog[open]')) return; // so does a modal sheet
  const ae = document.activeElement;
  const typing = ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.readOnly));
  if (e.key === 'Escape') {
    disarm();
    deselect();
    closePalette();
    closeCtx();
  }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  // cmd+C / X / V arrive as copy/cut/paste events, handled in capture.js.
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoDelete();
    return;
  }
  if (e.key === 'Enter' && state.selectedId && !mod) {
    e.preventDefault();
    renameSelected();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
    e.preventDefault();
    deleteItem(state.selectedId);
  }
  const map = { n: 'note', l: 'link', t: 'todo', b: 'board', c: 'column', m: 'comment' };
  if (map[e.key.toLowerCase()] && !mod) {
    const btn = document.querySelector(`.tool[data-tool="${map[e.key.toLowerCase()]}"]`);
    if (btn) arm(map[e.key.toLowerCase()], btn);
  }
});

document.addEventListener(
  'pointerdown',
  e => {
    if (isQuickNotesOpen()) return;
    if (!e.target.closest('#palette') && !e.target.closest('.swatch')) closePalette();
    if (!e.target.closest('#ctxmenu') && !e.target.closest('.item')) closeCtx();
    if (state.editingId && !e.target.closest('.item')) exitEdit();
  },
  true
);

// Another device may have changed this board while the tab was in the
// background: once our own queued edits have landed, show the server's copy.
// Skipped mid-edit so a caret or half-typed field isn't replaced.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.view.canvas) return;
  try {
    await flushAllSaves(false);
    if (!state.editingId && !state.drag && !isQuickNotesOpen()) await reloadView();
  } catch {
    /* offline: the next focus or navigation tries again */
  }
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && (!state.view.canvas || id !== state.view.canvas.id)) openCanvas(id);
});

initViewport();
initMobile();
initBoardChrome();
initQuickNotes();
initTools();
initTrash();
initCapture();
initLightbox();

(async function boot() {
  refreshIcons();
  const r = await api.root();
  state.rootCanvasId = r.rootCanvasId;
  const startId = location.hash.slice(1) || state.rootCanvasId;
  await openCanvas(startId, { replace: true });
})();
