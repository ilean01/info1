const CACHE = 'info1-pwa-v10';
const VERSION = '10';
const CORE = [
  './index.html',
  './manifest.webmanifest',
  './supabase-config.js',
  './cloud-sync.js',
  './supabase-media-bridge.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function legacyApiResponse(request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // The old localhost version of INFO1 used /api/* endpoints. On GitHub Pages
  // those routes do not exist. Never let them hit GitHub, because hundreds of
  // photo previews can otherwise create a request storm and trigger HTTP 429.
  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, provider: 'info1-browser-bridge', legacyServer: false });
  }

  if (path === '/api/photos' && method === 'GET') {
    return json([]);
  }
  if (/^\/api\/photos(?:\/[^/]+)?$/.test(path)) {
    return json({ error: 'El servidor local antiguo está desactivado.' }, 503);
  }

  // The real cloud synchronization is handled by cloud-sync.js + Supabase.
  // Acknowledge the legacy POST so its old retry loop does not run forever.
  if (path === '/api/state' && method === 'POST') {
    return json({ revision: Date.now(), savedAt: new Date().toISOString(), provider: 'supabase-bridge' });
  }
  if (path === '/api/state/history' && method === 'GET') {
    return json({ versions: [] });
  }
  if (path === '/api/state' && method === 'GET') {
    return json({ error: 'Usá la copia de Supabase desde INFO1.' }, 404);
  }

  return json({ error: 'API local desactivada en GitHub Pages.' }, 404);
}

async function refreshCore() {
  const cache = await caches.open(CACHE);
  for (const path of CORE) {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const freshUrl = `${path}${sep}__info1_sw=${VERSION}`;
      const response = await fetch(freshUrl, { cache: 'reload' });
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
  const url = new URL(request.url);

  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(Promise.resolve(legacyApiResponse(request, url)));
    return;
  }

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
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

  if (url.pathname.endsWith('/cloud-sync.js') || url.pathname.endsWith('/supabase-config.js') || url.pathname.endsWith('/supabase-media-bridge.js')) {
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