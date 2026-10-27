'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { imageSize, isUrl, toast, clipMarker, parseClipMarker, isTyping, hexColor } from './util.js';
import { screenToWorld } from './viewport.js';
import { render } from './cards.js';
import { select, selectedItems } from './editing.js';
import { copySelected, pasteClipboard } from './clipboard.js';
import { isQuickNotesOpen } from './quicknotes.js';

// Getting content onto the canvas from outside: the system clipboard (cmd+V),
// files and links dragged in from the OS, and the upload buttons. Copying a card
// writes a marker to the clipboard so pasting it still deep-copies the card.

const CELL_W = 280;
const CELL_H = 240;

// Where pasted content lands: under the last pointer position, else mid-screen.
let lastPointer = null;
export function pointerWorld() {
  const p = lastPointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return screenToWorld(p.x, p.y);
}

async function insert(body) {
  const it = await api.create({ canvasId: state.view.canvas.id, ...body });
  if (!it || it.error) return null;
  state.view.items.push(it);
  return it;
}

async function uploadOne(file) {
  const res = await api.upload(file).catch(() => null);
  if (!res || res.error) return { error: (res && res.error) || 'network error' };
  const isImage = (res.mime || file.type || '').startsWith('image/');
  if (!isImage) return { type: 'file', w: 220, data: { src: res.src, name: res.name, mime: res.mime || file.type } };
  const d = await imageSize(res.src);
  return { type: 'image', w: 260, data: { src: res.src, name: res.name, naturalW: d.w, naturalH: d.h } };
}

// Upload files in parallel, then lay the ones that made it out in a grid
// (3 across) centred on `at`. Failures are summed up in one toast.
export async function addFiles(files, at = pointerWorld()) {
  toast(files.length === 1 ? 'Uploading…' : `Uploading ${files.length} files…`);
  const results = await Promise.all(files.map(uploadOne));
  const ok = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  const cols = Math.min(3, ok.length);
  let last = null;
  for (const [i, card] of ok.entries()) {
    const x = Math.round(at.x + (i % cols) * CELL_W - (cols * CELL_W) / 2 + 10);
    const y = Math.round(at.y + Math.floor(i / cols) * CELL_H - 90);
    last = (await insert({ ...card, x, y })) || last;
  }
  if (last) {
    render();
    select(last.id);
  }
  if (failed.length) {
    const why = failed[0].error;
    toast(
      failed.length === files.length ? `Upload failed: ${why}` : `${failed.length} of ${files.length} failed: ${why}`
    );
  } else toast(ok.length === 1 ? 'Added' : `Added ${ok.length} files`);
  return last;
}

// A URL becomes a link card (it plays inline if it's a video/music embed);
// other text becomes a note.
export async function addText(text, at = pointerWorld()) {
  const t = String(text || '').trim();
  if (!t) return null;
  const x = Math.round(at.x - 120);
  const y = Math.round(at.y - 40);
  const hex = hexColor(t);
  const it = isUrl(t)
    ? await insert({ type: 'link', x, y, w: 240, color: 'blue', data: { url: t, title: '' } })
    : hex
      ? await insert({ type: 'swatch', x, y, w: 140, data: { hex, text: hex } })
      : await insert({ type: 'note', x, y, w: 240, data: { title: '', body: t } });
  if (!it) return null;
  render();
  select(it.id);
  return it;
}

// Keyboard copy/paste is left to the browser while typing, or while a modal or
// Quick notes owns the screen.
function canvasOwnsClipboard() {
  return !isTyping() && !isQuickNotesOpen() && !document.querySelector('dialog[open]') && !!state.view.canvas;
}

function onCopy(e, cut) {
  if (!canvasOwnsClipboard() || !state.selection.size || String(window.getSelection() || '')) return;
  e.preventDefault();
  e.clipboardData.setData(
    'text/plain',
    clipMarker(
      selectedItems().map(i => i.id),
      cut
    )
  );
  copySelected(cut, true);
}

// Cards moved by pasting a cut marker. The marker stays on the system clipboard,
// so without this every later cmd+V would move the card again.
const movedCuts = new Set();

export async function pasteData(dt) {
  const text = dt.getData('text/plain');
  const marker = parseClipMarker(text);
  if (marker) {
    const key = marker.ids.join(',');
    const pendingCut = state.clipboard && state.clipboard.cut && state.clipboard.ids.join(',') === key;
    if (marker.cut && movedCuts.has(key) && !pendingCut) return null; // a cut moves once
    if (marker.cut) movedCuts.add(key);
    state.clipboard = marker;
    return pasteClipboard();
  }
  // A context-menu copy that couldn't reach the system clipboard wins over its stale text.
  if (state.clipboard && state.clipboard.unsynced) return pasteClipboard();
  const files = [...(dt.files || [])];
  // Office apps put a rendered picture of the selection beside its text; the text is what was meant.
  const officeCopy = [...(dt.types || [])].includes('text/html') && text.trim();
  if (files.length && !officeCopy) return addFiles(files);
  if (text.trim()) return addText(text);
  if (state.clipboard) return pasteClipboard();
  return null;
}

function dropHasContent(dt) {
  const types = [...(dt.types || [])];
  return types.includes('Files') || types.includes('text/uri-list');
}

export function initCapture() {
  dom.stage.addEventListener('pointermove', e => (lastPointer = { x: e.clientX, y: e.clientY }));
  let sawClipEvent = false;
  document.addEventListener('copy', e => {
    sawClipEvent = true;
    onCopy(e, false);
  });
  document.addEventListener('cut', e => {
    sawClipEvent = true;
    onCopy(e, true);
  });
  document.addEventListener('paste', e => {
    sawClipEvent = true;
    if (!canvasOwnsClipboard()) return;
    e.preventDefault();
    pasteData(e.clipboardData);
  });
  // Safari fires no copy/cut/paste event when nothing editable has focus, which is
  // exactly the case with a selected card. The event (when it comes) is dispatched
  // during the keydown's default action, so by the next task we know: fall back to
  // the in-app clipboard.
  document.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !['c', 'x', 'v'].includes(k)) return;
    if (!canvasOwnsClipboard()) return;
    sawClipEvent = false;
    setTimeout(() => {
      if (sawClipEvent) return;
      if (k === 'v') pasteClipboard();
      else if (state.selectedId && !String(window.getSelection() || '')) copySelected(k === 'x');
    });
  });

  // Native drags that start in the page (a card's "Open ↗" link) aren't imports.
  let internalDrag = false;
  document.addEventListener('dragstart', () => (internalDrag = true));
  document.addEventListener('dragend', () => (internalDrag = false));

  dom.stage.addEventListener('dragover', e => {
    if (internalDrag || !dropHasContent(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dom.stage.addEventListener('drop', e => {
    if (internalDrag || !dropHasContent(e.dataTransfer)) return;
    e.preventDefault();
    const at = screenToWorld(e.clientX, e.clientY);
    const files = [...e.dataTransfer.files];
    if (files.length) return addFiles(files, at);
    const url = e.dataTransfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .find(l => l && !l.startsWith('#'));
    addText(url || e.dataTransfer.getData('text/plain'), at);
  });
}
