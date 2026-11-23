// Automatische Tests: Ablauf, Rechte, Freigaben, Warnsystem und Manipulationsversuche.
// Start:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { init, dispatch } from '../app/core/api.js';
import { nodeDriver } from './node-driver.js';
import { activateDevice, makeCode } from './license-helper.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasse-test-'));
const T = {};
let boot;

// Ruft die App-Schnittstelle direkt auf (wie die Oberfläche im Gerät)
async function call(method, p, body, token, headers = {}) {
  const u = new URL(p, 'http://x');
  const r = await dispatch({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body || {}, token, idem: headers['idempotency-key'] || null });
  return { s: r.status, j: r.file ? r.file.data : r.body, file: r.file };
}
const login = async (nr, pin, kind = 'kasse') => {
  const r = await call('POST', '/api/login', { personal_nr: nr, pin, device: 'Testgerät', kind });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  return r.j.token;
};
const art = (name) => boot.articles.find((a) => a.name.startsWith(name));
const tab = (n) => boot.tables.find((t) => t.number === n);

before(async () => {
  init(nodeDriver(path.join(dir, 'kasse.db')), { demo: true });
  await activateDevice(call);
  T.anna = await login(10, '1010');
  T.ben = await login(11, '1111');
  T.sabine = await login(2, '2222');
  T.admin = await login(1, '123456', 'admin');
  T.adminPos = await login(1, '123456', 'kasse');
  boot = (await call('GET', '/api/pos/bootstrap', null, T.anna)).j;
});
after(() => {});

test('Anwendungsfall 13: Tisch 12 → Storno → Verschiebung → Übernahme → Abschluss vollständig nachvollziehbar', async () => {
  const cola = art('Cola 0,33');
  const pizza = art('Pizza Margherita');
  const a = await call('POST', '/api/pos/items', { table_id: tab(12).id, article_id: cola.id, qty: 2 }, T.anna);
  assert.equal(a.s, 200);
  const p = await call('POST', '/api/pos/items', { table_id: tab(12).id, article_id: pizza.id }, T.anna);
  const st = await call('POST', `/api/pos/items/${a.j.item.id}/cancel`, { qty: 1, reason: 'Gast hat abbestellt' }, T.anna);
  assert.equal(st.s, 200, JSON.stringify(st.j));
  const mv = await call('POST', '/api/pos/move', { items: [{ item_id: p.j.item.id, qty: 1 }], to_table_id: tab(15).id, reason: 'umgesetzt' }, T.anna);
  assert.equal(mv.s, 200);
  const o15 = (await call('GET', `/api/pos/tables/${tab(15).id}`, null, T.ben)).j;
  assert.equal((await call('POST', `/api/pos/orders/${o15.order.id}/takeover`, {}, T.ben)).s, 200);
  const pay = await call('POST', `/api/pos/orders/${o15.order.id}/pay`, { method: 'Bar', given: 2000 }, T.ben);
  assert.equal(pay.s, 200);
  assert.equal(pay.j.total, 1050);
  assert.equal(pay.j.change, 950);
  assert.equal(pay.j.closed, true);

  // Lebenslauf der Pizza: Eingabe Tisch 12 durch Anna, Verschiebung 12→15, Übernahme, Rechnung durch Ben
  const lc = (await call('GET', `/api/admin/lifecycle/${p.j.item.id}`, null, T.admin)).j;
  const types = lc.events.map((e) => e.type);
  for (const t of ['ITEM_ADDED', 'ITEM_MOVED', 'TABLE_TAKEOVER', 'INVOICE_CREATED', 'TABLE_CLOSED']) assert.ok(types.includes(t), `fehlt ${t}`);
  const added = lc.events.find((e) => e.type === 'ITEM_ADDED');
  assert.equal(added.table_no, 12);
  assert.equal(added.user_name, 'Anna Service');
  const moved = lc.events.find((e) => e.type === 'ITEM_MOVED');
  assert.equal(moved.table_no, 12);
  assert.equal(moved.target_table_no, 15);
  assert.equal(lc.invoices[0].table_no, 15);

  // Tisch-12-Historie zeigt beide Colas, den Storno und die verschobene Pizza (nicht nur den Endzustand)
  const h12 = (await call('GET', `/api/admin/orders/${a.j.order_id}`, null, T.admin)).j;
  assert.equal(h12.cancellations.length, 1);
  assert.equal(h12.cancellations[0].reason, 'Gast hat abbestellt');
  assert.equal(h12.moves_out.length, 1);
  const colaRow = h12.items.find((i) => i.article_name.startsWith('Cola'));
  assert.equal(colaRow.qty, 2);
  assert.equal(colaRow.cancelled_qty, 1);
});

test('Es gibt keine Lösch-Funktion: DELETE-Anfragen werden nicht angeboten', async () => {
  for (const p of ['/api/pos/items/1', '/api/admin/audit/1', '/api/admin/invoices/1', '/api/admin/users/3']) {
    const r = await call('DELETE', p, null, T.admin);
    assert.equal(r.s, 404, p);
  }
});

