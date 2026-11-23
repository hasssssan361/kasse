// Kassen-Logik: Tische, Positionen, Storno, Verschiebung, Preis, Abrechnung, Wiedereröffnung
// Jede Funktion ändert Daten nur zusammen mit einem Audit-Eintrag in EINER Transaktion.
import { db, one, all, run, tx, INVOICE_HASH_FIELDS, chainHash } from './db.js';
import { logEvent } from './audit.js';
import { getSettings, resolveApproval, can, requirePerm } from './auth.js';
import { fail, nowIso, int, str, berlinParts } from './util.js';

const openQty = (i) => i.qty - i.cancelled_qty - i.moved_qty - i.billed_qty;
const userName = (id) => one('SELECT name FROM users WHERE id=?', id)?.name || `#${id}`;

function getTable(id) {
  const t = one('SELECT * FROM dining_tables WHERE id=?', int(id, 'Tisch'));
  if (!t || !t.active) fail(404, 'Tisch nicht gefunden');
  return t;
}
function getOpenOrder(orderId) {
  const o = one('SELECT o.*, t.number AS table_no FROM orders o JOIN dining_tables t ON t.id=o.table_id WHERE o.id=?', int(orderId, 'Bestellung'));
  if (!o) fail(404, 'Bestellung nicht gefunden');
  if (o.status !== 'open') fail(409, 'Dieser Tisch ist bereits abgeschlossen');
  return o;
}
function getItem(itemId) {
  const i = one('SELECT * FROM order_items WHERE id=?', int(itemId, 'Position'));
  if (!i) fail(404, 'Position nicht gefunden');
  const o = getOpenOrder(i.order_id);
  return { item: i, order: o };
}
const rootOf = (item) => one('SELECT * FROM order_items WHERE id=?', item.lifecycle_id) || item;
const snap = (i) => ({ id: i.id, artikel: i.article_name, menge: i.qty, offen: openQty(i), storniert: i.cancelled_qty, verschoben: i.moved_qty, abgerechnet: i.billed_qty, preis: i.unit_price });

function ensureOrder(actor, table, via) {
  const o = one("SELECT * FROM orders WHERE table_id=? AND status='open'", table.id);
  if (o) return { ...o, table_no: table.number };
  const now = nowIso();
  const r = run("INSERT INTO orders(table_id,status,opened_by,opened_at,waiter_id) VALUES(?,'open',?,?,?)", table.id, actor.user.id, now, actor.user.id);
  const id = Number(r.lastInsertRowid);
  logEvent(actor, { type: 'TABLE_OPENED', table_no: table.number, order_id: id, after: { tisch: table.number, bedienung: actor.user.name }, details: { via } });
  return { ...one('SELECT * FROM orders WHERE id=?', id), table_no: table.number };
}

