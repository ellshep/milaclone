'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { autoGrow, colorVar, lucideEl, refreshIcons, toast, rid } from './util.js';
import { screenToWorld } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { openCanvas } from './main.js';

/* =========================================================================
   Quick notes — the mobile task workspace layered over the canvas.

   A three-level stack (overview → list → task) plus a modal search layer,
   all living inside #quicknotes. Every `todo` card on the board is a list
   here and its `data.tasks` entries are the tasks, so edits made here land
   on the same card the canvas renders. Tasks carry a few extra fields the
   canvas ignores (starred, due, tags, note); they are only written when the
   user actually edits something, so existing cards stay untouched.

   Static chrome lives in index.html; this module fills the [id] regions and
   owns navigation, so the fields that hold a caret (list title, new-task
   input, note) survive a re-render.
   ========================================================================= */

const el = id => document.getElementById(id);
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const SMART = {
  today:     { label: 'Today',     color: '#4C7CBE', icon: 'calendar', f: t => t.due && daysUntil(t.due) === 0 && !t.done },
  starred:   { label: 'Starred',   color: '#E8B94A', icon: 'star',     f: t => t.starred && !t.done },
  all:       { label: 'All',       color: '#3D4A5C', icon: 'inbox',    f: t => !t.done },
  completed: { label: 'Completed', color: '#6E8B74', icon: 'check',    f: t => t.done }
};
const SMART_KEYS = ['today', 'starred', 'all', 'completed'];

// Lists without a card colour of their own cycle through these, and pick up a
// matching line icon, so the overview reads as a set rather than a grey wall.
const LIST_COLORS = ['#4C7CBE', '#6E8B74', '#B0724F', '#8A6FA8'];
const LIST_ICONS = ['moon', 'sun', 'lightbulb', 'leaf'];

const FMT_BUTTONS = [
  { key: 'bullet', title: 'Bullet list', icon: 'list' },
  { key: 'number', title: 'Numbered list', icon: 'list-ordered' },
  { key: 'b', title: 'Bold', glyph: 'B', cls: 'qn-fmt-b' },
  { key: 'i', title: 'Italic', glyph: 'I', cls: 'qn-fmt-i' },
  { key: 'u', title: 'Underline', glyph: 'U', cls: 'qn-fmt-u' }
];

const SETTINGS_KEY = 'quicknotes.settings';

const qn = {
  open: false,
  desk: false,             // desktop phone popover (vs mobile fullscreen)
  loaded: false,
  screen: 'home',          // 'home' | 'list' | 'task'
  listId: null,            // a todo item id, or 'smart:<key>'
  taskRef: null,           // { listId, taskId }
  lists: [],
  rootCanvasId: null,
  homeTag: null,
  searchOpen: false,
  query: '',
  searchTag: null,
  compOpen: true,
  adding: false,
  dirty: false,            // something changed → refresh the canvas on close
  settings: loadSettings()
};