test('Rechte: Mitarbeiter kommen nicht ins Dashboard; Kassen-Sitzung des Admins auch nicht', async () => {
  assert.equal((await call('GET', '/api/admin/audit', null, T.anna)).s, 403);
  assert.equal((await call('GET', '/api/admin/audit', null, T.adminPos)).s, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { storno_approval_always: 0 }, T.sabine)).s, 403);
  assert.equal((await call('POST', '/api/login', { personal_nr: 10, pin: '1010', device: 'x', kind: 'admin' })).s, 403);
  assert.equal((await call('GET', '/api/pos/tables', null, 'falsch')).s, 401);
});

test('Storno: Grund ist Pflicht, Menge nie größer als offen, große Beträge brauchen Freigabe', async () => {
  const steak = art('Rinderhüftsteak');
  const it = (await call('POST', '/api/pos/items', { table_id: tab(3).id, article_id: steak.id, qty: 1 }, T.anna)).j.item;
  assert.equal((await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 1, reason: '' }, T.anna)).s, 400);
  assert.equal((await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 2, reason: 'zu viel' }, T.anna)).s, 409);
  const need = await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 1, reason: 'Reklamation' }, T.anna);
  assert.equal(need.s, 409);
  assert.equal(need.j.needs_approval, true);
  // anderer Mitarbeiter darf nicht freigeben
  const bad = await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 1, reason: 'Reklamation', approver: { personal_nr: 11, pin: '1111' } }, T.anna);
  assert.equal(bad.s, 403);
  // falsche PIN → 403 (nicht 401, sonst würde die Kasse abgemeldet)
  const wrong = await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 1, reason: 'Reklamation', approver: { personal_nr: 2, pin: '0000' } }, T.anna);
  assert.equal(wrong.s, 403);
  assert.equal(wrong.j.needs_approval, true);
  const ok = await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 1, reason: 'Reklamation', approver: { personal_nr: 2, pin: '2222' } }, T.anna);
  assert.equal(ok.s, 200);
  const c = (await call('GET', '/api/admin/cancellations?from=2000-01-01&to=2999-01-01', null, T.admin)).j.find((x) => x.item_id === it.id);
  assert.equal(c.approved_by_name, 'Sabine Schichtleitung');
  assert.equal(c.entered_by_name, 'Anna Service');
  assert.equal(c.cancelled_by_name, 'Anna Service');
  assert.equal(c.total, steak.price);
  // fehlgeschlagene Freigaben sind protokolliert
  const fails = (await call('GET', '/api/admin/audit?type=APPROVAL_FAILED', null, T.admin)).j;
  assert.ok(fails.total >= 2);
});

test('Doppelte Übermittlung (Verbindungsabbruch) bucht nur einmal', async () => {
  const key = 'test-idem-1';
  const b = { table_id: tab(4).id, article_id: art('Espresso').id, qty: 1 };
  const r1 = await call('POST', '/api/pos/items', b, T.anna, { 'idempotency-key': key });
  const r2 = await call('POST', '/api/pos/items', b, T.anna, { 'idempotency-key': key });
  assert.equal(r1.j.item.id, r2.j.item.id);
  const o = (await call('GET', `/api/pos/tables/${tab(4).id}`, null, T.anna)).j;
  assert.equal(o.items.length, 1);
});

test('Preisänderung nur mit Freigabe und Grund; danach unveränderbar protokolliert', async () => {
  const it = (await call('POST', '/api/pos/items', { table_id: tab(5).id, article_id: art('Pils').id, qty: 2 }, T.anna)).j.item;
  assert.equal((await call('POST', `/api/pos/items/${it.id}/price`, { new_price: 0, reason: 'Personal' }, T.anna)).j.needs_approval, true);
  const r = await call('POST', `/api/pos/items/${it.id}/price`, { new_price: 0, reason: 'Personal', approver: { personal_nr: 2, pin: '2222' } }, T.anna);
  assert.equal(r.s, 200);
  const pc = (await call('GET', '/api/admin/price-changes?from=2000-01-01&to=2999-01-01', null, T.admin)).j[0];
  assert.equal(pc.old_price, art('Pils').price);
  assert.equal(pc.new_price, 0);
  const al = (await call('GET', '/api/admin/alerts', null, T.admin)).j;
  assert.ok(al.some((a) => a.rule === 'preissenkung'));
});

