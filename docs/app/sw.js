// SphereDex service worker.
//
// TWO CACHES, on purpose. The shell (the one big index.html that is the whole app) is keyed by the BUILD,
// so every release starts a clean cache and an emergency release is a real kill switch. Card art is 14MB
// across 290 files and does not change between releases, so it lives in a cache that survives deploys and
// refreshes itself in the background; versioning it with the shell would cost every returning user a 14MB
// download on every release.
//
// tools/rebuild.py stamps BUILD with the app version and a hash of the built page, so this file never has
// to be bumped by hand, which is what left it on one literal name for the app's whole life.
const BUILD = '1.11-ea09c96a';
const SHELL = 'spheredex-shell-' + BUILD;
const ASSETS = 'spheredex-assets-v1';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest'];
const ICONS = ['./icon-192.png', './icon-512.png', './icon-512-maskable.png'];
// Roughly the catalogue plus icons and a margin. Beyond it the oldest entries go, so a browser never
// carries an unbounded pile of art from sets the owner no longer looks at. The catalogue now includes the
// PalDex renders (img/PAL_*.webp, 86 files) alongside the card art, so the budget covers both: the old 420
// left under 40 slots spare, which one new set would have spent evicting Pal renders PalDex still needs.
const MAX_ASSETS = 600;
// How long the shell waits for the network before the cached copy answers instead. A phone on a connected
// but dead network does not fail fast: the socket stalls and a bare fetch can sit there for the browser's
// full timeout, showing a white screen the whole time, while a good copy of the app sits in this cache.
const SHELL_TIMEOUT_MS = 2500;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    try { const assets = await caches.open(ASSETS); await assets.addAll(ICONS); } catch (err) { /* icons are not worth failing over */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Navigation preload lets the browser start the request while this worker is still booting, which is
    // the other half of the delay on a cold open.
    try { if (self.registration.navigationPreload) await self.registration.navigationPreload.enable(); } catch (err) { /* not supported */ }
    const keep = new Set([SHELL, ASSETS]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Keep the asset cache bounded. Cache.keys() comes back in insertion order, so the front is the oldest.
async function trimAssets(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_ASSETS) return;
    await Promise.all(keys.slice(0, keys.length - MAX_ASSETS).map(k => cache.delete(k)));
  } catch (err) { /* a full cache is not worth an error */ }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // let backend / cross-origin pass straight through

  // App shell (navigations / HTML docs): NETWORK-FIRST so a new build reaches returning users right away,
  // but only for as long as the network is actually answering.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      // Whatever we have to fall back on: this exact URL, else the canonical shell. ignoreSearch so a
      // shared or tagged link (?utm=...) falls back to the app rather than missing.
      const cached = async () => (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || (await cache.match('./'));
      const network = (async () => {
        const preloaded = await e.preloadResponse;
        // Revalidate rather than letting the browser answer this from its own HTTP cache, which on Pages
        // can be up to ten minutes old on top of the edge age. The ETag makes that a cheap 304, so a user
        // who taps "tap here to reload" actually lands on the new build. Chromium answers navigations from
        // the preload above, which uses the HTTP cache, so this is mainly the Safari and Firefox path;
        // dropping the preload to cover Chromium too would cost more on every cold open. Some engines
        // refuse an init on a navigation request, so fall back rather than fail the whole load.
        let res = preloaded;
        if (!res) {
          try { res = await fetch(req, { cache: 'no-cache' }); }
          catch (err) { res = await fetch(req); }
        }
        if (res && res.status === 200) {
          // Keep both keys current: the one asked for, and the canonical shell the offline path falls back
          // to, which otherwise stayed frozen at whatever was cached on install.
          cache.put(req, res.clone());
          cache.put('./index.html', res.clone());
        }
        return res;
      })();
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

  // Everything else (card art, icons, the manifest): instant from cache, refreshed in the background, so a
  // re-baked image reaches the user on their next view rather than never.
  e.respondWith((async () => {
    const cache = await caches.open(ASSETS);
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && res.status === 200) cache.put(req, res.clone()).then(() => trimAssets(cache)).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
