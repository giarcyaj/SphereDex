const CACHE = 'spheredex-app-v3';
// How long the shell waits for the network before the cached copy answers instead. A phone on a dead but
// connected network (a lift, a train, hotel wifi, a card shop basement) does not fail fast: the socket
// stalls and a bare fetch can sit there for the browser's full timeout, showing a white screen the whole
// time, while a perfectly good copy of the app sits in this cache. The network answer still lands in the
// cache when it eventually arrives, so the next open is current either way.
const SHELL_TIMEOUT_MS = 2500;
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Navigation preload lets the browser start the request while this worker is still booting, which is
    // the other half of the delay on a cold open.
    try { if (self.registration.navigationPreload) await self.registration.navigationPreload.enable(); } catch (err) { /* not supported */ }
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // let backend / cross-origin pass straight through

  // App shell (navigations / HTML docs): NETWORK-FIRST, so a new build reaches returning users right
  // away without a cache-version bump. Falls back to the cached shell only when the network fails
  // (offline). The whole app lives in index.html, so this is what actually needs to stay fresh.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Whatever we have to fall back on: this exact URL, else the canonical shell. Cache.match ignores the
      // query string here, so a shared or tagged link (?utm=...) falls back to the app rather than missing.
      const cached = async () => (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || (await cache.match('./'));
      const network = (async () => {
        const preloaded = await e.preloadResponse;
        const res = preloaded || await fetch(req);
        if (res && res.status === 200) {
          // Keep both keys current: the one that was asked for, and the canonical shell the offline path
          // falls back to, which otherwise stayed frozen at whatever was cached on install.
          cache.put(req, res.clone());
          cache.put('./index.html', res.clone());
        }
        return res;
      })();
      // Network first, but only for as long as it is actually answering.
      const timed = new Promise(resolve => setTimeout(() => resolve(null), SHELL_TIMEOUT_MS));
      try {
        const res = await Promise.race([network, timed]);
        if (res) return res;
        const fallback = await cached();
        if (fallback) { network.catch(() => {}); return fallback; }   // let the slow network still fill the cache
        return await network;
      } catch (err) {
        const fallback = await cached();
        if (fallback) return fallback;
        throw err;
      }
    })());
    return;
  }

  // Static assets (icons, manifest): cache-first with background refresh - fast, and rarely change.
  e.respondWith(caches.open(CACHE).then(cache =>
    cache.match(req).then(cached => {
      const net = fetch(req).then(res => { if (res && res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;                            // instant from cache, refresh in background
    })
  ));
});
