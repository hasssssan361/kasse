// Erzeugt app/sw.js (Offline-Betrieb): Liste aller App-Dateien + Version aus deren Inhalt.
// Nach jeder Änderung an der App ausführen:  node tools/build-sw.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!/^(sw\.js|README\.md|VERSION\.txt)$/.test(e.name)) files.push(path.relative(root, p).split(path.sep).join('/'));
  }
})(root);
files.sort();
const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(fileURLToPath(import.meta.url))); // Änderungen an diesem Skript ergeben ebenfalls eine neue Version
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(root, f)));
const version = hash.digest('hex').slice(0, 12);

const sw = `// Automatisch erzeugt von tools/build-sw.mjs – nicht von Hand bearbeiten.
// Hält alle App-Dateien im Gerät vor, damit die Kasse ohne Internet startet.
const VERSION = '${version}';
const CACHE = 'kasse-' + VERSION;
const FILES = ${JSON.stringify(['./', ...files], null, 2)};

self.addEventListener('install', (e) => {
  // Immer frisch vom Server laden (cache: 'reload'), nicht aus dem Zwischenspeicher des Browsers –
  // sonst kann eine neue Version mit alten Dateien installiert werden (GitHub Pages erlaubt 10 Min. Zwischenspeicher).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
`;
fs.writeFileSync(path.join(root, 'sw.js'), sw);
console.log(`sw.js geschrieben: ${files.length} Dateien, Version ${version}`);
