// Test-Lizenzen: eigenes Schlüsselpaar nur für die Tests (der echte geheime Schlüssel liegt nie im Projekt).
import { setLicensePublicKey, encodePayload } from '../app/core/license.js';
import { base64url } from '../app/core/crypto.js';

const { subtle } = globalThis.crypto;
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await subtle.exportKey('jwk', kp.publicKey);
setLicensePublicKey({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });

export async function makeCode(deviceId, business = 'Testbetrieb', expires = null) {
  const p = encodePayload({ v: 1, d: deviceId, b: business, t: '2026-11-23', e: expires });
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(p)));
  return `${p}.${base64url(sig)}`;
}

// Gerät im Test freischalten; call(method, path, body) wie in den Tests
export async function activateDevice(call) {
  const st = await call('GET', '/api/license');
  const body = st.j ?? st.body;
  const r = await call('POST', '/api/license', { code: await makeCode(body.device_id) });
  if ((r.s ?? r.status) !== 200) throw new Error('Freischaltung im Test fehlgeschlagen: ' + JSON.stringify(r.j ?? r.body));
  return body.device_id;
}
