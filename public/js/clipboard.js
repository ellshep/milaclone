'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { isLocked, toast, clipMarker } from './util.js';
import { refreshItem } from './cards.js';
import { selectIds, selectedItems } from './editing.js';
import { closeCtx } from './menus.js';
import { reloadView } from './main.js';

// Copy / cut / paste / duplicate and position locking for the selected card.
// The clipboard holds the selected cards' ids; the server does the deep copy (a
// column's cards, a board's whole nested tree) or, for cut, the move — nothing
// is deleted, so a cut that is never pasted loses nothing.

// `viaEvent`: a keyboard copy already put the marker on the system clipboard.
// The context menu has no copy event, so it writes it here; until that write is
// known to have landed (it can't on plain-http LAN, where navigator.clipboard is
// missing) cmd+V pastes these cards rather than whatever text the clipboard holds.
export function copySelected(cut, viaEvent = false) {
  // ponytail: a line copies with its cards (db.js), not alone — a lone copy would sit on the original
  const ids = selectedItems()
    .filter(i => i.type !== 'line')
    .map(i => i.id);
  if (!ids.length) return;
  const clip = { ids, cut: !!cut, unsynced: !viaEvent };
  state.clipboard = clip;
  if (!viaEvent && navigator.clipboard) {
    navigator.clipboard.writeText(clipMarker(ids, cut)).then(
      () => (clip.unsynced = false),
      () => {}
    );
  }
  const what = ids.length === 1 ? '' : ` ${ids.length} cards`;
  toast((cut ? 'Cut' : 'Copied') + what);
  closeCtx();
}

// Copy (or move, for cut) each card to this board, keeping their layout relative
// to the first one, which lands at (x, y). Cards from another board, whose
// positions we don't have here, cascade instead.
async function placeAll(ids, cut, x, y) {
  const src = ids.map(id => state.view.items.find(i => i.id === id));
  const anchor = src.find(s => s && !s.parentItemId);
  const placed = [];
  for (const [n, id] of ids.entries()) {
    const s = src[n];
    const free = s && anchor && !s.parentItemId;
    const off = free ? { dx: s.x - anchor.x, dy: s.y - anchor.y } : { dx: (n + 1) * 24, dy: (n + 1) * 24 };
    const to = { canvasId: state.view.canvas.id, x: Math.round(x + off.dx), y: Math.round(y + off.dy) };
    const it = cut ? await api.move(id, to) : await api.copy(id, to);
    if (it) placed.push(it.id); // api already reported a failure
  }
  if (!placed.length) return null;
  await reloadView();
  selectIds(placed);
  closeCtx();
  return placed;
}

export async function pasteClipboard(wx, wy) {
  if (!state.clipboard) return;
  const sel = state.selectedId ? state.view.items.find(i => i.id === state.selectedId) : null;
  const x = wx != null ? wx : ((sel && sel.x) || 80) + 24;
  const y = wy != null ? wy : ((sel && sel.y) || 80) + 24;
  const { ids, cut } = state.clipboard;
  if (await placeAll(ids, cut, x, y)) {
    if (cut) state.clipboard = null; // cut cards move once
    toast('Pasted');
  }
}

export async function duplicateSelected() {
  const items = selectedItems().filter(i => i.type !== 'line');
  if (!items.length) return;
  // A card inside a column is duplicated onto the canvas next to its column.
  const first = items[0];
  const col = first.parentItemId && state.view.items.find(x => x.id === first.parentItemId);
  const at = col || first;
  await placeAll(
    items.map(i => i.id),
    false,
    (at.x || 0) + 28,
    (at.y || 0) + 28
  );
}

// Locks (or unlocks) the whole selection, following the primary card's state.
export async function toggleLock() {
  const primary = state.view.items.find(x => x.id === state.selectedId);
  if (!primary) return;
  const locked = !isLocked(primary);
  const items = selectedItems();
  for (const it of items) {
    it.data = Object.assign({}, it.data, { locked });
    refreshItem(it);
  }
  await Promise.all(items.map(it => api.patch(it.id, { data: { locked } })));
  toast(locked ? 'Position locked' : 'Position unlocked');
  closeCtx();
}
