'use strict';

/* =========================================================================
   Canvas Board — front-end engine
   - infinite pan/zoom canvas
   - cards: note, to-do, link, image, board (nested), column (container)
   - drag to move, drag into/out of columns, resize, inline edit
   - everything persists to the Node backend
   ========================================================================= */

const COLORS = ['slate','gray','teal','green','brown','yellow','orange','red','pink','purple','blue','indigo'];
const colorVar = c => `var(--c-${COLORS.includes(c) ? c : 'slate'})`;

const ICONS = {
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>'
};

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

// ---- DOM refs ----
const stage = document.getElementById('stage');
const world = document.getElementById('world');
const crumbs = document.getElementById('crumbs');
const hint = document.getElementById('hint');
const palette = document.getElementById('palette');
const fileInput = document.getElementById('fileInput');
const zoomLvl = document.getElementById('zoomLvl');
const toastEl = document.getElementById('toast');

// ---- state ----
let rootCanvasId = null;
let view = { canvas: null, items: [], breadcrumb: [] };
let cam = { x: 80, y: 60, scale: 1 };
let armed = null;          // tool name awaiting a canvas click
let selectedId = null;
let editingId = null;
const elMap = new Map();   // itemId -> root element

// ===========================================================================
// transforms
// ===========================================================================
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

// ===========================================================================
// load + render a canvas
// ===========================================================================
async function openCanvas(id) {
  view = await api.canvas(id);
  if (view.error) { if (id !== rootCanvasId) return openCanvas(rootCanvasId); toast('Board not found'); return; }
  cam = loadCam(id);
  selectedId = null; editingId = null;
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
}

// ===========================================================================
// item element factory
// ===========================================================================
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

function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item type-' + it.type;
  el.dataset.id = it.id;
  if (it.id === selectedId) el.classList.add('selected');
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
  else if (it.type === 'board') buildBoard(el, it);
  else if (it.type === 'column') buildColumn(el, it);

  // selection toolbar
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
  delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  delBtn.title = 'Delete';
  delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(it.id); };
  tools.appendChild(colorBtn); tools.appendChild(delBtn);
  el.appendChild(tools);

  // resize handle (not for board / column-children)
  if (it.type !== 'board' && !it.parentItemId) {
    const rz = document.createElement('div'); rz.className = 'resize'; rz.setAttribute('data-nodrag', '');
    rz.addEventListener('pointerdown', (e) => startResize(e, it, el));
    el.appendChild(rz);
  }

  el.addEventListener('pointerdown', (e) => onItemPointerDown(e, it, el));
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
  add.innerHTML = '<span style="font-size:16px;line-height:0">+</span> Add item';
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