test('Teilzahlung, Wiedereröffnung mit Stornorechnung, Originalrechnung bleibt unverändert', async () => {
  const t = tab(6);
  await call('POST', '/api/pos/items', { table_id: t.id, article_id: art('Tiramisu').id, qty: 2 }, T.anna);
  const second = (await call('POST', '/api/pos/items', { table_id: t.id, article_id: art('Tee').id, qty: 1 }, T.anna)).j;
  const part = await call('POST', `/api/pos/orders/${second.order_id}/pay`, { method: 'Kreditkarte', items: [{ item_id: second.item.id, qty: 1 }] }, T.anna);
  assert.equal(part.j.closed, false);
  const rest = await call('POST', `/api/pos/orders/${second.order_id}/pay`, { method: 'Bar' }, T.anna);
  assert.equal(rest.j.closed, true);
  const before = (await call('GET', `/api/admin/invoices/${rest.j.invoice_id}`, null, T.admin)).j;
  const re = await call('POST', `/api/pos/invoices/${rest.j.invoice_id}/reopen`, { reason: 'Falsche Zahlungsart', approver: { personal_nr: 2, pin: '2222' } }, T.anna);
  assert.equal(re.s, 200, JSON.stringify(re.j));
  const again = await call('POST', `/api/pos/invoices/${rest.j.invoice_id}/reopen`, { reason: 'nochmal', approver: { personal_nr: 2, pin: '2222' } }, T.anna);
  assert.equal(again.s, 409);
  const afterInv = (await call('GET', `/api/admin/invoices/${rest.j.invoice_id}`, null, T.admin)).j;
  assert.equal(afterInv.hash, before.hash);
  assert.equal(afterInv.total, before.total);
  assert.equal(afterInv.reversed_by.invoice_no, re.j.storno_invoice_no);
  const o = (await call('GET', `/api/pos/tables/${t.id}`, null, T.anna)).j;
  assert.equal(o.open_total, 2 * art('Tiramisu').price);
  const fin = await call('POST', `/api/pos/orders/${o.order.id}/pay`, { method: 'Kreditkarte' }, T.anna);
  assert.equal(fin.j.closed, true);
  // Rechnungsnummern lückenlos
  const inv = (await call('GET', '/api/admin/invoices', null, T.admin)).j.map((i) => i.invoice_no).sort();
  inv.forEach((no, i) => assert.equal(Number(no.split('-')[1]), i + 1));
});

test('Warnsystem: Artikel eingegeben und sofort wieder entfernt', async () => {
  for (let i = 0; i < 3; i++) {
    const it = (await call('POST', '/api/pos/items', { table_id: tab(7).id, article_id: art('Cola Zero').id }, T.ben)).j.item;
    assert.equal((await call('POST', `/api/pos/items/${it.id}/cancel`, { qty: 1, reason: 'Falsch eingegeben' }, T.ben)).s, 200);
  }
  await new Promise((r) => setTimeout(r, 50));
  const al = (await call('GET', '/api/admin/alerts?status=offen', null, T.admin)).j;
  assert.ok(al.some((a) => a.rule === 'sofortstorno' && a.user_name === 'Ben Service'), JSON.stringify(al.map((a) => a.rule)));
  // Warnung kann nur einmal geprüft werden, bleibt aber erhalten
  const a = al[0];
  assert.equal((await call('POST', `/api/admin/alerts/${a.id}/ack`, { note: 'geklärt' }, T.admin)).s, 200);
  assert.equal((await call('POST', `/api/admin/alerts/${a.id}/ack`, { note: 'nochmal' }, T.admin)).s, 409);
});

test('Mitarbeiter-Auswertung und Export enthalten Stornos', async () => {
  const emp = (await call('GET', '/api/admin/employees?period=month&date=' + new Date().toISOString().slice(0, 10), null, T.admin)).j;
  const ben = emp.rows.find((r) => r.name === 'Ben Service');
  assert.ok(ben.stornos >= 3);
  assert.ok(ben.sofortstornos >= 3);
  const text = (await call('GET', '/api/admin/export/cancellations?from=2000-01-01&to=2999-01-01&format=csv', null, T.admin)).j;
  assert.ok(text.includes('Gast hat abbestellt'));
  const buf = Buffer.from((await call('GET', '/api/admin/export/audit?format=pdf', null, T.admin)).j);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
});

test('Admin-Eingriffe (Preis, Einstellungen, Benutzer) werden mit Vorher/Nachher protokolliert', async () => {
  const a = art('Weizen');
  const r = await call('PUT', `/api/admin/articles/${a.id}`, { ...a, price: a.price + 20 }, T.admin);
  assert.equal(r.s, 200);
  const ev = (await call('GET', '/api/admin/audit?type=ARTICLE_PRICE_CHANGED', null, T.admin)).j.rows[0];
  assert.equal(JSON.parse(ev.before_json).price, a.price);
  assert.equal(JSON.parse(ev.after_json).price, a.price + 20);
  assert.equal(ev.user_name, 'Inhaber (Admin)');
  assert.equal((await call('PUT', '/api/admin/settings', { alert_storno_count_day: 7 }, T.admin)).j.changed, 1);
  const s = (await call('GET', '/api/admin/audit?type=SETTINGS_UPDATED', null, T.admin)).j.rows[0];
  assert.equal(JSON.parse(s.before_json).alert_storno_count_day, 5);
  // letzter Administrator kann sich nicht selbst entmachten
  assert.equal((await call('PUT', '/api/admin/users/1', { personal_nr: 1, name: 'x', role: 'mitarbeiter', active: 1 }, T.admin)).s, 409);
  // Admin-PIN muss mindestens 6 Ziffern haben
  assert.equal((await call('POST', '/api/admin/users', { personal_nr: 50, name: 'Neu', role: 'admin', pin: '1234' }, T.admin)).s, 400);
});

