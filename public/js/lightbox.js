'use strict';

import { state } from './state.js';

// Full-size image viewer: double-click an image card; ←/→ step through the
// board's images in reading order (top to bottom, then left to right).

const dlg = () => document.getElementById('lightbox');
let images = [];
let at = 0;

function show() {
  const it = images[at];
  const d = dlg();
  const img = d.querySelector('img');
  img.src = it.data.src;
  img.alt = it.data.caption || it.data.name || '';
  d.querySelector('.lb-caption').textContent = it.data.caption || '';
  d.querySelector('.lb-prev').hidden = at === 0;
  d.querySelector('.lb-next').hidden = at === images.length - 1;
}

export function step(delta) {
  const next = at + delta;
  if (next < 0 || next >= images.length) return;
  at = next;
  show();
}

// Canvas position for ordering; a card in a column takes its column's spot
// (its own y only orders it within the column).
function place(it) {
  const col = it.parentItemId && state.view.items.find(c => c.id === it.parentItemId);
  return col ? [col.y, col.x, it.y] : [it.y, it.x, 0];
}

export function openLightbox(id) {
  images = state.view.items
    .filter(i => i.type === 'image' && i.data.src)
    .map(i => [place(i), i])
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .map(([, i]) => i);
  at = Math.max(
    0,
    images.findIndex(i => i.id === id)
  );
  if (!images.length) return;
  show();
  if (!dlg().open) dlg().showModal();
}

export function initLightbox() {
  const d = dlg();
  d.querySelector('.lb-prev').onclick = () => step(-1);
  d.querySelector('.lb-next').onclick = () => step(1);
  d.querySelector('.lb-close').onclick = () => d.close();
  // On the document, not the dialog: stepping to an end hides the focused
  // arrow button, which drops focus out of the dialog.
  document.addEventListener('keydown', e => {
    if (!d.open) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  // a click on the dark surround (not the image or a button) closes it
  d.addEventListener('click', e => {
    if (e.target === d || e.target.classList.contains('lb-caption')) d.close();
  });
}
