'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { isLocked, toast } from './util.js';
import { render, refreshItem } from './cards.js';
import { select } from './editing.js';
import { closeCtx } from './menus.js';
import { defaultsFor } from './create.js';

// Copy / cut / paste / duplicate and position locking for the selected card.

function clonePayload(it) {
  return {
    type: it.type,
    w: it.w,
    h: it.h,
    color: it.color,
    data: JSON.parse(JSON.stringify(it.data || {})),
    _childTitle: it._childTitle,
    _childIcon: it._childIcon,
    _childColor: it._childColor
  };
}

export function copySelected(cut) {
  if (!state.selectedId) return;
  const it = state.view.items.find(x => x.id === state.selectedId);
  if (!it) return;
  state.clipboard = { items: [clonePayload(it)], cut: !!cut, cutIds: cut ? [it.id] : [] };
  toast(cut ? 'Cut' : 'Copied');
  closeCtx();
}

export async function pasteClipboard(wx, wy) {
  if (!state.clipboard || !state.clipboard.items.length) return;
  const base = state.clipboard.items[0];
  const sel = state.selectedId ? state.view.items.find(i => i.id === state.selectedId) : null;
  const x = Math.round(wx != null ? wx : ((sel && sel.x) || 80) + 24);
  const y = Math.round(wy != null ? wy : ((sel && sel.y) || 80) + 24);
  const data = Object.assign({}, base.data);
  delete data.locked;
  if (base.type === 'board') {
    data.title = (base._childTitle || 'Untitled board') + ' copy';
    if (base._childIcon) data.icon = base._childIcon;
    delete data.childCanvasId;
  }
  const body = {
    canvasId: state.view.canvas.id,
    type: base.type,
    x, y,
    w: base.w || defaultsFor(base.type).w,
    color: base.color || base._childColor || null,
    data
  };
  const it = await api.create(body);
  if (state.clipboard.cut && state.clipboard.cutIds.length) {
    for (const id of state.clipboard.cutIds) await api.remove(id);
    state.view.items = state.view.items.filter(x => !state.clipboard.cutIds.includes(x.id) && !state.clipboard.cutIds.includes(x.parentItemId));
    state.clipboard = null;
  }
  state.view.items.push(it);
  render();
  select(it.id);
  toast('Pasted');
  closeCtx();
}

export async function duplicateSelected() {
  if (!state.selectedId) return;
  const it = state.view.items.find(x => x.id === state.selectedId);
  if (!it) return;
  state.clipboard = { items: [clonePayload(it)], cut: false, cutIds: [] };
  await pasteClipboard((it.x || 0) + 28, (it.y || 0) + 28);
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