test('Mit EC zahlen: alle Artikel werden storniert, getrennt geführt, ohne Storno-Warnungen', async () => {
  const t = tab(13);
  const c = (await call('POST', '/api/pos/items', { table_id: t.id, article_id: art('Cola 0').id, qty: 2 }, T.anna)).j;
  await call('POST', '/api/pos/items', { table_id: t.id, article_id: art('Pizza Salami').id, qty: 1 }, T.anna);
  // Normaler Bezahlweg mit EC ist gesperrt – EC nur über „Mit EC zahlen“
  assert.equal((await call('POST', `/api/pos/orders/${c.order_id}/pay`, { method: 'EC-Karte' }, T.anna)).s, 400);
  const alertsBefore = (await call('GET', '/api/admin/alerts', null, T.admin)).j.length;
  const stornosBefore = (await call('GET', '/api/admin/cancellations?from=2000-01-01&to=2999-01-01', null, T.admin)).j.length;
  const r = await call('POST', `/api/pos/orders/${c.order_id}/ec-pay`, {}, T.anna);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.closed, true);
  assert.equal(r.j.total, 2 * art('Cola 0').price + art('Pizza Salami').price);
  // Getrennt: normale Storno-Liste unverändert, EC-Liste mit Vermerk
  assert.equal((await call('GET', '/api/admin/cancellations?from=2000-01-01&to=2999-01-01', null, T.admin)).j.length, stornosBefore);
  const ec = (await call('GET', '/api/admin/cancellations?from=2000-01-01&to=2999-01-01&kind=ec', null, T.admin)).j.filter((x) => x.order_id === c.order_id);
  assert.equal(ec.length, 2);
  assert.ok(ec.every((x) => x.reason === 'Mit EC bezahlt – daher storniert' && x.kind === 'ec'));
  assert.equal((await call('GET', '/api/admin/alerts', null, T.admin)).j.length, alertsBefore, 'EC-Stornos lösen keine Warnungen aus');
  // Tisch ist frei, Nullbeleg mit Zahlungsart EC, Protokoll vollständig
  assert.equal((await call('GET', `/api/pos/tables/${t.id}`, null, T.anna)).j.order, null);
  const inv = (await call('GET', '/api/admin/invoices', null, T.admin)).j.find((v) => v.table_no === 13);
  assert.equal(inv.total, 0);
  assert.equal(inv.payment_method, 'EC-Karte');
  const evs = (await call('GET', `/api/admin/audit?order_id=${c.order_id}`, null, T.admin)).j.rows.map((e) => e.type);
  for (const type of ['ITEM_ADDED', 'EC_STORNO', 'EC_PAYMENT', 'TABLE_CLOSED']) assert.ok(evs.includes(type), type);
  // Auswertungen: EC getrennt ausgewiesen; Soll-Ist zieht EC-Artikel ab
  const emp = (await call('GET', '/api/admin/employees?period=month&date=' + new Date().toISOString().slice(0, 10), null, T.admin)).j.rows.find((x) => x.name === 'Anna Service');
  assert.ok(emp.ec_tische >= 1 && emp.ec_wert >= r.j.total);
  const rev = (await call('GET', '/api/admin/revenue?from=2000-01-01&to=2999-01-01', null, T.admin)).j;
  assert.ok(rev.ec.v >= r.j.total);
  const soll = (await call('GET', '/api/admin/stock?from=2000-01-01&to=2999-01-01', null, T.admin)).j.rows.find((x) => x.name.startsWith('Cola 0'));
  assert.ok(soll.per_ec >= 2);
  assert.equal(soll.differenz, soll.entnommen - soll.verkauft - soll.per_ec - soll.offen);
});

