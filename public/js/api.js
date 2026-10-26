'use strict';

import { toast } from './util.js';

const json = (method, body, extra) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...extra,
});

// Writes must never fail silently: a failed save says so instead of pretending
// the edit landed. Resolves to the server's item, or null on failure.
async function write(url, init) {
  try {
    const r = await fetch(url, init);
    if (r.ok) return await r.json();
  } catch {
    /* offline or aborted: reported below */
  }
  toast('Could not save — check your connection');
  return null;
}

// Thin wrappers over the JSON endpoints exposed by the Node backend.
export const api = {
  async root() {
    return (await fetch('/api/root')).json();
  },
  async canvas(id) {
    return (await fetch('/api/canvas/' + id)).json();
  },
  // Never throws: a failed search just shows no results.
  async search(q) {
    try {
      return (await (await fetch('/api/search?q=' + encodeURIComponent(q))).json()).results || [];
    } catch {
      return [];
    }
  },
  async todos() {
    return (await fetch('/api/todos')).json();
  },
  patchCanvas(id, body) {
    return write('/api/canvas/' + id, json('PATCH', body));
  },
  async create(body) {
    return (
      await fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  },
  // `keepalive` lets a save started while the page is closing still reach the server.
  patch(id, body, keepalive = false) {
    return write('/api/item/' + id, json('PATCH', body, { keepalive }));
  },
  patchMany(updates) {
    return write('/api/items', json('PATCH', { updates }));
  },
  async remove(id) {
    return (await fetch('/api/item/' + id, { method: 'DELETE' })).json();
  },
  restore(id) {
    return write('/api/item/' + id + '/restore', { method: 'POST' });
  },
  copy(id, to) {
    return write('/api/item/' + id + '/copy', json('POST', to));
  },
  move(id, to) {
    return write('/api/item/' + id + '/move', json('POST', to));
  },
  // null when the server can't be reached or errors.
  async trash() {
    try {
      const r = await fetch('/api/trash');
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  emptyTrash() {
    return write('/api/trash', { method: 'DELETE' });
  },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    return (await fetch('/api/upload', { method: 'POST', body: fd })).json();
  },
};
