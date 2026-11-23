// Update-Sicherheit: Eine Datenbank aus der bisherigen App-Version (test/fixtures/db-v1.sqlite3, erzeugt mit
// Stand 6f0b12a: Buchungen, Storno, Tagesabschluss, offener Tisch) wird mit der neuen Version geöffnet.
// Es darf nichts verloren gehen, die Prüfkette muss gültig bleiben, neue Funktionen müssen gehen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, dispatch } from '../app/core/api.js';
import { nodeDriver } from './node-driver.js';
import { activateDevice, makeCode } from './license-helper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Datenbank der Vorversion wird beim Update erweitert, ohne Datenverlust', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasse-migration-'));
  const file = path.join(dir, 'kasse.db');
  fs.copyFileSync(path.join(here, 'fixtures', 'db-v1.sqlite3'), file);
  init(nodeDriver(file));
  const call = async (method, p, body, token) => {
    const u = new URL(p, 'http://x');
    const r = await dispatch({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body || {}, token });
    return { s: r.status, j: r.body };
  };
  // Nach dem Update ist das Gerät gesperrt, bis es freigeschaltet ist – die Daten bleiben dabei unangetastet
  const locked = await call('POST', '/api/login', { personal_nr: 1, pin: '123456', kind: 'admin' });
  assert.equal(locked.s, 403);
  assert.equal(locked.j.unlicensed, true);
  await activateDevice(call);
  const admin = (await call('POST', '/api/login', { personal_nr: 1, pin: '123456', kind: 'admin' })).j.token;
  const anna = (await call('POST', '/api/login', { personal_nr: 10, pin: '1010', kind: 'kasse' })).j.token;
  assert.ok(admin && anna, 'Anmeldung mit vorhandenen Benutzern');

  // Vorhandene Daten unverändert, Prüfkette gültig
  const integ = (await call('GET', '/api/admin/integrity', null, admin)).j;
  assert.equal(integ.ok, true, JSON.stringify(integ.problems));
  assert.ok(integ.events >= 15);
  assert.equal((await call('GET', '/api/admin/invoices', null, admin)).j.length, 1);
  assert.equal((await call('GET', '/api/admin/closings', null, admin)).j.length, 1);
  const stornos = (await call('GET', '/api/admin/cancellations?from=2000-01-01&to=2999-01-01', null, admin)).j;
  assert.equal(stornos.length, 1, 'alter Storno bleibt ein normaler Storno');
  const boot = (await call('GET', '/api/pos/bootstrap', null, anna)).j;
  const t2 = boot.tables.find((t) => t.number === 2);
  assert.ok(t2.order_id, 'offener Tisch aus der Vorversion ist noch offen');

  // Neue Funktionen auf der alten Datenbank
  const cat = boot.categories[0].id;
  const a = (await call('POST', '/api/admin/articles', { name: 'Bacardi', category_id: cat, price: 0, vat: 19,
    variants: [{ name: 'Shot', price: 400 }, { name: 'Longdrink', price: 750 }] }, admin)).j;
  const v = (await call('GET', '/api/pos/bootstrap', null, anna)).j.variants.find((x) => x.article_id === a.id);
  assert.equal((await call('POST', '/api/pos/items', { table_id: t2.id, article_id: a.id, variant_id: v.id }, anna)).s, 200);
  const ec = await call('POST', `/api/pos/orders/${t2.order_id}/ec-pay`, {}, anna);
  assert.equal(ec.s, 200, JSON.stringify(ec.j));
  assert.equal(ec.j.closed, true);
  const after = (await call('GET', '/api/admin/integrity', null, admin)).j;
  assert.equal(after.ok, true, JSON.stringify(after.problems));
  assert.equal(after.triggers, integ.triggers);

  // Zweites Öffnen (App-Neustart) ändert nichts mehr
  init(nodeDriver(file));
  const again = (await call('GET', '/api/admin/integrity', null, (await call('POST', '/api/login', { personal_nr: 1, pin: '123456', kind: 'admin' })).j.token)).j;
  assert.equal(again.ok, true, JSON.stringify(again.problems));
});
