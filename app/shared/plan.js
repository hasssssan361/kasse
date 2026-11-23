// Tischplan zeichnen (SVG) – gemeinsam für den Editor im Admin-Bereich und die Kasse.
// Koordinaten sind Plan-Einheiten (Standard-Bereich 1200 × 800); das SVG skaliert auf jede Bildschirmgröße.
import { esc } from './core.js';

export const SEAT_R = 17;
export const NEW_AREA = () => ({ name: 'Gastraum', w: 1200, h: 800, elements: [] });

// Tresenplätze: an jeder Seite eine Liste frei wählbarer Platznummern
// { unten: [12, 13, 14], rechts: [15], oben: [], links: [11] }
export const SIDES = ['unten', 'rechts', 'oben', 'links'];
export function counterSeats(el) {
  if (el.seats && typeof el.seats === 'object') return Object.fromEntries(SIDES.map((s) => [s, Array.isArray(el.seats[s]) ? el.seats[s] : []]));
  // ältere Pläne (Version 2.3/2.4): eine Seite, fortlaufende Nummern
  const n = el.seat_count || 0;
  const o = Object.fromEntries(SIDES.map((s) => [s, []]));
  o[SIDES.includes(el.seat_side) ? el.seat_side : 'unten'] = Array.from({ length: n }, (_, i) => (el.seat_start || 101) + i);
  return o;
}
export const seatList = (el) => { const s = counterSeats(el); return SIDES.flatMap((side) => s[side].map((number, i) => ({ side, i, number }))); };

// Buchbare Plätze eines Elements (wie im Rechenkern: manage.js → planSpots)
export function spots(el) {
  if (el.type === 'table') return [{ number: el.number, name: el.label || null }];
  if (el.type === 'counter') return seatList(el).map((s, k) => ({ number: s.number, name: `${el.label || 'Tresen'} ${k + 1}` }));
  if (el.type === 'slot' && el.number) return [{ number: el.number, name: el.label || 'Automat' }];
  return [];
}

// Mittelpunkte der Gastplätze am Tresen (alle Seiten)
export function seatPositions(el) {
  const g = SEAT_R + 7;
  const s = counterSeats(el);
  return SIDES.flatMap((side) => s[side].map((number, i) => {
    const f = (i + 0.5) / s[side].length;
    const p = side === 'oben' ? { cx: el.x + f * el.w, cy: el.y - g }
      : side === 'links' ? { cx: el.x - g, cy: el.y + f * el.h }
        : side === 'rechts' ? { cx: el.x + el.w + g, cy: el.y + f * el.h }
          : { cx: el.x + f * el.w, cy: el.y + el.h + g };
    return { ...p, side, i, number };
  }));
}

// Umriss aller Elemente (für den Zuschnitt in der Kasse)
export function bounds(area) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const e of area.elements) {
    x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y); x2 = Math.max(x2, e.x + e.w); y2 = Math.max(y2, e.y + e.h);
    for (const s of e.type === 'counter' ? seatPositions(e) : []) {
      x1 = Math.min(x1, s.cx - SEAT_R); y1 = Math.min(y1, s.cy - SEAT_R); x2 = Math.max(x2, s.cx + SEAT_R); y2 = Math.max(y2, s.cy + SEAT_R);
    }
  }
  return x1 === Infinity ? { x: 0, y: 0, w: area.w, h: area.h } : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const fs = (e, f = 0.32, lo = 13, hi = 40) => Math.max(lo, Math.min(hi, Math.min(e.w, e.h) * f));
