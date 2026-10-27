'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { lucideEl, refreshIcons } from './util.js';
import { applyCam } from './viewport.js';
import { selectIds } from './editing.js';
import { openCanvas } from './main.js';

// Global search (cmd+K / the topbar button): a <dialog> listing boards and cards
// whose text matches, each with its board path. Picking one opens its board and,
// for a card, selects it and brings it into view.

const el = id => document.getElementById(id);
const ICONS = {
  board: 'layout-grid',
  note: 'sticky-note',
  todo: 'list-checks',
  link: 'link',
  comment: 'message-circle',
};
let seq = 0;
let results = [];

export function openSearch() {
  el('searchDialog').showModal();
  el('searchInput').select();
}

async function run() {
  const q = el('searchInput').value.trim();
  const mine = ++seq; // only the latest query's answer is shown
  const found = q ? await api.search(q) : [];
  if (mine !== seq) return;
  results = found;
  const list = el('searchResults');
  list.replaceChildren(
    ...results.map((r, i) => {
      const li = document.createElement('li');
      const b = li.appendChild(document.createElement('button'));
      b.type = 'button';
      b.className = 'sr-item';
      b.appendChild(lucideEl(ICONS[r.kind === 'board' ? 'board' : r.type] || 'file'));
      const text = b.appendChild(document.createElement('span'));
      text.className = 'sr-text';
      const t = text.appendChild(document.createElement('span'));
      t.className = 'sr-title';
      t.textContent = r.title || 'Untitled';
      const p = text.appendChild(document.createElement('span'));
      p.className = 'sr-path';
      p.textContent = (r.kind === 'board' ? r.path.slice(0, -1) : r.path).join(' / ');
      b.onclick = () => go(results[i]);
      return li;
    })
  );
  el('searchEmpty').hidden = !q || results.length > 0;
  refreshIcons(list);
}

async function go(r) {
  el('searchDialog').close();
  await openCanvas(r.canvasId);
  // another navigation won, or the board was gone and we fell back to Home
  if (r.kind !== 'item' || !state.view.canvas || state.view.canvas.id !== r.canvasId) return;
  const it = state.view.items.find(i => i.id === r.id);
  if (!it) return;
  // A card inside a column is shown by centring its column.
  const at = (it.parentItemId && state.view.items.find(i => i.id === it.parentItemId)) || it;
  const card = elMap.get(at.id);
  const s = dom.stage.getBoundingClientRect();
  state.cam.x = s.width / 2 - (at.x + (card?.offsetWidth || 0) / 2) * state.cam.scale;
  state.cam.y = s.height / 2 - (at.y + (card?.offsetHeight || 0) / 2) * state.cam.scale;
  applyCam();
  selectIds([it.id]);
}

export function initSearch() {
  let timer = 0;
  el('searchInput').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  el('searchInput').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    clearTimeout(timer);
    await run(); // the results for what's typed now, not the last debounced query
    if (results.length) go(results[0]);
  });
  el('searchBtn').onclick = openSearch;
}
