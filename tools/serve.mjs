// Nur zum Ausprobieren am PC: stellt den Ordner app/ unter http://localhost:8080 bereit.
// (Im Betrieb liegt die App auf einem kostenlosen Webspeicher und läuft danach offline im Gerät.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const port = Number(process.env.PORT || 8080);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
    res.writeHead(404); return res.end('Nicht gefunden');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`App zum Testen: http://localhost:${port}/`));
