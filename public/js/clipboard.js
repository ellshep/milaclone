'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { isLocked, toast, clipMarker } from './util.js';
import { refreshItem } from './cards.js';
import { select } from './editing.js';
import { closeCtx } from './menus.js';
import { reloadView } from './main.js';

// Copy / cut / paste / duplicate and position locking for the selected card.
// The clipboard holds the source item's id; the server does the deep copy (a
// column's cards, a board's whole nested tree) or, for cut, the move — nothing
// is deleted, so a cut that is never pasted loses nothing.

// `viaEvent`: a keyboard copy already put the marker on the system clipboard.
// The context menu has no copy event, so it writes it here; until that write is
// known to have landed (it can't on plain-http LAN, where navigator.clipboard is
// missing) cmd+V pastes this card rather than whatever text the clipboard holds.
export function copySelected(cut, viaEvent = false) {
  if (!state.selectedId) return;
  const clip = { id: state.selectedId, cut: !!cut, unsynced: !viaEvent };
  state.clipboard = clip;
  if (!viaEvent && navigator.clipboard) {
    navigator.clipboard.writeText(clipMarker(clip.id, cut)).then(
      () => (clip.unsynced = false),
      () => {}
    );
  }
  toast(cut ? 'Cut' : 'Copied');
  closeCtx();
}

async function placeCopy(id, cut, x, y) {
  const to = { canvasId: state.view.canvas.id, x: Math.round(x), y: Math.round(y) };
  const it = cut ? await api.move(id, to) : await api.copy(id, to);
  if (!it) return; // api already reported the failure
  await reloadView();
  select(it.id);
  closeCtx();
  return it;
}

export async function pasteClipboard(wx, wy) {
  if (!state.clipboard) return;
  const sel = state.selectedId ? state.view.items.find(i => i.id === state.selectedId) : null;
  const x = wx != null ? wx : ((sel && sel.x) || 80) + 24;
  const y = wy != null ? wy : ((sel && sel.y) || 80) + 24;
  const { id, cut } = state.clipboard;
  if (await placeCopy(id, cut, x, y)) {
    if (cut) state.clipboard = null; // a cut item moves once
    toast('Pasted');
  }
}

export async function duplicateSelected() {
  if (!state.selectedId) return;
  const it = state.view.items.find(x => x.id === state.selectedId);
  if (!it) return;
  // A card inside a column is duplicated onto the canvas next to its column.
  const col = it.parentItemId && state.view.items.find(x => x.id === it.parentItemId);
  const at = col || it;
  await placeCopy(it.id, false, (at.x || 0) + 28, (at.y || 0) + 28);
}

export async function toggleLock() {
  if (!state.selectedId) return;
  const it = state.view.items.find(x => x.id === state.selectedId);
  if (!it) return;
  const locked = !isLocked(it);
  it.data = Object.assign({}, it.data, { locked });
  await api.patch(it.id, { data: { locked } });
  refreshItem(it);
  toast(locked ? 'Position locked' : 'Position unlocked');
  closeCtx();
}
