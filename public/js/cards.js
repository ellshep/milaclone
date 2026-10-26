'use strict';

import { state, dom, elMap } from './state.js';
import {
  colorVar,
  lucideEl,
  refreshIcons,
  autoGrow,
  isLocked,
  rid,
  normalizeUrl,
  embedUrl,
  fileIcon,
  docToDom,
  isEmptyDoc,
} from './util.js';
import { select, enterEdit, exitEdit, saveData, deleteItem, trackTasks } from './editing.js';
import { openPalette, openCtx } from './menus.js';
import { updateSelectionChrome } from './boardchrome.js';
import { onItemPointerDown, startResize } from './drag.js';
import { openCanvas } from './main.js';
import { api } from './api.js';
import { openLightbox } from './lightbox.js';
import { updateMobileChrome } from './mobile.js';

// Rendering of the canvas and every card type. This module owns the DOM for
// items; other modules ask it to (re)render when data changes.

export function childrenOf(id) {
  return state.view.items.filter(it => it.parentItemId === id).sort((a, b) => (a.y || 0) - (b.y || 0));
}

// Re-rendering a card mid-edit would orphan its TipTap editor: finish the edit first.
const leaveRichEdit = el => el && el.querySelector('[data-rich]') && el.dataset.id === state.editingId && exitEdit();

export function render() {
  leaveRichEdit(elMap.get(state.editingId));
  dom.world.innerHTML = '';
  elMap.clear();
  const free = state.view.items.filter(it => !it.parentItemId);
  for (const it of free) {
    const el = renderItem(it);
    dom.world.appendChild(el);
    elMap.set(it.id, el);
  }
  dom.hint.style.display = state.view.items.length ? 'none' : 'block';
  refreshIcons(dom.world);
}

export function renderCrumbs() {
  dom.crumbs.innerHTML = '';
  state.view.breadcrumb.forEach((c, i) => {
    if (i > 0) {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = '/';
      dom.crumbs.appendChild(s);
    }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === state.view.breadcrumb.length - 1 ? ' current' : '');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = colorVar(
      state.view.canvas && c.id === state.view.canvas.id ? state.view.canvas.color : 'slate'
    );
    b.appendChild(chip);
    const t = document.createElement('span');
    t.textContent = c.title;
    b.appendChild(t);
    if (i !== state.view.breadcrumb.length - 1) b.onclick = () => openCanvas(c.id);
    else b.onclick = () => renameBoard(b);
    dom.crumbs.appendChild(b);
  });
}

// Clicking the current board's name in the header edits it in place: Enter or
// blur saves, Escape cancels. Only this crumb is swapped (not the whole bar), so
// a click on another crumb that blurs the field still lands; if we navigated
// away meanwhile, the input is already detached and the swap is a no-op.
function renameBoard(b) {
  const canvas = state.view.canvas;
  const crumb = state.view.breadcrumb.at(-1);
  const input = document.createElement('input');
  input.className = 'crumb-input';
  input.value = canvas.title || '';
  input.setAttribute('aria-label', 'Board name');
  b.replaceWith(input);
  input.focus();
  input.select();
  let cancel = false;
  input.onkeydown = e => {
    if (e.key === 'Escape') cancel = true;
    if (e.key === 'Enter' || e.key === 'Escape') input.blur();
  };
  input.onblur = async () => {
    const title = input.value.trim();
    input.replaceWith(b);
    if (cancel || !title || title === canvas.title) return;
    const old = canvas.title;
    canvas.title = crumb.title = b.lastChild.textContent = title;
    if (!(await api.patchCanvas(canvas.id, { title }))) canvas.title = crumb.title = b.lastChild.textContent = old;
    if (state.view.canvas === canvas) updateMobileChrome();
  };
}

export function makeField(tag, cls, value, placeholder) {
  const f = document.createElement(tag === 'area' ? 'textarea' : 'input');
  if (tag === 'area') f.rows = 1;
  f.className = cls;
  f.value = value || '';
  f.placeholder = placeholder || '';
  f.setAttribute('data-edit', '');
  f.readOnly = true;
  f.tabIndex = -1;
  if (tag === 'area') {
    f.addEventListener('input', () => autoGrow(f));
  }
  return f;
}

