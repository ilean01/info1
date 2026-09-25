const CACHE = 'info1-pwa-network-first-v1';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    } catch (_) {}
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Las rutas heredadas /api no deben golpear GitHub Pages.
  if (url.pathname.includes('/api/')) {
    event.respondWith(new Response(JSON.stringify({ ok: false, legacy: true }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    }));
    return;
  }

  // PDFs/materiales se sirven tal cual; nunca se reemplazan por index.html.
  if (url.pathname.includes('/materiales/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Navegación y archivos de la app: red primero para tener siempre lo último.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        try {
          const cache = await caches.open(CACHE);
          await cache.put(req, fresh.clone());
        } catch (_) {}
      }
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html') || await caches.match('./');
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