function buildBoard(el, it) {
  el.classList.add('board');
  const tile = document.createElement('div'); tile.className = 'tile';
  tile.style.background = colorVar(it.color || it._childColor || 'slate');
  tile.innerHTML = ICONS.board;
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

// ===========================================================================
// editing
// ===========================================================================
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

// ===========================================================================
// selection + palette
// ===========================================================================
function select(id) {
  if (selectedId === id) return;
  if (editingId && editingId !== id) exitEdit();
  if (selectedId && elMap.get(selectedId)) elMap.get(selectedId).classList.remove('selected');
  selectedId = id;
  if (id && elMap.get(id)) elMap.get(id).classList.add('selected');
  closePalette();
}
function deselect() { select(null); if (editingId) exitEdit(); }

function openPalette(it, anchor) {
  palette.innerHTML = '';
  COLORS.forEach(c => {
    const sw = document.createElement('div'); sw.className = 'sw' + ((it.color || it._childColor) === c ? ' sel' : '');
    sw.style.background = colorVar(c);
    sw.onclick = () => { it.color = c; if (it.type === 'board') it._childColor = c; api.patch(it.id, { color: c }); refreshItem(it); closePalette(); };
    palette.appendChild(sw);
  });
  const r = anchor.getBoundingClientRect();
  palette.style.left = Math.min(r.left, window.innerWidth - 210) + 'px';
  palette.style.top = (r.bottom + 8) + 'px';
  palette.classList.add('open');
}
function closePalette() { palette.classList.remove('open'); }

function refreshItem(it) {
  const old = elMap.get(it.id);
  if (!old) return;
  const fresh = renderItem(it);
  old.replaceWith(fresh);
  elMap.set(it.id, fresh);
}

// ===========================================================================
// persistence helpers
// ===========================================================================
const saveTimers = new Map();
function saveData(it, patch) {
  Object.assign(it.data, patch);
  if (it.type === 'board' && patch.title != null) it._childTitle = patch.title;
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
  render();
}

// ===========================================================================
// item creation
// ===========================================================================
function defaultsFor(type) {
  switch (type) {
    case 'note':   return { w: 240, data: { title: '', body: '' } };
    case 'todo':   return { w: 240, data: { title: 'To-do', tasks: [{ id: rid(), text: '', done: false }] } };
    case 'link':   return { w: 240, color: 'blue', data: { url: '', title: '' } };
    case 'column': return { w: 252, data: { title: 'Column' } };
    case 'board':  return { w: 152, data: { title: 'Untitled board' } };
    default:       return { w: 240, data: {} };
  }
}
async function createAt(type, wx, wy) {
  const d = defaultsFor(type);
  const body = Object.assign({ canvasId: view.canvas.id, type, x: Math.round(wx), y: Math.round(wy) }, d);
  const it = await api.create(body);
  view.items.push(it);
  render();
  select(it.id);
  if (type !== 'board' && type !== 'image') { const el = elMap.get(it.id); enterEdit(el); el.querySelector('[data-edit]')?.focus(); }
  hint.style.display = 'none';
}

// ===========================================================================
// pointer interactions: pan, drag, resize
// ===========================================================================
let drag = null;   // active item drag
let pan = null;    // active background pan

function onItemPointerDown(e, it, el) {
  if (e.button !== 0) return;
  if (armed) return;                                          // let the stage place the new item
  if (e.target.closest('[data-nodrag]')) { e.stopPropagation(); return; } // let controls work, don't let the stage deselect/pan
  if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return; // typing
  e.stopPropagation();
  select(it.id);

  const start = { sx: e.clientX, sy: e.clientY };
  const fromColumn = !!it.parentItemId;
  let moved = false;

  // figure out current world position of the element (handles column children too)
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
      // pop a column child out into the world so it can float
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
    // detect column drop targets under pointer
    highlightColumn(ev, it);
  };

  const up = (ev) => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    if (!moved) {                       // it was a click → maybe enter edit
      if (it.type !== 'board') maybeEdit(el, ev);
      drag = null; return;
    }
    finishDrag(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function maybeEdit(el, ev) {
  // a second click on an already-selected non-board card opens editing
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
  if (it.type === 'column') { drag.dropCol = null; return; } // columns can't nest in columns
  const body = columnBodyUnder(ev.clientX, ev.clientY, it.id);
  drag.dropCol = body ? body.dataset.colbody : null;
  if (body) body.closest('.column').classList.add('drop-target');
}

async function finishDrag(ev) {
  const { it, el } = drag;
  world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));

  if (drag.dropCol) {
    // dropping into a column
    const kids = childrenOf(drag.dropCol).filter(k => k.id !== it.id);
    const order = insertOrder(drag.dropCol, ev.clientY, it.id);
    it.parentItemId = drag.dropCol;
    it.y = order;
    // renumber siblings
    const sibs = view.items.filter(k => k.parentItemId === drag.dropCol).sort((a, b) => a.y - b.y);
    sibs.forEach((s, i) => s.y = i);
    await api.patch(it.id, { parentItemId: it.parentItemId, canvasId: view.canvas.id });
    await api.patchMany(sibs.map(s => ({ id: s.id, y: s.y })));
    render();
  } else {
    // free placement
    const wx = Math.round(parseFloat(el.style.left));
    const wy = Math.round(parseFloat(el.style.top));
    const wasChild = drag.fromColumn;
    it.x = wx; it.y = wy; it.parentItemId = null;
    await api.patch(it.id, { x: wx, y: wy, parentItemId: null });
    if (wasChild) render();   // reflow the column it left
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

// resize (width; images keep aspect)
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

// ===========================================================================
// stage: pan / zoom / placement / deselect
// ===========================================================================
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  // placement of an armed tool
  if (armed) {
    const w = screenToWorld(e.clientX, e.clientY);
    const t = armed; disarm();
    if (t === 'image') { pendingImageWorld = w; fileInput.click(); }
    else createAt(t, w.x - defaultsFor(t).w / 2, w.y - 20);
    return;
  }
  // begin panning
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

// ===========================================================================
// toolbar
// ===========================================================================
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

// image upload
let pendingImageWorld = null;
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
function imageSize(src) { return new Promise(r => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => r({ w: 1, h: 1 }); i.src = src; }); }

// ===========================================================================
// keyboard
// ===========================================================================
document.addEventListener('keydown', (e) => {
  const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !document.activeElement.readOnly;
  if (e.key === 'Escape') { disarm(); deselect(); closePalette(); }
  if (typing) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteItem(selectedId); }
  const map = { n: 'note', l: 'link', t: 'todo', b: 'board', c: 'column' };
  if (map[e.key.toLowerCase()]) {
    const btn = document.querySelector(`.tool[data-tool="${map[e.key.toLowerCase()]}"]`);
    if (btn) arm(map[e.key.toLowerCase()], btn);
  }
});

// click anywhere outside cards/palette closes palette + edit
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#palette') && !e.target.closest('.swatch')) closePalette();
  if (editingId && !e.target.closest('.item')) exitEdit();
}, true);

// ===========================================================================
// utils + boot
// ===========================================================================
function rid() { return Math.random().toString(36).slice(2, 10); }
function normalizeUrl(u) { if (!u) return '#'; return /^https?:\/\//.test(u) ? u : 'https://' + u; }
let toastTimer;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200); }

(async function boot() {
  const r = await api.root();
  rootCanvasId = r.rootCanvasId;
  const startId = location.hash.slice(1) || rootCanvasId;
  await openCanvas(startId);
})();

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && (!view.canvas || id !== view.canvas.id)) openCanvas(id);
});