test('Varianten: Artikel mit Shot/Longdrink/Flasche, Auswahl Pflicht, Lager je Variante', async () => {
  const cat = boot.categories[0].id;
  const r = await call('POST', '/api/admin/articles', { name: 'Bacardi', category_id: cat, price: 0, vat: 19, track_stock: 1,
    variants: [{ name: 'Shot', price: 400 }, { name: 'Longdrink', price: 750 }, { name: 'Flasche', price: 6500 }] }, T.admin);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await call('POST', '/api/admin/articles', { name: 'X', category_id: cat, price: 0, variants: [{ name: 'A', price: 1 }, { name: 'a', price: 2 }] }, T.admin)).s, 400);
  const b2 = (await call('GET', '/api/pos/bootstrap', null, T.anna)).j;
  const vs = b2.variants.filter((v) => v.article_id === r.j.id);
  assert.deepEqual(vs.map((v) => v.name), ['Shot', 'Longdrink', 'Flasche']);
  assert.equal(b2.articles.find((a) => a.id === r.j.id).price, 400); // „ab“-Preis
  const t = tab(14);
  const no = await call('POST', '/api/pos/items', { table_id: t.id, article_id: r.j.id }, T.anna);
  assert.equal(no.s, 400);
  assert.equal(no.j.needs_variant, true);
  const ld = vs.find((v) => v.name === 'Longdrink');
  const it = (await call('POST', '/api/pos/items', { table_id: t.id, article_id: r.j.id, variant_id: ld.id, qty: 2 }, T.anna)).j;
  assert.equal(it.item.article_name, 'Bacardi (Longdrink)');
  assert.equal(it.item.unit_price, 750);
  assert.equal(it.item.variant_id, ld.id);
  // Verschieben behält die Variante
  await call('POST', '/api/pos/move', { items: [{ item_id: it.item.id, qty: 1 }], to_table_id: tab(15).id }, T.anna);
  const moved = (await call('GET', `/api/admin/lifecycle/${it.item.id}`, null, T.admin)).j.items;
  assert.ok(moved.every((x) => x.variant_id === ld.id));
  // Lager je Variante
  assert.equal((await call('POST', '/api/admin/stock', { article_id: r.j.id, qty: 5 }, T.admin)).s, 400);
  assert.equal((await call('POST', '/api/admin/stock', { article_id: r.j.id, variant_id: ld.id, qty: 5 }, T.admin)).s, 200);
  await call('POST', `/api/pos/orders/${it.order_id}/pay`, { method: 'Bar' }, T.anna);
  const o15 = (await call('GET', `/api/pos/tables/${tab(15).id}`, null, T.anna)).j;
  await call('POST', `/api/pos/orders/${o15.order.id}/pay`, { method: 'Bar' }, T.anna);
  const row = (await call('GET', '/api/admin/stock?from=2000-01-01&to=2999-01-01', null, T.admin)).j.rows.find((x) => x.name === 'Bacardi – Longdrink');
  assert.equal(row.entnommen, 5);
  assert.equal(row.verkauft, 2);
  assert.equal(row.differenz, 3);
  // Bearbeiten: Variante umbenennen, Flasche entfernen → deaktiviert (nicht gelöscht), protokolliert
  const shot = vs.find((v) => v.name === 'Shot');
  assert.equal((await call('PUT', `/api/admin/articles/${r.j.id}`, { name: 'Bacardi', category_id: cat, price: 0, vat: 19, track_stock: 1,
    variants: [{ id: shot.id, name: 'Shot 2 cl', price: 450 }, { id: ld.id, name: 'Longdrink', price: 750 }] }, T.admin)).s, 200);
  const b3 = (await call('GET', '/api/pos/bootstrap', null, T.anna)).j;
  assert.deepEqual(b3.variants.filter((v) => v.article_id === r.j.id).map((v) => `${v.name}:${v.price}`), ['Shot 2 cl:450', 'Longdrink:750']);
  const ev = (await call('GET', '/api/admin/audit?type=ARTICLE_PRICE_CHANGED', null, T.admin)).j.rows[0];
  assert.equal(JSON.parse(ev.before_json).varianten.length, 3);
});

test('Lizenz: Code nur für dieses Gerät gültig, fremde/manipulierte/abgelaufene Codes abgelehnt', async () => {
  const st = (await call('GET', '/api/license')).j;
  assert.equal(st.licensed, true);
  assert.match(st.device_id, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(st.business, 'Testbetrieb');
  // Code eines anderen Geräts
  const other = await call('POST', '/api/license', { code: await makeCode('AAAA-BBBB-CCCC-DDDD') });
  assert.equal(other.s, 400);
  assert.match(other.j.error, /anderen Gerät/);
  // Manipuliert: anderer Betriebsname bei gleicher Signatur
  const good = await makeCode(st.device_id, 'Echter Betrieb');
  const [p, s] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), b: 'Fremder' })).toString('base64url') + '.' + s;
  assert.match((await call('POST', '/api/license', { code: forged })).j.error, /ungültig/);
  assert.match((await call('POST', '/api/license', { code: 'quatsch' })).j.error, /unvollständig/);
  // Abgelaufen
  assert.match((await call('POST', '/api/license', { code: await makeCode(st.device_id, 'X', '2020-01-01') })).j.error, /abgelaufen/);
  // Gerät bleibt freigeschaltet, Freischaltung protokolliert
  assert.equal((await call('GET', '/api/license')).j.licensed, true);
  const ev = (await call('GET', '/api/admin/audit?type=LICENSE_ACTIVATED', null, T.admin)).j.rows;
  assert.equal(ev.length, 1);
});

