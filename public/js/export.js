'use strict';

import { state } from './state.js';

// The topbar Export menu: this board as Markdown (re-importable with
// scripts/import-milanote-md.js) or a backup of the whole database.

const el = id => document.getElementById(id);
export const boardMarkdownUrl = () =>
  `/api/canvas/${state.view.canvas.id}/export.md?origin=${encodeURIComponent(location.origin)}`;

// Fetch a download without navigating: if the server answers with an error
// instead of an attachment, the page stays (a <a download> saves it as a file).
export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
}

function close() {
  el('exportMenu').hidden = true;
  el('exportBtn').setAttribute('aria-expanded', 'false');
}

export function initExport() {
  const btn = el('exportBtn');
  const menu = el('exportMenu');
  btn.onclick = () => {
    if (!menu.hidden) return close();
    el('exportMd').href = boardMarkdownUrl();
    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.right = window.innerWidth - r.right + 'px';
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  menu.addEventListener('click', close); // a download link was picked
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !e.target.closest('#exportMenu, #exportBtn')) close();
  });
}
