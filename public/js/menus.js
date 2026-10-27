'use strict';

import { state, dom, elMap, COLORS, BOARD_ICONS } from './state.js';
import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons, isLocked, zRange } from './util.js';
import { refreshItem } from './cards.js';
import { select, renameSelected, deleteSelection, selectedItems } from './editing.js';
import { copySelected, pasteClipboard, duplicateSelected, toggleLock } from './clipboard.js';
import { setLine, editLabel } from './lines.js';

// The floating color/icon palette and the right-click context menu.

// mode: 'color' | 'icon' | 'auto' (auto = colors, plus icons for boards — legacy badge path)
export function openPalette(it, anchor, mode = 'auto') {
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
  const showColor = mode === 'color' || mode === 'auto';
  const showIcon = mode === 'icon' || (mode === 'auto' && it.type === 'board');
  dom.palette.className = 'open' + (showIcon ? ' board-palette' : '') + (mode === 'icon' ? ' icon-only' : '');

  if (showColor) {
    // The 12 colours, then None (null clears the colour) — except on cards that
    // fall back to a default colour, where None would look like a swatch.
    const none = ['todo', 'board', 'column'].includes(it.type) ? [] : [null];
    [...COLORS, ...none].forEach(c => {
      const sw = document.createElement('div');
      sw.className = 'sw' + (c ? '' : ' sw-none') + ((it.color || it._childColor || null) === c ? ' sel' : '');
      if (c) sw.style.background = colorVar(c);
      else sw.title = 'None';
      // Recolours the whole selection when this card is part of it.
      sw.onclick = () => {
        const targets = state.selection.has(it.id) && state.selection.size > 1 ? selectedItems() : [it];
        for (const t of targets) {
          t.color = c;
          if (t.type === 'board') t._childColor = c;
          api.patch(t.id, { color: c });
          refreshItem(t);
        }
        closePalette();
      };
      dom.palette.appendChild(sw);
    });
  }

  if (showIcon) {
    if (showColor) {
      const sep = document.createElement('div');
      sep.className = 'pal-sep';
      dom.palette.appendChild(sep);
    }
    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    const current = it._childIcon || 'layout-grid';
    BOARD_ICONS.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-pick' + (name === current ? ' sel' : '');
      btn.title = name;
      btn.appendChild(lucideEl(name));
      btn.onclick = () => {
        it._childIcon = name;
        api.patch(it.id, { data: { icon: name } });
        refreshItem(it);
        closePalette();
      };
      grid.appendChild(btn);
    });
    dom.palette.appendChild(grid);
  }

  const r = anchor.getBoundingClientRect();
  const w = showIcon ? 280 : 210;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + 220 > window.innerHeight) top = Math.max(8, r.top - 228);
  dom.palette.style.left = Math.max(8, left) + 'px';
  dom.palette.style.top = top + 'px';
  refreshIcons(dom.palette);
}

export function closePalette() {
  dom.palette.classList.remove('open', 'board-palette', 'icon-only');
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
}

export function openCtx(e, it) {
  e.preventDefault();
  e.stopPropagation();
  if (!state.selection.has(it.id)) select(it.id); // right-clicking inside a group keeps it
  const many = state.selection.size > 1;
  const locked = isLocked(it);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl+';
  const trashRow = {
    label: many ? `Move ${state.selection.size} to Trash` : 'Move to Trash',
    hint: 'Delete',
    danger: true,
    fn: () => deleteSelection(),
  };
  const arrow = it.data.arrow || 'end';
  const lineRows = [
    ...[
      ['end', 'Arrow at End'],
      ['both', 'Arrows at Both Ends'],
      ['none', 'No Arrows'],
    ].map(([a, label]) => ({ label, hint: arrow === a ? '✓' : '', fn: () => setLine(it, { arrow: a }) })),
    { label: it.data.dashed ? 'Solid Line' : 'Dashed Line', fn: () => setLine(it, { dashed: !it.data.dashed }) },
    { label: it.data.label ? 'Edit Label' : 'Add Label', fn: () => editLabel(it) },
    { label: 'Colour…', fn: () => openPalette(it, elMap.get(it.id), 'color') },
    { sep: true },
    trashRow,
  ];
  const rows =
    it.type === 'line'
      ? lineRows
      : [
          { label: 'Cut', hint: mod + 'X', fn: () => copySelected(true) },
          { label: 'Copy', hint: mod + 'C', fn: () => copySelected(false) },
          { label: 'Paste', hint: mod + 'V', fn: () => pasteClipboard(), disabled: !state.clipboard },
          { label: 'Duplicate', hint: mod + 'D', fn: () => duplicateSelected() },
          { sep: true },
          ...(it.parentItemId
            ? []
            : [
                { label: 'Bring to Front', fn: () => restack(it, 'front') },
                { label: 'Send to Back', fn: () => restack(it, 'back') },
                { sep: true },
              ]),
          ...(many ? [] : [{ label: 'Rename', hint: 'Return', fn: () => renameSelected() }]),
          { label: locked ? 'Unlock Position' : 'Lock Position', fn: () => toggleLock() },
          ...(it.type === 'image'
            ? [
                {
                  label: it.data.transparent ? 'Show Background' : 'Transparent Background',
                  fn: () => toggleTransparent(it),
                },
              ]
            : []),
          { sep: true },
          trashRow,
        ];
  dom.ctxmenu.innerHTML = '';
  rows.forEach(r => {
    if (r.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      dom.ctxmenu.appendChild(s);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (r.danger ? ' danger' : '');
    if (r.disabled) b.disabled = true;
    const lab = document.createElement('span');
    lab.textContent = r.label;
    b.appendChild(lab);
    if (r.hint) {
      const k = document.createElement('kbd');
      k.textContent = r.hint;
      b.appendChild(k);
    }
    b.onclick = () => r.fn();
    dom.ctxmenu.appendChild(b);
  });
  dom.ctxmenu.classList.add('open');
  const mw = 220,
    mh = dom.ctxmenu.offsetHeight || 280;
  let left = e.clientX,
    top = e.clientY;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
  dom.ctxmenu.style.left = left + 'px';
  dom.ctxmenu.style.top = top + 'px';
}

// Stacking order: the selection (or just this card) goes above or below every
// other free card on the board, keeping its own internal order.
function restack(it, where) {
  const group = (state.selection.has(it.id) ? selectedItems() : [it]).filter(i => !i.parentItemId);
  const [lo, hi] = zRange(state.view.items);
  const ordered = group.sort((a, b) => (a.z || 0) - (b.z || 0));
  let z = where === 'front' ? hi : lo - ordered.length - 1;
  for (const g of ordered) g.z = ++z;
  api.patchMany(ordered.map(g => ({ id: g.id, z: g.z })));
  for (const g of ordered) refreshItem(g);
  closeCtx();
}

function toggleTransparent(it) {
  const transparent = !it.data.transparent;
  it.data = Object.assign({}, it.data, { transparent });
  api.patch(it.id, { data: { transparent } });
  refreshItem(it);
  closeCtx();
}

export function closeCtx() {
  dom.ctxmenu.classList.remove('open');
  dom.ctxmenu.innerHTML = '';
}
