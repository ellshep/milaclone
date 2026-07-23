'use strict';

/* =========================================================================
   Canvas Board — front-end engine
   - infinite pan/zoom canvas
   - cards: note, to-do, link, image, file, comment, board, column
   - drag to move, drag into/out of columns, resize, inline edit
   - context menu: copy/cut/paste/duplicate/rename/trash/lock
   - everything persists to the Node backend
   ========================================================================= */

const COLORS = ['slate','gray','teal','green','brown','yellow','orange','red','pink','purple','blue','indigo'];
const colorVar = c => `var(--c-${COLORS.includes(c) ? c : 'slate'})`;

const BOARD_ICONS = [
  'layout-grid', 'book-open', 'monitor', 'clock', 'heart', 'house', 'lightbulb',
  'palette', 'briefcase', 'sparkles', 'glasses', 'landmark', 'compass', 'camera',
  'music', 'pen-tool', 'layers', 'folder', 'star', 'zap', 'globe', 'cpu', 'leaf', 'target'
];

const api = {
  async root() { return (await fetch('/api/root')).json(); },
  async canvas(id) { return (await fetch('/api/canvas/' + id)).json(); },
  async patchCanvas(id, body) { return (await fetch('/api/canvas/' + id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); },
  async create(body) { return (await fetch('/api/item', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); },
  async patch(id, body) { return (await fetch('/api/item/' + id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); },
  async patchMany(updates) { return (await fetch('/api/items', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({updates}) })).json(); },
  async remove(id) { return (await fetch('/api/item/' + id, { method:'DELETE' })).json(); },
  async upload(file) { const fd = new FormData(); fd.append('file', file); return (await fetch('/api/upload', { method:'POST', body:fd })).json(); }
};

const stage = document.getElementById('stage');
const world = document.getElementById('world');
const crumbs = document.getElementById('crumbs');
const hint = document.getElementById('hint');
const palette = document.getElementById('palette');
const ctxmenu = document.getElementById('ctxmenu');
const fileInput = document.getElementById('fileInput');
const uploadInput = document.getElementById('uploadInput');
const zoomLvl = document.getElementById('zoomLvl');
const toastEl = document.getElementById('toast');

let rootCanvasId = null;
let view = { canvas: null, items: [], breadcrumb: [] };
let cam = { x: 80, y: 60, scale: 1 };
let armed = null;
let selectedId = null;
let editingId = null;
const elMap = new Map();
let clipboard = null;
let pendingImageWorld = null;
let pendingUploadWorld = null;

function lucideEl(name) {
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  return i;
}
function refreshIcons(root) {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons(root ? { nodes: [root] } : undefined);
  }
}

function applyCam() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`;
  zoomLvl.textContent = Math.round(cam.scale * 100) + '%';
  saveCam();
}
function screenToWorld(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return { x: (clientX - r.left - cam.x) / cam.scale, y: (clientY - r.top - cam.y) / cam.scale };
}
function saveCam() { if (view.canvas) localStorage.setItem('cam:' + view.canvas.id, JSON.stringify(cam)); }
function loadCam(id) {
  try { const c = JSON.parse(localStorage.getItem('cam:' + id)); if (c && c.scale) return c; } catch (e) {}
  return { x: 80, y: 60, scale: 1 };
}

async function openCanvas(id) {
  view = await api.canvas(id);
  if (view.error) { if (id !== rootCanvasId) return openCanvas(rootCanvasId); toast('Board not found'); return; }
  cam = loadCam(id);
  selectedId = null; editingId = null;
  closeCtx();
  renderCrumbs();
  render();
  applyCam();
  if (location.hash.slice(1) !== id) { history.replaceState(null, '', '#' + id); }
}

function renderCrumbs() {
  crumbs.innerHTML = '';
  view.breadcrumb.forEach((c, i) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; crumbs.appendChild(s); }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === view.breadcrumb.length - 1 ? ' current' : '');
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.style.background = colorVar((view.canvas && c.id === view.canvas.id) ? view.canvas.color : 'slate');
    b.appendChild(chip);
    const t = document.createElement('span'); t.textContent = c.title; b.appendChild(t);
    if (i !== view.breadcrumb.length - 1) b.onclick = () => openCanvas(c.id);
    crumbs.appendChild(b);
  });
}

function childrenOf(id) {
  return view.items.filter(it => it.parentItemId === id).sort((a, b) => (a.y || 0) - (b.y || 0));
}

function render() {
  world.innerHTML = '';
  elMap.clear();
  const free = view.items.filter(it => !it.parentItemId);
  for (const it of free) {
    const el = renderItem(it);
    world.appendChild(el);
    elMap.set(it.id, el);
  }
  hint.style.display = view.items.length ? 'none' : 'block';
  refreshIcons(world);
}

function makeField(tag, cls, value, placeholder) {
  const f = document.createElement(tag === 'area' ? 'textarea' : 'input');
  if (tag === 'area') f.rows = 1;
  f.className = cls; f.value = value || ''; f.placeholder = placeholder || '';
  f.setAttribute('data-edit', '');
  f.readOnly = true; f.tabIndex = -1;
  if (tag === 'area') { f.addEventListener('input', () => autoGrow(f)); }
  return f;
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
function isLocked(it) { return !!(it.data && it.data.locked); }

function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item type-' + it.type;
  el.dataset.id = it.id;
  if (it.id === selectedId) el.classList.add('selected');
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
    if (selectedId !== it.id) { select(it.id); return; }
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

function enterEdit(el) {
  if (editingId && editingId !== el.dataset.id) exitEdit();
  editingId = el.dataset.id;
  el.classList.add('editing');
  el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = false; f.tabIndex = 0; });
}
function exitEdit() {
  if (!editingId) return;
  const el = elMap.get(editingId);
  if (el) { el.classList.remove('editing'); el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = true; f.tabIndex = -1; f.blur(); }); }
  editingId = null;
}
function renameSelected() {
  if (!selectedId) return;
  const el = elMap.get(selectedId);
  if (!el || !el.querySelector('[data-edit]')) return;
  enterEdit(el);
  const f = el.querySelector('[data-edit]');
  requestAnimationFrame(() => { f?.focus(); if (f && f.select) f.select(); });
}

function select(id) {
  if (selectedId === id) return;
  if (editingId && editingId !== id) exitEdit();
  if (selectedId && elMap.get(selectedId)) elMap.get(selectedId).classList.remove('selected');
  selectedId = id;
  if (id && elMap.get(id)) elMap.get(id).classList.add('selected');
  closePalette();
  closeCtx();
}
function deselect() { select(null); if (editingId) exitEdit(); }

function openPalette(it, anchor) {
  palette.innerHTML = '';
  palette.className = it.type === 'board' ? 'open board-palette' : 'open';

  COLORS.forEach(c => {
    const sw = document.createElement('div'); sw.className = 'sw' + ((it.color || it._childColor) === c ? ' sel' : '');
    sw.style.background = colorVar(c);
    sw.onclick = () => { it.color = c; if (it.type === 'board') it._childColor = c; api.patch(it.id, { color: c }); refreshItem(it); closePalette(); };
    palette.appendChild(sw);
  });

  if (it.type === 'board') {
    const sep = document.createElement('div'); sep.className = 'pal-sep'; palette.appendChild(sep);
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
    palette.appendChild(grid);
  }

  const r = anchor.getBoundingClientRect();
  const w = it.type === 'board' ? 280 : 210;
  palette.style.left = Math.min(r.left, window.innerWidth - w) + 'px';
  palette.style.top = (r.bottom + 8) + 'px';
  refreshIcons(palette);
}
function closePalette() { palette.classList.remove('open', 'board-palette'); palette.innerHTML = ''; }

function refreshItem(it) {
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

function copySelected(cut) {
  if (!selectedId) return;
  const it = view.items.find(x => x.id === selectedId);
  if (!it) return;
  clipboard = { items: [clonePayload(it)], cut: !!cut, cutIds: cut ? [it.id] : [] };
  toast(cut ? 'Cut' : 'Copied');
  closeCtx();
}

async function pasteClipboard(wx, wy) {
  if (!clipboard || !clipboard.items.length) return;
  const base = clipboard.items[0];
  const sel = selectedId ? view.items.find(i => i.id === selectedId) : null;
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
    canvasId: view.canvas.id,
    type: base.type,
    x, y,
    w: base.w || defaultsFor(base.type).w,
    color: base.color || base._childColor || null,
    data
  };
  const it = await api.create(body);
  if (clipboard.cut && clipboard.cutIds.length) {
    for (const id of clipboard.cutIds) await api.remove(id);
    view.items = view.items.filter(x => !clipboard.cutIds.includes(x.id) && !clipboard.cutIds.includes(x.parentItemId));
    clipboard = null;
  }
  view.items.push(it);
  render();
  select(it.id);
  toast('Pasted');
  closeCtx();
}

async function duplicateSelected() {
  if (!selectedId) return;
  const it = view.items.find(x => x.id === selectedId);
  if (!it) return;
  clipboard = { items: [clonePayload(it)], cut: false, cutIds: [] };
  await pasteClipboard((it.x || 0) + 28, (it.y || 0) + 28);
}

async function toggleLock() {
  if (!selectedId) return;
  const it = view.items.find(x => x.id === selectedId);
  if (!it) return;
  const locked = !isLocked(it);
  it.data = Object.assign({}, it.data, { locked });
  await api.patch(it.id, { data: { locked } });
  refreshItem(it);
  toast(locked ? 'Position locked' : 'Position unlocked');
  closeCtx();
}

function openCtx(e, it) {
  e.preventDefault();
  e.stopPropagation();
  select(it.id);
  const locked = isLocked(it);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '\u2318' : 'Ctrl+';
  const rows = [
    { label: 'Cut', hint: mod + 'X', fn: () => copySelected(true) },
    { label: 'Copy', hint: mod + 'C', fn: () => copySelected(false) },
    { label: 'Paste', hint: mod + 'V', fn: () => pasteClipboard(), disabled: !clipboard },
    { label: 'Duplicate', hint: mod + 'D', fn: () => duplicateSelected() },
    { sep: true },
    { label: 'Rename', hint: 'Return', fn: () => renameSelected() },
    { label: locked ? 'Unlock Position' : 'Lock Position', fn: () => toggleLock() },
    { sep: true },
    { label: 'Move to Trash', hint: 'Delete', danger: true, fn: () => deleteItem(it.id) }
  ];
  ctxmenu.innerHTML = '';
  rows.forEach(r => {
    if (r.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; ctxmenu.appendChild(s); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (r.danger ? ' danger' : '');
    if (r.disabled) b.disabled = true;
    const lab = document.createElement('span'); lab.textContent = r.label; b.appendChild(lab);
    if (r.hint) { const k = document.createElement('kbd'); k.textContent = r.hint; b.appendChild(k); }
    b.onclick = () => r.fn();
    ctxmenu.appendChild(b);
  });
  ctxmenu.classList.add('open');
  const mw = 220, mh = ctxmenu.offsetHeight || 280;
  let left = e.clientX, top = e.clientY;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
  ctxmenu.style.left = left + 'px';
  ctxmenu.style.top = top + 'px';
}
function closeCtx() { ctxmenu.classList.remove('open'); ctxmenu.innerHTML = ''; }

const saveTimers = new Map();
function saveData(it, patch) {
  Object.assign(it.data, patch);
  if (it.type === 'board' && patch.title != null) it._childTitle = patch.title;
  if (it.type === 'board' && patch.icon != null) it._childIcon = patch.icon;
  clearTimeout(saveTimers.get(it.id));
  saveTimers.set(it.id, setTimeout(() => {
    api.patch(it.id, { data: patch });
    if (it.type === 'board' && patch.title != null) renderCrumbs();
  }, 400));
}
async function deleteItem(id) {
  await api.remove(id);
  view.items = view.items.filter(x => x.parentItemId !== id && x.id !== id);
  if (selectedId === id) selectedId = null;
  closeCtx();
  render();
}

function defaultsFor(type) {
  switch (type) {
    case 'note':    return { w: 240, data: { title: '', body: '' } };
    case 'todo':    return { w: 240, data: { title: 'To-do', tasks: [{ id: rid(), text: '', done: false }] } };
    case 'link':    return { w: 240, color: 'blue', data: { url: '', title: '' } };
    case 'column':  return { w: 252, data: { title: 'Column' } };
    case 'board':   return { w: 152, data: { title: 'Untitled board' } };
    case 'comment': return { w: 220, data: { body: '' } };
    case 'file':    return { w: 220, data: {} };
    default:        return { w: 240, data: {} };
  }
}
async function createAt(type, wx, wy) {
  const d = defaultsFor(type);
  const body = Object.assign({ canvasId: view.canvas.id, type, x: Math.round(wx), y: Math.round(wy) }, d);
  const it = await api.create(body);
  view.items.push(it);
  render();
  select(it.id);
  if (type !== 'board' && type !== 'image' && type !== 'file') {
    const el = elMap.get(it.id); enterEdit(el); el.querySelector('[data-edit]')?.focus();
  }
  hint.style.display = 'none';
}

let drag = null;
let pan = null;

function onItemPointerDown(e, it, el) {
  if (e.button !== 0) return;
  if (armed) return;
  if (e.target.closest('[data-nodrag]')) { e.stopPropagation(); return; }
  if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
  e.stopPropagation();
  select(it.id);
  if (isLocked(it)) return;

  const start = { sx: e.clientX, sy: e.clientY };
  const fromColumn = !!it.parentItemId;
  let moved = false;
  const rect = el.getBoundingClientRect();
  const startWorld = screenToWorld(rect.left, rect.top);
  drag = { it, el, start, startWorld, fromColumn, moved: false, dropCol: null };
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - start.sx, dy = ev.clientY - start.sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true; drag.moved = true;
      el.classList.add('dragging');
      if (fromColumn) {
        world.appendChild(el);
        el.classList.remove('in-column');
        el.style.width = (it.w || 240) + 'px';
        el.style.zIndex = 99999;
      }
    }
    const wx = startWorld.x + dx / cam.scale;
    const wy = startWorld.y + dy / cam.scale;
    el.style.left = wx + 'px'; el.style.top = wy + 'px';
    highlightColumn(ev, it);
  };

  const up = (ev) => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    if (!moved) {
      if (it.type !== 'board') maybeEdit(el, ev);
      drag = null; return;
    }
    finishDrag(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function maybeEdit(el, ev) {
  if (!el.querySelector('[data-edit]')) return;
  if (!el.classList.contains('editing')) {
    enterEdit(el);
    const f = ev.target.closest('[data-edit]') || el.querySelector('[data-edit]');
    requestAnimationFrame(() => f?.focus());
  }
}

function columnBodyUnder(clientX, clientY, excludeId) {
  const bodies = world.querySelectorAll('.col-body');
  for (const b of bodies) {
    if (b.dataset.colbody === excludeId) continue;
    const r = b.getBoundingClientRect();
    if (clientX >= r.left - 6 && clientX <= r.right + 6 && clientY >= r.top - 6 && clientY <= r.bottom + 30) return b;
  }
  return null;
}
function highlightColumn(ev, it) {
  world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (it.type === 'column') { drag.dropCol = null; return; }
  const body = columnBodyUnder(ev.clientX, ev.clientY, it.id);
  drag.dropCol = body ? body.dataset.colbody : null;
  if (body) body.closest('.column').classList.add('drop-target');
}

async function finishDrag(ev) {
  const { it, el } = drag;
  world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (drag.dropCol) {
    const order = insertOrder(drag.dropCol, ev.clientY, it.id);
    it.parentItemId = drag.dropCol;
    it.y = order;
    const sibs = view.items.filter(k => k.parentItemId === drag.dropCol).sort((a, b) => a.y - b.y);
    sibs.forEach((s, i) => s.y = i);
    await api.patch(it.id, { parentItemId: it.parentItemId, canvasId: view.canvas.id });
    await api.patchMany(sibs.map(s => ({ id: s.id, y: s.y })));
    render();
  } else {
    const wx = Math.round(parseFloat(el.style.left));
    const wy = Math.round(parseFloat(el.style.top));
    const wasChild = drag.fromColumn;
    it.x = wx; it.y = wy; it.parentItemId = null;
    await api.patch(it.id, { x: wx, y: wy, parentItemId: null });
    if (wasChild) render();
  }
  drag = null;
}
function insertOrder(colId, clientY, selfId) {
  const rows = [...world.querySelectorAll(`[data-colbody="${colId}"] > .item`)].filter(r => r.dataset.id !== selfId);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

function startResize(e, it, el) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startW = it.w || el.offsetWidth;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    let w = startW + (ev.clientX - startX) / cam.scale;
    w = Math.max(120, Math.min(900, w));
    el.style.width = w + 'px'; it.w = Math.round(w);
  };
  const up = () => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    api.patch(it.id, { w: it.w });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (armed) {
    const w = screenToWorld(e.clientX, e.clientY);
    const t = armed; disarm();
    if (t === 'image') { pendingImageWorld = w; fileInput.click(); }
    else if (t === 'upload') { pendingUploadWorld = w; uploadInput.click(); }
    else createAt(t, w.x - defaultsFor(t).w / 2, w.y - 20);
    return;
  }
  deselect();
  pan = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
  stage.classList.add('panning');
  const move = (ev) => { cam.x = pan.cx + (ev.clientX - pan.sx); cam.y = pan.cy + (ev.clientY - pan.sy); applyCam(); };
  const up = () => { pan = null; stage.classList.remove('panning'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = stage.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const wx = (px - cam.x) / cam.scale, wy = (py - cam.y) / cam.scale;
    const factor = Math.exp(-e.deltaY * 0.0015);
    cam.scale = Math.max(0.2, Math.min(2.5, cam.scale * factor));
    cam.x = px - wx * cam.scale; cam.y = py - wy * cam.scale;
  } else {
    cam.x -= e.deltaX; cam.y -= e.deltaY;
  }
  applyCam();
}, { passive: false });

function zoomBy(factor) {
  const r = stage.getBoundingClientRect();
  const px = r.width / 2, py = r.height / 2;
  const wx = (px - cam.x) / cam.scale, wy = (py - cam.y) / cam.scale;
  cam.scale = Math.max(0.2, Math.min(2.5, cam.scale * factor));
  cam.x = px - wx * cam.scale; cam.y = py - wy * cam.scale; applyCam();
}
document.getElementById('zoomIn').onclick = () => zoomBy(1.2);
document.getElementById('zoomOut').onclick = () => zoomBy(1 / 1.2);
document.getElementById('zoomReset').onclick = () => { cam = { x: 80, y: 60, scale: 1 }; applyCam(); };
document.getElementById('exportBtn').onclick = () => toast('Tip: your boards auto-save to the server');

document.querySelectorAll('.tool').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    if (armed === t) { disarm(); return; }
    arm(t, btn);
  });
});
function arm(tool, btn) {
  disarm();
  armed = tool; stage.classList.add('armed');
  btn.classList.add('armed');
  toast('Click the canvas to place your ' + tool);
}
function disarm() {
  armed = null; stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed').forEach(b => b.classList.remove('armed'));
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; fileInput.value = '';
  if (!file) return;
  toast('Uploading image…');
  const res = await api.upload(file);
  if (res.error) { toast('Upload failed'); return; }
  const dim = await imageSize(res.src);
  const w = pendingImageWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const it = await api.create({
    canvasId: view.canvas.id, type: 'image',
    x: Math.round(w.x - 130), y: Math.round(w.y - 90), w: 260,
    data: { src: res.src, name: res.name, naturalW: dim.w, naturalH: dim.h }
  });
  view.items.push(it); render(); select(it.id); toast('Image added');
  pendingImageWorld = null;
});

uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files[0]; uploadInput.value = '';
  if (!file) return;
  toast('Uploading file…');
  const res = await api.upload(file);
  if (res.error) { toast('Upload failed'); return; }
  const w = pendingUploadWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const it = await api.create({
    canvasId: view.canvas.id, type: 'file',
    x: Math.round(w.x - 110), y: Math.round(w.y - 40), w: 220,
    data: { src: res.src, name: res.name, mime: res.mime || file.type }
  });
  view.items.push(it); render(); select(it.id); toast('File added');
  pendingUploadWorld = null;
});

function imageSize(src) { return new Promise(r => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => r({ w: 1, h: 1 }); i.src = src; }); }

document.addEventListener('keydown', (e) => {
  const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !document.activeElement.readOnly;
  if (e.key === 'Escape') { disarm(); deselect(); closePalette(); closeCtx(); }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(false); return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); copySelected(true); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === 'Enter' && selectedId && !mod) { e.preventDefault(); renameSelected(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteItem(selectedId); }
  const map = { n: 'note', l: 'link', t: 'todo', b: 'board', c: 'column', m: 'comment' };
  if (map[e.key.toLowerCase()] && !mod) {
    const btn = document.querySelector(`.tool[data-tool="${map[e.key.toLowerCase()]}"]`);
    if (btn) arm(map[e.key.toLowerCase()], btn);
  }
});

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#palette') && !e.target.closest('.swatch')) closePalette();
  if (!e.target.closest('#ctxmenu') && !e.target.closest('.item')) closeCtx();
  if (editingId && !e.target.closest('.item')) exitEdit();
}, true);

function rid() { return Math.random().toString(36).slice(2, 10); }
function normalizeUrl(u) { if (!u) return '#'; return /^https?:\/\//.test(u) ? u : 'https://' + u; }
let toastTimer;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200); }

(async function boot() {
  refreshIcons();
  const r = await api.root();
  rootCanvasId = r.rootCanvasId;
  const startId = location.hash.slice(1) || rootCanvasId;
  await openCanvas(startId);
})();

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && (!view.canvas || id !== view.canvas.id)) openCanvas(id);
});
