'use strict';

import { state, dom, elMap, COLORS } from './state.js';
import { api } from './api.js';
import { colorVar, hexColor, isLocked, zRange, toast } from './util.js';
import { iconPicker } from './iconpicker.js';
import { refreshItem, render } from './cards.js';
import { select, renameSelected, deleteSelection, selectedItems } from './editing.js';
import { copySelected, pasteClipboard, duplicateSelected, toggleLock, sendUp } from './clipboard.js';
import { setLine, editLabel } from './lines.js';
import { openLabels } from './labels.js';

// The floating color/icon palette and the right-click context menu.

// mode: 'color' (swatches) | 'icon' (a board's icon search, iconpicker.js)
export function openPalette(it, anchor, mode) {
  const icon = mode === 'icon';
  dom.palette.replaceChildren();
  dom.palette.className = 'open' + (icon ? ' icon-only' : '');

  if (icon) {
    dom.palette.appendChild(
      iconPicker(it._childIcon || 'layout-grid', name => {
        it._childIcon = name;
        api.patch(it.id, { data: { icon: name } });
        refreshItem(it);
        closePalette();
      })
    );
  } else {
    // Recolours the whole selection when this card is part of it.
    const apply = c => {
      const targets = state.selection.has(it.id) && state.selection.size > 1 ? selectedItems() : [it];
      for (const t of targets) {
        t.color = c;
        if (t.type === 'board') t._childColor = c;
        api.patch(t.id, { color: c });
        refreshItem(t);
      }
      closePalette();
    };
    const current = it.color || it._childColor || null;
    // The 12 colours, then None (null clears the colour) — except on cards that
    // fall back to a default colour, where None would look like a swatch.
    const none = ['todo', 'board', 'column'].includes(it.type) ? [] : [null];
    [...COLORS, ...none].forEach(c => {
      const sw = document.createElement('div');
      sw.className = 'sw' + (c ? '' : ' sw-none') + (current === c ? ' sel' : '');
      if (c) sw.style.background = colorVar(c);
      else sw.title = 'None';
      sw.onclick = () => apply(c);
      dom.palette.appendChild(sw);
    });
    // Any other colour, through the browser's own picker. A custom colour is
    // saved as '#rrggbb'; this swatch shows it once chosen.
    const hex = hexColor(current);
    const custom = document.createElement('label');
    custom.className = 'sw sw-custom' + (hex ? ' sel' : '');
    custom.title = 'Custom colour';
    if (hex) custom.style.background = hex;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = hex || '#888888';
    input.setAttribute('aria-label', 'Custom colour');
    input.onchange = () => apply(hexColor(input.value));
    custom.appendChild(input);
    dom.palette.appendChild(custom);
  }

  // Open below the anchor, or above it when there isn't room (the mobile footer).
  // On a touch screen the keyboard covers the lower half, so icon search opens at the top.
  const touch = matchMedia('(hover: none)').matches;
  const r = anchor.getBoundingClientRect();
  const w = icon ? 280 : 210;
  const h = dom.palette.offsetHeight;
  let top = r.bottom + 8;
  if (icon && touch) top = 8;
  else if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  dom.palette.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  dom.palette.style.top = top + 'px';
  // Type to search straight away, but don't pop a phone keyboard before it's asked for.
  if (icon && !touch) dom.palette.querySelector('.icon-search').focus();
}

export function closePalette() {
  dom.palette.classList.remove('open', 'icon-only');
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
  const parent = state.view.breadcrumb.at(-2); // none on Home
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
          ...(parent
            ? [
                {
                  label: `Send ${many ? state.selection.size + ' ' : ''}to ${parent.title}`,
                  fn: () =>
                    sendUp(
                      selectedItems()
                        .filter(i => i.type !== 'line')
                        .map(i => i.id)
                    ),
                },
              ]
            : []),
          { sep: true },
          ...(it.parentItemId
            ? []
            : [
                { label: 'Bring to Front', fn: () => restack(it, 'front') },
                { label: 'Send to Back', fn: () => restack(it, 'back') },
                { sep: true },
              ]),
          ...(many || !elMap.get(it.id)?.querySelector('[data-edit]')
            ? []
            : [{ label: 'Rename', hint: 'Return', fn: () => renameSelected() }]),
          { label: locked ? 'Unlock Position' : 'Lock Position', fn: () => toggleLock() },
          { label: 'Labels…', fn: () => openLabels() },
          ...(it.type === 'board' && !many
            ? [
                { label: 'Create Shortcut', fn: () => createShortcut(it) },
                { label: it._childAgentAccess ? 'Block Agents' : 'Allow Agents', fn: () => toggleAgentAccess(it) },
              ]
            : []),
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
    b.onclick = () => {
      closeCtx(); // every row, not just the ones whose action re-renders
      r.fn();
    };
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
}

function toggleTransparent(it) {
  const transparent = !it.data.transparent;
  it.data = Object.assign({}, it.data, { transparent });
  api.patch(it.id, { data: { transparent } });
  refreshItem(it);
}

export function closeCtx() {
  dom.ctxmenu.classList.remove('open');
  dom.ctxmenu.innerHTML = '';
}

// Whether agents may read the board (docs/agent-addon.md A3): off by default,
// stored on the child canvas, shown on the card as `_childAgentAccess`.
async function toggleAgentAccess(board) {
  const agentAccess = !board._childAgentAccess;
  const c = await api.patchCanvas(board.data.childCanvasId, { agentAccess });
  if (!c) return;
  board._childAgentAccess = c.agentAccess;
  toast(c.agentAccess ? 'Agents may read this board' : 'Agents are blocked from this board');
}

// F7.5: an alias card for `board`, placed beside it; cut/paste it to any board.
async function createShortcut(board) {
  const it = await api.create({
    canvasId: state.view.canvas.id,
    type: 'shortcut',
    x: board.x + 180,
    y: board.y,
    w: 152,
    data: { targetCanvasId: board.data.childCanvasId },
  });
  if (!it || it.error) return;
  it._target = { title: board._childTitle, color: board._childColor, icon: board._childIcon };
  state.view.items.push(it);
  render();
  select(it.id);
  toast('Shortcut made — cut and paste it onto any board');
}
