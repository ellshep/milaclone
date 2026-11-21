'use strict';

// The auto-save protocol, shared by the canvas (editing.js) and Quick notes
// (quicknotes.js). Each surface makes its own queue and keeps its own base, so
// edits to the same list from both in one tab merge on the server instead of
// one replacing the other in a shared queue.
//
// For each item: fields edited inside the debounce window go out together as
// one PATCH; a to-do edit carries `baseTasks`, the list as this surface last
// got it from the server, so the server can merge three ways; after a save the
// server's list becomes the new base. A save that may work later goes back in
// the queue with the field's *current* value (never the failed one, so a retry
// can't undo a newer edit) and is retried with backoff. A rejected save is not
// retried.
//
// The server is reached through `send(id, body, keepalive)`, which resolves to
// the saved item, `null` (failed, worth retrying) or `false` (rejected): the
// app passes `api.patch`, tests pass an in-memory stand-in.

const clone = v => JSON.parse(JSON.stringify(v));
const backoff = n => Math.min(60000, 1000 * 2 ** n);

export function createSaveQueue({ send, delay, current, onSaved = () => {} }) {
  const pending = new Map(); // id -> fields waiting to go out
  const timers = new Map();
  const retries = new Map();
  const bases = new Map(); // id -> task list as last received
  const stale = new Map(); // id -> fields whose failed value must be re-read before sending

  function schedule(id, ms) {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => flushOne(id), ms)
    );
  }

  function requeue(id, patch) {
    const p = pending.get(id) || {};
    const keys = stale.get(id) || new Set();
    for (const k of Object.keys(patch)) if (!(k in p)) keys.add(k);
    pending.set(id, Object.assign({}, patch, p));
    stale.set(id, keys);
    const n = (retries.get(id) || 0) + 1;
    retries.set(id, n);
    schedule(id, backoff(n));
  }

  async function flushOne(id, keepalive = false) {
    const patch = pending.get(id);
    if (!patch) return;
    pending.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    for (const k of stale.get(id) || []) patch[k] = current(id, k);
    stale.delete(id);
    const body = { data: patch };
    if (patch.tasks) body.baseTasks = bases.get(id) || [];
    const saved = await send(id, body, keepalive);
    if (saved === null) return requeue(id, patch);
    retries.delete(id);
    if (!saved) return;
    if (Array.isArray(saved.data?.tasks)) bases.set(id, clone(saved.data.tasks));
    onSaved(id, saved, patch);
  }

  return {
    // Queue fields for an item and restart its debounce.
    edit(id, patch) {
      pending.set(id, Object.assign(pending.get(id) || {}, patch));
      schedule(id, delay);
    },
    // Remember an item's task list as the server sent it.
    track(id, tasks) {
      bases.set(id, clone(tasks || []));
    },
    // Send queued edits now: one item, or every item when `id` is omitted.
    flush(id, { keepalive = false } = {}) {
      const ids = id === undefined ? [...pending.keys()] : [id];
      return Promise.all(ids.map(i => flushOne(i, keepalive)));
    },
    // Take an item's queued fields out of the queue, e.g. to send them in a
    // request of the caller's own.
    take(id) {
      clearTimeout(timers.get(id));
      timers.delete(id);
      const patch = pending.get(id);
      for (const k of stale.get(id) || []) patch[k] = current(id, k);
      stale.delete(id);
      pending.delete(id);
      return patch;
    },
    // Whether edits are waiting: for one item, or any.
    pending(id) {
      return id === undefined ? pending.size > 0 : pending.has(id);
    },
  };
}
