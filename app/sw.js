// Automatisch erzeugt von tools/build-sw.mjs – nicht von Hand bearbeiten.
// Hält alle App-Dateien im Gerät vor, damit die Kasse ohne Internet startet.
const VERSION = '7dbf9c18ba35';
const CACHE = 'kasse-' + VERSION;
const FILES = [
  "./",
  "admin/admin.css",
  "admin/admin.js",
  "admin/index.html",
  "core/alerts.js",
  "core/api.js",
  "core/audit.js",
  "core/auth.js",
  "core/crypto.js",
  "core/db.js",
  "core/events.js",
  "core/export.js",
  "core/manage.js",
  "core/pos.js",
  "core/reports.js",
  "core/seed.js",
  "core/util.js",
  "core/wasm-driver.js",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "index.html",
  "kasse/index.html",
  "kasse/kasse.css",
  "kasse/kasse.js",
  "manifest.webmanifest",
  "shared/base.css",
  "shared/core.js",
  "shared/engine-worker.js",
  "shared/invoice.js",
  "vendor/sqlite/sqlite3.mjs",
  "vendor/sqlite/sqlite3.wasm"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kasse-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Ordner-Adressen (z. B. .../kasse/) gehören zur jeweiligen index.html
  const key = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  e.respondWith(caches.match(key, { ignoreSearch: true })
    .then((hit) => hit || caches.match(e.request, { ignoreSearch: true }))
    .then((hit) => hit || fetch(e.request)));
});
