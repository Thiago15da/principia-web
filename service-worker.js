'use strict';

const CACHE_NAME = 'rvh-pcp-static-v8';
const STATIC_ASSETS = [
  './',
  './index.html',
  './estilos.css',
  './carga.html',
  './asistencia.html',
  './shared.js',
  './manifest.json',
  './IMG_8258.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(
        // cache.add() individual (no cache.addAll) para que un asset que
        // todavía no exista (ej. el logo) no tumbe la instalación entera.
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      ))
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

// La planilla (lectura) y el Apps Script (escritura de partes diarios) son
// datos de producción: nunca deben servirse desde caché. Siempre a la red,
// para trabajar contra el estado real de las órdenes.
function isProductionDataRequest(url) {
  return url.hostname === 'docs.google.com'
    || url.hostname === 'script.google.com'
    || url.hostname.endsWith('.googleusercontent.com');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Las escrituras (POST del parte diario al Apps Script) pasan derecho al
  // navegador. No hay nada que cachear y reenviarlas desde el service worker
  // solo agrega un punto de falla sobre el dato más sensible del sistema.
  if (request.method !== 'GET') return;

  if (isProductionDataRequest(url)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Solo cacheamos nuestros propios assets estáticos (GET, mismo origen).
  if (url.origin !== self.location.origin) return;

  // Red primero, caché como respaldo.
  //
  // Antes era al revés (stale-while-revalidate) y traía un problema real:
  // al publicar un cambio, la primera carga seguía usando el código viejo
  // y hacía falta recargar dos veces. Un deploy parecía no haber ocurrido.
  // Como la app igual no sirve sin conexión —necesita la planilla—, tener
  // siempre la versión correcta del código vale más que ahorrar milisegundos
  // al abrir. La caché queda para que la pantalla no muera si se corta la señal.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
