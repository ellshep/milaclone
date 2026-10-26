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
  async todos() {
    return (await fetch('/api/todos')).json();
  },
  async patchCanvas(id, body) {
    return (
      await fetch('/api/canvas/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
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
  async trash() {
    return (await fetch('/api/trash')).json();
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
