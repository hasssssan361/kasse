// Erzeugt das App-Symbol (PNG) für den Startbildschirm – ohne Zusatzbibliotheken.
// Aufruf: node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';


const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x + 0.5, y + 0.5);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Kassen-Symbol: weißer Bon auf blauem Grund
const outK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];
for (const size of [180, 192, 512]) {
  const s = size;
  const box = { x0: 0.31 * s, x1: 0.69 * s, y0: 0.22 * s, y1: 0.78 * s, r: 0.04 * s };
  const inBox = (x, y) => {
    const cx = Math.min(Math.max(x, box.x0 + box.r), box.x1 - box.r);
    const cy = Math.min(Math.max(y, box.y0 + box.r), box.y1 - box.r);
    return box.r + 0.5 - Math.hypot(x - cx, y - cy);
  };
  const lines = [0.36, 0.46, 0.56].map((f) => f * s);
  const buf = png(s, (x, y) => {
    let c = BLUE;
    const a = Math.max(0, Math.min(1, inBox(x, y)));
    if (a > 0) c = mix(c, WHITE, a);
    for (const ly of lines) {
      const len = ly === lines[2] ? 0.2 : 0.26;
      if (Math.abs(y - ly) < 0.018 * s && x > 0.37 * s && x < (0.37 + len) * s) c = BLUE;
    }
    if (Math.abs(y - 0.68 * s) < 0.022 * s && x > 0.48 * s && x < 0.63 * s) c = BLUE; // Summe
    return c;
  });
  fs.writeFileSync(path.join(outK, `icon-${s}.png`), buf);
  console.log(`kasse/icon-${s}.png`, buf.length, 'Bytes');
}