test('Tischplan: Tische und Tresenplätze werden buchbar angelegt, Nummern eindeutig, protokolliert', async () => {
  const plan = { areas: [
    { name: 'Gastraum', w: 1200, h: 800, elements: [
      { id: 'a', type: 'table', shape: 'circle', x: 40, y: 40, w: 90, h: 120, number: 1, seats: 4 },
      { id: 'b', type: 'counter', x: 300, y: 300, w: 360, h: 70, seat_count: 3, seat_start: 201, seat_side: 'unten', label: 'Bar' },
      { id: 'c', type: 'entrance', x: 500, y: 740, w: 170, h: 50, label: 'Eingang' },
      { id: 'd', type: 'slot', shape: 'square', x: 1100, y: 40, w: 80, h: 80 },
      { id: 'e', type: 'table', shape: 'rect', x: 5000, y: 40, w: 140, h: 90, number: 250, seats: 6 },
    ] },
    { name: 'Terrasse', w: 1200, h: 800, elements: [{ id: 'z', type: 'zone', x: 20, y: 20, w: 600, h: 300 }] },
  ] };
  assert.equal((await call('PUT', '/api/admin/plan', plan, T.anna)).s, 403);
  const dup = structuredClone(plan);
  dup.areas[0].elements[4].number = 202;
  const d = await call('PUT', '/api/admin/plan', dup, T.admin);
  assert.equal(d.s, 400);
  assert.match(d.j.error, /202.*doppelt/);
  const r = await call('PUT', '/api/admin/plan', plan, T.admin);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.tische_neu, 4); // 3 Tresenplätze + Tisch 250 (Tisch 1 gab es schon)
  const saved = r.j.plan.areas[0].elements;
  assert.equal(saved[0].h, 90, 'Kreis bleibt rund');
  assert.equal(saved[4].x, 1200 - 140, 'Position bleibt im Bereich');
  assert.equal(r.j.plan.areas[1].elements[0].label, 'Terrasse');
  const b = (await call('GET', '/api/pos/bootstrap', null, T.anna)).j;
  assert.equal(b.plan.areas.length, 2);
  const seat = b.tables.find((t) => t.number === 202);
  assert.equal(seat.name, 'Bar 2');
  assert.equal(seat.area, 'Gastraum');
  assert.equal(b.tables.find((t) => t.number === 1).area, 'Gastraum');
  // Tresenplatz ist buchbar wie ein Tisch
  const add = await call('POST', '/api/pos/items', { table_id: seat.id, article_id: boot.articles.find((a) => !boot.variants?.some((v) => v.article_id === a.id)).id, qty: 1 }, T.anna);
  assert.equal(add.s, 200, JSON.stringify(add.j));
  const ev = (await call('GET', '/api/admin/audit?type=PLAN_UPDATED', null, T.admin)).j.rows;
  assert.equal(ev.length, 1);
  assert.equal((await call('PUT', '/api/admin/plan', r.j.plan, T.admin)).j.tische_neu, 0);
  assert.equal((await call('GET', '/api/admin/audit?type=PLAN_UPDATED', null, T.admin)).j.rows.length, 1, 'unveränderter Plan erzeugt keinen Eintrag');
});

test('Tischplan 3.0: Tresenplätze an mehreren Seiten mit freien Nummern, Automaten buchbar', async () => {
  const base = (await call('GET', '/api/admin/meta', null, T.admin)).j.plan;
  const plan = structuredClone(base);
  plan.areas[0].elements.push(
    { id: 'k2', type: 'counter', x: 300, y: 500, w: 300, h: 60, label: 'Theke', seats: { unten: [61, 62], links: [60], rechts: [64], oben: [] } },
    { id: 's1', type: 'slot', shape: 'square', x: 900, y: 500, w: 80, h: 80, number: 70, label: 'Automat' },
  );
  // gleiche Nummer an Tresen und Automat → abgelehnt
  const dup = structuredClone(plan);
  dup.areas[0].elements.at(-1).number = 64;
  assert.match((await call('PUT', '/api/admin/plan', dup, T.admin)).j.error, /64.*doppelt/);
  const r = await call('PUT', '/api/admin/plan', plan, T.admin);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.tische_neu, 5);
  const b = (await call('GET', '/api/pos/bootstrap', null, T.anna)).j;
  const nm = (n) => b.tables.find((t) => t.number === n)?.name;
  // Reihenfolge der Platznamen: unten, rechts, oben, links
  assert.deepEqual([61, 62, 64, 60].map(nm), ['Theke 1', 'Theke 2', 'Theke 3', 'Theke 4']);
  assert.equal(nm(70), 'Automat');
  const slot = b.tables.find((t) => t.number === 70);
  const plain = boot.articles.find((a) => !boot.variants?.some((v) => v.article_id === a.id));
  assert.equal((await call('POST', '/api/pos/items', { table_id: slot.id, article_id: plain.id, qty: 2 }, T.anna)).s, 200, 'am Automaten buchbar');
  const k2 = r.j.plan.areas[0].elements.find((e) => e.id === 'k2');
  assert.deepEqual(k2.seats, { unten: [61, 62], rechts: [64], oben: [], links: [60] });
});

test('Gästename: Tisch benennen (auch freier Tisch), protokolliert, endet mit dem Abschluss', async () => {
  const t = (await call('GET', '/api/pos/tables', null, T.ben)).j.find((x) => !x.order_id && x.number < 60);
  const r = await call('POST', `/api/pos/tables/${t.id}/guest`, { name: '  Stammtisch   Kevin ' }, T.ben);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.guest_name, 'Stammtisch Kevin');
  let ov = (await call('GET', '/api/pos/tables', null, T.ben)).j.find((x) => x.id === t.id);
  assert.equal(ov.guest_name, 'Stammtisch Kevin');
  assert.ok(ov.order_id, 'freier Tisch wurde dafür eröffnet');
  await call('POST', `/api/pos/tables/${t.id}/guest`, { name: 'Familie Yilmaz' }, T.ben);
  const ev = (await call('GET', '/api/admin/audit?type=GUEST_NAME_SET', null, T.admin)).j.rows;
  assert.equal(ev.length, 2);
  assert.equal(JSON.parse(ev[0].before_json).gastname, 'Stammtisch Kevin');
  assert.equal(JSON.parse(ev[0].after_json).gastname, 'Familie Yilmaz');
  // Tisch (leer) schließen → nächste Belegung ohne Namen
  assert.equal((await call('POST', `/api/pos/orders/${ov.order_id}/close-empty`, {}, T.ben)).s, 200);
  await call('POST', '/api/pos/items', { table_id: t.id, article_id: boot.articles.find((a) => !boot.variants?.some((v) => v.article_id === a.id)).id, qty: 1 }, T.ben);
  ov = (await call('GET', '/api/pos/tables', null, T.ben)).j.find((x) => x.id === t.id);
  assert.equal(ov.guest_name, null);
});

