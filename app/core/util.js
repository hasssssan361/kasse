// Hilfsfunktionen: Zeit (Europe/Berlin), Geld, Fehler
import { sha256 as sha, uuid as rid } from './crypto.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export const uuid = () => rid();
export const sha256 = (s) => sha(s);

// Serverseitiger Zeitstempel (UTC, Millisekunden)
export const nowIso = () => new Date().toISOString();

const TZ = 'Europe/Berlin';
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function berlinParts(date) {
  const o = {};
  for (const p of partsFmt.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
// Ortszeit Berlin -> UTC-Date
export function berlinToUtc(y, mo, d, h = 0, mi = 0) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = berlinParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= asUtc - target;
  }
  return new Date(guess);
}
export function fmtBerlin(iso, withSeconds = true) {
  if (!iso) return '';
  const p = berlinParts(new Date(iso));
  const z = (n) => String(n).padStart(2, '0');
  return `${z(p.day)}.${z(p.month)}.${p.year} ${z(p.hour)}:${z(p.minute)}${withSeconds ? ':' + z(p.second) : ''}`;
}
// Geschäftstag (Beginn z. B. 04:00 Uhr, damit Nachtschichten zum Vortag zählen)
export function businessDate(iso, startHour) {
  const d = new Date(new Date(iso).getTime());
  const p = berlinParts(d);
  let dt = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour < startHour) dt = new Date(dt.getTime() - 86400000);
  return dt.toISOString().slice(0, 10);
}
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) fail(400, 'Ungültiges Datum (erwartet JJJJ-MM-TT)');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const addDays = (y, m, d, n) => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};
// Zeitraum Tag / Woche (Mo–So) / Monat als [vonIso, bisIso)
export function periodRange(period, dateStr, startHour = 4) {
  let [y, m, d] = parseDate(dateStr);
  let start, end;
  if (period === 'week') {
    const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mo=0
    start = addDays(y, m, d, -wd);
    end = addDays(...start, 7);
  } else if (period === 'month') {
    start = [y, m, 1];
    end = m === 12 ? [y + 1, 1, 1] : [y, m + 1, 1];
  } else {
    start = [y, m, d];
    end = addDays(y, m, d, 1);
  }
  return [berlinToUtc(...start, startHour).toISOString(), berlinToUtc(...end, startHour).toISOString()];
}
export function rangeFromQuery(q, startHour) {
  if (q.from || q.to) {
    const from = q.from ? periodRange('day', q.from, startHour)[0] : '0000';
    const to = q.to ? periodRange('day', q.to, startHour)[1] : '9999';
    return [from, to];
  }
  if (q.date) return periodRange(q.period || 'day', q.date, startHour);
  return ['0000', '9999'];
}
export const todayBerlin = (startHour = 4) => businessDate(nowIso(), startHour);

export const euro = (cents) =>
  ((cents || 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export const int = (v, name, { min = -Infinity, max = Infinity, optional = false } = {}) => {
  if ((v === undefined || v === null || v === '') && optional) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `Ungültiger Wert für ${name}`);
  return n;
};
export const str = (v, name, { max = 500, optional = false, min = 0 } = {}) => {
  if ((v === undefined || v === null || String(v).trim() === '') && optional) return null;
  const s = String(v ?? '').trim();
  if (s.length < Math.max(min, 1) || s.length > max) fail(400, `Bitte ${name} angeben`);
  return s;
};
