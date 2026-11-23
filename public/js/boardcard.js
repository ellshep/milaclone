'use strict';

import { state } from './state.js';
import { colorVar, lucideEl, autoGrow, toast } from './util.js';
import { select, enterEdit, exitEdit, saveData } from './editing.js';
import { openCanvas } from './main.js';

// Board and shortcut cards: a coloured icon tile, the name and a count; a
// double-click (or a touch double-tap) opens the board. `makeField` is cards.js's
// inert-until-editing field builder.

export function buildBoard(el, it, makeField) {
  el.classList.add('board');
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.background = colorVar(it.color || it._childColor || 'slate');
  tile.appendChild(lucideEl(it._childIcon || 'layout-grid'));
  el.appendChild(tile);
  // A one-line name that wraps: a textarea where Enter ends the edit and pasted
  // line breaks become spaces.
  const title = makeField('area', 'btitle', it._childTitle || 'Untitled board', 'Board name');
  title.setAttribute('data-nodrag', '');
  title.addEventListener('input', () => {
    if (/[\r\n]/.test(title.value)) title.value = title.value.replace(/[\r\n]+/g, ' ');
    saveData(it, { title: title.value });
  });
  title.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation(); // else main.js's Enter-to-rename starts the edit again
    exitEdit();
  });
  requestAnimationFrame(() => autoGrow(title));
  title.addEventListener('click', e => {
    e.stopPropagation();
    // A touch double-tap opens the board on pointerup; don't fall through into rename.
    if (el.dataset.suppressTitleClick) {
      delete el.dataset.suppressTitleClick;
      return;
    }
    if (state.selectedId !== it.id) {
      select(it.id);
      return;
    }
    enterEdit(el);
    title.focus();
    title.select();
  });
  el.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'bmeta';
  const n = it._childCount || 0;
  meta.textContent = n + (n === 1 ? ' card' : ' cards');
  el.appendChild(meta);
  bindBoardOpen(el, it);
}

// An alias of another board: opens it, and reads as broken once it's trashed.
export function buildShortcut(el, it) {
  el.classList.add('board', 'shortcut');
  const t = it._target;
  el.classList.toggle('broken', !t);
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.background = t ? colorVar(t.color || 'slate') : 'var(--hover-strong)';
  tile.appendChild(lucideEl(t ? t.icon : 'unlink'));
  const badge = document.createElement('span');
  badge.className = 'sc-badge';
  badge.appendChild(lucideEl('corner-up-right'));
  tile.appendChild(badge);
  el.appendChild(tile);
  const title = document.createElement('div');
  title.className = 'btitle';
  title.textContent = t ? t.title : 'Missing board';
  el.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'bmeta';
  meta.textContent = t ? 'Shortcut' : 'Board in trash';
  el.appendChild(meta);
  bindBoardOpen(el, it, t ? it.data.targetCanvasId : null);
}

// Desktop mouse gets a real dblclick; mobile Safari/WebKit does not synthesize
// one from a double-tap, so we also detect a second quick, unmoved pointerup.
function bindBoardOpen(el, it, target = it.data.childCanvasId) {
  let lastTap = -Infinity,
    lastX = 0,
    lastY = 0;
  const open = () => {
    exitEdit();
    if (target) openCanvas(target);
    else toast('The board this shortcut opens is in the trash');
  };
  el.addEventListener('dblclick', e => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    open();
  });
  el.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse') return; // mouse keeps using dblclick
    if (state.drag && state.drag.moved) return; // was a drag, not a tap
    if (state.drag && state.drag.it && state.drag.it.id !== it.id) return;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 28) {
      lastTap = -Infinity;
      el.dataset.suppressTitleClick = '1';
      open();
      return;
    }
    lastTap = now;
    lastX = e.clientX;
    lastY = e.clientY;
  });
}