test('Getränkekarte übernehmen: Vorschau, Anlage mit Varianten, nichts doppelt, protokolliert', async () => {
  const list = JSON.parse(fs.readFileSync(new URL('../app/data/artikelliste.json', import.meta.url), 'utf8'));
  const total = list.kategorien.reduce((s, k) => s + k.artikel.length, 0);
  assert.equal((await call('POST', '/api/admin/import-articles', { list, dryRun: true }, T.anna)).s, 403);
  const before = (await call('GET', '/api/admin/meta', null, T.admin)).j;
  const dry = (await call('POST', '/api/admin/import-articles', { list, dryRun: true }, T.admin)).j;
  assert.equal(dry.neue_artikel.length + dry.uebersprungen.length, total);
  assert.equal((await call('GET', '/api/admin/meta', null, T.admin)).j.articles.length, before.articles.length, 'Vorschau ändert nichts');
  const r = await call('POST', '/api/admin/import-articles', { list }, T.admin);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const m = (await call('GET', '/api/admin/meta', null, T.admin)).j;
  assert.equal(m.articles.length, before.articles.length + dry.neue_artikel.length);
  const jaeger = m.articles.find((a) => a.name === 'Jägermeister');
  assert.deepEqual(m.variants.filter((v) => v.article_id === jaeger.id).map((v) => `${v.name}:${v.price}`), ['2 cl:260', 'Longdrink:800', 'Flasche:7500']);
  assert.equal(jaeger.price, 260);
  const donn = m.articles.find((a) => a.name === 'Donnerstag');
  assert.deepEqual(m.variants.filter((v) => v.article_id === donn.id).map((v) => `${v.name}:${v.price}`), ['Bier:200', 'Longdrink:500', 'Shot:150', 'Shot doppelt:250']);
  assert.equal(m.categories.find((c) => c.id === donn.category_id).name, '3 Nächte');
  assert.equal(m.articles.find((a) => a.name === 'Girls Night').price, 600);
  assert.equal(m.categories.find((c) => c.id === jaeger.category_id).name, 'Spirituosen');
  assert.ok(dry.uebersprungen.includes('Latte Macchiato'), 'vorhandener Artikel bleibt unverändert');
  assert.equal(m.articles.find((a) => a.name === 'Latte Macchiato').price, 420);
  assert.equal(m.articles.find((a) => a.name === 'Shot').price, 150);
  const again = (await call('POST', '/api/admin/import-articles', { list, dryRun: true }, T.admin)).j;
  assert.equal(again.neue_artikel.length, 0);
  assert.equal(again.neue_kategorien.length, 0);
  const ev = (await call('GET', '/api/admin/audit?type=ARTICLES_IMPORTED', null, T.admin)).j.rows;
  assert.equal(ev.length, 1);
});

