'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { lucideEl, refreshIcons, toast } from './util.js';
import { forgetUndo } from './editing.js';
import { reloadView } from './main.js';

// The Trash sheet: one row per delete, restorable unless the board it lived on
// is itself in the trash. Emptying it is permanent and also removes upload files.

const ICONS = {
  note: 'sticky-note',
  todo: 'list-checks',
  link: 'link',
  board: 'layout-grid',
  column: 'columns-3',
  image: 'image',
  file: 'file',
  comment: 'message-square',
};
const el = id => document.getElementById(id);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(ts) {
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins > -60) return rtf.format(mins, 'minute');
  if (mins > -1440) return rtf.format(Math.round(mins / 60), 'hour');
  return rtf.format(Math.round(mins / 1440), 'day');
}

function row(entry) {
  const li = document.createElement('li');
  li.dataset.id = entry.id;
  const icon = document.createElement('span');
  icon.className = 'trash-icon';
  icon.appendChild(lucideEl(ICONS[entry.type] || 'square'));
  const text = document.createElement('div');
  text.className = 'trash-text';
  const name = document.createElement('div');
  name.className = 'trash-name';
  name.textContent = entry.title || 'Untitled ' + entry.type;
  const meta = document.createElement('div');
  meta.className = 'trash-meta';
  meta.textContent = `${entry.canvasTitle || 'Board'} · ${ago(entry.trashedAt)}`;
  text.append(name, meta);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'trash-restore';
  btn.textContent = 'Restore';
  if (!entry.restorable) {
    btn.disabled = true;
    btn.title = 'Its board is in the trash — restore that first';
  }
  btn.onclick = () => restore(entry);
  li.append(icon, text, btn);
  return li;
}

async function load() {
  const r = await api.trash();
  if (!r) {
    toast('Could not load the trash — check your connection');
    return;
  }
  const items = r.items || [];
  el('trashList').replaceChildren(...items.map(row));
  el('trashEmptyNote').hidden = items.length > 0;
  el('trashEmpty').disabled = items.length === 0;
  refreshIcons(el('trashList'));
}

async function restore(entry) {
  if (!(await api.restore(entry.id))) return;
  forgetUndo(entry.id);
  toast('Restored');
  if (state.view.canvas && entry.canvasId === state.view.canvas.id) await reloadView();
  await load();
}

async function empty() {
  if (!confirm('Permanently delete everything in the trash? This can’t be undone.')) return;
  const r = await api.emptyTrash();
  if (!r) return;
  forgetUndo();
  toast(r.items === 1 ? 'Deleted 1 item for good' : `Deleted ${r.items} items for good`);
  await load();
}

export async function openTrash() {
  const dlg = el('trashDialog');
  if (!dlg.open) dlg.showModal();
  await load();
}

export function initTrash() {
  el('trashBtn').onclick = openTrash;
  el('trashClose').onclick = () => el('trashDialog').close();
  el('trashEmpty').onclick = empty;
  // A click on the backdrop lands on the dialog element itself.
  el('trashDialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
}
