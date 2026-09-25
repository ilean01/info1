const CACHE = 'info1-pwa-v11';
const VERSION = '11';
const CORE = [
  './index.html',
  './manifest.webmanifest',
  './supabase-config.js',
  './cloud-sync.js',
  './supabase-media-bridge.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const SCOPE_PATH = new URL(self.registration.scope).pathname;
const APP_PATH = SCOPE_PATH.endsWith('/') ? SCOPE_PATH : SCOPE_PATH + '/';
const APP_ROOT = APP_PATH.replace(/\/$/, '');

function isAppShellNavigation(url) {
  return url.pathname === APP_PATH ||
         url.pathname === APP_ROOT ||
         url.pathname === APP_PATH + 'index.html';
}

async function refreshCore() {
  const cache = await caches.open(CACHE);
  for (const path of CORE) {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const response = await fetch(`${path}${sep}__info1_sw=${VERSION}`, { cache: 'reload' });
      if (response && response.ok) await cache.put(path, response.clone());
    } catch (_) {}
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

  // Only /info1/ itself is an app-shell navigation. Never return
  // index.html for PDFs or other nested resources.
  if (request.mode === 'navigate') {
    if (!isAppShellNavigation(url)) return;
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      try {
        const response = await fetch('./index.html', { cache: 'no-store' });
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

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      return new Response('', { status: 503 });
    }
  })());
});