function insertItem(f) {
  const id = (one('SELECT MAX(id) m FROM order_items')?.m || 0) + 1;
  run(`INSERT INTO order_items(id,order_id,lifecycle_id,origin_item_id,origin_kind,article_id,article_name,category_kind,vat,list_price,unit_price,qty,created_by,created_at,raw_input)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, f.order_id, f.lifecycle_id ?? id, f.origin_item_id ?? null, f.origin_kind, f.article_id, f.article_name, f.category_kind ?? null,
  f.vat, f.list_price, f.unit_price, f.qty, f.created_by, f.created_at, f.raw_input ?? null);
  return one('SELECT * FROM order_items WHERE id=?', id);
}

// ---- Ansichten -------------------------------------------------------------
export function tablesOverview() {
  return all(`SELECT t.id, t.number, t.name, t.area, t.seats,
      o.id AS order_id, o.opened_at, o.waiter_id, u.name AS waiter_name, o.reopen_count,
      (SELECT COALESCE(SUM((i.qty-i.cancelled_qty-i.moved_qty-i.billed_qty)*i.unit_price),0) FROM order_items i WHERE i.order_id=o.id) AS open_total,
      (SELECT COALESCE(SUM(i.qty-i.cancelled_qty-i.moved_qty-i.billed_qty),0) FROM order_items i WHERE i.order_id=o.id) AS open_count,
      (SELECT MAX(a.ts) FROM audit_log a WHERE a.order_id=o.id) AS last_activity
    FROM dining_tables t
    LEFT JOIN orders o ON o.table_id=t.id AND o.status='open'
    LEFT JOIN users u ON u.id=o.waiter_id
    WHERE t.active=1 ORDER BY t.number`);
}

export function orderView(orderId) {
  const o = one(`SELECT o.*, t.number AS table_no, t.id AS table_id, u.name AS waiter_name, ob.name AS opened_by_name
                 FROM orders o JOIN dining_tables t ON t.id=o.table_id JOIN users u ON u.id=o.waiter_id JOIN users ob ON ob.id=o.opened_by WHERE o.id=?`, int(orderId, 'Bestellung'));
  if (!o) fail(404, 'Bestellung nicht gefunden');
  const items = all(`SELECT i.*, u.name AS created_by_name FROM order_items i JOIN users u ON u.id=i.created_by WHERE i.order_id=? ORDER BY i.id`, o.id)
    .map((i) => ({ ...i, open_qty: openQty(i) }));
  const cancellations = all(`SELECT c.*, ue.name AS entered_by_name, uc.name AS cancelled_by_name, ua.name AS approved_by_name
      FROM cancellations c JOIN users ue ON ue.id=c.entered_by JOIN users uc ON uc.id=c.cancelled_by LEFT JOIN users ua ON ua.id=c.approved_by
      WHERE c.order_id=? ORDER BY c.id`, o.id);
  const invoices = all(`SELECT id, invoice_no, kind, total, payment_method, closed_at, reverses_invoice_id,
      (SELECT COUNT(*) FROM invoices r WHERE r.reverses_invoice_id=invoices.id) AS reversed FROM invoices WHERE order_id=? ORDER BY id`, o.id);
  const open_total = items.reduce((s, i) => s + i.open_qty * i.unit_price, 0);
  const moves = all(`SELECT m.*, u.name AS moved_by_name FROM item_moves m JOIN users u ON u.id=m.moved_by
                     WHERE m.from_order_id=? OR m.to_order_id=? ORDER BY m.id`, o.id, o.id);
  return { order: o, items, cancellations, invoices, open_total, moves };
}

export function tableOrder(tableId) {
  const t = getTable(tableId);
  const o = one("SELECT id FROM orders WHERE table_id=? AND status='open'", t.id);
  return { table: t, ...(o ? orderView(o.id) : { order: null, items: [], cancellations: [], invoices: [], open_total: 0, moves: [] }) };
}

// ---- Artikel erfassen --------------------------------------------------------
export function addItem(actor, body) {
  requirePerm(actor, 'pos');
  const table = getTable(body.table_id);
  const a = one('SELECT a.*, c.kind AS category_kind FROM articles a JOIN categories c ON c.id=a.category_id WHERE a.id=?', int(body.article_id, 'Artikel'));
  if (!a || !a.active) fail(404, 'Artikel nicht verfügbar');
  const qty = int(body.qty ?? 1, 'Menge', { min: 1, max: 99 });
  const raw = body.raw_input ? String(body.raw_input).slice(0, 40) : null;
  return tx(() => {
    const order = ensureOrder(actor, table, 'Artikeleingabe');
    const it = insertItem({
      order_id: order.id, origin_kind: 'entry', article_id: a.id, article_name: a.name, category_kind: a.category_kind,
      vat: a.vat, list_price: a.price, unit_price: a.price, qty, created_by: actor.user.id, created_at: nowIso(), raw_input: raw,
    });
    logEvent(actor, {
      type: 'ITEM_ADDED', table_no: table.number, order_id: order.id, item_id: it.id, lifecycle_id: it.lifecycle_id,
      article_name: a.name, qty, unit_price: a.price, amount: qty * a.price, before: null, after: snap(it),
      details: { article_id: a.id, plu: a.plu, eingabe: raw },
    });
    return { order_id: order.id, item: it };
  });
}

export function increaseQty(actor, itemId, body) {
  requirePerm(actor, 'pos');
  const add = int(body.qty ?? 1, 'Menge', { min: 1, max: 99 });
  return tx(() => {
    const { item, order } = getItem(itemId);
    if (item.billed_qty || item.moved_qty || item.cancelled_qty) fail(409, 'Bitte den Artikel neu eingeben (Position wurde bereits bearbeitet)');
    run('UPDATE order_items SET qty=qty+? WHERE id=?', add, item.id);
    const after = one('SELECT * FROM order_items WHERE id=?', item.id);
    logEvent(actor, {
      type: 'ITEM_QTY_INCREASED', table_no: order.table_no, order_id: order.id, item_id: item.id, lifecycle_id: item.lifecycle_id,
      article_name: item.article_name, qty: add, unit_price: item.unit_price, amount: add * item.unit_price,
      before: snap(item), after: snap(after), details: { eingabe: body.raw_input ?? null },
    });
    return { item: after };
  });
}

// ---- Storno ------------------------------------------------------------------
export function stornoNeedsApproval(item, qty, s = getSettings()) {
  const root = rootOf(item);
  const ageMin = (Date.now() - Date.parse(root.created_at)) / 60000;
  const value = qty * item.unit_price;
  const why = [];
  if (s.storno_approval_always) why.push('jede Stornierung');
  if (s.storno_approval_min_value > 0 && value >= s.storno_approval_min_value) why.push('Wert über Grenze');
  if (s.storno_approval_after_minutes > 0 && ageMin >= s.storno_approval_after_minutes) why.push(`älter als ${s.storno_approval_after_minutes} Min.`);
  return why;
}

export function cancelItem(actor, itemId, body) {
  requirePerm(actor, 'pos');
  const { item } = getItem(itemId);
  const qty = int(body.qty ?? 1, 'Menge', { min: 1, max: 999 });
  if (qty > openQty(item)) fail(409, `Nur noch ${openQty(item)} offen`);
  const reason = str(body.reason, 'einen Stornogrund', { max: 300 });
  if (reason.length < 3) fail(400, 'Bitte einen aussagekräftigen Stornogrund angeben');
  const why = stornoNeedsApproval(item, qty);
  const appr = resolveApproval(actor, why.length > 0, 'storno_free', body.approver, `Storno (${why.join(', ')})`);
  return tx(() => {
    const { item: cur, order } = getItem(itemId); // erneut lesen (gleichzeitige Änderungen)
    if (qty > openQty(cur)) fail(409, `Nur noch ${openQty(cur)} offen`);
    const root = rootOf(cur);
    const now = nowIso();
    run('UPDATE order_items SET cancelled_qty=cancelled_qty+? WHERE id=?', qty, cur.id);
    const after = one('SELECT * FROM order_items WHERE id=?', cur.id);
    const secs = Math.round((Date.parse(now) - Date.parse(root.created_at)) / 1000);
    const ev = logEvent(actor, {
      type: 'ITEM_CANCELLED', table_no: order.table_no, order_id: order.id, item_id: cur.id, lifecycle_id: cur.lifecycle_id,
      article_name: cur.article_name, qty, unit_price: cur.unit_price, amount: qty * cur.unit_price, reason,
      before: snap(cur), after: snap(after),
      details: {
        eingegeben_von: userName(root.created_by), eingegeben_von_id: root.created_by, eingegeben_am: root.created_at,
        sekunden_nach_eingabe: secs, freigabe_noetig: why, freigegeben_von: appr.approved_by_name || null,
      },
    });
    run(`INSERT INTO cancellations(item_id,lifecycle_id,order_id,table_no,article_name,qty,unit_price,total,entered_by,entered_at,cancelled_by,cancelled_at,reason,approval_required,approved_by,seconds_after_entry,audit_seq)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cur.id, cur.lifecycle_id, order.id, order.table_no, cur.article_name, qty,
    cur.unit_price, qty * cur.unit_price, root.created_by, root.created_at, actor.user.id, ev.ts, reason, why.length ? 1 : 0,
    appr.approved_by, secs, ev.seq);
    return { item: after };
  });
}