function loadSettings() {
  const def = { tiles: true, chips: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch { return def; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(qn.settings)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// Tasks gain their Quick-notes fields on read; blank rows (the canvas editor's
// "type here" placeholders) are never surfaced as tasks.
function normTask(t) {
  return {
    id: t.id || rid(),
    text: typeof t.text === 'string' ? t.text : '',
    done: !!t.done,
    starred: !!t.starred,
    due: t.due || null,
    tags: Array.isArray(t.tags) ? t.tags.slice() : [],
    note: typeof t.note === 'string' ? t.note : '',
    noteStyle: t.noteStyle && typeof t.noteStyle === 'object' ? t.noteStyle : {},
    createdAt: t.createdAt || null
  };
}

async function load() {
  const r = await api.todos();
  qn.rootCanvasId = r.rootCanvasId;
  if (savePending.size) return;   // a local edit is still in flight — keep ours
  qn.lists = (r.lists || []).map(l => ({
    id: l.id,
    canvasId: l.canvasId,
    canvasTitle: l.canvasTitle,
    title: l.title || 'To-do',
    color: l.color || null,
    tags: Array.isArray(l.tags) ? l.tags : [],
    tasks: (l.tasks || []).map(normTask),
    baseTasks: l.tasks || [],       // as the server has it; sent with edits so they merge
    createdAt: l.createdAt
  }));
  qn.loaded = true;
  updateBadge();
  render();
}

const saveTimers = new Map();
const savePending = new Map();
function save(list, body) {
  qn.dirty = true;
  clearTimeout(saveTimers.get(list.id));
  savePending.set(list.id, Object.assign(savePending.get(list.id) || {}, body));
  saveTimers.set(list.id, setTimeout(() => flushSaves(list.id), 200));
}

// Writes are debounced while typing; anything still queued goes out as soon as
// the user closes a sheet or leaves Quick notes, so nothing is lost.
function flushSaves(only, keepalive = false) {
  const sent = [];
  for (const [id, body] of savePending) {
    if (only && id !== only) continue;
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    savePending.delete(id);
    const list = listById(id);
    const req = { data: body };
    if (body.tasks && list) req.baseTasks = list.baseTasks || [];
    sent.push(api.patch(id, req, keepalive).then(saved => adoptMerged(list, saved)));
  }
  return sent;
}

// The server merges task edits with changes made elsewhere (the canvas card,
// another device); take its result as the new base and show it if it differs.
function adoptMerged(list, saved) {
  if (!saved || !list || !Array.isArray(saved.data.tasks)) return;
  list.baseTasks = saved.data.tasks;
  const merged = saved.data.tasks.map(normTask);
  if (savePending.has(list.id) || JSON.stringify(merged) === JSON.stringify(list.tasks)) return;
  list.tasks = merged;
  render();
}
// Queued edits go out before the tab closes or the phone backgrounds the app.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(null, true); });
window.addEventListener('pagehide', () => flushSaves(null, true));
const saveTasks = list => save(list, { tasks: list.tasks });
const saveMeta = list => save(list, { title: list.title, tags: list.tags });

const listById = id => qn.lists.find(l => l.id === id) || null;
const tasksOf = list => list.tasks.filter(t => t.text.trim());
const openCount = list => tasksOf(list).filter(t => !t.done).length;

// Smart views are computed filters over every list, so their rows carry the
// list they came from for the sub-line and for writes.
function smartPairs(key) {
  const f = SMART[key].f;
  const out = [];
  for (const list of qn.lists) for (const task of tasksOf(list)) if (f(task)) out.push({ list, task });
  return out;
}

function allTags() {
  const seen = new Set();
  for (const list of qn.lists) {
    for (const tag of list.tags) seen.add(tag);
    for (const task of list.tasks) for (const tag of task.tags) seen.add(tag);
  }
  return [...seen].sort();
}

function findTask(ref) {
  if (!ref) return null;
  const list = listById(ref.listId);
  if (!list) return null;
  const task = list.tasks.find(t => t.id === ref.taskId);
  return task ? { list, task } : null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const DAY = 86400000;
const parseISO = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
function daysUntil(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  const now = new Date();
  return Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY);
}
function relDays(n) {
  if (n === 0) return 'due today';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(n);
  if (abs < 7) return rtf.format(n, 'day');
  if (abs < 30) return rtf.format(Math.round(n / 7), 'week');
  return rtf.format(Math.round(n / 30), 'month');
}
function dueInfo(iso) {
  const n = daysUntil(iso);
  if (n === null) return null;
  const short = parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const near = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : null;
  return {
    label: near || short,
    full: near || 'Due ' + short,
    sub: relDays(n),
    color: n <= 0 ? 'var(--qn-due)' : 'var(--qn-muted)'
  };
}
function agoLabel(ms) {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return rtf.format(-Math.max(mins, 0), 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  return rtf.format(-Math.round(days / 30), 'month');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
export function isQuickNotesOpen() { return qn.open; }

function placeDeskPanel() {
  const btn = el('phoneNotes');
  const panel = el('quicknotes');
  if (!btn || !panel) return;
  const r = btn.getBoundingClientRect();
  const w = 360;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
  panel.style.left = left + 'px';
  panel.style.top = (r.bottom + 10) + 'px';
}

function syncPhoneBtn() {
  const btn = el('phoneNotes');
  if (!btn) return;
  btn.setAttribute('aria-expanded', qn.open && qn.desk ? 'true' : 'false');
}

function updateBadge() {
  const badge = el('phoneNotesBadge');
  if (!badge) return;
  const n = qn.lists.length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

async function refreshBadge() {
  if (qn.loaded) { updateBadge(); return; }
  try {
    const r = await api.todos();
    const badge = el('phoneNotesBadge');
    if (!badge) return;
    const n = (r.lists || []).length;
    badge.textContent = String(n);
    badge.hidden = n === 0;
  } catch { /* badge is decorative */ }
}

export function openQuickNotes(opts) {
  qn.open = true;
  qn.desk = !!(opts && opts.desk);
  qn.screen = 'home';
  el('quicknotes').hidden = false;
  const head = el('qnDeskHead');
  if (head) head.hidden = !qn.desk;
  document.body.classList.add('qn-open');
  document.body.classList.toggle('qn-desk', qn.desk);
  if (qn.desk) placeDeskPanel();
  syncPhoneBtn();
  render();                                        // paint the cached lists…
  load().catch(() => { if (!qn.loaded) toast('Could not load your lists'); });   // …then refresh
}

export function closeQuickNotes() {
  const sent = flushSaves();
  qn.open = false;
  qn.desk = false;
  qn.searchOpen = false;
  hideSheet();
  el('quicknotes').hidden = true;
  const head = el('qnDeskHead');
  if (head) head.hidden = true;
  document.body.classList.remove('qn-open', 'qn-desk');
  el('quicknotes').style.left = '';
  el('quicknotes').style.top = '';
  syncPhoneBtn();
  updateBadge();
  // edits here change cards on the board, so pull the open canvas back in sync
  // once the last write has actually landed
  if (qn.dirty && state.view.canvas) {
    const id = state.view.canvas.id;
    qn.dirty = false;
    Promise.all(sent).then(() => openCanvas(id));
  }
}

export function togglePhoneNotes() {
  if (qn.open && qn.desk) closeQuickNotes();
  else openQuickNotes({ desk: true });
}

function goHome() { qn.screen = 'home'; qn.adding = false; render(); }
function openList(id, opts) {
  qn.listId = id;
  qn.screen = 'list';
  qn.adding = false;
  qn.compOpen = true;
  render();
  if (opts && opts.rename) {
    const title = el('qnListTitle');
    title.focus();
    document.getSelection().selectAllChildren(title);
  }
}
function openTask(list, task) {
  qn.taskRef = { listId: list.id, taskId: task.id };
  qn.screen = 'task';
  render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  if (!qn.open) return;
  renderHome();
  renderListScreen();
  renderTaskScreen();
  renderSearch();
  applyStack();
  refreshIcons();
}

function applyStack() {
  const level = qn.screen === 'home' ? 0 : qn.screen === 'list' ? 1 : 2;
  el('qnHome').style.transform = level > 0 ? 'translateX(-30%)' : 'translateX(0)';
  el('qnList').style.transform = level === 0 ? 'translateX(100%)' : level === 1 ? 'translateX(0)' : 'translateX(-30%)';
  el('qnTask').style.transform = level === 2 ? 'translateX(0)' : 'translateX(100%)';
  el('qnSearch').style.transform = qn.searchOpen ? 'translateY(0)' : 'translateY(100%)';
}

// ---- overview --------------------------------------------------------------
function renderHome() {
  const tiles = el('qnTiles');
  tiles.hidden = !qn.settings.tiles;
  tiles.innerHTML = '';
  if (qn.settings.tiles) {
    for (const key of SMART_KEYS) {
      const def = SMART[key];
      const tile = h('button', 'qn-tile');
      tile.dataset.smart = key;
      const top = h('div', 'qn-tile-top');
      const circle = h('span', 'qn-circle');
      circle.style.background = def.color;
      circle.appendChild(lucideEl(def.icon));
      top.appendChild(circle);
      top.appendChild(h('span', 'qn-tile-count', String(smartPairs(key).length)));
      tile.appendChild(top);
      tile.appendChild(h('span', 'qn-tile-label', def.label));
      tile.onclick = () => openList('smart:' + key);
      tiles.appendChild(tile);
    }
  }

  const chips = el('qnHomeChips');
  chips.hidden = !qn.settings.chips;
  chips.innerHTML = '';
  if (qn.settings.chips) {
    buildChips(chips, qn.homeTag, tag => { qn.homeTag = tag; renderHome(); refreshIcons(); });
  }

  const rows = el('qnLists');
  rows.innerHTML = '';
  const shown = qn.lists.filter(l => !qn.homeTag || l.tags.includes(qn.homeTag));
  if (!shown.length) {
    rows.appendChild(h('div', 'qn-empty', qn.lists.length
      ? 'No lists carry that tag.'
      : 'No todo lists yet. Tap + to make one.'));
    return;
  }
  shown.forEach((list) => {
    const i = qn.lists.indexOf(list);
    const row = h('button', 'qn-row-btn');
    row.dataset.list = list.id;
    const circle = h('span', 'qn-circle');
    circle.style.background = list.color ? colorVar(list.color) : LIST_COLORS[i % LIST_COLORS.length];
    circle.appendChild(lucideEl(LIST_ICONS[i % LIST_ICONS.length]));
    row.appendChild(circle);
    row.appendChild(h('span', 'qn-row-name', list.title));
    row.appendChild(h('span', 'qn-row-count', String(openCount(list))));
    const chev = h('span', 'qn-chev');
    chev.appendChild(lucideEl('chevron-right'));
    row.appendChild(chev);
    row.onclick = () => openList(list.id);
    rows.appendChild(row);
  });
}

function buildChips(parent, active, onPick) {
  const tags = [null].concat(allTags());
  for (const tag of tags) {
    const chip = h('button', 'qn-chip' + ((active || null) === tag ? ' on' : ''), tag ? '#' + tag : 'All');
    chip.onclick = () => onPick(tag);
    parent.appendChild(chip);
  }
}

// ---- list detail -----------------------------------------------------------
function activeList() {
  return String(qn.listId || '').startsWith('smart:') ? null : listById(qn.listId);
}
function activeTitle() {
  const key = String(qn.listId || '').startsWith('smart:') ? qn.listId.slice(6) : null;
  if (key) return (SMART[key] || {}).label || 'Quick notes';
  const list = activeList();
  return list ? list.title : '';
}

function renderListScreen() {
  const smartKey = String(qn.listId || '').startsWith('smart:') ? qn.listId.slice(6) : null;
  const list = activeList();
  const title = el('qnListTitle');
  const meta = el('qnListMeta');
  const tasksEl = el('qnTasks');

  title.contentEditable = smartKey ? 'false' : 'true';
  if (document.activeElement !== title) title.textContent = activeTitle();
  meta.innerHTML = '';
  tasksEl.innerHTML = '';

  if (smartKey) {
    const pairs = smartPairs(smartKey);
    meta.appendChild(h('span', null, pairs.length + (pairs.length === 1 ? ' task' : ' tasks')));
    for (const p of pairs) tasksEl.appendChild(taskRow(p.list, p.task, p.list.title));
    if (!pairs.length) tasksEl.appendChild(h('div', 'qn-empty', 'Nothing here right now.'));
    el('qnAddBar').hidden = true;
    return;
  }

  if (!list) { el('qnAddBar').hidden = true; return; }

  const all = tasksOf(list);
  const open = all.filter(t => !t.done);
  const done = all.filter(t => t.done);
  meta.appendChild(h('span', null, done.length + ' of ' + all.length));
  for (const tag of list.tags) meta.appendChild(h('span', 'qn-tag', '#' + tag));

  for (const task of open) tasksEl.appendChild(taskRow(list, task));
  if (!all.length) tasksEl.appendChild(h('div', 'qn-empty', 'No tasks yet — add the first one below.'));

  if (done.length) {
    const head = h('button', 'qn-comphead' + (qn.compOpen ? '' : ' closed'));
    head.appendChild(h('span', null, 'Completed · ' + done.length));
    head.appendChild(lucideEl('chevron-down'));
    head.onclick = () => { qn.compOpen = !qn.compOpen; renderListScreen(); refreshIcons(); };
    tasksEl.appendChild(head);
    if (qn.compOpen) for (const task of done) tasksEl.appendChild(taskRow(list, task));
  }

  el('qnAddBar').hidden = false;
  el('qnAddTask').hidden = qn.adding;
  el('qnAddField').hidden = !qn.adding;
}

// One row anatomy for list detail, smart views and search results.
function taskRow(list, task, sub) {
  const row = h('div', 'qn-task' + (task.done ? ' done' : ''));
  row.dataset.task = task.id;

  const box = h('button', 'qn-box' + (task.done ? ' on' : ''));
  box.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
  box.appendChild(lucideEl('check'));
  box.onclick = e => { e.stopPropagation(); task.done = !task.done; saveTasks(list); render(); };

  const mid = h('div', 'qn-task-mid');
  mid.appendChild(h('span', 'qn-task-text', task.text));
  if (sub) mid.appendChild(h('span', 'qn-task-sub', sub));
  const due = dueInfo(task.due);
  if (due && !task.done) {
    const line = h('span', 'qn-task-due');
    line.style.color = due.color;
    line.appendChild(lucideEl('calendar'));
    line.appendChild(h('span', null, due.label));
    mid.appendChild(line);
  }

  const star = h('button', 'qn-star' + (task.starred ? ' on' : ''));
  star.setAttribute('aria-label', task.starred ? 'Remove star' : 'Star task');
  star.appendChild(lucideEl('star'));
  star.onclick = e => { e.stopPropagation(); task.starred = !task.starred; saveTasks(list); render(); };

  row.append(box, mid, star);
  row.onclick = () => openTask(list, task);
  return row;
}

// ---- task detail -----------------------------------------------------------
function renderTaskScreen() {
  const found = findTask(qn.taskRef);
  if (!found) return;
  const { list, task } = found;

  el('qnTaskBackLabel').textContent = activeTitle() || list.title;
  el('qnTaskBox').classList.toggle('on', task.done);
  el('qnTaskStar').classList.toggle('on', task.starred);

  const title = el('qnTaskTitle');
  title.classList.toggle('done', task.done);
  if (document.activeElement !== title) title.textContent = task.text;

  // details card: due row + tags row
  const details = el('qnDetails');
  details.innerHTML = '';
  const due = dueInfo(task.due);
  const dueRow = h('div', 'qn-row' + (due ? '' : ' empty'));
  dueRow.appendChild(lucideEl('calendar'));
  if (due) {
    const mid = h('div', 'qn-row-mid');
    mid.appendChild(h('span', 'qn-due-label', due.full));
    mid.appendChild(h('span', 'qn-due-sub', due.sub));
    dueRow.appendChild(mid);
  } else {
    dueRow.appendChild(h('span', 'qn-due-add', 'Add due date'));
  }
  const picker = document.createElement('input');
  picker.type = 'date';
  picker.className = 'qn-dateinput';
  picker.value = task.due || '';
  picker.setAttribute('aria-label', 'Due date');
  picker.onchange = () => { task.due = picker.value || null; saveTasks(list); render(); };
  dueRow.appendChild(picker);
  if (due) {
    const clear = h('button', 'qn-x');
    clear.setAttribute('aria-label', 'Clear due date');
    clear.appendChild(lucideEl('x'));
    clear.onclick = e => {
      e.stopPropagation();
      task.due = null; saveTasks(list); render(); toast('Due date removed');
    };
    dueRow.appendChild(clear);
  }
  details.appendChild(dueRow);

  const tagRow = h('div', 'qn-row');
  tagRow.appendChild(lucideEl('tag'));
  const tagList = h('div', 'qn-taglist');
  for (const tag of task.tags) tagList.appendChild(h('span', 'qn-tag', '#' + tag));
  const addTag = h('button', 'qn-addtag', '+ Add tag');
  addTag.onclick = () => showTagSheet(list, task);
  tagList.appendChild(addTag);
  tagRow.appendChild(tagList);
  details.appendChild(tagRow);

  // note card
  const fmt = el('qnFmt');
  fmt.innerHTML = '';
  for (const b of FMT_BUTTONS) {
    const btn = h('button', (b.cls || '') + (task.noteStyle[b.key] ? ' on' : ''), b.glyph || null);
    btn.title = b.title;
    btn.setAttribute('aria-label', b.title);
    btn.dataset.fmt = b.key;
    if (b.icon) btn.appendChild(lucideEl(b.icon));
    btn.onclick = () => applyFormat(list, task, b.key);
    fmt.appendChild(btn);
  }
  const note = el('qnNote');
  if (document.activeElement !== note) note.value = task.note;
  requestAnimationFrame(() => autoGrow(note));
  note.style.fontWeight = task.noteStyle.b ? '700' : '400';
  note.style.fontStyle = task.noteStyle.i ? 'italic' : 'normal';
  note.style.textDecoration = task.noteStyle.u ? 'underline' : 'none';

  el('qnCreated').textContent = task.createdAt || list.createdAt
    ? 'Created ' + agoLabel(task.createdAt || list.createdAt)
    : '';
}

// Bullets/numbers rewrite the note's lines; B/I/U style the whole note and are
// stored with the task so the styling survives a reload.
function applyFormat(list, task, key) {
  if (key === 'bullet' || key === 'number') {
    task.note = toggleListPrefix(el('qnNote').value, key);
  } else {
    task.noteStyle = Object.assign({}, task.noteStyle, { [key]: !task.noteStyle[key] });
  }
  saveTasks(list);
  el('qnNote').value = task.note;
  autoGrow(el('qnNote'));
  renderTaskScreen();
  refreshIcons();
}

function toggleListPrefix(note, kind) {
  const lines = (note || '').split('\n');
  const isBul = l => l.startsWith('• ');
  const isNum = l => /^\d+\. /.test(l);
  const strip = l => l.replace(/^• /, '').replace(/^\d+\. /, '');
  const marked = lines.every(l => !l.trim() || (kind === 'bullet' ? isBul(l) : isNum(l)));
  if (marked && lines.some(l => l.trim())) return lines.map(strip).join('\n');
  let n = 0;
  return lines.map(l => !l.trim() ? l : (kind === 'bullet' ? '• ' + strip(l) : (++n) + '. ' + strip(l))).join('\n');
}

// ---- search ----------------------------------------------------------------
function searchResults() {
  const q = qn.query.trim().toLowerCase();
  if (!q && !qn.searchTag) return [];
  const out = [];
  for (const list of qn.lists) {
    for (const task of tasksOf(list)) {
      const textHit = !q || task.text.toLowerCase().includes(q) || task.note.toLowerCase().includes(q);
      const tagHit = !qn.searchTag || task.tags.includes(qn.searchTag) || list.tags.includes(qn.searchTag);
      if (textHit && tagHit) out.push({ list, task });
    }
  }
  return out;
}

function renderSearch() {
  const chips = el('qnSearchChips');
  chips.innerHTML = '';
  buildChips(chips, qn.searchTag, tag => { qn.searchTag = tag; renderSearch(); refreshIcons(); });

  const results = el('qnResults');
  results.innerHTML = '';
  el('qnQueryClear').hidden = !qn.query.length;
  if (document.activeElement !== el('qnQuery')) el('qnQuery').value = qn.query;

  if (!qn.query.trim() && !qn.searchTag) {
    const blank = h('div', 'qn-blank');
    blank.appendChild(lucideEl('search'));
    blank.appendChild(h('span', 'qn-blank-2', 'Type to search, or pick a tag to see everything filed under it.'));
    results.appendChild(blank);
    return;
  }
  const found = searchResults();
  if (!found.length) {
    const blank = h('div', 'qn-blank');
    blank.appendChild(h('span', 'qn-blank-1', 'No matching tasks'));
    blank.appendChild(h('span', 'qn-blank-2', 'Try a different word or tag.'));
    results.appendChild(blank);
    return;
  }
  results.appendChild(h('span', 'qn-count', found.length + (found.length === 1 ? ' result' : ' results')));
  for (const p of found) {
    const row = taskRow(p.list, p.task, p.list.title);
    row.onclick = () => { closeSearch(); qn.listId = p.list.id; openTask(p.list, p.task); };
    results.appendChild(row);
  }
}

function openSearch() {
  qn.searchOpen = true;
  applyStack();
  renderSearch();
  refreshIcons();
  setTimeout(() => el('qnQuery').focus(), 60);
}
function closeSearch() {
  qn.searchOpen = false;
  qn.query = '';
  qn.searchTag = null;
  el('qnQuery').value = '';
  el('qnQuery').blur();
  renderSearch();
  applyStack();
}

// ---- bottom sheet ----------------------------------------------------------
let sheetBuilder = null;

function showSheet(builder) {
  sheetBuilder = builder;
  drawSheet();
  el('qnSheet').classList.add('open');
  el('qnDim').classList.add('open');
}
function drawSheet() {
  const body = el('qnSheetBody');
  body.innerHTML = '';
  if (sheetBuilder) sheetBuilder(body);
  refreshIcons();
}
function hideSheet() {
  flushSaves();
  sheetBuilder = null;
  el('qnSheet').classList.remove('open');
  el('qnDim').classList.remove('open');
}
function sheetRow(parent, opt) {
  const row = h('button', 'qn-sheet-row' + (opt.cls ? ' ' + opt.cls : ''));
  if (opt.icon) row.appendChild(lucideEl(opt.icon));
  row.appendChild(h('span', 'qn-sheet-label', opt.label));
  if (opt.state) row.appendChild(h('span', 'qn-sheet-state', opt.state));
  row.onclick = opt.onClick;
  parent.appendChild(row);
  return row;
}

function showAddSheet() {
  showSheet(body => {
    sheetRow(body, {
      icon: 'file-text', label: 'Note',
      onClick: () => { hideSheet(); addNoteToBoard(); }
    });
    sheetRow(body, {
      icon: 'square-check-big', label: 'Todo list',
      onClick: () => { hideSheet(); createList(); }
    });
  });
}

function showSettingsSheet() {
  showSheet(body => {
    sheetRow(body, {
      icon: 'layout-grid', label: 'Smart views', state: qn.settings.tiles ? 'On' : 'Off',
      cls: qn.settings.tiles ? 'on' : '',
      onClick: () => { qn.settings.tiles = !qn.settings.tiles; saveSettings(); renderHome(); drawSheet(); refreshIcons(); }
    });
    sheetRow(body, {
      icon: 'tag', label: 'Tag filters', state: qn.settings.chips ? 'On' : 'Off',
      cls: qn.settings.chips ? 'on' : '',
      onClick: () => {
        qn.settings.chips = !qn.settings.chips;
        if (!qn.settings.chips) qn.homeTag = null;
        saveSettings(); renderHome(); drawSheet(); refreshIcons();
      }
    });
  });
}

function showListSheet() {
  const list = activeList();
  if (!list) { showSettingsSheet(); return; }
  showSheet(body => {
    sheetRow(body, {
      icon: 'pencil', label: 'Rename list',
      onClick: () => {
        hideSheet();
        const title = el('qnListTitle');
        title.focus();
        document.getSelection().selectAllChildren(title);
      }
    });
    sheetRow(body, {
      icon: 'layout-grid', label: 'Show on board',
      onClick: () => { hideSheet(); closeQuickNotes(); openCanvas(list.canvasId); }
    });
    sheetRow(body, {
      icon: 'trash-2', label: 'Delete list', cls: 'danger',
      onClick: () => { hideSheet(); deleteList(list); }
    });
  });
}

// Tag picker: every tag already in use, plus a field for a new one.
function showTagSheet(list, task) {
  showSheet(body => {
    const known = allTags();
    for (const tag of known) {
      const on = task.tags.includes(tag);
      sheetRow(body, {
        icon: on ? 'check' : 'tag', label: '#' + tag, cls: on ? 'on' : '',
        onClick: () => { toggleTag(list, task, tag); drawSheet(); }
      });
    }
    const field = h('div', 'qn-sheet-field');
    const input = document.createElement('input');
    input.placeholder = known.length ? 'New tag' : 'First tag';
    input.setAttribute('aria-label', 'New tag');
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const tag = input.value.trim().replace(/^#/, '').toLowerCase();
      if (!tag) return;
      if (!task.tags.includes(tag)) toggleTag(list, task, tag);
      input.value = '';
      drawSheet();
    };
    field.appendChild(input);
    body.appendChild(field);
    setTimeout(() => { if (!known.length) input.focus(); }, 60);
  });
}
function toggleTag(list, task, tag) {
  task.tags = task.tags.includes(tag) ? task.tags.filter(t => t !== tag) : task.tags.concat([tag]);
  saveTasks(list);
  renderTaskScreen();
  refreshIcons();
}

// ---- creating + deleting ---------------------------------------------------

// The + sheet's "Note" option keeps the old Quick-notes tab behaviour: drop a
// note on the board the user was last looking at.
function addNoteToBoard() {
  closeQuickNotes();
  const w = screenToWorld(window.innerWidth / 2, window.innerHeight / 2 - 80);
  createAt('note', w.x - defaultsFor('note').w / 2, w.y);
}

// New lists are real todo cards on the root board, placed under whatever is
// already there so they don't land on top of an existing card.
async function createList() {
  const rootId = qn.rootCanvasId || state.rootCanvasId;
  if (!rootId) { toast('Could not reach your board'); return; }
  let y = 60;
  try {
    const root = await api.canvas(rootId);
    for (const it of root.items || []) {
      if (it.parentItemId) continue;
      y = Math.max(y, (it.y || 0) + (it.h || 200) + 24);
    }
  } catch { /* fall back to the default slot */ }

  const created = await api.create({
    canvasId: rootId, type: 'todo', x: 60, y,
    w: defaultsFor('todo').w,
    data: { title: 'New list', tasks: [] }
  });
  qn.dirty = true;
  qn.lists.push({
    id: created.id, canvasId: rootId, canvasTitle: '',
    title: 'New list', color: created.color || null, tags: [], tasks: [], createdAt: created.createdAt
  });
  openList(created.id, { rename: true });
}

async function deleteList(list) {
  qn.lists = qn.lists.filter(l => l.id !== list.id);
  qn.dirty = true;
  goHome();
  flushSaves(list.id);
  try { await api.remove(list.id); } catch { toast('Could not delete the list'); return; }
  toast('List deleted', { label: 'Undo', fn: async () => { if (await api.restore(list.id)) { qn.dirty = true; await load(); } } });
}

function addTask(list, text) {
  const task = normTask({ id: rid(), text, createdAt: Date.now() });
  list.tasks.push(task);
  saveTasks(list);
  renderListScreen();
  renderHome();
  refreshIcons();
}

function deleteTask(list, task) {
  list.tasks = list.tasks.filter(t => t !== task);
  saveTasks(list);
  qn.taskRef = null;
  qn.screen = 'list';
  render();
  toast('Task deleted');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
export function initQuickNotes() {
  const phone = el('phoneNotes');
  if (phone) phone.onclick = togglePhoneNotes;
  refreshBadge();

  el('qnSearchBtn').onclick = openSearch;
  el('qnHomeMenu').onclick = showSettingsSheet;
  el('qnBarMenu').onclick = showSettingsSheet;
  el('qnBoards').onclick = closeQuickNotes;
  el('qnAdd').onclick = showAddSheet;
  el('qnDim').onclick = hideSheet;

  el('qnListBack').onclick = goHome;
  el('qnListMenu').onclick = showListSheet;

  const title = el('qnListTitle');
  title.addEventListener('input', () => {
    const list = activeList();
    if (!list) return;
    list.title = title.textContent.trim();
    saveMeta(list);
    renderHome();
    refreshIcons();
  });
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
  });

  el('qnAddTask').onclick = () => {
    qn.adding = true;
    renderListScreen();
    refreshIcons();
    el('qnNewTask').value = '';
    el('qnNewTask').focus();
  };
  el('qnAddCancel').onclick = () => { qn.adding = false; el('qnNewTask').value = ''; renderListScreen(); refreshIcons(); };
  el('qnNewTask').addEventListener('keydown', e => {
    const input = el('qnNewTask');
    if (e.key === 'Escape') { qn.adding = false; input.value = ''; renderListScreen(); refreshIcons(); return; }
    if (e.key !== 'Enter') return;
    const list = activeList();
    const text = input.value.trim();
    if (!list || !text) return;
    addTask(list, text);
    input.value = '';
    input.focus();                       // stays open for the next one
  });

  el('qnTaskBack').onclick = () => { qn.screen = 'list'; render(); };
  el('qnTaskBox').onclick = () => {
    const f = findTask(qn.taskRef); if (!f) return;
    f.task.done = !f.task.done; saveTasks(f.list); render();
  };
  el('qnTaskStar').onclick = () => {
    const f = findTask(qn.taskRef); if (!f) return;
    f.task.starred = !f.task.starred; saveTasks(f.list); render();
  };
  const taskTitle = el('qnTaskTitle');
  taskTitle.addEventListener('input', () => {
    const f = findTask(qn.taskRef); if (!f) return;
    f.task.text = taskTitle.textContent.trim();
    saveTasks(f.list);
  });
  taskTitle.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); taskTitle.blur(); } });
  el('qnNote').addEventListener('input', () => {
    autoGrow(el('qnNote'));
    const f = findTask(qn.taskRef); if (!f) return;
    f.task.note = el('qnNote').value;
    saveTasks(f.list);
  });
  el('qnDelTask').onclick = () => {
    const f = findTask(qn.taskRef); if (!f) return;
    deleteTask(f.list, f.task);
  };

  el('qnSearchCancel').onclick = closeSearch;
  el('qnQueryClear').onclick = () => { qn.query = ''; el('qnQuery').value = ''; renderSearch(); refreshIcons(); el('qnQuery').focus(); };
  el('qnQuery').addEventListener('input', () => { qn.query = el('qnQuery').value; renderSearch(); refreshIcons(); });

  // Mobile fullscreen ↔ desktop popover: close when the chrome that opened it
  // disappears; re-anchor the popover while it stays open.
  window.addEventListener('resize', () => {
    if (!qn.open) return;
    if (qn.desk) {
      if (window.innerWidth <= 768) closeQuickNotes();
      else placeDeskPanel();
    } else if (window.innerWidth > 768) {
      closeQuickNotes();
    }
  });

  // Desktop popover: click outside dismisses (mobile stays fullscreen until Escape / Your boards).
  document.addEventListener('pointerdown', e => {
    if (!qn.open || !qn.desk) return;
    if (e.target.closest('#quicknotes') || e.target.closest('#phoneNotes')) return;
    closeQuickNotes();
  }, true);

  // Escape backs out one layer at a time: sheet → search → task → list → board.
  document.addEventListener('keydown', e => {
    if (!qn.open || e.key !== 'Escape') return;
    if (sheetBuilder) { hideSheet(); return; }
    if (qn.searchOpen) { closeSearch(); return; }
    if (qn.screen === 'task') { qn.screen = 'list'; render(); return; }
    if (qn.screen === 'list') { goHome(); return; }
    closeQuickNotes();
  });
}
