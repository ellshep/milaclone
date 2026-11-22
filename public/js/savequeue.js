'use strict';

// The auto-save protocol, shared by the canvas (editing.js) and Quick notes
// (quicknotes.js). Each surface makes its own queue and keeps its own base, so
// edits to the same list from both in one tab merge on the server instead of
// one replacing the other in a shared queue.
//
// For each item: fields edited inside the debounce window go out together as
// one PATCH; a to-do edit carries `baseTasks`, the list as this surface last
// got it from the server, so the server can merge three ways; after a to-do
// save with nothing else pending, the server's list becomes the new base. A
// save that may work later goes back in the queue and is retried with backoff,
// sending each field's *current* value at that moment (never the failed one, so
// a retry can't undo a newer edit). After `retryDelay` gives up (null) the edit
// stays queued for the next edit or flush. A rejected save is not retried. An
// item counts as pending from its first edit until a save lands or is rejected,
// including while in flight.
//
// The server is reached through `send(id, body, keepalive)`, which resolves to
// the saved item, `null` (failed, worth retrying) or `false` (rejected): the
// app passes `api.patch`, tests pass an in-memory stand-in.

const clone = v => JSON.parse(JSON.stringify(v));
// Six tries, 2 s doubling to 60 s (about two minutes), then stop. The app
// passes api.js retryDelay, which is the same and also tells the user.
const defaultRetryDelay = n => (n <= 6 ? Math.min(60000, 1000 * 2 ** n) : null);

export function createSaveQueue({ send, delay, current, onSaved = () => {}, retryDelay = defaultRetryDelay }) {
  const pending = new Map(); // id -> fields waiting to go out
  const timers = new Map();
  const retries = new Map();
  const bases = new Map(); // id -> task list as last received
  const stale = new Map(); // id -> fields whose failed value must be re-read before sending
  const inflight = new Map(); // id -> saves sent and not yet answered

  const isPending = id => pending.has(id) || inflight.has(id);

  function schedule(id, ms) {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => flushOne(id), ms)
    );
  }

  function requeue(id, patch) {
    const newer = pending.has(id); // a newer edit keeps its own, sooner debounce
    const p = pending.get(id) || {};
    const keys = stale.get(id) || new Set();
    for (const k of Object.keys(patch)) if (!(k in p)) keys.add(k);
    pending.set(id, Object.assign({}, patch, p));
    stale.set(id, keys);
    const n = (retries.get(id) || 0) + 1;
    retries.set(id, n);
    const wait = retryDelay(n);
    if (!newer && wait !== null) schedule(id, wait);
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
    inflight.set(id, (inflight.get(id) || 0) + 1);
    let saved;
    try {
      saved = await send(id, body, keepalive);
    } finally {
      if (inflight.get(id) > 1) inflight.set(id, inflight.get(id) - 1);
      else inflight.delete(id);
    }
    if (saved === null) return requeue(id, patch);
    retries.delete(id);
    if (!saved) return;
    // The base is the list the surface's copy grew from, so it moves only when the
    // surface adopts the merged list: after a to-do save (a title or label save
    // must not make a stale list look like deletions) with nothing else pending
    // (the surface keeps its copy then, so a task added elsewhere would look deleted).
    if (patch.tasks && Array.isArray(saved.data?.tasks) && !isPending(id)) bases.set(id, clone(saved.data.tasks));
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
    // Whether edits haven't landed yet (queued, retrying or in flight): for one
    // item, or any. While true, don't replace the surface's copy with the server's.
    pending(id) {
      if (id === undefined) return pending.size > 0 || inflight.size > 0;
      return isPending(id);
    },
  };
}
