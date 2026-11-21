// The full-screen /focus page (next-phases M2.2), its own entry point: it never
// imports main.js. Two modes, picked by the URL hash:
//
//   Three (default)  the top three of the focus order, largest first. Click a
//                    title → "Done?" ✓ ✕ (✕ or 5 s cancels) → strike and fade →
//                    the others move up and the next one slides in.
//   List (#list)     every ranked task. Drag (or Alt+↑/↓) to reorder; that
//                    saves placements (focusOrder). Reset clears them.
//
// The order itself comes from the server (focus.js), so the page, the task API
// and the digest never disagree. No polling: it refetches when the window
// becomes visible again and from the refresh control.

import { dueLabel, isFixed, placementAfterDrop } from './focusorder.js';

const CONFIRM_MS = 5000;
const DONE_MS = 1000; // strike, then fade (focus.css .task.done)

const $ = sel => document.querySelector(sel);
const threeEl = $('#three');
const listEl = $('#list');
const emptyEl = $('#empty');
const resetBtn = $('#reset');

let tasks = [];
let busy = false; // a Done is animating or saving: hold refetches until it ends
let confirming = null; // { li, timer }

const mode = () => (location.hash === '#list' ? 'list' : 'three');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function showMessage(text) {
  emptyEl.textContent = text;
  emptyEl.hidden = !text;
}

async function load() {
  if (busy) return;
  try {
    const r = await fetch('/api/focus?limit=all');
    if (!r.ok) throw new Error(String(r.status));
    tasks = (await r.json()).tasks;
  } catch {
    tasks = [];
    render();
    showMessage("Can't reach the board. Use refresh to try again.");
    return;
  }
  render();
}

function render() {
  const m = mode();
  document.body.dataset.mode = m;
  for (const b of document.querySelectorAll('[data-mode-link]')) {
    b.setAttribute('aria-current', String(b.dataset.modeLink === m));
  }
  threeEl.hidden = m !== 'three';
  listEl.hidden = m !== 'list';
  resetBtn.hidden = true;
  showMessage(tasks.length ? '' : 'Nothing to do. New tasks from the board show up here.');
  if (m === 'three') renderThree();
  else renderList();
}

// ---- Three ---------------------------------------------------------------------

function meta(task) {
  const p = el('p', 'meta');
  const due = dueLabel(task);
  if (due) p.append(el('span', 'due ' + task.tier, due));
  if (task.rankReason) p.append(el('span', 'reason', task.rankReason));
  return p;
}

function buildTask(task) {
  const li = el('li', 'task');
  li.dataset.id = task.id;
  const title = el('button', 'title', task.text);
  title.type = 'button';
  title.addEventListener('click', () => askDone(li));
  const confirm = el('div', 'confirm');
  confirm.hidden = true;
  confirm.append(el('span', 'ask', 'Done?'));
  const yes = el('button', 'yes', '✓');
  yes.type = 'button';
  yes.setAttribute('aria-label', 'Mark done');
  yes.addEventListener('click', () => markDone(li));
  const no = el('button', 'no', '✕');
  no.type = 'button';
  no.setAttribute('aria-label', 'Keep it');
  no.addEventListener('click', cancelConfirm);
  confirm.append(yes, no);
  li.append(title, meta(task), confirm);
  return li;
}

// Keyed by task id, so tasks that stay just change position (and size, by CSS)
// while a new one slides in.
function renderThree() {
  const top = tasks.slice(0, 3);
  const keep = new Map([...threeEl.children].map(li => [li.dataset.id, li]));
  const next = top.map((task, i) => {
    let li = keep.get(task.id);
    if (li) {
      li.querySelector('.title').textContent = task.text;
      li.querySelector('.meta').replaceWith(meta(task));
    } else {
      li = buildTask(task);
      if (threeEl.children.length) li.classList.add('enter');
    }
    li.dataset.pos = String(i + 1);
    return li;
  });
  threeEl.replaceChildren(...next);
}

function askDone(li) {
  if (busy) return;
  cancelConfirm();
  li.querySelector('.confirm').hidden = false;
  li.classList.add('asking');
  li.querySelector('.yes').focus();
  confirming = { li, timer: setTimeout(cancelConfirm, CONFIRM_MS) };
}

