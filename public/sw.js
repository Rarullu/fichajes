// Service worker: guarda la app para que abra sin conexión. Nunca guarda datos de /api.
const CACHE = 'fichajes-v2';
const BASE = ['/', '/estilos.css', '/app.js', '/manifest.json', '/icono.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Primero la red (para recibir actualizaciones); si no hay, la copia guardada.
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(url.pathname === '/' ? '/' : e.request, copia)); }
      return r;
    }).catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request).then((r) => r || caches.match('/')))
  );
});