// Text auf verfügbare Breite kürzen (grobe Zeichenbreite ≈ 0,58 × Schriftgröße)
const fit = (t, width, size) => { const max = Math.max(3, Math.floor(width / (size * 0.58))); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const shape = (e, cls = 'shp') => (e.shape === 'circle'
  ? `<circle class="${cls}" cx="${e.x + e.w / 2}" cy="${e.y + e.h / 2}" r="${e.w / 2}"/>`
  : `<rect class="${cls}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="${e.type === 'table' ? 10 : 6}"/>`);

/**
 * opts.edit   – Editor: Raster, Auswahlrahmen, Anfasser
 * opts.sel    – id des ausgewählten Elements
 * opts.status – (nummer) => { cls: 'free'|'mine'|'other'|'none', sub: 'Text' } (Kasse)
 * opts.crop   – nur den belegten Ausschnitt zeigen (Kasse)
 */
export function planSvg(area, opts = {}) {
  const st = opts.status || (() => ({ cls: 'free', sub: '' }));
  const vb = opts.crop ? (() => { const b = bounds(area); const m = 24; return `${b.x - m} ${b.y - m} ${b.w + 2 * m} ${b.h + 2 * m}`; })() : `0 0 ${area.w} ${area.h}`;
  // Eingang zuletzt zeichnen, damit er zur Orientierung immer sichtbar bleibt
  const order = { zone: 0, slot: 1, counter: 2, table: 3, entrance: 4 };
  const els = [...area.elements].sort((a, b) => order[a.type] - order[b.type]);
  const out = [];
  for (const e of els) {
    const sel = opts.edit && opts.sel === e.id ? ' sel' : '';
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    if (e.type === 'zone') {
      out.push(`<g class="pe pe-zone${sel}" data-id="${esc(e.id)}">${shape(e)}
        <text class="zl" x="${e.x + 12}" y="${e.y + 26}">${esc(e.label || 'Terrasse')}</text></g>`);
    } else if (e.type === 'entrance') {
      const f = fs(e, 0.3, 13, 26);
      const wide = e.w >= e.h;
      // Pfeil als Form (Schriftzeichen-Pfeile sehen nicht auf jedem Gerät gleich aus)
      const ax = wide ? e.x + Math.max(16, f * 0.9) : cx, ay = wide ? cy : e.y + Math.max(16, f * 0.9);
      const arrow = `<path class="arr" d="M${ax - 4} ${ay - 10} h8 v8 h6 l-10 11 l-10 -11 h6 z"/>`;
      out.push(`<g class="pe pe-entrance${sel}" data-id="${esc(e.id)}">${shape(e)}${arrow}
        <text x="${wide ? cx + f * 0.5 : cx}" y="${wide ? cy + f * 0.35 : cy + f * 0.8}" font-size="${f}">${esc(e.label || 'Eingang')}</text></g>`);
    } else if (e.type === 'slot') {
      // Automat: buchbar wie ein Tisch (Nummer im „Bildschirm“), Belegung am Rahmen erkennbar
      const f = fs(e, 0.22, 11, 22);
      const s = e.number ? st(e.number) : { cls: 'none', sub: '' };
      out.push(`<g class="pe pe-slot ${s.cls}${sel}" data-id="${esc(e.id)}"${e.number ? ` data-n="${e.number}"` : ''}>${shape(e)}<rect class="slot-screen" x="${e.x + e.w * 0.14}" y="${e.y + e.h * 0.12}" width="${e.w * 0.72}" height="${e.h * 0.36}" rx="4"/>
        <text x="${cx}" y="${e.y + e.h * 0.12 + e.h * 0.36 * 0.5 + f * 0.36}" font-size="${f * 1.1}" class="slot-777">${e.number || '777'}</text>
        <text x="${cx}" y="${e.y + e.h * 0.72}" font-size="${f * 0.75}">${esc(fit(s.name || e.label || 'Automat', e.w, f * 0.75))}</text>
        ${s.sub ? `<text x="${cx}" y="${e.y + e.h * 0.9}" font-size="${f * 0.75}" class="slot-sum">${esc(s.sub)}</text>` : ''}</g>`);
    } else if (e.type === 'counter') {
      const f = fs(e, 0.34, 13, 26);
      const seats = seatPositions(e).map((p) => {
        const s = st(p.number);
        const ssel = opts.edit && opts.sel === e.id && opts.seat && opts.seat.side === p.side && opts.seat.i === p.i ? ' ssel' : '';
        const fz = String(p.number).length > 2 ? 11 : 14;
        return `<g class="seat ${s.cls}${ssel}" data-n="${p.number}" data-side="${p.side}" data-i="${p.i}"><circle cx="${p.cx}" cy="${p.cy}" r="${SEAT_R}"/><text x="${p.cx}" y="${p.cy + fz * 0.36}" font-size="${fz}">${p.number}</text></g>`;
      }).join('');
      out.push(`<g class="pe pe-counter${sel}" data-id="${esc(e.id)}">${shape(e)}
        <text x="${cx}" y="${cy + f * 0.35}" font-size="${f}">${esc(e.label || 'Tresen')}</text>${seats}</g>`);
    } else {
      const s = st(e.number);
      const f = fs(e);
      // Tisch: Nummer, darunter ggf. Gästename und offener Betrag (in eigenen Zeilen, passend gekürzt)
      const small = Math.max(11, f * 0.45);
      const lines = [s.name ? fit(s.name, e.w * (e.shape === 'circle' ? 0.8 : 0.92), small) : null, s.sub || null].filter(Boolean);
      const top = cy + f * 0.35 - (lines.length * small * 1.1) / 2;
      out.push(`<g class="pe pe-table ${s.cls}${sel}" data-id="${esc(e.id)}" data-n="${e.number}">${shape(e)}
        <text x="${cx}" y="${top}" font-size="${f}" class="tn">${e.number}</text>
        ${lines.map((l, k) => `<text x="${cx}" y="${top + f * 0.05 + small * 1.15 * (k + 1)}" font-size="${small}" class="ts${k === 0 && s.name ? ' tg' : ''}">${esc(l)}</text>`).join('')}</g>`);
    }
  }
  if (opts.edit && opts.sel) {
    const e = area.elements.find((x) => x.id === opts.sel);
    if (e) out.push(`<rect class="selbox" x="${e.x - 5}" y="${e.y - 5}" width="${e.w + 10}" height="${e.h + 10}" rx="8"/>
      <g class="hdl" data-h="1"><circle cx="${e.x + e.w}" cy="${e.y + e.h}" r="22"/><path d="M${e.x + e.w - 8} ${e.y + e.h + 8} L${e.x + e.w + 8} ${e.y + e.h - 8} M${e.x + e.w + 1} ${e.y + e.h + 8} L${e.x + e.w + 8} ${e.y + e.h + 1}"/></g>`);
  }
  const grid = opts.edit ? `<rect x="0" y="0" width="${area.w}" height="${area.h}" fill="url(#pgrid)"/>` : '';
  return `<svg class="plan-svg${opts.edit ? ' edit' : ''}" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <defs><pattern id="pgrid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" class="gl"/></pattern>
      <pattern id="pslot" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" class="ps1"/><rect width="6" height="14" class="ps2"/></pattern></defs>
    <rect class="floor" x="0" y="0" width="${area.w}" height="${area.h}"/>${grid}${out.join('')}</svg>`;
}