export function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item type-' + it.type;
  el.dataset.id = it.id;
  if (state.selection.has(it.id)) el.classList.add('selected');
  if (isLocked(it)) el.classList.add('locked');
  if (!it.parentItemId) {
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = (it.w || 240) + 'px';
    el.style.zIndex = it.z ?? 1; // may be negative after Send to Back
  } else {
    el.classList.add('in-column');
  }

  if (it.type === 'note') buildNote(el, it);
  else if (it.type === 'todo') buildTodo(el, it);
  else if (it.type === 'link') buildLink(el, it);
  else if (it.type === 'image') buildImage(el, it);
  else if (it.type === 'file') buildFile(el, it);
  else if (it.type === 'comment') buildComment(el, it);
  else if (it.type === 'board') buildBoard(el, it);
  else if (it.type === 'column') buildColumn(el, it);

  // Boards use the rail / mobile footer for color·icon·rename·delete.
  // Other cards keep the floating properties badge.
  if (it.type !== 'board') {
    const tools = document.createElement('div');
    tools.className = 'card-tools';
    const colorBtn = document.createElement('div');
    colorBtn.className = 'swatch';
    colorBtn.style.background = colorVar(it.color || 'slate');
    colorBtn.title = 'Color';
    colorBtn.setAttribute('data-nodrag', '');
    colorBtn.onclick = e => {
      e.stopPropagation();
      openPalette(it, colorBtn, 'color');
    };
    const delBtn = document.createElement('button');
    delBtn.setAttribute('data-nodrag', '');
    delBtn.appendChild(lucideEl('trash-2'));
    delBtn.title = 'Delete';
    delBtn.onclick = e => {
      e.stopPropagation();
      deleteItem(it.id);
    };
    tools.appendChild(colorBtn);
    tools.appendChild(delBtn);
    if (isLocked(it)) {
      const lockBadge = document.createElement('span');
      lockBadge.className = 'lock-badge';
      lockBadge.appendChild(lucideEl('lock'));
      lockBadge.title = 'Position locked';
      tools.appendChild(lockBadge);
    }
    el.appendChild(tools);
  } else if (isLocked(it)) {
    const lockBadge = document.createElement('span');
    lockBadge.className = 'lock-badge board-lock';
    lockBadge.appendChild(lucideEl('lock'));
    lockBadge.title = 'Position locked';
    el.appendChild(lockBadge);
  }

  if (it.type !== 'board' && !it.parentItemId && !isLocked(it)) {
    const rz = document.createElement('div');
    rz.className = 'resize';
    rz.setAttribute('data-nodrag', '');
    rz.addEventListener('pointerdown', e => startResize(e, it, el));
    el.appendChild(rz);
  }

  el.addEventListener('pointerdown', e => onItemPointerDown(e, it, el));
  el.addEventListener('contextmenu', e => openCtx(e, it));
  return el;
}

function buildNote(el, it) {
  el.classList.add('note');
  if (it.color) {
    const a = document.createElement('div');
    a.className = 'accent';
    a.style.background = colorVar(it.color);
    el.appendChild(a);
  }
  el.appendChild(richField('nbody', it, 'Write a note…'));
}

// A note/comment body: the static render of data.doc; editing the card swaps
// in TipTap (rich.js).
function richField(cls, it, placeholder) {
  const f = document.createElement('div');
  f.className = cls + ' rich';
  f.dataset.edit = '';
  f.dataset.rich = '';
  f.dataset.placeholder = placeholder;
  f.tabIndex = -1;
  f.toggleAttribute('data-empty', isEmptyDoc(it.data.doc));
  f.appendChild(docToDom(it.data.doc));
  return f;
}

