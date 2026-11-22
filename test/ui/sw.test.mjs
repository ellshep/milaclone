import { it, expect, vi } from 'vitest';
import fs from 'node:fs';

// sw.js run against a fake worker scope: which GETs it caches.
function loadWorker() {
  const listeners = {};
  const put = vi.fn(async () => {});
  const self = {
    location: new URL('http://mila.test/'),
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  const caches = { open: async () => ({ put }) };
  const fetch = async () => new Response('ok', { status: 200 });
  new Function('self', 'caches', 'fetch', fs.readFileSync('public/sw.js', 'utf8'))(self, caches, fetch);
  const get = async url => {
    const waits = [];
    let answered = null;
    listeners.fetch({
      request: { method: 'GET', url, headers: new Headers(), mode: 'cors' },
      respondWith: p => (answered = p),
      waitUntil: p => waits.push(p),
    });
    if (answered) await answered;
    await Promise.all(waits);
    return !!answered;
  };
  return { get, put };
}

it('caches plain same-origin GETs', async () => {
  const { get, put } = loadWorker();
  expect(await get('http://mila.test/api/canvas/abc')).toBe(true);
  expect(put).toHaveBeenCalledOnce();
});

it('leaves same-origin URLs with a query string alone, so they never pile up in the cache', async () => {
  const { get, put } = loadWorker();
  expect(await get('http://mila.test/api/search?q=pho')).toBe(false);
  expect(put).not.toHaveBeenCalled();
});
