'use strict';

const CACHE_NAME = 'rvh-produccion-static-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// La planilla de Google Sheets es la fuente de datos de producción: nunca
// debe servirse desde caché, siempre tiene que ir a la red para traer el
// estado real y actual de las órdenes de trabajo.
function isProductionDataRequest(url) {
  return url.hostname === 'docs.google.com' || url.hostname.endsWith('.googleusercontent.com');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (isProductionDataRequest(url)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Solo cacheamos nuestros propios assets estáticos (GET, mismo origen).
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Stale-while-revalidate: responde rápido con lo cacheado si existe,
  // y de fondo actualiza la caché con la versión más nueva del asset.
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request)
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
