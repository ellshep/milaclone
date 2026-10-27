'use strict';

import { state, dom, elMap, COLORS } from './state.js';
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
  hexColor,
  tableText,
  wordLabel,
  toast,
  dueInfo,
  clampIndents,
} from './util.js';
import { select, enterEdit, exitEdit, saveData, deleteItem, trackTasks } from './editing.js';
import { openPalette, openCtx } from './menus.js';
import { updateSelectionChrome } from './boardchrome.js';
import { onItemPointerDown, startResize } from './drag.js';
import { openCanvas } from './main.js';
import { api } from './api.js';
import { openLightbox } from './lightbox.js';
import { updateMobileChrome } from './mobile.js';
import { openDocument } from './document.js';
import { drawLines } from './lines.js';

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
    if (it.type === 'line') continue; // drawn by lines.js
    const el = renderItem(it);
    dom.world.appendChild(el);
    elMap.set(it.id, el);
  }
  drawLines();
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
  else if (it.type === 'swatch') buildSwatch(el, it);
  else if (it.type === 'table') buildTable(el, it);
  else if (it.type === 'document') buildDocument(el, it);
  else if (it.type === 'sketch') buildSketch(el, it);
  else if (it.type === 'shortcut') buildShortcut(el, it);

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
    if (it.type !== 'shortcut') tools.appendChild(colorBtn); // a shortcut wears its board's colour
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

const MAX_INDENT = 4;

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
  // Rows are keyed by id (reorder): give any missing or duplicated one a fresh id.
  const seen = new Set();
  for (const t of tasks) {
    if (!t.id || seen.has(t.id)) t.id = rid();
    seen.add(t.id);
  }
  const renderTasks = () => {
    list.innerHTML = '';
    tasks.forEach(task => {
      const row = document.createElement('div');
      row.className = 'task' + (task.done ? ' done' : '');
      row.dataset.tid = task.id;
      row.style.setProperty('--indent', task.indent || 0);
      const grip = document.createElement('span'); // lucide swaps the <i>, so the listener sits on a wrapper
      grip.className = 'grip';
      grip.title = 'Drag to reorder';
      grip.appendChild(lucideEl('grip-vertical'));
      grip.setAttribute('data-nodrag', '');
      grip.addEventListener('pointerdown', e => reorderTask(e, row));
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
        if (e.key === 'Tab') {
          // Nest under the task above (one level deeper at most), or back out.
          e.preventDefault();
          const before = tasks.map(t => t.indent || 0);
          task.indent = Math.max(0, (task.indent || 0) + (e.shiftKey ? -1 : 1));
          clampIndents(tasks, MAX_INDENT); // also pulls up the tasks under an outdented one
          if (tasks.every((t, i) => (t.indent || 0) === before[i])) return;
          for (const r of list.children) {
            const t = tasks.find(x => x.id === r.dataset.tid);
            if (t) r.style.setProperty('--indent', t.indent || 0);
          }
          saveData(it, { tasks });
        }
        if (e.key === 'Backspace' && tx.value === '' && tasks.length > 1) {
          e.preventDefault();
          tasks.splice(tasks.indexOf(task), 1);
          clampIndents(tasks, MAX_INDENT);
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
        clampIndents(tasks, MAX_INDENT);
        saveData(it, { tasks });
        renderTasks();
      };
      // Quick notes' due date and tags, read-only here.
      const body = document.createElement('div');
      body.className = 'tbody';
      body.appendChild(tx);
      const due = dueInfo(task.due);
      if (due || (task.tags && task.tags.length)) {
        const meta = document.createElement('div');
        meta.className = 'tmeta';
        if (due) {
          const d = document.createElement('span');
          d.className = 'tdue';
          d.textContent = due.label;
          d.title = due.full + ' (' + due.sub + ')';
          d.classList.toggle('overdue', due.n <= 0 && !task.done);
          meta.appendChild(d);
        }
        for (const tag of task.tags || []) {
          const t = document.createElement('span');
          t.className = 'ttag';
          t.textContent = '#' + tag;
          meta.appendChild(t);
        }
        body.appendChild(meta);
      }
      row.appendChild(grip);
      row.appendChild(cb);
      row.appendChild(body);
      row.appendChild(del);
      list.appendChild(row);
      requestAnimationFrame(() => autoGrow(tx));
    });
    refreshIcons(list);
  };
  // Drag a task by its grip; the list's DOM order becomes the new order on release.
  // Listens on document: moving the row in the DOM would drop a pointer capture.
  const reorderTask = (e, row) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    row.classList.add('dragging');
    const move = ev => {
      const next = [...list.children].find(r => {
        if (r === row) return false;
        const b = r.getBoundingClientRect();
        return ev.clientY < b.top + b.height / 2;
      });
      if (next !== row.nextSibling) list.insertBefore(row, next || null);
    };
    const up = ev => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      row.classList.remove('dragging');
      // A rebuilt card (merged save from another device) owns the list now, and
      // an interrupted gesture puts the rows back: neither saves.
      if (!list.isConnected) return;
      const order = [...list.children].map(r => r.dataset.tid);
      if (ev.type === 'pointercancel' || order.every((id, i) => tasks[i].id === id)) return renderTasks();
      tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      clampIndents(tasks, MAX_INDENT);
      saveData(it, { tasks });
      renderTasks();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
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

