const CACHE = 'info1-pwa-v6';
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

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Supabase/CDN/otros orígenes no pasan por la caché de GitHub Pages.
  if (url.origin !== self.location.origin) return;

  // La PWA abre desde caché primero. Esto permite entrar incluso si
  // GitHub Pages responde temporalmente con 429/rate limit.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put('./index.html', copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Archivos estáticos: cache-first. La versión del CACHE se incrementa
  // cuando desplegamos cambios, por lo que evitamos pedir los mismos
  // JS, iconos y recursos a GitHub Pages en cada visita.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
