'use strict';

import { toast } from './util.js';

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Writes must never fail silently: a failed save says so instead of pretending
// the edit landed. Resolves to the server's item; null when it may work if
// retried (offline, timeout, rate limit, server error); false when the server
// rejected it (any other 4xx, e.g. the card was deleted elsewhere). The
// connection toast shows once per outage, not once per retry.
const RETRYABLE = new Set([408, 429]);
let failing = false;
async function write(url, init) {
  try {
    const r = await fetch(url, init);
    if (r.ok) {
      failing = false;
      return await r.json();
    }
    if (r.status < 500 && !RETRYABLE.has(r.status)) {
      toast('Could not save — the server rejected the change');
      return false;
    }
  } catch {
    /* offline or aborted: reported below */
  }
  if (!failing) toast('Could not save — check your connection');
  failing = true;
  return null;
}

// Automatic retries for a failed save (n = how many times it has failed): 2 s,
// doubling up to 60 s, six tries, about two minutes. After that it stops: the
// edit stays queued and goes out with the next edit, when the browser comes
// back online, or when the tab is shown again. Returns the delay, or null.
const MAX_RETRIES = 6;
export function retryDelay(n) {
  if (n <= MAX_RETRIES) return Math.min(60000, 1000 * 2 ** n);
  if (n === MAX_RETRIES + 1) toast("Still can't save — your change will go out when the connection is back");
  return null;
}

// Browsers refuse keepalive requests once the bodies in flight together pass
// 64 KB (in bytes), so a save asks for keepalive only while it fits under that;
// a big one goes out as a normal request.
const KEEPALIVE_MAX = 60000;
const utf8 = new TextEncoder();
let keepaliveBytes = 0;

function normalizeReadTasks(data) {
  if (!Array.isArray(data.tasks)) return;
  data.tasks = data.tasks.map(task => {
    if (!task || typeof task !== 'object' || !('done' in task || 'stale' in task)) return task;
    const out = { ...task, status: task.done ? 'done' : 'open' };
    delete out.done;
    delete out.stale;
    if (task.done) out.statusAt = null;
    return out;
  });
}

// Thin wrappers over the JSON endpoints exposed by the Node backend.
export const api = {
  async root() {
    return (await fetch('/api/root')).json();
  },
  async canvas(id) {
    const view = await (await fetch('/api/canvas/' + id)).json();
    for (const item of view.items || []) if (item.type === 'todo') normalizeReadTasks(item.data);
    return view;
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
    const view = await (await fetch('/api/todos')).json();
    for (const list of view.lists || []) normalizeReadTasks(list);
    return view;
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
    const init = json('PATCH', body);
    const size = keepalive ? utf8.encode(init.body).length : 0;
    init.keepalive = keepalive && keepaliveBytes + size < KEEPALIVE_MAX;
    if (!init.keepalive) return write('/api/item/' + id, init);
    keepaliveBytes += size;
    return write('/api/item/' + id, init).finally(() => (keepaliveBytes -= size));
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
