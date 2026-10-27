'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { refreshIcons, toast, GRID, isTyping } from './util.js';
import { loadCam, applyCam, initViewport, zoomBy, zoomToFit, resetZoom } from './viewport.js';
import { render, renderCrumbs } from './cards.js';
import {
  deselect,
  renameSelected,
  deleteSelection,
  exitEdit,
  undoDelete,
  flushAllSaves,
  selectIds,
} from './editing.js';
import { closePalette, closeCtx } from './menus.js';
import { duplicateSelected } from './clipboard.js';
import { nudgeSelection } from './drag.js';
import { arm, disarm, initTools } from './tools.js';
import { initMobile, updateMobileChrome } from './mobile.js';
import { initBoardChrome, updateSelectionChrome } from './boardchrome.js';
import { initQuickNotes, isQuickNotesOpen } from './quicknotes.js';
import { initTrash } from './trash.js';
import { initCapture } from './capture.js';
import { initLightbox } from './lightbox.js';
import { initDocument } from './document.js';
import { initLines } from './lines.js';
import { initLabels, resetFilter } from './labels.js';
import { initSearch, openSearch } from './search.js';
import { initExport } from './export.js';

// Entry point: canvas loading/navigation, global keyboard + pointer handling,
// and boot. Wiring for the viewport and toolbar lives in their own modules and
// is activated here.

// Each board visit is a history entry, so browser Back/Forward walk between
// boards. `replace` is for the initial load and fallbacks that shouldn't add one.
// A later call wins: fast Back presses can overlap, and a stale fetch finishing
// last must not push its board back over the newer one.
let navSeq = 0;
let navTarget = null; // the board being opened, which may not be state.view yet
export async function openCanvas(id, { replace = false } = {}) {
  const seq = ++navSeq;
  navTarget = id;
  const hashAtStart = location.hash;
  const view = await api.canvas(id);
  if (seq !== navSeq) return;
  // The URL moved to another board meanwhile (its hashchange event is still
  // queued): that navigation wins, so don't overwrite its hash with ours.
  if (location.hash !== hashAtStart && location.hash.slice(1) !== id) return;
  const prevId = state.view.canvas?.id;
  state.view = view;
  if (state.view.error) {
    if (id !== state.rootCanvasId) return openCanvas(state.rootCanvasId, { replace: true });
    toast('Board not found');
    return;
  }
  if (prevId !== id) resetFilter(); // a filter belongs to its board
  state.cam = loadCam(id);
  selectIds([]);
  state.editingId = null;
  closeCtx();
  renderCrumbs();
  updateMobileChrome();
  updateSelectionChrome();
  render();
  applyCam();
  const i = (history.state?.i ?? 0) + (replace ? 0 : 1);
  if (location.hash.slice(1) !== id) history[replace ? 'replaceState' : 'pushState']({ i }, '', '#' + id);
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
  const typing = isTyping();
  if (e.key === 'Escape') {
    disarm();
    deselect();
    closePalette();
    closeCtx();
  }
  const mod = e.metaKey || e.ctrlKey;
  // Canvas zoom, even mid-typing, so the browser never zooms the page instead.
  if (mod && ['=', '+', '-', '0'].includes(e.key)) {
    e.preventDefault();
    if (e.key === '0') resetZoom();
    else zoomBy(e.key === '-' ? 1 / 1.2 : 1.2);
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault(); // also from inside a text field
    openSearch();
    return;
  }
  if (typing) return;
  // Space held = pan mode, unless a focused control should get the keypress.
  const control = ae && ae.closest('button, a, select, summary, [role="button"], [tabindex]:not([tabindex="-1"])');
  if (e.key === ' ' && !control) {
    e.preventDefault(); // no page scroll
    if (!state.spaceDown) {
      state.spaceDown = true;
      dom.stage.classList.add('space-pan');
    }
    return;
  }
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
  // Back / forward through visited boards, and up to the parent board.
  if (mod && (e.key === '[' || e.key === ']')) {
    e.preventDefault();
    // Back never leaves the app: history.state.i counts this tab's board visits.
    if (e.key === ']') history.forward();
    else if (history.state?.i > 0) history.back();
    return;
  }
  if (mod && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    const bc = state.view.breadcrumb;
    if (bc.length > 1) openCanvas(bc[bc.length - 2].id);
    return;
  }
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (arrow && state.selection.size && !mod && !control) {
    e.preventDefault();
    const step = GRID * (e.shiftKey ? 10 : 1);
    nudgeSelection(arrow[0] * step, arrow[1] * step);
    return;
  }
  if (e.key === '/' && !mod) {
    e.preventDefault();
    document.getElementById('shortcutsDialog').showModal();
    return;
  }
  if (e.key.toLowerCase() === 'z' && !mod) {
    zoomToFit();
    return;
  }
  if (e.key === 'Enter' && state.selectedId && !mod) {
    e.preventDefault();
    renameSelected();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.size) {
    e.preventDefault();
    deleteSelection();
  }
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    // Not the cards a label filter has dimmed or hidden: Delete must only hit what you see.
    selectIds(
      state.view.items
        .filter(i => !i.parentItemId && !elMap.get(i.id)?.classList.contains('filtered-out'))
        .map(i => i.id)
    );
    return;
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
    if (!state.editingId && !state.drag && !isQuickNotesOpen() && !document.querySelector('dialog[open]')) {
      await reloadView();
    }
  } catch {
    /* offline: the next focus or navigation tries again */
  }
});

const endSpacePan = () => {
  state.spaceDown = false;
  dom.stage.classList.remove('space-pan');
};
document.addEventListener('keyup', e => e.key === ' ' && endSpacePan());
window.addEventListener('blur', endSpacePan);

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  // Compare with the pending target, not state.view: a fast second Back can land on
  // the board still shown while the first Back's fetch is in flight.
  if (id && id !== navTarget) openCanvas(id);
});

initViewport();
initMobile();
initBoardChrome();
initQuickNotes();
initTools();
initTrash();
initCapture();
initLightbox();
initDocument();
initLines();
initLabels();
initSearch();
initExport();

(async function boot() {
  refreshIcons();
  const r = await api.root();
  state.rootCanvasId = r.rootCanvasId;
  const startId = location.hash.slice(1) || state.rootCanvasId;
  await openCanvas(startId, { replace: true });
})();