// An alias of another board: opens it, and reads as broken once it's trashed.
function buildShortcut(el, it) {
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

// A colour chip plus its hex; clicking the chip copies the hex.
function buildSwatch(el, it) {
  el.classList.add('swatch-card');
  let color = hexColor(it.data.hex) || '#888888'; // never raw CSS from the API (e.g. url())
  const chip = document.createElement('div');
  chip.className = 'sw-chip';
  chip.style.background = color;
  chip.title = 'Copy ' + color;
  chip.setAttribute('data-nodrag', ''); // a click copies; the card drags by its label
  chip.addEventListener('click', () => {
    (navigator.clipboard ? navigator.clipboard.writeText(color) : Promise.reject()).then(
      () => toast('Copied ' + color),
      () => toast('Could not copy')
    );
  });
  const hex = makeField('input', 'sw-hex', color, '#000000');
  hex.addEventListener('change', () => {
    const h = hexColor(hex.value);
    hex.value = h || color; // an invalid code reverts
    if (!h) return;
    color = h;
    saveData(it, { hex: h, text: h });
    chip.style.background = h;
    chip.title = 'Copy ' + h;
  });
  el.appendChild(chip);
  el.appendChild(hex);
}

// Plain-text cells. Tab walks the cells (they're ordinary inputs); the bar adds
// or removes a row/column at the last focused cell.
function buildTable(el, it) {
  el.classList.add('table');
  // Rows from the API may be ragged: pad every row to the widest.
  const src = Array.isArray(it.data.rows) && it.data.rows.length ? it.data.rows : [['']];
  const width = Math.max(1, ...src.map(r => (Array.isArray(r) ? r.length : 0)));
  const rows = src.map(r => Array.from({ length: width }, (_, i) => String((Array.isArray(r) && r[i]) ?? '')));
  const save = () => saveData(it, { rows, text: tableText(rows) });
  let at = [0, 0];
  const grid = document.createElement('table');
  grid.className = 'tgrid';
  const draw = focus => {
    grid.replaceChildren();
    rows.forEach((r, ri) => {
      const tr = grid.insertRow();
      r.forEach((c, ci) => {
        const f = makeField('input', 'tcell', c, '');
        if (el.classList.contains('editing')) {
          f.readOnly = false;
          f.tabIndex = 0;
        }
        f.addEventListener('focus', () => (at = [ri, ci]));
        f.addEventListener('input', () => {
          r[ci] = f.value;
          save();
        });
        tr.insertCell().appendChild(f);
      });
    });
    if (focus) grid.rows[focus[0]]?.cells[focus[1]]?.firstChild.focus();
  };
  draw();
  el.appendChild(grid);
  const bar = document.createElement('div');
  bar.className = 'tbar';
  bar.setAttribute('data-nodrag', '');
  const op = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.onclick = e => {
      e.stopPropagation();
      fn();
      save();
      enterEdit(el);
      draw(at);
    };
    bar.appendChild(b);
  };
  op('+ Row', 'Add a row below', () => {
    rows.splice(
      at[0] + 1,
      0,
      rows[0].map(() => '')
    );
    at = [at[0] + 1, at[1]];
  });
  op('+ Column', 'Add a column to the right', () => {
    rows.forEach(r => r.splice(at[1] + 1, 0, ''));
    at = [at[0], at[1] + 1];
  });
  op('− Row', 'Remove this row', () => {
    if (rows.length > 1) rows.splice(at[0], 1);
    at = [Math.min(at[0], rows.length - 1), at[1]];
  });
  op('− Column', 'Remove this column', () => {
    if (rows[0].length > 1) rows.forEach(r => r.splice(at[1], 1));
    at = [at[0], Math.min(at[1], rows[0].length - 1)];
  });
  el.appendChild(bar);
}

