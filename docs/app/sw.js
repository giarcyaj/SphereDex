const CACHE = 'spheredex-app-v3';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
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
    e.respondWith(
      fetch(req)
        .then(res => { if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
        .catch(() => caches.open(CACHE).then(c => c.match(req).then(m => m || c.match('./index.html') || c.match('./'))))
    );
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
