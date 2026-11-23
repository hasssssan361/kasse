// Stammdaten-Übertragung: Gerät A exportiert, Gerät B (mit eigenen, abweichenden Daten) liest 1:1 ein.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, dispatch } from '../app/core/api.js';
import { nodeDriver } from './node-driver.js';
import { activateDevice } from './license-helper.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasse-transfer-'));
async function call(method, p, body, token) {
  const u = new URL(p, 'http://x');
  const r = await dispatch({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body || {}, token });
  return { s: r.status, j: r.file ? r.file.data : r.body, file: r.file };
}
const login = async (nr, pin, kind = 'admin') => (await call('POST', '/api/login', { personal_nr: nr, pin, device: 'Test', kind })).j.token;

test('Stammdaten von Gerät A nach Gerät B: verschlüsselt, 1:1 angeglichen, nichts gelöscht, protokolliert', async () => {
  // ---- Gerät A: Beispieldaten + Tischplan + geänderte Einstellung
  init(nodeDriver(path.join(dir, 'a.db')), { demo: true });
  const devA = await activateDevice(call);
  let adm = await login(1, '123456');
  await call('PUT', '/api/admin/settings', { business_name: 'Bar Nord' }, adm);
  await call('PUT', '/api/admin/plan', { areas: [{ name: 'Gastraum', w: 1200, h: 800, elements: [
    { id: 't', type: 'table', shape: 'square', x: 40, y: 40, w: 90, h: 90, number: 1, seats: 4 },
    { id: 'c', type: 'counter', x: 300, y: 300, w: 360, h: 70, seat_count: 2, seat_start: 301, seat_side: 'unten' }] }] }, adm);
  assert.equal((await call('POST', '/api/admin/master-export', { password: '123' }, adm)).s, 400, 'Passwort zu kurz');
  const exp = await call('POST', '/api/admin/master-export', { password: 'geheim42' }, adm);
  assert.equal(exp.s, 200, JSON.stringify(exp.j));
  assert.match(exp.file.filename, /^stammdaten-bar-nord-\d{4}-\d{2}-\d{2}\.json$/);
  const pkg = JSON.parse(exp.j);
  assert.equal(pkg.device, devA);
  assert.ok(!exp.j.includes('pbkdf2'), 'PIN-Daten stehen nicht lesbar in der Datei');
  assert.ok(!exp.j.includes('Cola'), 'Artikel stehen nicht lesbar in der Datei');
  const metaA = (await call('GET', '/api/admin/meta', null, adm)).j;

  // ---- Gerät B: eigener Admin-PIN, ein eigener Artikel, ein eigener Mitarbeiter, ein belegter Tisch
  init(nodeDriver(path.join(dir, 'b.db')));
  const devB = await activateDevice(call);
  assert.notEqual(devA, devB, 'jedes Gerät hat eine eigene Kennung');
  assert.equal((await call('POST', '/api/setup', { personal_nr: 1, name: 'Chef B', pin: '123456', pin2: '123456' })).s, 200, 'Ersteinrichtung auf Gerät B');
  adm = await login(1, '123456');
  const cat = (await call('POST', '/api/admin/categories', { name: 'Eigenes', kind: 'getraenk', color: '#123456' }, adm)).j.id;
  await call('POST', '/api/admin/articles', { name: 'Hausschnaps', category_id: cat, price: 300, vat: 19 }, adm);
  await call('POST', '/api/admin/users', { personal_nr: 77, name: 'Nur auf B', role: 'mitarbeiter', pin: '7777' }, adm);
  const t99 = (await call('POST', '/api/admin/tables', { number: 99, area: 'Gastraum', seats: 2 }, adm)).j.id;
  const b77 = await login(77, '7777', 'kasse');
  assert.ok(b77, 'Mitarbeiter 77 kann sich auf B anmelden');
  const art = (await call('GET', '/api/pos/bootstrap', null, b77)).j.articles[0];
  assert.equal((await call('POST', '/api/pos/items', { table_id: t99, article_id: art.id, qty: 1 }, b77)).s, 200);

  // Falsches Passwort
  const bad = await call('POST', '/api/admin/master-import', { package: pkg, password: 'falsch99', dryRun: true }, adm);
  assert.equal(bad.s, 400);
  assert.match(bad.j.error, /Passwort/);
  // Vorschau ändert nichts
  const before = (await call('GET', '/api/admin/meta', null, adm)).j;
  const dry = await call('POST', '/api/admin/master-import', { package: pkg, password: 'geheim42', dryRun: true }, adm);
  assert.equal(dry.s, 200, JSON.stringify(dry.j));
  assert.ok(dry.j.neu.artikel > 10);
  assert.equal(dry.j.deaktiviert.artikel, 1);
  assert.equal((await call('GET', '/api/admin/meta', null, adm)).j.articles.length, before.articles.length, 'Vorschau ändert nichts');
  assert.equal((await call('GET', '/api/admin/audit?type=MASTER_IMPORTED', null, adm)).j.rows.length, 0);

  // Übernahme
  const imp = await call('POST', '/api/admin/master-import', { package: pkg, password: 'geheim42' }, adm);
  assert.equal(imp.s, 200, JSON.stringify(imp.j));
  assert.ok(imp.j.hinweise.some((h) => /Tisch 99/.test(h)), 'belegter Tisch bleibt aktiv (Hinweis)');
  const metaB = (await call('GET', '/api/admin/meta', null, adm)).j;
  const act = (m) => m.articles.filter((a) => a.active).map((a) => `${a.name}:${a.price}`).sort();
  assert.deepEqual(act(metaB), act(metaA), 'aktive Artikel identisch');
  assert.equal(metaB.settings.business_name, 'Bar Nord');
  assert.deepEqual(metaB.plan, metaA.plan, 'Tischplan identisch');
  assert.ok(metaB.articles.find((a) => a.name === 'Hausschnaps' && !a.active), 'eigener Artikel deaktiviert, nicht gelöscht');
  assert.ok(metaB.tables.find((t) => t.number === 99 && t.active), 'belegter Tisch bleibt aktiv');
  assert.ok(metaB.tables.find((t) => t.number === 302 && t.active), 'Tresenplatz aus dem Plan vorhanden');
  // Mitarbeiter mit PINs von Gerät A
  assert.ok(await login(10, '1010', 'kasse'), 'Anna (von A) meldet sich auf B mit ihrer PIN an');
  assert.equal((await call('POST', '/api/login', { personal_nr: 77, pin: '7777', device: 'x', kind: 'kasse' })).s >= 400, true, 'Mitarbeiter nur auf B ist deaktiviert');
  // Protokolliert, Prüfkette intakt
  assert.equal((await call('GET', '/api/admin/audit?type=MASTER_IMPORTED', null, adm)).j.rows.length, 1);
  const integ = (await call('GET', '/api/admin/integrity', null, adm)).j;
  assert.equal(integ.ok, true, JSON.stringify(integ.problems));
  // Zweites Einlesen ändert nichts mehr
  const again = (await call('POST', '/api/admin/master-import', { package: pkg, password: 'geheim42', dryRun: true }, adm)).j;
  assert.deepEqual([again.neu, again.geaendert, again.deaktiviert], [{}, {}, {}]);
});
