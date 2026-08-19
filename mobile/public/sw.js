// Hand-written, with the asset list stamped in by the build (see vite.config.ts).
//
// Two policies, because the two kinds of file differ in one decisive way.
//
// Hashed assets under /assets/ are immutable: the name changes when the content
// does, so a cache hit is never the wrong version and cache-first is free speed.
//
// index.html is NOT hashed. Serving it cache-first means a deployed update is
// never seen — the page loads from cache, referencing the previous build's
// assets, forever. So navigations go to the network first and fall back to the
// cache, which is also exactly what offline needs.
//
// The GitHub API is never cached at all: sync writes every response into
// IndexedDB itself, and a stale API response served from a second cache is how
// a phone quietly shows notes that no longer exist.
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

  const isNavigation = e.request.mode === 'navigate' || url.pathname.endsWith('/index.html');

  e.respondWith((async () => {
    if (isNavigation) {
      try {
        const res = await fetch(e.request);
        if (res.ok) (await caches.open(CACHE)).put('./index.html', res.clone());
        return res;
      } catch {
        // No network: the last good shell is enough, because every note is
        // already in IndexedDB.
        return (await caches.match('./index.html')) ?? (await caches.match('./')) ?? Response.error();
      }
    }

    const hit = await caches.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
    return res;
  })());
});
