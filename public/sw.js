// Network-first offline shell (U2.2): every GET goes to the network and refreshes
// the cache; only when the network fails is the cached copy served. Writes and
// the database backup always go straight to the network.
const CACHE = 'mila-v1';
const CDN = ['https://unpkg.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

const cacheable = url =>
  (url.origin === self.location.origin && url.pathname !== '/api/backup') || CDN.includes(url.origin);

// 206 (a media range) can't be stored; opaque is a no-cors CDN script or stylesheet.
const storable = res => res.status === 200 || res.type === 'opaque';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range') || !cacheable(new URL(req.url))) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (storable(res)) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)));
        }
        return res;
      })
      .catch(
        async () => (await caches.match(req)) || (req.mode === 'navigate' && caches.match('/')) || Response.error()
      )
  );
});

// The page that installed us loaded before we controlled it, so it sends the URLs
// it fetched and we cache them now: the very first launch then works offline too.
self.addEventListener('message', e => {
  const urls = Array.isArray(e.data?.warm) ? e.data.warm : [];
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(
        urls
          .filter(u => cacheable(new URL(u)))
          .map(u =>
            fetch(u)
              .then(res => storable(res) && c.put(u, res))
              .catch(() => {})
          )
      )
    )
  );
});
