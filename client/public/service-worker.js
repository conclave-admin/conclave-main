// Cache only the public application shell. Account data and private attachment
// bytes are handled by the authenticated app and its account-scoped IndexedDB.
const CACHE = 'conclave-shell-v2';
const assetUrl = (value) => {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.pathname.startsWith('/assets/') ? url.href : null;
  } catch { return null; }
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) throw new Error('Application shell unavailable');
    const html = await response.clone().text();
    await cache.put('/', response);
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => assetUrl(match[1])).filter(Boolean);
    await cache.addAll([...new Set(assets)]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('conclave-shell-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Capture lazy modules loaded before the new Worker took control of the page.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_ASSETS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    // A new document may arrive while activation is claiming the previous one.
    // The ready-page handshake must also claim it before offline use.
    await self.clients.claim();
    const cache = await caches.open(CACHE);
    await Promise.all(event.data.urls.slice(0, 128).map(assetUrl).filter(Boolean).map(async (url) => {
      if (await cache.match(url, { ignoreVary: true })) return;
      try {
        const response = await fetch(url);
        if (response.ok) await cache.put(url, response);
      } catch { /* Already-cached modules remain usable during an outage. */ }
    }));
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (assetUrl(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Public hashed assets have identical bytes for this origin. Module
      // requests and worker prefetches can carry different Origin headers.
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone()).catch(() => {});
      return response;
    })());
  } else if (request.mode === 'navigate' && !url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          await cache.put('/', response.clone()).catch(() => {});
        }
        return response;
      } catch {
        return await cache.match('/') || Response.error();
      }
    })());
  }
});
