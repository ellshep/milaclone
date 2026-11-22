'use strict';

// When the board is framed by another page on the same origin (the agent add-on's
// page, docs/agent-addon.md A14), it tells that page which cards are selected, so
// a question there can carry the selection as context. Ids only, never content.
// Standalone, nothing is posted.
export function postSelection(ids, win = window) {
  if (win.parent === win) return;
  win.parent.postMessage({ type: 'milaclone:selection', ids: [...ids] }, win.location.origin);
}
