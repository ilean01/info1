const CACHE = 'info1-pwa-v9';
const VERSION = '9';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './supabase-config.js',
  './cloud-sync.js',
  './supabase-media-bridge.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

async function refreshCore() {
  const cache = await caches.open(CACHE);

  for (const path of CORE) {
    let stored = false;

    try {
      const sep = path.includes('?') ? '&' : '?';
      const freshUrl = `${path}${sep}__info1_sw=${VERSION}`;
      const response = await fetch(freshUrl, { cache: 'reload' });
      if (response && response.ok) {
        await cache.put(path, response.clone());
        stored = true;
      }
    } catch (_) {}

    if (!stored) {
      const old = await caches.match(path);
      if (old) await cache.put(path, old.clone());
    }
  }
}

self.addEventListener('install', event => {
  event.waitUntil(refreshCore().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) {
        event.waitUntil((async () => {
          try {
            const response = await fetch('./index.html?__info1_nav=' + VERSION, { cache: 'no-store' });
            if (response && response.ok) {
              const cache = await caches.open(CACHE);
              await cache.put('./index.html', response.clone());
            }
          } catch (_) {}
        })());
        return cached;
      }

      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch (_) {
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>INFO 1 sin conexión</title><body style="font-family:system-ui;background:#09101f;color:#eef4ff;padding:32px"><h1>INFO 1</h1><p>No se pudo abrir la aplicación. Conectate una vez a internet y volvé a intentar.</p></body>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  if (url.pathname.endsWith('/cloud-sync.js') || url.pathname.endsWith('/supabase-config.js')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'reload' });
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch (_) {
        return (await caches.match(request)) || new Response('', { status: 503 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