test('Integrität vor Manipulationsversuchen: alles in Ordnung', async () => {
  const r = (await call('GET', '/api/admin/integrity', null, T.admin)).j;
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('Manipulationsversuche direkt an der Datenbank werden blockiert', () => {
  const raw = new DatabaseSync(path.join(dir, 'kasse.db'));
  const blocked = (sql) => assert.throws(() => raw.exec(sql), /MANIPULATIONSSCHUTZ|no such function/, sql);
  blocked("UPDATE audit_log SET reason='geändert' WHERE seq=5");
  blocked('DELETE FROM audit_log WHERE seq=5');
  blocked("DELETE FROM audit_log WHERE type='ITEM_CANCELLED'");
  blocked('DELETE FROM cancellations');
  blocked('UPDATE cancellations SET qty=0');
  blocked('DELETE FROM item_moves');
  blocked('UPDATE invoices SET total=0');
  blocked('DELETE FROM invoices');
  blocked('DELETE FROM order_items');
  blocked('UPDATE order_items SET qty=qty-1 WHERE id=1');
  blocked('UPDATE order_items SET cancelled_qty=0 WHERE cancelled_qty>0');
  blocked("UPDATE order_items SET article_name='Wasser' WHERE id=1");
  blocked('DELETE FROM orders');
  blocked('DELETE FROM users WHERE id=3');
  blocked('DELETE FROM db_journal');
  // Ohne die Prüfsummenfunktion der Kassensoftware kann niemand Einträge "nachschieben"
  blocked(`INSERT INTO audit_log(seq,event_id,ts,type,category,source,prev_hash,hash)
           VALUES((SELECT MAX(seq)+1 FROM audit_log),'x','2999-01-01','ITEM_ADDED','artikel','server','x','x')`);
  raw.close();
});

test('Tagesabschluss löschen: nur ältester, nur mit Bestätigung, offene Tische bleiben, Prüfkette bleibt gültig', async () => {
  // Tisch 9 wird vor dem Abschluss bezahlt, Tisch 10 bleibt über den Abschluss hinaus offen
  const a9 = (await call('POST', '/api/pos/items', { table_id: tab(9).id, article_id: art('Tee').id, qty: 1 }, T.anna)).j;
  const inv9 = (await call('POST', `/api/pos/orders/${a9.order_id}/pay`, { method: 'Bar' }, T.anna)).j;
  const a10 = (await call('POST', '/api/pos/items', { table_id: tab(10).id, article_id: art('Espresso').id, qty: 2 }, T.anna)).j;
  const c1 = await call('POST', '/api/admin/closings', {}, T.admin);
  assert.equal(c1.s, 200);
  const invBefore = (await call('GET', '/api/admin/invoices', null, T.admin)).j.length;
  // Nach dem Abschluss: Tisch 10 wird bezahlt
  const pay10 = (await call('POST', `/api/pos/orders/${a10.order_id}/pay`, { method: 'Kreditkarte' }, T.anna)).j;
  const c2 = await call('POST', '/api/admin/closings', {}, T.admin);
  const closings = (await call('GET', '/api/admin/closings', null, T.admin)).j;
  const [newest, oldest] = [closings[0], closings[closings.length - 1]];
  assert.equal(c2.s, 200);
  // Regeln
  assert.equal((await call('POST', `/api/admin/closings/${newest.id}/delete`, { confirm: 'LÖSCHEN' }, T.admin)).s, 409);
  assert.equal((await call('POST', `/api/admin/closings/${oldest.id}/delete`, { confirm: 'ja' }, T.admin)).s, 400);
  assert.equal((await call('POST', `/api/admin/closings/${oldest.id}/delete`, { confirm: 'LÖSCHEN' }, T.anna)).s, 403);
  // Löschen
  const d = await call('POST', `/api/admin/closings/${oldest.id}/delete`, { confirm: 'LÖSCHEN' }, T.admin);
  assert.equal(d.s, 200, JSON.stringify(d.j));
  assert.ok(d.j.counts.protokolleintraege > 50);
  assert.equal(d.j.counts.rechnungen, invBefore);
  // Alte Rechnung weg, Rechnung nach dem Abschluss (Tisch 10) noch da
  assert.equal((await call('GET', `/api/admin/invoices/${inv9.invoice_id}`, null, T.admin)).s, 404);
  assert.equal((await call('GET', `/api/admin/invoices/${pay10.invoice_id}`, null, T.admin)).s, 200);
  // Tisch 10 (über den Abschluss offen) behält seine Positionen
  const lc = (await call('GET', `/api/admin/lifecycle/${a10.item.id}`, null, T.admin));
  assert.equal(lc.s, 200);
  assert.ok(lc.j.events.some((e) => e.type === 'INVOICE_CREATED'));
  // Löschung ist protokolliert, Prüfkette weiterhin gültig, Rechnungsnummern laufen weiter
  const del = (await call('GET', '/api/admin/audit?type=CLOSING_DELETED', null, T.admin)).j.rows[0];
  assert.equal(del.user_name, 'Inhaber (Admin)');
  const integ = (await call('GET', '/api/admin/integrity', null, T.admin)).j;
  assert.equal(integ.ok, true, JSON.stringify(integ.problems));
  const a11 = (await call('POST', '/api/pos/items', { table_id: tab(11).id, article_id: art('Tee').id }, T.anna)).j;
  const inv11 = (await call('POST', `/api/pos/orders/${a11.order_id}/pay`, { method: 'Bar' }, T.anna)).j;
  assert.equal(Number(inv11.invoice_no.split('-')[1]), Number(pay10.invoice_no.split('-')[1]) + 1);
  assert.equal((await call('GET', '/api/admin/integrity', null, T.admin)).j.ok, true);
  // Auch der jetzt älteste Abschluss lässt sich löschen; danach bleibt alles prüfbar
  const rest = (await call('GET', '/api/admin/closings', null, T.admin)).j;
  assert.equal((await call('POST', `/api/admin/closings/${rest[rest.length - 1].id}/delete`, { confirm: 'löschen' }, T.admin)).s, 200);
  assert.equal((await call('GET', '/api/admin/integrity', null, T.admin)).j.ok, true);
});

test('Selbst wer die Schutz-Trigger entfernt, wird bei der Integritätsprüfung entdeckt', async () => {
  const raw = new DatabaseSync(path.join(dir, 'kasse.db'));
  raw.exec('DROP TRIGGER audit_log_no_update');
  raw.exec("UPDATE audit_log SET reason='Kunde wollte nicht' WHERE seq=(SELECT MAX(seq) FROM audit_log)");
  raw.exec('UPDATE orders SET waiter_id=1 WHERE id=(SELECT MAX(id) FROM orders)'); // Änderung außerhalb der Software
  raw.close();
  const r = (await call('GET', '/api/admin/integrity', null, T.admin)).j;
  assert.equal(r.ok, false);
  const arts = new Set(r.problems.map((p) => p.art));
  assert.ok(arts.has('Hash'), 'veränderter Inhalt erkannt');
  assert.ok(arts.has('Schutz'), 'fehlender Trigger erkannt');
  assert.ok(arts.has('Fremdzugriff'), 'Direktzugriff erkannt');
});