function cancelConfirm() {
  if (!confirming) return;
  clearTimeout(confirming.timer);
  confirming.li.querySelector('.confirm').hidden = true;
  confirming.li.classList.remove('asking');
  confirming = null;
}

async function markDone(li) {
  const id = li.dataset.id;
  cancelConfirm();
  busy = true;
  li.classList.add('done');
  const pause = new Promise(r => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : DONE_MS));
  let ok = false;
  try {
    ok = (await fetch(`/api/focus/${encodeURIComponent(id)}/done`, { method: 'POST' })).ok;
  } catch {
    ok = false;
  }
  await pause;
  busy = false;
  if (!ok) {
    li.classList.remove('done');
    li.querySelector('.meta').replaceChildren(el('span', 'due overdue', "Couldn't mark it done. Try again."));
    return;
  }
  tasks = tasks.filter(t => t.id !== id);
  render();
}

// ---- List ----------------------------------------------------------------------

let dragId = null;

function renderList() {
  const rows = tasks.map((task, i) => {
    const li = el('li', 'row ' + task.tier);
    li.dataset.id = task.id;
    if (i === 2) li.classList.add('cut');
    li.append(el('span', 'row-title', task.text));
    const due = dueLabel(task);
    if (due) li.append(el('span', 'due ' + task.tier, due));
    if (!isFixed(task)) {
      li.draggable = true;
      li.tabIndex = 0;
      li.setAttribute('aria-label', `${task.text}. Drag, or Alt and an arrow key, to move it.`);
    }
    return li;
  });
  listEl.replaceChildren(...rows);
  resetBtn.hidden = !tasks.some(t => t.tier === 'placed');
}

async function saveOrder(ids) {
  try {
    const r = await fetch('/api/focus/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) throw new Error(String(r.status));
    tasks = (await r.json()).tasks;
    render();
  } catch {
    await load();
    showMessage("Couldn't save the new order. Try again.");
  }
}

function dropTarget(e) {
  const li = e.target.closest('.row');
  if (!li || !li.draggable || li.dataset.id === dragId) return null;
  const box = li.getBoundingClientRect();
  return { li, after: e.clientY > box.top + box.height / 2 };
}

function clearMarks() {
  for (const n of listEl.querySelectorAll('.drop-before, .drop-after, .dragging')) {
    n.classList.remove('drop-before', 'drop-after', 'dragging');
  }
}

listEl.addEventListener('dragstart', e => {
  const li = e.target.closest('.row');
  if (!li || !li.draggable) return;
  dragId = li.dataset.id;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
listEl.addEventListener('dragover', e => {
  const t = dragId && dropTarget(e);
  for (const n of listEl.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after');
  if (!t) return;
  e.preventDefault();
  t.li.classList.add(t.after ? 'drop-after' : 'drop-before');
});
listEl.addEventListener('drop', e => {
  const t = dragId && dropTarget(e);
  const from = dragId;
  dragId = null;
  clearMarks();
  if (!t) return;
  e.preventDefault();
  const ids = placementAfterDrop(tasks, from, t.li.dataset.id, t.after);
  if (ids) saveOrder(ids);
});
listEl.addEventListener('dragend', () => {
  dragId = null;
  clearMarks();
});
listEl.addEventListener('keydown', async e => {
  const li = e.target.closest('.row');
  if (!li || !li.draggable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const movable = tasks.filter(t => !isFixed(t));
  const i = movable.findIndex(t => t.id === li.dataset.id);
  const target = movable[e.key === 'ArrowUp' ? i - 1 : i + 1];
  if (!target) return;
  const ids = placementAfterDrop(tasks, li.dataset.id, target.id, e.key === 'ArrowDown');
  if (!ids) return;
  await saveOrder(ids);
  listEl.querySelector(`.row[data-id="${CSS.escape(li.dataset.id)}"]`)?.focus();
});

resetBtn.addEventListener('click', () => saveOrder([]));

// ---- Controls and refetching ---------------------------------------------------

$('#refresh').addEventListener('click', load);
window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') cancelConfirm();
});

load();
