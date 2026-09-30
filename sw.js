// Service worker de Magia Verde: permite instalar la app y abrirla rápido.
// Los datos SIEMPRE se piden a Google (nunca se guardan aquí); solo se guarda la "cáscara" de la app.
// Al publicar cambios en index.html, sube el número de VERSION para que los celulares tomen la versión nueva.
const VERSION = 'mv-v13';
const SHELL = ['./', 'index.html', 'manifest.json', 'logo.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google Apps Script y fuentes: directo a la red
  // Red primero (siempre la versión más nueva); si no hay señal, usar la copia guardada.
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