function buildComment(el, it) {
  el.classList.add('comment');
  const mark = document.createElement('div');
  mark.className = 'cmark';
  mark.appendChild(lucideEl('message-circle'));
  el.appendChild(mark);
  el.appendChild(richField('cbody', it, 'Add a comment…'));
}

function buildTodo(el, it) {
  el.classList.add('todo');
  trackTasks(it);
  const title = makeField('input', 'ttitle', it.data.title, 'To-do');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  el.appendChild(title);
  const list = document.createElement('div');
  list.className = 'tasks';
  el.appendChild(list);
  const tasks = it.data.tasks || [];
  const renderTasks = () => {
    list.innerHTML = '';
    tasks.forEach(task => {
      const row = document.createElement('div');
      row.className = 'task' + (task.done ? ' done' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!task.done;
      cb.setAttribute('data-nodrag', '');
      cb.onclick = e => {
        e.stopPropagation();
        task.done = cb.checked;
        row.classList.toggle('done', task.done);
        saveData(it, { tasks });
      };
      const tx = makeField('area', 'txt', task.text, 'List item');
      tx.addEventListener('input', () => {
        task.text = tx.value;
        saveData(it, { tasks });
      });
      tx.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const ni = { id: rid(), text: '', done: false };
          tasks.splice(tasks.indexOf(task) + 1, 0, ni);
          saveData(it, { tasks });
          renderTasks();
          enterEdit(el);
          list.querySelectorAll('.txt')[tasks.indexOf(ni)].focus();
        }
        if (e.key === 'Backspace' && tx.value === '' && tasks.length > 1) {
          e.preventDefault();
          tasks.splice(tasks.indexOf(task), 1);
          saveData(it, { tasks });
          renderTasks();
        }
      });
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.setAttribute('data-nodrag', '');
      del.onclick = e => {
        e.stopPropagation();
        tasks.splice(tasks.indexOf(task), 1);
        saveData(it, { tasks });
        renderTasks();
      };
      row.appendChild(cb);
      row.appendChild(tx);
      row.appendChild(del);
      list.appendChild(row);
      requestAnimationFrame(() => autoGrow(tx));
    });
  };
  renderTasks();
  const add = document.createElement('button');
  add.className = 'add';
  add.setAttribute('data-nodrag', '');
  add.textContent = '+ Add item';
  add.onclick = e => {
    e.stopPropagation();
    tasks.push({ id: rid(), text: '', done: false });
    saveData(it, { tasks });
    renderTasks();
    enterEdit(el);
    const f = list.querySelectorAll('.txt');
    f[f.length - 1].focus();
  };
  el.appendChild(add);
}

function buildLink(el, it) {
  el.classList.add('link');
  const embed = embedUrl(it.data.url);
  // ponytail: render() rebuilds every card, so a playing embed restarts when the
  // board re-renders; keyed rendering (reuse unchanged card elements) would fix it.
  if (embed) {
    el.classList.add('embed');
    const frame = document.createElement('iframe');
    frame.className = 'embed-frame' + (embed.includes('spotify') ? ' audio' : '');
    frame.src = embed;
    frame.title = it.data.title || 'Embedded player';
    frame.loading = 'lazy';
    frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    el.appendChild(frame);
  }
  const bar = document.createElement('div');
  bar.className = 'lbar';
  bar.style.background = colorVar(it.color || 'blue');
  el.appendChild(bar);
  const body = document.createElement('div');
  body.className = 'lbody';
  const title = makeField('input', 'ltitle', it.data.title, 'Link title');
  const url = makeField('input', 'lurl', it.data.url, 'https://…');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  url.addEventListener('input', () => {
    saveData(it, { url: url.value });
    open.href = normalizeUrl(url.value);
  });
  const open = document.createElement('a');
  open.className = 'open';
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open ↗';
  open.href = normalizeUrl(it.data.url || '#');
  open.setAttribute('data-nodrag', '');
  body.appendChild(title);
  body.appendChild(url);
  body.appendChild(open);
  el.appendChild(body);
}

