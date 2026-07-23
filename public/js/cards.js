'use strict';

import { state, dom, elMap } from './state.js';
import { colorVar, lucideEl, refreshIcons, autoGrow, isLocked, rid, normalizeUrl } from './util.js';
import { select, enterEdit, exitEdit, saveData, deleteItem } from './editing.js';
import { openPalette, openCtx } from './menus.js';
import { onItemPointerDown, startResize } from './drag.js';
import { openCanvas } from './main.js';

// Rendering of the canvas and every card type. This module owns the DOM for
// items; other modules ask it to (re)render when data changes.

export function childrenOf(id) {
  return state.view.items.filter(it => it.parentItemId === id).sort((a, b) => (a.y || 0) - (b.y || 0));
}

export function render() {
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
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; dom.crumbs.appendChild(s); }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === state.view.breadcrumb.length - 1 ? ' current' : '');
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.style.background = colorVar((state.view.canvas && c.id === state.view.canvas.id) ? state.view.canvas.color : 'slate');
    b.appendChild(chip);
    const t = document.createElement('span'); t.textContent = c.title; b.appendChild(t);
    if (i !== state.view.breadcrumb.length - 1) b.onclick = () => openCanvas(c.id);
    dom.crumbs.appendChild(b);
  });
}

export function makeField(tag, cls, value, placeholder) {
  const f = document.createElement(tag === 'area' ? 'textarea' : 'input');
  if (tag === 'area') f.rows = 1;
  f.className = cls; f.value = value || ''; f.placeholder = placeholder || '';
  f.setAttribute('data-edit', '');
  f.readOnly = true; f.tabIndex = -1;
  if (tag === 'area') { f.addEventListener('input', () => autoGrow(f)); }
  return f;
}

export function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item type-' + it.type;
  el.dataset.id = it.id;
  if (it.id === state.selectedId) el.classList.add('selected');
  if (isLocked(it)) el.classList.add('locked');
  if (!it.parentItemId) {
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    el.style.width = (it.w || 240) + 'px';
    el.style.zIndex = it.z || 1;
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

  const tools = document.createElement('div');
  tools.className = 'card-tools';
  const colorBtn = document.createElement('div');
  colorBtn.className = 'swatch';
  colorBtn.style.background = colorVar(it.color || (it._childColor) || 'slate');
  colorBtn.title = 'Color';
  colorBtn.setAttribute('data-nodrag', '');
  colorBtn.onclick = (e) => { e.stopPropagation(); openPalette(it, colorBtn); };
  const delBtn = document.createElement('button');
  delBtn.setAttribute('data-nodrag', '');
  delBtn.appendChild(lucideEl('trash-2'));
  delBtn.title = 'Delete';
  delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(it.id); };
  tools.appendChild(colorBtn); tools.appendChild(delBtn);
  if (isLocked(it)) {
    const lockBadge = document.createElement('span');
    lockBadge.className = 'lock-badge';
    lockBadge.appendChild(lucideEl('lock'));
    lockBadge.title = 'Position locked';
    tools.appendChild(lockBadge);
  }
  el.appendChild(tools);

  if (it.type !== 'board' && !it.parentItemId && !isLocked(it)) {
    const rz = document.createElement('div'); rz.className = 'resize'; rz.setAttribute('data-nodrag', '');
    rz.addEventListener('pointerdown', (e) => startResize(e, it, el));
    el.appendChild(rz);
  }

  el.addEventListener('pointerdown', (e) => onItemPointerDown(e, it, el));
  el.addEventListener('contextmenu', (e) => openCtx(e, it));
  return el;
}

function buildNote(el, it) {
  el.classList.add('note');
  if (it.color) { const a = document.createElement('div'); a.className = 'accent'; a.style.background = colorVar(it.color); el.appendChild(a); }
  const t = makeField('area', 'ntitle', it.data.title, 'Title');
  const b = makeField('area', 'nbody', it.data.body, 'Write a note…');
  t.addEventListener('input', () => saveData(it, { title: t.value }));
  b.addEventListener('input', () => saveData(it, { body: b.value }));
  el.appendChild(t); el.appendChild(b);
  requestAnimationFrame(() => { autoGrow(t); autoGrow(b); });
}

function buildComment(el, it) {
  el.classList.add('comment');
  const mark = document.createElement('div');
  mark.className = 'cmark';
  mark.appendChild(lucideEl('message-circle'));
  el.appendChild(mark);
  const b = makeField('area', 'cbody', it.data.body, 'Add a comment…');
  b.addEventListener('input', () => saveData(it, { body: b.value }));
  el.appendChild(b);
  requestAnimationFrame(() => autoGrow(b));
}

