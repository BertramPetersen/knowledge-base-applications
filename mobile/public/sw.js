// Hand-written, with the asset list stamped in by the build (see vite.config.ts).
//
// Two rules. App shell: cache-first, because Vite hashes filenames so a cached
// asset is never the wrong version. GitHub API: never cached — sync writes every
// response into IndexedDB itself, and a stale API response served from a second
// cache is how a phone quietly shows notes that no longer exist.
// Written by the build. Lazy runtime caching is not enough on its own: the
// worker registers after the first page's assets have already been fetched, so
// nothing it needs is in the cache until a second online visit. Precaching at
// install makes one online visit sufficient, which is the actual requirement.
const CACHE = 'kb-shell-__BUILD__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const hit = await caches.match(e.request);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch (err) {
      // A navigation with no network still has to render something: the shell
      // is enough, because every note is already in IndexedDB.
      if (e.request.mode === 'navigate') return (await caches.match('./index.html')) ?? Response.error();
      throw err;
    }
  })());
});
