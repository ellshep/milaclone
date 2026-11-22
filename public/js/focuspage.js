// The full-screen /focus page (next-phases M2.2), its own entry point: it never
// imports main.js. Two modes, picked by the URL hash:
//
//   Three (default)  the top three of the focus order, one size, each with its
//                    own done ring (like the 3 Things Pebble app's buttons).
//                    Press and hold it: the ring charges, floods green, the
//                    task is saved as done, fades, and the next one slides in.
//                    A quick tap only shows a hint. "N in queue" sits in the
//                    controls.
//   List (#list)     every ranked task. Drag (or Alt+↑/↓) to reorder; that
//                    saves placements (focusOrder). Reset clears them.
//
// The order itself comes from the server (focus.js), so the page, the task API
// and the digest never disagree. No polling: it refetches when the window
// becomes visible again and from the refresh control.

import { dueLabel, isFixed, placementAfterDrop } from './focusorder.js';

const HOLD_MS = 900; // the ring's charge; focus.css reads it as --hold
const TAP_MS = 300; // let go sooner than this and it was a tap: show the hint
const CHEER_MS = 700; // green flood, check and pulse (focus.css .task.charged)
const FADE_MS = 450; // focus.css .task.done

const TAB =
  '<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="46" /><circle class="charge" cx="50" cy="50" r="46" pathLength="100" /></svg>' +
  '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11" pathLength="1" /></svg>';

const $ = sel => document.querySelector(sel);
const threeEl = $('#three');
const listEl = $('#list');
const emptyEl = $('#empty');
const resetBtn = $('#reset');
const queueEl = $('#queue');

let tasks = [];
const holds = new Map(); // task id → { at, timer } while its ring is held down
let saving = 0; // Done saves in flight. Refetches wait while this or `holds` is non-empty.

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
  if (holds.size || saving) return;
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
  const queued = tasks.length - 3;
  queueEl.textContent = `${queued} in queue`;
  queueEl.hidden = m !== 'three' || queued < 1;
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
  li.style.setProperty('--hold', `${HOLD_MS}ms`);
  const body = el('div', 'body');
  body.append(el('p', 'title', task.text), meta(task));
  const tab = el('button', 'tab');
  tab.type = 'button';
  tab.innerHTML = TAB;
  tab.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    tab.setPointerCapture(e.pointerId);
    startHold(li);
  });
  tab.addEventListener('pointerup', () => stopHold(li));
  tab.addEventListener('pointercancel', () => stopHold(li));
  tab.addEventListener('keydown', e => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) startHold(li);
  });
  tab.addEventListener('keyup', e => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    stopHold(li);
  });
  tab.addEventListener('blur', () => stopHold(li));
  tab.addEventListener('contextmenu', e => e.preventDefault()); // a long press is ours
  // Screen readers activate with a click that no pointer or key made (detail 0):
  // there's no way to hold, so finish at once.
  tab.addEventListener('click', e => {
    if (e.detail === 0 && !holds.has(li.dataset.id)) finish(li);
  });
  const hint = el('span', 'hint', 'Hold to finish');
  hint.setAttribute('aria-hidden', 'true');
  const act = el('div', 'act');
  act.append(tab, hint);
  li.append(body, act);
  return li;
}

// Keyed by task id, so tasks that stay keep their place and state while a new
// one slides in.
function renderThree() {
  const keep = new Map([...threeEl.children].map(li => [li.dataset.id, li]));
  const next = tasks.slice(0, 3).map(task => {
    let li = keep.get(task.id);
    if (li) {
      li.querySelector('.title').textContent = task.text;
      li.querySelector('.meta').replaceWith(meta(task));
    } else {
      li = buildTask(task);
      if (threeEl.children.length) li.classList.add('enter');
    }
    li.querySelector('.tab').setAttribute('aria-label', `Hold to finish: ${task.text}`);
    return li;
  });
  threeEl.replaceChildren(...next);
}

function startHold(li) {
  const id = li.dataset.id;
  if (holds.has(id) || li.classList.contains('charged')) return;
  li.classList.remove('hinting');
  li.classList.add('holding');
  const timer = setTimeout(() => {
    holds.delete(id);
    finish(li);
  }, HOLD_MS);
  holds.set(id, { at: performance.now(), timer });
}

// Let go early: the ring drains back. A tap shows "Hold to finish" for a moment.
function stopHold(li) {
  const hold = holds.get(li.dataset.id);
  if (!hold) return;
  clearTimeout(hold.timer);
  holds.delete(li.dataset.id);
  li.classList.remove('holding');
  if (performance.now() - hold.at < TAP_MS) {
    li.classList.add('hinting');
    setTimeout(() => li.classList.remove('hinting'), 1800);
  }
}

const pause = ms => new Promise(r => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms));

async function finish(li) {
  const id = li.dataset.id;
  li.classList.remove('holding', 'hinting');
  li.classList.add('charged');
  navigator.vibrate?.(20);
  saving++;
  const cheer = pause(CHEER_MS);
  let ok = false;
  try {
    ok = (await fetch(`/api/focus/${encodeURIComponent(id)}/done`, { method: 'POST' })).ok;
  } catch {
    ok = false;
  }
  await cheer;
  if (ok) {
    li.classList.add('done');
    await pause(FADE_MS);
  }
  saving--;
  if (!ok) {
    li.classList.remove('charged');
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

load();
