const CACHE_KILL_VERSION = 'info1-disable-sw-v12';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
  })());
});

// Deliberately no fetch handler.
// INFO1 is temporarily running without a service worker while the GitHub Pages
// migration is stabilised. This prevents stale app-shell caches and request loops.