function buildTodo(el, it) {
  el.classList.add('todo');
  const title = makeField('input', 'ttitle', it.data.title, 'To-do');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  el.appendChild(title);
  const list = document.createElement('div'); list.className = 'tasks';
  el.appendChild(list);
  const tasks = it.data.tasks || [];
  const renderTasks = () => {
    list.innerHTML = '';
    tasks.forEach((task) => {
      const row = document.createElement('div'); row.className = 'task' + (task.done ? ' done' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!task.done; cb.setAttribute('data-nodrag', '');
      cb.onclick = (e) => { e.stopPropagation(); task.done = cb.checked; row.classList.toggle('done', task.done); saveData(it, { tasks }); };
      const tx = makeField('area', 'txt', task.text, 'List item');
      tx.addEventListener('input', () => { task.text = tx.value; saveData(it, { tasks }); });
      tx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const ni = { id: rid(), text: '', done: false }; tasks.splice(tasks.indexOf(task) + 1, 0, ni); saveData(it, { tasks }); renderTasks(); enterEdit(el); list.querySelectorAll('.txt')[tasks.indexOf(ni)].focus(); }
        if (e.key === 'Backspace' && tx.value === '' && tasks.length > 1) { e.preventDefault(); tasks.splice(tasks.indexOf(task), 1); saveData(it, { tasks }); renderTasks(); }
      });
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.setAttribute('data-nodrag', '');
      del.onclick = (e) => { e.stopPropagation(); tasks.splice(tasks.indexOf(task), 1); saveData(it, { tasks }); renderTasks(); };
      row.appendChild(cb); row.appendChild(tx); row.appendChild(del);
      list.appendChild(row);
      requestAnimationFrame(() => autoGrow(tx));
    });
  };
  renderTasks();
  const add = document.createElement('button'); add.className = 'add'; add.setAttribute('data-nodrag', '');
  add.textContent = '+ Add item';
  add.onclick = (e) => { e.stopPropagation(); tasks.push({ id: rid(), text: '', done: false }); saveData(it, { tasks }); renderTasks(); enterEdit(el); const f = list.querySelectorAll('.txt'); f[f.length - 1].focus(); };
  el.appendChild(add);
}

function buildLink(el, it) {
  el.classList.add('link');
  const bar = document.createElement('div'); bar.className = 'lbar'; bar.style.background = colorVar(it.color || 'blue'); el.appendChild(bar);
  const body = document.createElement('div'); body.className = 'lbody';
  const title = makeField('input', 'ltitle', it.data.title, 'Link title');
  const url = makeField('input', 'lurl', it.data.url, 'https://…');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  url.addEventListener('input', () => { saveData(it, { url: url.value }); open.href = normalizeUrl(url.value); });
  const open = document.createElement('a'); open.className = 'open'; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open ↗';
  open.href = normalizeUrl(it.data.url || '#'); open.setAttribute('data-nodrag', '');
  body.appendChild(title); body.appendChild(url); body.appendChild(open); el.appendChild(body);
}

function buildImage(el, it) {
  el.classList.add('image');
  const img = document.createElement('img'); img.src = it.data.src; img.alt = it.data.name || '';
  if (it.data.naturalW && it.data.naturalH) el.style.aspectRatio = it.data.naturalW + ' / ' + it.data.naturalH;
  el.appendChild(img);
}

function buildFile(el, it) {
  el.classList.add('file');
  const icon = document.createElement('div'); icon.className = 'ficon';
  icon.appendChild(lucideEl('file-text'));
  const name = document.createElement('div'); name.className = 'fname';
  name.textContent = it.data.name || 'File';
  name.title = it.data.name || '';
  const open = document.createElement('a'); open.className = 'fopen'; open.setAttribute('data-nodrag', '');
  open.href = it.data.src || '#'; open.target = '_blank'; open.rel = 'noopener'; open.download = it.data.name || '';
  open.textContent = 'Open ↗';
  el.appendChild(icon); el.appendChild(name); el.appendChild(open);
}

function buildBoard(el, it) {
  el.classList.add('board');
  const tile = document.createElement('div'); tile.className = 'tile';
  tile.style.background = colorVar(it.color || it._childColor || 'slate');
  tile.appendChild(lucideEl(it._childIcon || 'layout-grid'));
  el.appendChild(tile);
  const title = makeField('input', 'btitle', it._childTitle || 'Untitled board', 'Board name');
  title.setAttribute('data-nodrag', '');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.selectedId !== it.id) { select(it.id); return; }
    enterEdit(el); title.focus(); title.select();
  });
  el.appendChild(title);
  const meta = document.createElement('div'); meta.className = 'bmeta';
  const n = it._childCount || 0; meta.textContent = n + (n === 1 ? ' card' : ' cards');
  el.appendChild(meta);
  el.addEventListener('dblclick', (e) => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    exitEdit();
    openCanvas(it.data.childCanvasId);
  });
}

function buildColumn(el, it) {
  el.classList.add('column');
  const head = document.createElement('div'); head.className = 'col-head';
  const chip = document.createElement('div'); chip.className = 'col-chip'; chip.style.background = colorVar(it.color || 'slate');
  const title = makeField('input', 'col-title', it.data.title, 'Column');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  head.appendChild(chip); head.appendChild(title); el.appendChild(head);
  const body = document.createElement('div'); body.className = 'col-body'; body.dataset.colbody = it.id; el.appendChild(body);
  const kids = childrenOf(it.id);
  if (!kids.length) { const e = document.createElement('div'); e.className = 'col-empty'; e.textContent = 'Drag cards here'; body.appendChild(e); }
  for (const k of kids) { const ke = renderItem(k); body.appendChild(ke); elMap.set(k.id, ke); }
}

export function refreshItem(it) {
  const old = elMap.get(it.id);
  if (!old) return;
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
}