// ---- Preis ändern ------------------------------------------------------------
export function changePrice(actor, itemId, body) {
  requirePerm(actor, 'pos');
  const { item } = getItem(itemId);
  const np = int(body.new_price, 'Preis', { min: 0, max: 10000000 });
  if (np === item.unit_price) fail(400, 'Der Preis ist unverändert');
  if (item.cancelled_qty + item.moved_qty + item.billed_qty > 0) fail(409, 'Preis nur bei unbearbeiteten Positionen änderbar');
  const reason = str(body.reason, 'einen Grund für die Preisänderung', { max: 300 });
  const s = getSettings();
  const appr = resolveApproval(actor, !!s.price_change_requires_approval, 'price_change', body.approver, 'Preisänderung');
  return tx(() => {
    const { item: cur, order } = getItem(itemId);
    run('UPDATE order_items SET unit_price=? WHERE id=?', np, cur.id);
    const after = one('SELECT * FROM order_items WHERE id=?', cur.id);
    const ev = logEvent(actor, {
      type: 'ITEM_PRICE_CHANGED', table_no: order.table_no, order_id: order.id, item_id: cur.id, lifecycle_id: cur.lifecycle_id,
      article_name: cur.article_name, qty: cur.qty, unit_price: np, amount: (np - cur.unit_price) * cur.qty, reason,
      before: { preis: cur.unit_price, listenpreis: cur.list_price }, after: { preis: np },
      details: { eingabe: body.raw_input ?? null, freigegeben_von: appr.approved_by_name || null },
    });
    run(`INSERT INTO price_changes(item_id,lifecycle_id,order_id,table_no,article_name,qty,old_price,new_price,changed_by,approved_by,changed_at,reason,audit_seq)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, cur.id, cur.lifecycle_id, order.id, order.table_no, cur.article_name, cur.qty,
    cur.unit_price, np, actor.user.id, appr.approved_by, ev.ts, reason, ev.seq);
    return { item: after };
  });
}

// ---- Verschieben -------------------------------------------------------------
function moveLines(actor, order, target, lines, reason, kind) {
  const targetOrder = ensureOrder(actor, target, `Verschiebung von Tisch ${order.table_no}`);
  const moved = [];
  for (const { item, qty } of lines) {
    const cur = one('SELECT * FROM order_items WHERE id=?', item.id);
    if (qty > openQty(cur)) fail(409, `${cur.article_name}: nur noch ${openQty(cur)} offen`);
    run('UPDATE order_items SET moved_qty=moved_qty+? WHERE id=?', qty, cur.id);
    const now = nowIso();
    const n = insertItem({
      order_id: targetOrder.id, lifecycle_id: cur.lifecycle_id, origin_item_id: cur.id, origin_kind: 'move',
      article_id: cur.article_id, article_name: cur.article_name, category_kind: cur.category_kind, vat: cur.vat,
      list_price: cur.list_price, unit_price: cur.unit_price, qty, created_by: actor.user.id, created_at: now,
    });
    const ev = logEvent(actor, {
      type: 'ITEM_MOVED', table_no: order.table_no, target_table_no: target.number, order_id: order.id,
      item_id: cur.id, lifecycle_id: cur.lifecycle_id, article_name: cur.article_name, qty, unit_price: cur.unit_price,
      amount: qty * cur.unit_price, reason, before: { tisch: order.table_no, position: cur.id, offen: openQty(cur) },
      after: { tisch: target.number, neue_position: n.id, offen_alt: openQty(cur) - qty },
      details: { art: kind, von_bestellung: order.id, nach_bestellung: targetOrder.id, neue_position: n.id },
    });
    run(`INSERT INTO item_moves(kind,source_item_id,target_item_id,lifecycle_id,from_order_id,to_order_id,from_table_no,to_table_no,article_name,qty,unit_price,moved_by,moved_at,reason,audit_seq)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, kind, cur.id, n.id, cur.lifecycle_id, order.id, targetOrder.id, order.table_no,
    target.number, cur.article_name, qty, cur.unit_price, actor.user.id, ev.ts, reason, ev.seq);
    moved.push(n);
  }
  return { targetOrder, moved };
}

export function moveItems(actor, body) {
  requirePerm(actor, 'pos');
  const target = getTable(body.to_table_id);
  const reason = body.reason ? String(body.reason).trim().slice(0, 300) || null : null;
  if (getSettings().move_requires_reason && !reason) fail(400, 'Bitte einen Grund für die Verschiebung angeben');
  if (!Array.isArray(body.items) || !body.items.length) fail(400, 'Keine Artikel ausgewählt');
  return tx(() => {
    let order = null;
    const lines = body.items.map((l) => {
      const { item, order: o } = getItem(l.item_id);
      if (order && o.id !== order.id) fail(400, 'Artikel müssen vom selben Tisch stammen');
      order = o;
      return { item, qty: int(l.qty ?? openQty(item), 'Menge', { min: 1, max: 999 }) };
    });
    if (order.table_id === target.id) fail(400, 'Ziel ist derselbe Tisch');
    const r = moveLines(actor, order, target, lines, reason, 'artikel');
    autoClose(actor, order.id, `Alle Artikel auf Tisch ${target.number} verschoben`);
    return { to_order_id: r.targetOrder.id, moved: r.moved.length };
  });
}

export function moveTable(actor, orderId, body) {
  requirePerm(actor, 'pos');
  const target = getTable(body.to_table_id);
  const reason = body.reason ? String(body.reason).trim().slice(0, 300) || null : null;
  return tx(() => {
    const order = getOpenOrder(orderId);
    if (order.table_id === target.id) fail(400, 'Ziel ist derselbe Tisch');
    const occupied = one("SELECT id FROM orders WHERE table_id=? AND status='open'", target.id);
    if (!occupied) {
      run('UPDATE orders SET table_id=? WHERE id=?', target.id, order.id);
      logEvent(actor, {
        type: 'TABLE_CHANGED', table_no: order.table_no, target_table_no: target.number, order_id: order.id, reason,
        before: { tisch: order.table_no }, after: { tisch: target.number },
        details: { art: 'Tischwechsel auf freien Tisch', positionen: all('SELECT id FROM order_items WHERE order_id=?', order.id).map((x) => x.id) },
      });
      return { order_id: order.id };
    }
    const lines = all('SELECT * FROM order_items WHERE order_id=?', order.id).filter((i) => openQty(i) > 0).map((i) => ({ item: i, qty: openQty(i) }));
    if (!lines.length) fail(409, 'Keine offenen Artikel zum Verschieben');
    const r = moveLines(actor, order, target, lines, reason, 'tischwechsel');
    logEvent(actor, {
      type: 'TABLE_CHANGED', table_no: order.table_no, target_table_no: target.number, order_id: order.id, reason,
      before: { tisch: order.table_no }, after: { tisch: target.number, zusammengefuehrt_mit_bestellung: r.targetOrder.id },
      details: { art: 'Zusammenlegung mit belegtem Tisch', positionen: lines.length },
    });
    autoClose(actor, order.id, `Mit Tisch ${target.number} zusammengelegt`);
    return { order_id: r.targetOrder.id };
  });
}

export function takeover(actor, orderId, body) {
  requirePerm(actor, 'pos');
  return tx(() => {
    const order = getOpenOrder(orderId);
    if (order.waiter_id === actor.user.id) fail(400, 'Sie bedienen diesen Tisch bereits');
    run('UPDATE orders SET waiter_id=? WHERE id=?', actor.user.id, order.id);
    logEvent(actor, {
      type: 'TABLE_TAKEOVER', table_no: order.table_no, order_id: order.id, reason: body.reason || null,
      before: { bedienung: userName(order.waiter_id), bedienung_id: order.waiter_id }, after: { bedienung: actor.user.name, bedienung_id: actor.user.id },
    });
    return { ok: true };
  });
}

// ---- Abrechnung --------------------------------------------------------------
function vatBreakdown(lines, discount, subtotal) {
  const groups = {};
  for (const l of lines) groups[l.vat] = (groups[l.vat] || 0) + l.total;
  const rates = Object.keys(groups).map(Number).sort((a, b) => a - b);
  let restDisc = discount;
  return rates.map((rate, i) => {
    const d = i === rates.length - 1 ? restDisc : Math.round(discount * groups[rate] / (subtotal || 1));
    restDisc -= d;
    const gross = groups[rate] - d;
    const net = Math.round(gross * 100 / (100 + rate));
    return { satz: rate, brutto: gross, netto: net, steuer: gross - net };
  });
}

function nextInvoiceNo() {
  const y = berlinParts(new Date()).year;
  const p = one('SELECT invoice_seq_json FROM purges ORDER BY id DESC LIMIT 1');
  const purged = p ? JSON.parse(p.invoice_seq_json)[y] || 0 : 0;
  const seq = (one('SELECT MAX(seq_in_year) m FROM invoices WHERE year=?', y)?.m || purged) + 1;
  return { year: y, seq, no: `${y}-${String(seq).padStart(6, '0')}` };
}

function insertInvoice(actor, ev, inv) {
  const prev = one('SELECT hash FROM invoices ORDER BY id DESC LIMIT 1')?.hash
    || one('SELECT invoice_hash FROM purges ORDER BY id DESC LIMIT 1')?.invoice_hash || 'GENESIS';
  const row = { ...inv, audit_seq: ev.seq, prev_hash: prev };
  row.hash = chainHash(prev, ...INVOICE_HASH_FIELDS.map((f) => row[f] ?? null));
  const cols = ['invoice_no', 'year', 'seq_in_year', 'kind', 'order_id', 'table_no', 'waiter_id', 'waiter_name', 'closed_by', 'closed_by_name',
    'opened_at', 'closed_at', 'subtotal', 'discount', 'discount_reason', 'total', 'vat_json', 'payment_method', 'given', 'change_amount',
    'items_json', 'cancelled_json', 'reverses_invoice_id', 'is_final', 'approved_by', 'audit_seq', 'prev_hash', 'hash'];
  const r = run(`INSERT INTO invoices(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c] ?? null));
  const id = Number(r.lastInsertRowid);
  for (const l of JSON.parse(inv.items_json)) {
    run('INSERT INTO invoice_items(invoice_id,item_id,lifecycle_id,article_id,article_name,vat,qty,unit_price,total) VALUES(?,?,?,?,?,?,?,?,?)',
      id, l.item_id, l.lifecycle_id, l.article_id, l.article_name, l.vat, l.qty, l.unit_price, l.total);
  }
  return id;
}

const cancelledSnapshot = (orderId) => all(`SELECT c.item_id, c.lifecycle_id, c.article_name, c.qty, c.unit_price, c.total, c.reason,
    c.entered_at, c.cancelled_at, ue.name AS eingegeben_von, uc.name AS storniert_von FROM cancellations c
    JOIN users ue ON ue.id=c.entered_by JOIN users uc ON uc.id=c.cancelled_by WHERE c.order_id=? ORDER BY c.id`, orderId).map((r) => ({ ...r }));

function createInvoice(actor, order, lines, opt) {
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const total = subtotal - (opt.discount || 0);
  const no = nextInvoiceNo();
  const now = nowIso();
  const cancelled = cancelledSnapshot(order.id);
  const ev = logEvent(actor, {
    type: 'INVOICE_CREATED', table_no: order.table_no, order_id: order.id, amount: total, reason: opt.discount_reason || null,
    after: { rechnung: no.no, summe: total, zahlungsart: opt.method, positionen: lines.length, rabatt: opt.discount || 0 },
    details: {
      rechnungsnummer: no.no, zwischensumme: subtotal, rabatt: opt.discount || 0, rabatt_eingabe: opt.discount_input || null,
      rabatt_freigabe: opt.approved_by_name || null, zahlungsart: opt.method, gegeben: opt.given ?? null, rueckgeld: opt.change ?? null,
      teilzahlung: !opt.final, stornierte_positionen: cancelled.length, nullbeleg: !!opt.zero,
    },
  });
  const id = insertInvoice(actor, ev, {
    invoice_no: no.no, year: no.year, seq_in_year: no.seq, kind: 'rechnung', order_id: order.id, table_no: order.table_no,
    waiter_id: order.waiter_id, waiter_name: userName(order.waiter_id), closed_by: actor.user.id, closed_by_name: actor.user.name,
    opened_at: order.opened_at, closed_at: now, subtotal, discount: opt.discount || 0, discount_reason: opt.discount_reason || null,
    total, vat_json: JSON.stringify(vatBreakdown(lines, opt.discount || 0, subtotal)), payment_method: opt.method,
    given: opt.given ?? null, change_amount: opt.change ?? null, items_json: JSON.stringify(lines),
    cancelled_json: JSON.stringify(cancelled), reverses_invoice_id: null, is_final: opt.final ? 1 : 0, approved_by: opt.approved_by || null,
  });
  run('INSERT INTO payments(invoice_id,method,amount,given,change_amount,user_id,created_at) VALUES(?,?,?,?,?,?,?)',
    id, opt.method, total, opt.given ?? null, opt.change ?? null, actor.user.id, now);
  return { id, invoice_no: no.no, total };
}

function closeOrderRow(actor, order, reason, invoiceNo) {
  run("UPDATE orders SET status='closed', closed_by=?, closed_at=? WHERE id=?", actor.user.id, nowIso(), order.id);
  logEvent(actor, {
    type: 'TABLE_CLOSED', table_no: order.table_no, order_id: order.id, reason,
    after: { status: 'abgeschlossen', rechnung: invoiceNo || null },
    details: {
      eroeffnet: order.opened_at, bedienung: userName(order.waiter_id),
      stornos: one('SELECT COUNT(*) c, COALESCE(SUM(total),0) v FROM cancellations WHERE order_id=?', order.id),
    },
  });
}

// Bestellung ohne offene Artikel schließen (nach Verschieben/Storno)
function autoClose(actor, orderId, why) {
  const o = one('SELECT o.*, t.number AS table_no FROM orders o JOIN dining_tables t ON t.id=o.table_id WHERE o.id=?', orderId);
  if (o.status !== 'open') return;
  const left = one('SELECT COALESCE(SUM(qty-cancelled_qty-moved_qty-billed_qty),0) n FROM order_items WHERE order_id=?', orderId).n;
  if (left > 0) return;
  const hasInv = one('SELECT COUNT(*) c FROM invoices WHERE order_id=?', orderId).c > 0;
  const hasStorno = one('SELECT COUNT(*) c FROM cancellations WHERE order_id=?', orderId).c > 0;
  if (!hasInv && hasStorno) {
    const inv = createInvoice(actor, o, [], { method: 'Keine Zahlung', final: true, zero: true });
    closeOrderRow(actor, o, why + ' (Nullbeleg mit Stornos)', inv.invoice_no);
  } else if (!hasInv) {
    run("UPDATE orders SET status='merged', closed_by=?, closed_at=? WHERE id=?", actor.user.id, nowIso(), orderId);
    logEvent(actor, { type: 'ORDER_CLOSED_EMPTY', table_no: o.table_no, order_id: orderId, reason: why, after: { status: 'ohne Umsatz geschlossen' } });
  } else {
    closeOrderRow(actor, o, why, null);
  }
}

export function closeEmpty(actor, orderId) {
  requirePerm(actor, 'pos');
  return tx(() => {
    const order = getOpenOrder(orderId);
    const left = one('SELECT COALESCE(SUM(qty-cancelled_qty-moved_qty-billed_qty),0) n FROM order_items WHERE order_id=?', order.id).n;
    if (left > 0) fail(409, 'Es sind noch offene Artikel vorhanden – bitte abrechnen');
    autoClose(actor, order.id, 'Tisch ohne offene Artikel geschlossen');
    return { ok: true };
  });
}

export function pay(actor, orderId, body) {
  requirePerm(actor, 'pos');
  const s = getSettings();
  const pre = getOpenOrder(orderId);
  const method = String(body.method || '');
  if (!s.payment_methods.includes(method)) fail(400, 'Bitte eine Zahlungsart wählen');
  const all_ = all('SELECT * FROM order_items WHERE order_id=?', pre.id);
  const pick = (items) => {
    let lines;
    if (Array.isArray(body.items) && body.items.length) {
      lines = body.items.map((l) => {
        const it = items.find((x) => x.id === Number(l.item_id));
        if (!it) fail(400, 'Position gehört nicht zu diesem Tisch');
        const q = int(l.qty ?? openQty(it), 'Menge', { min: 1, max: 999 });
        if (q > openQty(it)) fail(409, `${it.article_name}: nur noch ${openQty(it)} offen`);
        return { it, q };
      });
    } else lines = items.filter((i) => openQty(i) > 0).map((it) => ({ it, q: openQty(it) }));
    if (!lines.length) fail(409, 'Keine offenen Artikel zum Abrechnen');
    return lines;
  };
  const sel = pick(all_);
  const subtotal = sel.reduce((x, l) => x + l.q * l.it.unit_price, 0);
  let discount = 0;
  let discountReason = null;
  let discountInput = null;
  if (body.discount && Number(body.discount.value) > 0) {
    const d = body.discount;
    discountReason = str(d.reason, 'einen Rabattgrund', { max: 200 });
    if (d.type === 'percent') {
      const p = Number(d.value);
      if (!(p > 0 && p <= 100)) fail(400, 'Rabatt in Prozent ungültig');
      discount = Math.round(subtotal * p / 100);
      discountInput = `${p} %`;
    } else {
      discount = int(d.value, 'Rabattbetrag', { min: 1, max: subtotal });
      discountInput = `${(discount / 100).toFixed(2)} €`;
    }
  }
  const appr = resolveApproval(actor, discount > 0 && !!s.discount_requires_approval, 'discount', body.approver, 'Rabatt');
  const total = subtotal - discount;
  let given = null;
  let change = null;
  if (method === 'Bar' && body.given != null && body.given !== '') {
    given = int(body.given, 'gegebener Betrag', { min: 0 });
    if (given < total) fail(400, 'Gegebener Betrag reicht nicht');
    change = given - total;
  }
  return tx(() => {
    const order = getOpenOrder(orderId);
    const lines = pick(all('SELECT * FROM order_items WHERE order_id=?', order.id));
    for (const l of lines) run('UPDATE order_items SET billed_qty=billed_qty+? WHERE id=?', l.q, l.it.id);
    const left = one('SELECT COALESCE(SUM(qty-cancelled_qty-moved_qty-billed_qty),0) n FROM order_items WHERE order_id=?', order.id).n;
    const invLines = lines.map((l) => ({
      item_id: l.it.id, lifecycle_id: l.it.lifecycle_id, article_id: l.it.article_id, article_name: l.it.article_name,
      vat: l.it.vat, qty: l.q, unit_price: l.it.unit_price, total: l.q * l.it.unit_price,
    }));
    const inv = createInvoice(actor, order, invLines, {
      method, given, change, discount, discount_reason: discountReason, discount_input: discountInput,
      approved_by: appr.approved_by, approved_by_name: appr.approved_by_name, final: left === 0,
    });
    if (left === 0) closeOrderRow(actor, order, 'Bezahlt', inv.invoice_no);
    return { invoice_id: inv.id, invoice_no: inv.invoice_no, total: inv.total, change, closed: left === 0 };
  });
}

// ---- Wiedereröffnung -----------------------------------------------------------
export function reopenInvoice(actor, invoiceId, body) {
  requirePerm(actor, 'pos');
  const inv = one('SELECT * FROM invoices WHERE id=?', int(invoiceId, 'Rechnung'));
  if (!inv) fail(404, 'Rechnung nicht gefunden');
  if (inv.kind !== 'rechnung') fail(409, 'Eine Stornorechnung kann nicht wiedereröffnet werden');
  if (one('SELECT id FROM invoices WHERE reverses_invoice_id=?', inv.id)) fail(409, 'Diese Rechnung wurde bereits storniert/wiedereröffnet');
  const reason = str(body.reason, 'einen Grund für die Wiedereröffnung', { max: 300 });
  const appr = resolveApproval(actor, !!getSettings().reopen_requires_approval, 'reopen', body.approver, 'Wiedereröffnung');
  return tx(() => {
    const order = one('SELECT o.*, t.number AS table_no FROM orders o JOIN dining_tables t ON t.id=o.table_id WHERE o.id=?', inv.order_id);
    if (order.status !== 'open') {
      const busy = one("SELECT id FROM orders WHERE table_id=? AND status='open'", order.table_id);
      if (busy) fail(409, `Tisch ${order.table_no} ist gerade belegt – bitte zuerst abschließen oder umsetzen`);
    }
    const items = JSON.parse(inv.items_json);
    const neg = items.map((l) => ({ ...l, qty: -l.qty, total: -l.total }));
    const no = nextInvoiceNo();
    const now = nowIso();
    const ev = logEvent(actor, {
      type: 'INVOICE_REVERSED', table_no: order.table_no, order_id: order.id, amount: -inv.total, reason,
      before: { rechnung: inv.invoice_no, summe: inv.total, status: 'gültig' },
      after: { rechnung: inv.invoice_no, status: 'durch Stornorechnung aufgehoben', stornorechnung: no.no },
      details: { original_id: inv.id, stornorechnung: no.no, freigegeben_von: appr.approved_by_name || null },
    });
    insertInvoice(actor, ev, {
      invoice_no: no.no, year: no.year, seq_in_year: no.seq, kind: 'storno', order_id: order.id, table_no: inv.table_no,
      waiter_id: inv.waiter_id, waiter_name: inv.waiter_name, closed_by: actor.user.id, closed_by_name: actor.user.name,
      opened_at: inv.opened_at, closed_at: now, subtotal: -inv.subtotal, discount: -inv.discount, discount_reason: inv.discount_reason,
      total: -inv.total, vat_json: JSON.stringify(JSON.parse(inv.vat_json).map((v) => ({ satz: v.satz, brutto: -v.brutto, netto: -v.netto, steuer: -v.steuer }))),
      payment_method: inv.payment_method, given: null, change_amount: null, items_json: JSON.stringify(neg), cancelled_json: '[]',
      reverses_invoice_id: inv.id, is_final: 0, approved_by: appr.approved_by,
    });
    const newId = one('SELECT id FROM invoices WHERE invoice_no=?', no.no).id;
    run('INSERT INTO payments(invoice_id,method,amount,user_id,created_at) VALUES(?,?,?,?,?)', newId, inv.payment_method, -inv.total, actor.user.id, now);
    if (order.status !== 'open') {
      run("UPDATE orders SET status='open', closed_by=NULL, closed_at=NULL, reopen_count=reopen_count+1 WHERE id=?", order.id);
    } else run('UPDATE orders SET reopen_count=reopen_count+1 WHERE id=?', order.id);
    const restored = [];
    for (const l of items) {
      const src = one('SELECT * FROM order_items WHERE id=?', l.item_id);
      const n = insertItem({
        order_id: order.id, lifecycle_id: src.lifecycle_id, origin_item_id: src.id, origin_kind: 'reopen', article_id: src.article_id,
        article_name: src.article_name, category_kind: src.category_kind, vat: src.vat, list_price: src.list_price,
        unit_price: l.unit_price, qty: l.qty, created_by: actor.user.id, created_at: now,
      });
      restored.push({ alt: src.id, neu: n.id, artikel: n.article_name, menge: n.qty });
    }
    logEvent(actor, {
      type: 'TABLE_REOPENED', table_no: order.table_no, order_id: order.id, amount: inv.total, reason,
      before: { status: order.status === 'open' ? 'offen (Teilzahlung)' : 'abgeschlossen', rechnung: inv.invoice_no },
      after: { status: 'offen', wiederhergestellte_positionen: restored },
      details: { stornorechnung: no.no, freigegeben_von: appr.approved_by_name || null },
    });
    return { order_id: order.id, table_id: order.table_id, storno_invoice_no: no.no };
  });
}

// ---- Vom Gerät gemeldete Abbrüche (z. B. Storno-Dialog geöffnet und abgebrochen) ----
export function uiEvent(actor, body) {
  const allowed = ['storno', 'verschieben', 'bezahlen', 'preis', 'wiedereroeffnen', 'rabatt', 'tischwechsel'];
  const dialog = String(body.dialog || '');
  if (!allowed.includes(dialog)) fail(400, 'Unbekannter Dialog');
  return tx(() => logEvent(actor, {
    type: 'DIALOG_ABORTED', source: 'client', table_no: body.table_no ?? null, order_id: body.order_id ?? null,
    item_id: body.item_id ?? null, article_name: body.article_name ? String(body.article_name).slice(0, 80) : null,
    details: { dialog, eingaben: body.inputs ? String(JSON.stringify(body.inputs)).slice(0, 500) : null },
  }) && { ok: true });
}

// ---- Schicht ------------------------------------------------------------------
export function shiftReport(userId, from, to) {
  const inv = all(`SELECT kind, payment_method, COUNT(*) n, SUM(total) total, SUM(discount) discount FROM invoices
                   WHERE closed_by=? AND closed_at>=? AND closed_at<? GROUP BY kind, payment_method`, userId, from, to);
  const by = {};
  let total = 0;
  for (const r of inv) { by[r.payment_method] = (by[r.payment_method] || 0) + r.total; total += r.total; }
  const st = one('SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE cancelled_by=? AND cancelled_at>=? AND cancelled_at<?', userId, from, to);
  const items = one("SELECT COALESCE(SUM(qty),0) n FROM audit_log WHERE user_id=? AND type IN ('ITEM_ADDED','ITEM_QTY_INCREASED') AND ts>=? AND ts<?", userId, from, to);
  const open = all(`SELECT t.number FROM orders o JOIN dining_tables t ON t.id=o.table_id WHERE o.status='open' AND o.waiter_id=?`, userId).map((r) => r.number);
  return {
    von: from, bis: to, umsatz: total, nach_zahlungsart: by,
    rechnungen: inv.filter((r) => r.kind === 'rechnung').reduce((s, r) => s + r.n, 0),
    stornorechnungen: inv.filter((r) => r.kind === 'storno').reduce((s, r) => s + r.n, 0),
    rabatte: inv.reduce((s, r) => s + (r.kind === 'rechnung' ? r.discount : 0), 0),
    stornos: st.n, storno_wert: st.v, artikel_eingegeben: items.n, offene_tische: open,
  };
}
export function currentShift(actor, userId = actor.user.id) {
  const sh = one('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', userId);
  if (!sh) return { shift: null };
  return { shift: sh, report: shiftReport(userId, sh.started_at, '9999') };
}
export function closeShift(actor, body) {
  const uid = body.user_id ? int(body.user_id, 'Mitarbeiter') : actor.user.id;
  if (uid !== actor.user.id) requirePerm(actor, 'day_close');
  return tx(() => {
    const sh = one('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', uid);
    if (!sh) fail(404, 'Keine offene Schicht');
    const now = nowIso();
    const rep = shiftReport(uid, sh.started_at, now);
    rep.mitarbeiter = userName(uid);
    run('UPDATE shifts SET ended_at=?, ended_by=?, report_json=? WHERE id=?', now, actor.user.id, JSON.stringify(rep), sh.id);
    logEvent(actor, { type: 'SHIFT_CLOSED', amount: rep.umsatz, after: rep, details: { schicht_id: sh.id, mitarbeiter: rep.mitarbeiter } });
    return { shift_id: sh.id, report: rep };
  });
}

export { openQty, can };
