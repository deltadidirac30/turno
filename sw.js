// Service worker di Turno.
// - L'app (HTML, CSS, JS, icone) viene messa in cache all'installazione: dopo il primo
//   caricamento lista e inserimento manuale funzionano anche in modalità aereo.
// - Le risorse pesanti in vendor/ (ZXing, Tesseract) vivono in una cache separata,
//   riempita dall'app (resources.js) o al primo utilizzo, e servite da lì offline.
// Percorsi relativi: funziona anche sotto /nome-repo/.
const VERSION = '1.1.0'; // allineare con js/version.js
const SHELL = 'turno-shell-' + VERSION;
const RES = 'turno-res-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'fonts/archivo.woff2',
  'icons/apple-touch-icon.png',
  'icons/favicon-64.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/app.js',
  'js/backup.js',
  'js/barcode.js',
  'js/camera.js',
  'js/components/forms.js',
  'js/components/scanner.js',
  'js/dates.js',
  'js/db.js',
  'js/i18n.js',
  'js/ics.js',
  'js/ocr-parse.js',
  'js/ocr.js',
  'js/products.js',
  'js/resources.js',
  'js/router.js',
  'js/store.js',
  'js/util.js',
  'js/version.js',
  'js/views/batch.js',
  'js/views/home.js',
  'js/views/item.js',
  'js/views/scan.js',
  'js/views/settings.js',
  'js/views/todo.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // cache: 'reload' evita di salvare copie vecchie dalla cache HTTP
    await cache.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })));
    // Primo avvio: attivazione immediata. Aggiornamenti: l'app chiede all'utente.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('turno-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Open Food Facts: sempre dalla rete

  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname;

  if (rel.startsWith('vendor/')) {
    event.respondWith(vendor(req));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match('index.html') || await cache.match('./');
      if (hit) return hit;
      return fetch(req);
    })());
    return;
  }
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});

async function vendor(req) {
  const cache = await caches.open(RES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  // Conserva per l'uso offline (solo risposte complete).
  if (res.ok && res.status === 200) {
    try { await cache.put(req.url, res.clone()); } catch {}
  }
  return res;
}
