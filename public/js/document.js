'use strict';

import { saveData, exitEdit } from './editing.js';
import { refreshItem } from './cards.js';
import { loadEditor } from './rich.js';
import { toast, wordLabel } from './util.js';

// Document cards open here: a full-screen <dialog> with the TipTap editor (the
// same lazily built bundle as note bodies) and a live word count. The card shows
// the title, a snippet and the count; closing the dialog re-renders it.

const dlg = () => document.getElementById('docDialog');
let current = null;
let editor = null;
let opens = 0; // a close + reopen while the bundle loads must not mount twice

const showCount = text => (dlg().querySelector('.doc-count').textContent = wordLabel(text));

export async function openDocument(it) {
  exitEdit();
  const d = dlg();
  const seq = ++opens;
  current = it;
  d.querySelector('.doc-title').value = it.data.title || '';
  const body = d.querySelector('.doc-body');
  body.replaceChildren();
  showCount(it.data.text);
  d.showModal();
  const mod = await loadEditor();
  if (seq !== opens || !d.open) return; // closed or reopened while the bundle loaded
  if (!mod) return d.close();
  try {
    editor = mod.mountEditor(body, it.data.doc, {
      placeholder: 'Start writing…',
      onChange: (doc, text) => {
        saveData(it, { doc, text });
        showCount(text);
      },
    });
  } catch {
    toast("This document's text can't be edited");
    d.close();
    return;
  }
  editor.commands.focus('end');
}

export function initDocument() {
  const d = dlg();
  d.querySelector('.doc-title').addEventListener('input', e => current && saveData(current, { title: e.target.value }));
  d.querySelector('.doc-close').addEventListener('click', () => d.close());
  // TipTap claims Escape (preventDefault), so the dialog's own cancel never fires.
  d.addEventListener('keydown', e => e.key === 'Escape' && d.close());
  d.addEventListener('close', () => {
    opens++;
    editor?.destroy();
    editor = null;
    if (current) refreshItem(current);
    current = null;
  });
}
