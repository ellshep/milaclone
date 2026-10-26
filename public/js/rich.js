'use strict';

import { state } from './state.js';
import { docToDom, isEmptyDoc, toast } from './util.js';
import { saveData } from './editing.js';

// Note and comment bodies. Until a card is edited it shows docToDom's static
// render; editing swaps in TipTap, whose bundle (public/vendor/editor.js, built
// by server.js) is fetched the first time any card is edited.

let bundle = null;

export async function startRich(field, it) {
  // Editable at once, inside the user's tap, so a phone opens its keyboard; the
  // editor takes over the focus when it mounts.
  // ponytail: keys typed while the bundle is first loading are dropped.
  field.contentEditable = 'true';
  field.onfocus = () => field.editor && field.editor.commands.focus(); // callers focus [data-edit]
  bundle ||= import('/vendor/editor.js');
  let mod;
  try {
    mod = await bundle;
  } catch {
    bundle = null; // let the next edit retry
    field.contentEditable = 'false';
    toast('Could not load the editor — check your connection');
    return;
  }
  // The edit may have ended (or the card re-rendered) while the bundle loaded.
  if (state.editingId !== it.id || !field.isConnected || field.editor) return;
  field.contentEditable = 'false';
  try {
    field.editor = mod.mountEditor(field, it.data.doc, {
      placeholder: field.dataset.placeholder,
      onChange: (doc, text) => saveData(it, { doc, text }),
    });
  } catch {
    field.replaceChildren(docToDom(it.data.doc)); // a stored doc TipTap can't read: keep showing it
    toast("This card's text can't be edited");
    return;
  }
  field.removeAttribute('data-empty');
  field.editor.commands.focus('end');
}

export function stopRich(field, it) {
  field.contentEditable = 'false';
  if (!field.editor) return;
  field.editor.destroy();
  field.editor = null;
  if (!it) return; // the card was just deleted
  field.replaceChildren(docToDom(it.data.doc));
  field.toggleAttribute('data-empty', isEmptyDoc(it.data.doc));
}
