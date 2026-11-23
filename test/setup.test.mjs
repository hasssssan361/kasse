// Neues Gerät beim Kunden: freischalten → eigene Admin-Zugangsdaten festlegen (einmalig) → anmelden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, dispatch } from '../app/core/api.js';
import { nodeDriver } from './node-driver.js';
import { activateDevice } from './license-helper.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasse-setup-'));
async function call(method, p, body, token) {
  const u = new URL(p, 'http://x');
  const r = await dispatch({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body || {}, token });
  return { s: r.status, j: r.body };
}
const login = (nr, pin) => call('POST', '/api/login', { personal_nr: nr, pin, device: 'Test', kind: 'admin' });

test('Blanko-Gerät: Ersteinrichtung mit frei wählbaren Zugangsdaten, nur einmal, Standard-PIN gesperrt', async () => {
  init(nodeDriver(path.join(dir, 'neu.db')));
  // Vor der Freischaltung: weder Einrichtung noch Anmeldung
  assert.equal((await call('POST', '/api/setup', { personal_nr: 5, name: 'X', pin: '111111', pin2: '111111' })).s, 403);
  await activateDevice(call);
  const st = (await call('GET', '/api/license')).j;
  assert.equal(st.setup_required, true);
  // Blanko: keine Artikel, Kategorien, Tische, kein Tischplan
  // Vorläufiger Zugang 1/123456 ist gesperrt
  const blocked = await login(1, '123456');
  assert.equal(blocked.s, 403);
  assert.equal(blocked.j.setup_required, true);
  // Fehleingaben
  assert.match((await call('POST', '/api/setup', { personal_nr: 7, name: 'Chef', pin: '1234', pin2: '1234' })).j.error, /6–12 Ziffern/);
  assert.match((await call('POST', '/api/setup', { personal_nr: 7, name: 'Chef', pin: '246813', pin2: '246814' })).j.error, /stimmen nicht/);
  // Einrichtung
  const ok = await call('POST', '/api/setup', { personal_nr: 7, name: 'Chef Bar Süd', pin: '246813', pin2: '246813' });
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
  assert.equal((await call('GET', '/api/license')).j.setup_required, false);
  assert.equal((await login(1, '123456')).s >= 400, true, 'alter Zugang funktioniert nicht mehr');
  const r = await login(7, '246813');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const adm = r.j.token;
  // Nur einmal möglich
  assert.equal((await call('POST', '/api/setup', { personal_nr: 8, name: 'Fremd', pin: '999999', pin2: '999999' })).s, 409);
  // Danach normal unter Verwaltung änderbar
  const me = (await call('GET', '/api/admin/users', null, adm)).j.find((u) => u.personal_nr === 7);
  assert.equal(me.name, 'Chef Bar Süd');
  assert.equal((await call('PUT', `/api/admin/users/${me.id}`, { personal_nr: 7, name: 'Chef', role: 'admin', pin: '135790' }, adm)).s, 200);
  assert.equal((await login(7, '135790')).s, 200);
  // Leer ausgeliefert
  const meta = (await call('GET', '/api/admin/meta', null, adm)).j;
  assert.deepEqual([meta.categories.length, meta.articles.length, meta.tables.length, meta.plan.areas.length], [0, 0, 0, 0]);
  // Protokolliert, Prüfkette intakt
  assert.equal((await call('GET', '/api/admin/audit?type=SETUP_COMPLETED', null, adm)).j.rows.length, 1);
  assert.equal((await call('GET', '/api/admin/integrity', null, adm)).j.ok, true);
  // Neustart der App: bleibt eingerichtet
  init(nodeDriver(path.join(dir, 'neu.db')));
  assert.equal((await call('GET', '/api/license')).j.setup_required, false);
});