// A long-form card: the canvas shows title, snippet and word count; double-click
// (or Open) edits it full screen in document.js.
function buildDocument(el, it) {
  el.classList.add('document');
  const head = document.createElement('div');
  head.className = 'doc-head';
  head.appendChild(lucideEl('file-text'));
  const title = makeField('input', 'dtitle', it.data.title, 'Untitled document');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  head.appendChild(title);
  el.appendChild(head);
  const snip = document.createElement('div');
  snip.className = 'dsnip';
  snip.textContent = String(it.data.text || '').slice(0, 280);
  el.appendChild(snip);
  const foot = document.createElement('div');
  foot.className = 'dfoot';
  foot.textContent = wordLabel(it.data.text);
  const open = document.createElement('button');
  open.className = 'dopen';
  open.setAttribute('data-nodrag', '');
  open.textContent = 'Open';
  open.onclick = e => {
    e.stopPropagation();
    openDocument(it);
  };
  foot.appendChild(open);
  el.appendChild(foot);
  el.addEventListener('dblclick', e => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    openDocument(it);
  });
}

// Freehand pen (4 sizes, the palette colours) and an eraser. Strokes are SVG
// path data in a fixed SKETCH_W × SKETCH_H viewBox, so the drawing scales with
// the card. Draw while the card is being edited; otherwise it's a plain card.
const SKETCH_W = 400,
  SKETCH_H = 280,
  PEN_SIZES = [2, 4, 8, 16];
const pen = { size: 4, color: null, erase: false }; // shared, so the next sketch keeps your pen
const strokeColor = c => (c ? colorVar(c) : 'var(--ink)');

