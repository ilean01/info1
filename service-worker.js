const CACHE = 'info1-pwa-network-first-v12';
const APP_SHELL = [
  './',
  './index.html',
  './app-bootstrap.js',
  './vendor/supabase-2.117.2.js',
  './app-core.js',
  './app-study.js',
  './notebook-merge.js',
  './state-storage.js',
  './manifest.webmanifest',
  './supabase-config.js',
  './cloud-sync.js',
  './cloud-settings-ui.js',
  './device-sync.js',
  './notebooks-realtime.js',
  './notebooks-selection.js',
  './notebooks-resilience.js',
  './notebooks-collaboration.js',
  './notebooks-interface.js',
  './notebooks-laser.js',
  './supabase-media-bridge.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(APP_SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
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

  if (url.pathname.includes('/api/')) {
    event.respondWith(new Response(JSON.stringify({ ok: false, legacy: true }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    }));
    return;
  }

  if (url.pathname.includes('/materiales/')) {
    event.respondWith((async () => {
      const fullRequest = new Request(req.url, {credentials:'same-origin'});
      try {
        const fresh = await fetch(fullRequest, {cache:'no-store'});
        if(fresh.ok){const cache=await caches.open(CACHE);await cache.put(fullRequest,fresh.clone());}
        return fresh;
      } catch (error) {
        const cached = await caches.match(fullRequest);
        if(cached)return cached;
        throw error;
      }
    })());
    return;
  }

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
      const cached = await caches.match(req) || (APP_SHELL.some(path => new URL(path, self.registration.scope).pathname === url.pathname) ? await caches.match(req, {ignoreSearch:true}) : null);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html') || await caches.match('./');
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
