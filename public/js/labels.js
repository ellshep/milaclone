'use strict';

import { state, elMap } from './state.js';
import { colorVar, labelColor } from './util.js';
import { saveData, selectedItems } from './editing.js';
import { refreshItem } from './cards.js';
import { drawLines } from './lines.js';

// Labels (F7.7): `data.labels` is a list of names on any card (lines aside); a
// name's colour comes from labelColor. The topbar Filter dims (or hides) the
// cards on this board carrying none of the chosen labels. The filter is per
// tab and resets when you open another board.

const el = id => document.getElementById(id);
const filter = { labels: new Set(), hide: false };
const labelsOf = it => (Array.isArray(it.data.labels) ? it.data.labels : []);
const labelled = it => it.type !== 'line';

export function boardLabels() {
  const all = new Set();
  for (const it of state.view.items) for (const l of labelsOf(it)) all.add(l);
  return [...all].sort((a, b) => a.localeCompare(b));
}

// The chip row a card shows (cards.js renderItem).
export function labelChips(it) {
  const names = labelsOf(it);
  if (!names.length || !labelled(it)) return null;
  const row = document.createElement('div');
  row.className = 'card-labels';
  for (const n of names) {
    const chip = document.createElement('span');
    chip.className = 'label-chip';
    chip.textContent = n;
    chip.style.background = colorVar(labelColor(n));
    row.appendChild(chip);
  }
  return row;
}

// A checkbox · colour dot · name row, for the filter menu and the Labels sheet.
function labelRow(name, checked, onchange) {
  const row = document.createElement('label');
  row.className = 'filter-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.onchange = () => onchange(cb.checked);
  const dot = document.createElement('span');
  dot.className = 'label-dot';
  dot.style.background = colorVar(labelColor(name));
  row.append(cb, dot, document.createTextNode(name));
  return row;
}

// ---- Filter ---------------------------------------------------------------

const matches = it => labelsOf(it).some(l => filter.labels.has(l));

export function applyFilter() {
  // A label nobody carries any more can't keep the board filtered.
  if (filter.labels.size) {
    const names = new Set(boardLabels());
    for (const l of filter.labels) if (!names.has(l)) filter.labels.delete(l);
  }
  const on = filter.labels.size > 0;
  el('filterBtn')?.classList.toggle('on', on);
  if (!on && !document.querySelector('.filtered-out')) return drawLines(); // the common case: nothing to undo
  document.body.classList.toggle('filter-hide', on && filter.hide);
  const inColumn = new Set(state.view.items.filter(k => k.parentItemId && matches(k)).map(k => k.parentItemId));
  for (const it of state.view.items) {
    const card = elMap.get(it.id);
    if (!card || !labelled(it)) continue;
    // A column stays while any card in it matches; a selected card (say, one
    // you just made) stays until you move on.
    const keep = !on || matches(it) || inColumn.has(it.id) || state.selection.has(it.id);
    card.classList.toggle('filtered-out', !keep);
  }
  drawLines(); // a hidden card's lines go with it
}

export function resetFilter() {
  filter.labels.clear();
  filter.hide = false;
  closeFilter();
}

function closeFilter() {
  el('filterMenu').hidden = true;
  el('filterBtn').setAttribute('aria-expanded', 'false');
}

function renderFilter() {
  const menu = el('filterMenu');
  const names = boardLabels();
  for (const l of filter.labels) if (!names.includes(l)) filter.labels.delete(l);
  menu.replaceChildren();
  if (!names.length) {
    const p = document.createElement('p');
    p.className = 'filter-empty';
    p.textContent = 'No labels on this board yet. Right-click a card → Labels… to add one.';
    menu.appendChild(p);
    return;
  }
  for (const n of names) {
    menu.appendChild(
      labelRow(n, filter.labels.has(n), on => {
        if (on) filter.labels.add(n);
        else filter.labels.delete(n);
        applyFilter();
      })
    );
  }
  const mode = document.createElement('label');
  mode.className = 'filter-row filter-mode';
  const hide = document.createElement('input');
  hide.type = 'checkbox';
  hide.checked = filter.hide;
  hide.onchange = () => {
    filter.hide = hide.checked;
    applyFilter();
  };
  mode.append(hide, document.createTextNode('Hide other cards (instead of dimming)'));
  menu.appendChild(mode);
}

// ---- Labels sheet -----------------------------------------------------------

let targets = [];

function renderSheet() {
  const list = el('labelList');
  list.replaceChildren();
  for (const n of boardLabels()) {
    const have = targets.filter(t => labelsOf(t).includes(n)).length;
    const row = labelRow(n, have === targets.length, on => setLabel(n, on));
    row.querySelector('input').indeterminate = have > 0 && have < targets.length;
    list.appendChild(row);
  }
}

function setLabel(name, on) {
  for (const t of targets) {
    const now = labelsOf(t).filter(l => l !== name);
    if (on) now.push(name);
    saveData(t, { labels: now });
    refreshItem(t);
  }
  renderSheet();
  applyFilter();
}

// Opens the sheet for the selection (every selected card, lines aside).
export function openLabels() {
  targets = selectedItems().filter(labelled);
  if (!targets.length) return;
  renderSheet();
  el('labelNew').value = '';
  el('labelDialog').showModal();
  el('labelNew').focus();
}

export function initLabels() {
  el('labelNew').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const typed = e.target.value.trim().slice(0, 40);
    if (!typed) return;
    e.target.value = '';
    // "Urgent" and "urgent" would look identical (same colour): reuse the existing spelling.
    setLabel(boardLabels().find(l => l.toLowerCase() === typed.toLowerCase()) || typed, true);
  });
  const btn = el('filterBtn');
  const menu = el('filterMenu');
  btn.onclick = () => {
    if (!menu.hidden) return closeFilter();
    renderFilter();
    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.right = window.innerWidth - r.right + 'px';
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !e.target.closest('#filterMenu, #filterBtn')) closeFilter();
  });
}