function buildSketch(el, it) {
  el.classList.add('sketch');
  const strokes = Array.isArray(it.data.strokes) ? it.data.strokes : [];
  const NS = 'http://www.w3.org/2000/svg';
  const pad = document.createElementNS(NS, 'svg');
  pad.setAttribute('class', 'sk-pad');
  pad.setAttribute('viewBox', `0 0 ${SKETCH_W} ${SKETCH_H}`);
  pad.setAttribute('data-edit', ''); // a click on it enters edit mode, like a field
  const path = (s, i) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', s.d);
    p.setAttribute('stroke-width', s.size);
    p.style.stroke = strokeColor(s.color);
    p.dataset.i = i;
    return p;
  };
  const draw = () => pad.replaceChildren(...strokes.map(path));
  draw();
  const at = e => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(pad.getScreenCTM().inverse());
    return [Math.round(p.x), Math.round(p.y)];
  };
  let last = null;
  const eraseAt = e => {
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sk-pad path');
    if (!hit || !pad.contains(hit)) return false;
    strokes.splice(+hit.dataset.i, 1);
    draw();
    return true;
  };
  pad.addEventListener('pointerdown', e => {
    if (!el.classList.contains('editing') || e.button !== 0) return; // select / drag as usual
    e.stopPropagation();
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    let changed = false;
    let live = null;
    if (pen.erase) changed = eraseAt(e);
    else {
      last = at(e);
      live = { d: `M${last.join(' ')} L${last.join(' ')}`, size: pen.size, color: pen.color };
      strokes.push(live);
      pad.appendChild(path(live, strokes.length - 1));
    }
    const move = ev => {
      if (live) {
        // Skip sub-3-unit moves: strokes stay small (every save sends them all).
        const p = at(ev);
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 3) return;
        last = p;
        live.d += ` L${p.join(' ')}`;
        pad.lastChild.setAttribute('d', live.d);
      } else changed = eraseAt(ev) || changed;
    };
    const up = () => {
      pad.removeEventListener('pointermove', move);
      pad.removeEventListener('pointerup', up);
      pad.removeEventListener('pointercancel', up);
      if (live || changed) saveData(it, { strokes });
    };
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
  });
  el.appendChild(pad);

  const bar = document.createElement('div');
  bar.className = 'skbar';
  bar.setAttribute('data-nodrag', '');
  const paint = () =>
    bar.querySelectorAll('button').forEach(b => {
      const on = b.dataset.erase
        ? pen.erase
        : !pen.erase && (b.dataset.size ? +b.dataset.size === pen.size : (b.dataset.color || null) === pen.color);
      b.classList.toggle('on', on);
    });
  const btn = (cls, title, set, data) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = title;
    Object.assign(b.dataset, data);
    b.onclick = e => {
      e.stopPropagation();
      Object.assign(pen, set);
      paint();
    };
    bar.appendChild(b);
    return b;
  };
  for (const s of PEN_SIZES) {
    const b = btn('sk-size', `Pen size ${s}`, { size: s, erase: false }, { size: s });
    const dot = document.createElement('span');
    dot.style.width = dot.style.height = Math.min(14, s + 2) + 'px';
    b.appendChild(dot);
  }
  for (const c of [null, ...COLORS]) {
    const b = btn('sk-color', c || 'Ink', { color: c, erase: false }, c ? { color: c } : {});
    b.style.background = strokeColor(c);
  }
  btn('sk-erase', 'Eraser', { erase: true }, { erase: '1' }).appendChild(lucideEl('eraser'));
  paint();
  el.appendChild(bar);
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
  // Collapse to just the header (saved on the column); the count shows either way.
  const kids = childrenOf(it.id);
  const count = document.createElement('span');
  count.className = 'col-count';
  count.textContent = kids.length;
  count.title = kids.length + (kids.length === 1 ? ' card' : ' cards');
  head.appendChild(count);
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'col-fold';
  fold.setAttribute('data-nodrag', '');
  fold.setAttribute('aria-expanded', String(!it.data.collapsed));
  fold.title = it.data.collapsed ? 'Expand column' : 'Collapse column';
  fold.appendChild(lucideEl('chevron-down'));
  fold.onclick = e => {
    e.stopPropagation();
    saveData(it, { collapsed: !it.data.collapsed });
    refreshItem(it);
  };
  head.appendChild(fold);
  el.classList.toggle('collapsed', !!it.data.collapsed);
  el.appendChild(head);
  const body = document.createElement('div');
  body.className = 'col-body';
  body.dataset.colbody = it.id;
  el.appendChild(body);
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
  if (it.type === 'line') return drawLines();
  const old = elMap.get(it.id);
  if (!old) return;
  leaveRichEdit(old);
  const fresh = renderItem(it);
  old.replaceWith(fresh);
  elMap.set(it.id, fresh);
  refreshIcons(fresh);
  if (state.editingId === it.id) {
    // Still mid-edit (a recolour, say): the fresh card must be editable too.
    state.editingId = null;
    enterEdit(fresh);
  }
  if (it.type === 'column') {
    for (const k of childrenOf(it.id)) {
      const ke = fresh.querySelector(`[data-id="${k.id}"]`);
      if (ke) elMap.set(k.id, ke);
    }
  }
  if (it.type === 'board' && it.id === state.selectedId) updateSelectionChrome();
}
