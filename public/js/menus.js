'use strict';

import { state, dom, COLORS, BOARD_ICONS } from './state.js';
import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons, isLocked } from './util.js';
import { refreshItem } from './cards.js';
import { select, renameSelected, deleteItem } from './editing.js';
import { copySelected, pasteClipboard, duplicateSelected, toggleLock } from './clipboard.js';

// The floating color/icon palette and the right-click context menu.

export function openPalette(it, anchor) {
  dom.palette.innerHTML = '';
  dom.palette.className = it.type === 'board' ? 'open board-palette' : 'open';

  COLORS.forEach(c => {
    const sw = document.createElement('div'); sw.className = 'sw' + ((it.color || it._childColor) === c ? ' sel' : '');
    sw.style.background = colorVar(c);
    sw.onclick = () => { it.color = c; if (it.type === 'board') it._childColor = c; api.patch(it.id, { color: c }); refreshItem(it); closePalette(); };
    dom.palette.appendChild(sw);
  });

  if (it.type === 'board') {
    const sep = document.createElement('div'); sep.className = 'pal-sep'; dom.palette.appendChild(sep);
    const grid = document.createElement('div'); grid.className = 'icon-grid';
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
  const w = it.type === 'board' ? 280 : 210;
  dom.palette.style.left = Math.min(r.left, window.innerWidth - w) + 'px';
  dom.palette.style.top = (r.bottom + 8) + 'px';
  refreshIcons(dom.palette);
}

export function closePalette() { dom.palette.classList.remove('open', 'board-palette'); dom.palette.innerHTML = ''; }

export function openCtx(e, it) {
  e.preventDefault();
  e.stopPropagation();
  select(it.id);
  const locked = isLocked(it);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl+';
  const rows = [
    { label: 'Cut', hint: mod + 'X', fn: () => copySelected(true) },
    { label: 'Copy', hint: mod + 'C', fn: () => copySelected(false) },
    { label: 'Paste', hint: mod + 'V', fn: () => pasteClipboard(), disabled: !state.clipboard },
    { label: 'Duplicate', hint: mod + 'D', fn: () => duplicateSelected() },
    { sep: true },
    { label: 'Rename', hint: 'Return', fn: () => renameSelected() },
    { label: locked ? 'Unlock Position' : 'Lock Position', fn: () => toggleLock() },
    { sep: true },
    { label: 'Move to Trash', hint: 'Delete', danger: true, fn: () => deleteItem(it.id) }
  ];
  dom.ctxmenu.innerHTML = '';
  rows.forEach(r => {
    if (r.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; dom.ctxmenu.appendChild(s); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (r.danger ? ' danger' : '');
    if (r.disabled) b.disabled = true;
    const lab = document.createElement('span'); lab.textContent = r.label; b.appendChild(lab);
    if (r.hint) { const k = document.createElement('kbd'); k.textContent = r.hint; b.appendChild(k); }
    b.onclick = () => r.fn();
    dom.ctxmenu.appendChild(b);
  });
  dom.ctxmenu.classList.add('open');
  const mw = 220, mh = dom.ctxmenu.offsetHeight || 280;
  let left = e.clientX, top = e.clientY;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
  dom.ctxmenu.style.left = left + 'px';
  dom.ctxmenu.style.top = top + 'px';
}

export function closeCtx() { dom.ctxmenu.classList.remove('open'); dom.ctxmenu.innerHTML = ''; }