function buildImage(el, it) {
  el.classList.add('image');
  if (it.data.transparent) el.classList.add('transparent');
  const img = document.createElement('img');
  img.src = it.data.src;
  img.alt = it.data.caption || it.data.name || '';
  if (it.data.naturalW && it.data.naturalH) img.style.aspectRatio = it.data.naturalW + ' / ' + it.data.naturalH;
  el.appendChild(img);
  const caption = makeField('input', 'icaption', it.data.caption, 'Add a caption');
  caption.setAttribute('aria-label', 'Caption');
  caption.addEventListener('input', () => saveData(it, { caption: caption.value }));
  el.appendChild(caption);
  el.addEventListener('dblclick', e => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    openLightbox(it.id);
  });
}

function buildFile(el, it) {
  el.classList.add('file');
  const icon = document.createElement('div');
  icon.className = 'ficon';
  icon.appendChild(lucideEl(fileIcon(it.data.name, it.data.mime)));
  const name = document.createElement('div');
  name.className = 'fname';
  name.textContent = it.data.name || 'File';
  name.title = it.data.name || '';
  const open = document.createElement('a');
  open.className = 'fopen';
  open.setAttribute('data-nodrag', '');
  open.href = it.data.src || '#';
  open.target = '_blank';
  open.rel = 'noopener';
  open.download = it.data.name || '';
  open.textContent = 'Open ↗';
  el.appendChild(icon);
  el.appendChild(name);
  el.appendChild(open);
  const kind = String(it.data.mime || '').split('/')[0];
  if (it.data.src && (kind === 'audio' || kind === 'video')) {
    const media = document.createElement(kind);
    media.className = 'fmedia';
    media.controls = true;
    media.preload = 'metadata';
    media.src = it.data.src;
    media.setAttribute('data-nodrag', '');
    el.classList.add('has-media');
    el.appendChild(media);
  }
}

function buildBoard(el, it) {
  el.classList.add('board');
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.background = colorVar(it.color || it._childColor || 'slate');
  tile.appendChild(lucideEl(it._childIcon || 'layout-grid'));
  el.appendChild(tile);
  const title = makeField('input', 'btitle', it._childTitle || 'Untitled board', 'Board name');
  title.setAttribute('data-nodrag', '');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
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

// Desktop mouse gets a real dblclick; mobile Safari/WebKit does not synthesize
// one from a double-tap, so we also detect a second quick, unmoved pointerup.
function bindBoardOpen(el, it) {
  let lastTap = -Infinity,
    lastX = 0,
    lastY = 0;
  const open = () => {
    exitEdit();
    openCanvas(it.data.childCanvasId);
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

function buildColumn(el, it) {
  el.classList.add('column');
  const head = document.createElement('div');
  head.className = 'col-head';
  const chip = document.createElement('div');
  chip.className = 'col-chip';
  chip.style.background = colorVar(it.color || 'slate');
  const title = makeField('input', 'col-title', it.data.title, 'Column');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  head.appendChild(chip);
  head.appendChild(title);
  el.appendChild(head);
  const body = document.createElement('div');
  body.className = 'col-body';
  body.dataset.colbody = it.id;
  el.appendChild(body);
  const kids = childrenOf(it.id);
  if (!kids.length) {
    const e = document.createElement('div');
    e.className = 'col-empty';
    e.textContent = 'Drag cards here';
    body.appendChild(e);
  }
  for (const k of kids) {
    const ke = renderItem(k);
    body.appendChild(ke);
    elMap.set(k.id, ke);
  }
}

export function refreshItem(it) {
  const old = elMap.get(it.id);
  if (!old) return;
  leaveRichEdit(old);
  const fresh = renderItem(it);
  old.replaceWith(fresh);
  elMap.set(it.id, fresh);
  refreshIcons(fresh);
  if (it.type === 'column') {
    for (const k of childrenOf(it.id)) {
      const ke = fresh.querySelector(`[data-id="${k.id}"]`);
      if (ke) elMap.set(k.id, ke);
    }
  }
  if (it.type === 'board' && it.id === state.selectedId) updateSelectionChrome();
}
