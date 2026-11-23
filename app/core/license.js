// Lizenzprüfung: Jedes Gerät braucht einen Freischaltcode, der genau zu seiner Gerätekennung passt.
// Der Code ist mit dem geheimen Schlüssel des Anbieters digital unterschrieben (ECDSA P-256);
// die App enthält nur den öffentlichen Schlüssel und kann damit prüfen, aber keine Codes erzeugen.
// Ohne gültigen Code beantwortet der Rechenkern nur die Lizenz-Anfragen.
import { one, run, tx } from './db.js';
import { logEvent } from './audit.js';
import { randomBytes, base64url } from './crypto.js';
import { fail } from './util.js';

let PUBLIC_KEY = { kty: 'EC', crv: 'P-256', x: 'QDfAQdabsg6N3PWVEhpJ_EiFbSHn6rLpGcOYgrqgHAY', y: 'G4j_2D5bNmpWcjRgjdpEOn6KR4rLtAQ37hpdtICD_j0' };
// Nur für die automatischen Tests (eigenes Schlüsselpaar)
export function setLicensePublicKey(jwk) { PUBLIC_KEY = jwk; keyPromise = null; state = null; }
export function resetLicenseCache() { state = null; }

const SYSTEM = { user: null, device: 'Kassengerät' };
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I – gut abzutippen
let keyPromise = null;
let state = null; // zwischengespeichertes Prüfergebnis

// Gerätekennung: einmal zufällig erzeugt und in der Datenbank des Geräts gespeichert
export function deviceId() {
  const r = one("SELECT value FROM meta WHERE key='device_id'");
  if (r) return r.value;
  const b = randomBytes(16);
  const s = Array.from(b, (x) => ALPHA[x % 32]).join('');
  const id = s.match(/.{4}/g).join('-');
  run("INSERT INTO meta(key,value) VALUES('device_id',?)", id);
  return id;
}

const fromB64 = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

// Prüft einen Code. Ergebnis: { ok, payload?, error? }
export async function verifyCode(code, dev = deviceId()) {
  try {
    const clean = String(code || '').replace(/\s+/g, '');
    const [p, s] = clean.split('.');
    if (!p || !s) return { ok: false, error: 'Der Freischaltcode ist unvollständig. Bitte komplett einfügen.' };
    keyPromise ||= globalThis.crypto.subtle.importKey('jwk', PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const good = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await keyPromise, fromB64(s), new TextEncoder().encode(p));
    if (!good) return { ok: false, error: 'Der Freischaltcode ist ungültig.' };
    const payload = JSON.parse(new TextDecoder().decode(fromB64(p)));
    if (payload.d !== dev) return { ok: false, error: `Dieser Code gehört zu einem anderen Gerät (${payload.d}). Dieses Gerät: ${dev}` };
    if (payload.e && today() > payload.e) return { ok: false, payload, error: `Die Lizenz ist am ${payload.e.split('-').reverse().join('.')} abgelaufen.` };
    return { ok: true, payload };
  } catch {
    return { ok: false, error: 'Der Freischaltcode ist ungültig.' };
  }
}

export async function licenseStatus() {
  if (state && (!state.payload?.e || today() <= state.payload.e)) return state;
  const dev = deviceId();
  const r = one("SELECT value FROM meta WHERE key='license'");
  if (!r) return (state = { licensed: false, device_id: dev });
  const v = await verifyCode(r.value, dev);
  state = v.ok
    ? { licensed: true, device_id: dev, business: v.payload.b, issued: v.payload.t, expires: v.payload.e || null, payload: v.payload }
    : { licensed: false, device_id: dev, error: v.error, payload: v.payload };
  return state;
}
export const publicStatus = (s) => ({ licensed: s.licensed, device_id: s.device_id, business: s.business || null, issued: s.issued || null, expires: s.expires || null, error: s.error || null });

export async function activate(code) {
  const dev = deviceId();
  const v = await verifyCode(code, dev);
  if (!v.ok) fail(400, v.error);
  tx(() => {
    run("INSERT INTO meta(key,value) VALUES('license',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(code).replace(/\s+/g, ''));
    logEvent(SYSTEM, { type: 'LICENSE_ACTIVATED', category: 'system', after: { geraet: dev, betrieb: v.payload.b, ausgestellt: v.payload.t, gueltig_bis: v.payload.e || 'unbegrenzt' } });
  });
  state = null;
  return publicStatus(await licenseStatus());
}

// Hilfsfunktion für Tests und das Freischalt-Werkzeug: Code aus Nutzdaten + Signatur zusammensetzen
export const encodePayload = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
