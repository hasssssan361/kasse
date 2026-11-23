// Datenbank: Schema, Schutz-Trigger, Transaktionen
// Der Manipulationsschutz sitzt IN der Datenbank (Trigger), nicht in der Oberfläche:
//  - Audit-Log, Rechnungen, Storni, Verschiebungen usw. sind nur anhängbar (kein UPDATE/DELETE).
//  - Jeder neue Audit-Eintrag muss fortlaufend nummeriert und korrekt hash-verkettet sein.
//  - Positionen können nicht gelöscht werden; Mengen können nur wachsen, Storno/Verschiebung/
//    Abrechnung nur zunehmen.
//  - Ein Änderungsjournal (db_journal) zeichnet per Trigger JEDE Zeilenänderung der Kerntabellen
//    auf – unabhängig vom Programmcode. Änderungen ohne Transaktionskennung der Kassensoftware
//    werden bei der Integritätsprüfung als "außerhalb der Software" gemeldet.
import { sha256, uuid } from './util.js';

export const AUDIT_FIELDS = [
  'seq', 'event_id', 'ts', 'tx_id', 'type', 'category', 'user_id', 'user_name', 'role', 'session_id',
  'device', 'table_no', 'target_table_no', 'order_id', 'item_id', 'lifecycle_id', 'article_name', 'qty',
  'unit_price', 'amount', 'before_json', 'after_json', 'reason', 'details_json', 'source',
];
export const INVOICE_HASH_FIELDS = [
  'invoice_no', 'kind', 'order_id', 'table_no', 'waiter_id', 'closed_by', 'opened_at', 'closed_at',
  'subtotal', 'discount', 'total', 'payment_method', 'items_json', 'cancelled_json', 'reverses_invoice_id', 'audit_seq',
];
export const chainHash = (...args) => sha256(JSON.stringify(args.map((a) => (a === undefined ? null : a))));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ctx(id INTEGER PRIMARY KEY CHECK(id=1), tx_id TEXT, purge INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO ctx(id,tx_id,purge) VALUES(1,NULL,0);
-- Gelöschte (abgeschlossene) Zeiträume: Startpunkt für die Prüfung der verbleibenden Hash-Ketten
CREATE TABLE IF NOT EXISTS purges(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user_id INTEGER, user_name TEXT, closing_id INTEGER NOT NULL, from_ts TEXT, to_ts TEXT,
  audit_seq INTEGER NOT NULL, audit_hash TEXT NOT NULL, invoice_id INTEGER, invoice_hash TEXT, invoice_seq_json TEXT NOT NULL,
  journal_id INTEGER NOT NULL, counts_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS roles(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL, permissions TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, personal_nr INTEGER UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(code), pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  device TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, ended_at TEXT, end_reason TEXT);

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('speise','getraenk','sonstiges')),
  color TEXT NOT NULL DEFAULT '#64748b', sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS articles(
  id INTEGER PRIMARY KEY, plu INTEGER UNIQUE, name TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
  price INTEGER NOT NULL CHECK(price>=0), vat INTEGER NOT NULL DEFAULT 19, track_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS dining_tables(
  id INTEGER PRIMARY KEY, number INTEGER UNIQUE NOT NULL, name TEXT, area TEXT NOT NULL DEFAULT 'Gastraum',
  seats INTEGER NOT NULL DEFAULT 4, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES dining_tables(id),
  status TEXT NOT NULL CHECK(status IN('open','closed','merged')),
  opened_by INTEGER NOT NULL REFERENCES users(id), opened_at TEXT NOT NULL,
  waiter_id INTEGER NOT NULL REFERENCES users(id), closed_by INTEGER, closed_at TEXT, reopen_count INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_order_per_table ON orders(table_id) WHERE status='open';

CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, lifecycle_id INTEGER NOT NULL,
  origin_item_id INTEGER, origin_kind TEXT NOT NULL CHECK(origin_kind IN('entry','move','reopen')),
  article_id INTEGER NOT NULL REFERENCES articles(id), article_name TEXT NOT NULL, category_kind TEXT,
  vat INTEGER NOT NULL, list_price INTEGER NOT NULL, unit_price INTEGER NOT NULL CHECK(unit_price>=0),
  qty INTEGER NOT NULL CHECK(qty>0), cancelled_qty INTEGER NOT NULL DEFAULT 0, moved_qty INTEGER NOT NULL DEFAULT 0,
  billed_qty INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  raw_input TEXT,
  CHECK(cancelled_qty>=0 AND moved_qty>=0 AND billed_qty>=0 AND cancelled_qty+moved_qty+billed_qty<=qty));
CREATE INDEX IF NOT EXISTS oi_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS oi_life ON order_items(lifecycle_id);

CREATE TABLE IF NOT EXISTS cancellations(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, lifecycle_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL, table_no INTEGER NOT NULL, article_name TEXT NOT NULL, qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, total INTEGER NOT NULL, entered_by INTEGER NOT NULL, entered_at TEXT NOT NULL,
  cancelled_by INTEGER NOT NULL, cancelled_at TEXT NOT NULL, reason TEXT NOT NULL,
  approval_required INTEGER NOT NULL, approved_by INTEGER, seconds_after_entry INTEGER NOT NULL, audit_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS item_moves(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('artikel','tischwechsel')), source_item_id INTEGER NOT NULL,
  target_item_id INTEGER NOT NULL, lifecycle_id INTEGER NOT NULL, from_order_id INTEGER NOT NULL, to_order_id INTEGER NOT NULL,
  from_table_no INTEGER NOT NULL, to_table_no INTEGER NOT NULL, article_name TEXT NOT NULL, qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, moved_by INTEGER NOT NULL, moved_at TEXT NOT NULL, reason TEXT, audit_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS price_changes(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, lifecycle_id INTEGER NOT NULL, order_id INTEGER NOT NULL,
  table_no INTEGER NOT NULL, article_name TEXT NOT NULL, qty INTEGER NOT NULL, old_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL, changed_by INTEGER NOT NULL, approved_by INTEGER, changed_at TEXT NOT NULL,
  reason TEXT NOT NULL, audit_seq INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY, invoice_no TEXT UNIQUE NOT NULL, year INTEGER NOT NULL, seq_in_year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('rechnung','storno')), order_id INTEGER NOT NULL, table_no INTEGER NOT NULL,
  waiter_id INTEGER NOT NULL, waiter_name TEXT NOT NULL, closed_by INTEGER NOT NULL, closed_by_name TEXT NOT NULL,
  opened_at TEXT NOT NULL, closed_at TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT, total INTEGER NOT NULL, vat_json TEXT NOT NULL, payment_method TEXT NOT NULL,
  given INTEGER, change_amount INTEGER, items_json TEXT NOT NULL, cancelled_json TEXT NOT NULL,
  reverses_invoice_id INTEGER, is_final INTEGER NOT NULL, approved_by INTEGER,
  audit_seq INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  UNIQUE(year, seq_in_year));
CREATE INDEX IF NOT EXISTS inv_closed ON invoices(closed_at);
CREATE TABLE IF NOT EXISTS invoice_items(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  lifecycle_id INTEGER NOT NULL, article_id INTEGER NOT NULL, article_name TEXT NOT NULL, vat INTEGER NOT NULL,
  qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, total INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, method TEXT NOT NULL,
  amount INTEGER NOT NULL, given INTEGER, change_amount INTEGER, user_id INTEGER NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS shifts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), started_at TEXT NOT NULL,
  ended_at TEXT, ended_by INTEGER, report_json TEXT);
CREATE TABLE IF NOT EXISTS day_closings(
  id INTEGER PRIMARY KEY, from_ts TEXT NOT NULL, to_ts TEXT NOT NULL, closed_by INTEGER NOT NULL,
  data_json TEXT NOT NULL, audit_seq INTEGER NOT NULL, audit_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(id), qty INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('entnahme','rueckgabe')), user_id INTEGER NOT NULL, ts TEXT NOT NULL,
  note TEXT, audit_seq INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log(
  seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL, tx_id TEXT, type TEXT NOT NULL,
  category TEXT NOT NULL, user_id INTEGER, user_name TEXT, role TEXT, session_id TEXT, device TEXT,
  table_no INTEGER, target_table_no INTEGER, order_id INTEGER, item_id INTEGER, lifecycle_id INTEGER,
  article_name TEXT, qty INTEGER, unit_price INTEGER, amount INTEGER, before_json TEXT, after_json TEXT,
  reason TEXT, details_json TEXT, source TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS al_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS al_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS al_table ON audit_log(table_no);
CREATE INDEX IF NOT EXISTS al_ttable ON audit_log(target_table_no);
CREATE INDEX IF NOT EXISTS al_order ON audit_log(order_id);
CREATE INDEX IF NOT EXISTS al_life ON audit_log(lifecycle_id);
CREATE INDEX IF NOT EXISTS al_type ON audit_log(type);

CREATE TABLE IF NOT EXISTS admin_actions(
  id INTEGER PRIMARY KEY, audit_seq INTEGER NOT NULL, ts TEXT NOT NULL, admin_id INTEGER NOT NULL, admin_name TEXT NOT NULL,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, before_json TEXT, after_json TEXT);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN('info','mittel','hoch')),
  user_id INTEGER, user_name TEXT, title TEXT NOT NULL, message TEXT NOT NULL, details_json TEXT,
  related_seq INTEGER, dedupe_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN('offen','geprueft')),
  ack_by INTEGER, ack_at TEXT, ack_note TEXT);
CREATE TABLE IF NOT EXISTS anchors(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, invoice_hash TEXT, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS db_journal(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  tx_id TEXT, tbl TEXT NOT NULL, row_id TEXT, op TEXT NOT NULL, old_json TEXT, new_json TEXT);
CREATE INDEX IF NOT EXISTS j_tx ON db_journal(tx_id);
`;

// Tabellen, die nie verändert oder gelöscht werden dürfen
const APPEND_ONLY = [
  'audit_log', 'cancellations', 'item_moves', 'price_changes', 'invoices', 'invoice_items', 'payments',
  'day_closings', 'stock_movements', 'admin_actions', 'anchors', 'db_journal',
];
// Tabellen, deren Zeilenänderungen das Journal automatisch mitschreibt
const JOURNALED = ['orders', 'order_items', 'articles', 'categories', 'dining_tables', 'users', 'roles', 'settings', 'shifts', 'alerts'];

const NOPURGE = "(SELECT purge FROM ctx WHERE id=1)=0";
const LASTPURGE = (col) => `(SELECT ${col} FROM purges ORDER BY id DESC LIMIT 1)`;

function protectionTriggers(db) {
  const sql = [];
  for (const t of APPEND_ONLY) {
    sql.push(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
      BEGIN SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: ${t} ist unveränderbar'); END;`);
    sql.push(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} WHEN ${NOPURGE}
      BEGIN SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Einträge in ${t} können nicht gelöscht werden'); END;`);
  }
  // Audit-Log: fortlaufende Nummer, korrekte Verkettung, Hash, keine Rückdatierung
  const hashArgs = AUDIT_FIELDS.map((f) => `NEW.${f}`).join(',');
  sql.push(`CREATE TRIGGER IF NOT EXISTS audit_log_chain BEFORE INSERT ON audit_log BEGIN
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Ereignisnummer nicht fortlaufend')
      WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit_log),${LASTPURGE('audit_seq')},0)+1;
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Hash-Kette unterbrochen')
      WHERE NEW.prev_hash <> COALESCE((SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1),${LASTPURGE('audit_hash')},'GENESIS');
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Zeitstempel liegt vor dem letzten Eintrag')
      WHERE NEW.ts < COALESCE((SELECT ts FROM audit_log ORDER BY seq DESC LIMIT 1),'');
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Hash ungültig')
      WHERE NEW.hash <> chain_hash(NEW.prev_hash,${hashArgs});
  END;`);
  const invArgs = INVOICE_HASH_FIELDS.map((f) => `NEW.${f}`).join(',');
  sql.push(`CREATE TRIGGER IF NOT EXISTS invoices_chain BEFORE INSERT ON invoices BEGIN
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Rechnungsnummer nicht fortlaufend')
      WHERE NEW.seq_in_year <> COALESCE((SELECT MAX(seq_in_year) FROM invoices WHERE year=NEW.year),
        (SELECT json_extract(invoice_seq_json, '$."' || NEW.year || '"') FROM purges ORDER BY id DESC LIMIT 1),0)+1;
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Rechnungs-Hash-Kette unterbrochen')
      WHERE NEW.prev_hash <> COALESCE((SELECT hash FROM invoices ORDER BY id DESC LIMIT 1),${LASTPURGE('invoice_hash')},'GENESIS');
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Rechnungs-Hash ungültig')
      WHERE NEW.hash <> chain_hash(NEW.prev_hash,${invArgs});
  END;`);
  // Positionen: nie löschen, Stammfelder fix, Mengen nur wachsend
  sql.push(`CREATE TRIGGER IF NOT EXISTS order_items_no_delete BEFORE DELETE ON order_items WHEN ${NOPURGE}
    BEGIN SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Positionen können nicht gelöscht werden – nur storniert'); END;`);
  sql.push(`CREATE TRIGGER IF NOT EXISTS order_items_guard BEFORE UPDATE ON order_items BEGIN
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Stammdaten einer Position sind unveränderbar')
      WHERE NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id OR NEW.lifecycle_id IS NOT OLD.lifecycle_id
         OR NEW.origin_item_id IS NOT OLD.origin_item_id OR NEW.origin_kind IS NOT OLD.origin_kind
         OR NEW.article_id IS NOT OLD.article_id OR NEW.article_name IS NOT OLD.article_name
         OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
         OR NEW.list_price IS NOT OLD.list_price OR NEW.vat IS NOT OLD.vat OR NEW.raw_input IS NOT OLD.raw_input;
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Mengen dürfen nicht verringert werden – bitte stornieren')
      WHERE NEW.qty < OLD.qty OR NEW.cancelled_qty < OLD.cancelled_qty OR NEW.moved_qty < OLD.moved_qty
         OR NEW.billed_qty < OLD.billed_qty;
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Preis nur vor Storno/Verschiebung/Abrechnung änderbar')
      WHERE NEW.unit_price <> OLD.unit_price AND (OLD.cancelled_qty+OLD.moved_qty+OLD.billed_qty)>0;
  END;`);
  sql.push(`CREATE TRIGGER IF NOT EXISTS orders_no_delete BEFORE DELETE ON orders WHEN ${NOPURGE}
    BEGIN SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Bestellungen können nicht gelöscht werden'); END;`);
  sql.push(`CREATE TRIGGER IF NOT EXISTS orders_guard BEFORE UPDATE ON orders BEGIN
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Eröffnungsdaten sind unveränderbar')
      WHERE NEW.opened_by IS NOT OLD.opened_by OR NEW.opened_at IS NOT OLD.opened_at OR NEW.id IS NOT OLD.id;
  END;`);
  for (const t of ['users', 'articles', 'categories', 'dining_tables', 'shifts', 'alerts', 'roles', 'settings']) {
    const when = ['shifts', 'alerts'].includes(t) ? ` WHEN ${NOPURGE}` : '';
    sql.push(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}${when}
      BEGIN SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Löschen nicht erlaubt – bitte deaktivieren'); END;`);
  }
  sql.push(`CREATE TRIGGER IF NOT EXISTS shifts_guard BEFORE UPDATE ON shifts BEGIN
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Abgeschlossene Schicht ist unveränderbar') WHERE OLD.ended_at IS NOT NULL;
  END;`);
  sql.push(`CREATE TRIGGER IF NOT EXISTS alerts_guard BEFORE UPDATE ON alerts BEGIN
    SELECT RAISE(ABORT,'MANIPULATIONSSCHUTZ: Warnmeldung nur einmal als geprüft markierbar')
      WHERE OLD.status='geprueft' OR NEW.ts IS NOT OLD.ts OR NEW.rule IS NOT OLD.rule OR NEW.title IS NOT OLD.title
         OR NEW.message IS NOT OLD.message OR NEW.details_json IS NOT OLD.details_json OR NEW.user_id IS NOT OLD.user_id
         OR NEW.severity IS NOT OLD.severity OR NEW.dedupe_key IS NOT OLD.dedupe_key;
  END;`);

  // Journal-Trigger aus den tatsächlichen Spalten erzeugen
  for (const t of JOURNALED) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const pk = cols.includes('id') ? 'id' : cols.includes('code') ? 'code' : 'key';
    const obj = (p) => `json_object(${cols.map((c) => `'${c}',${p}.${c}`).join(',')})`;
    const tx = `(SELECT tx_id FROM ctx WHERE id=1)`;
    sql.push(`CREATE TRIGGER IF NOT EXISTS j_${t}_ins AFTER INSERT ON ${t} BEGIN
      INSERT INTO db_journal(tx_id,tbl,row_id,op,old_json,new_json) VALUES(${tx},'${t}',NEW.${pk},'INSERT',NULL,${obj('NEW')}); END;`);
    sql.push(`CREATE TRIGGER IF NOT EXISTS j_${t}_upd AFTER UPDATE ON ${t} BEGIN
      INSERT INTO db_journal(tx_id,tbl,row_id,op,old_json,new_json) VALUES(${tx},'${t}',NEW.${pk},'UPDATE',${obj('OLD')},${obj('NEW')}); END;`);
    sql.push(`CREATE TRIGGER IF NOT EXISTS j_${t}_del AFTER DELETE ON ${t} WHEN ${NOPURGE} BEGIN
      INSERT INTO db_journal(tx_id,tbl,row_id,op,old_json,new_json) VALUES(${tx},'${t}',OLD.${pk},'DELETE',${obj('OLD')},NULL); END;`);
  }
  db.exec(sql.join('\n'));
}

export const EXPECTED_TRIGGER_COUNT = () => APPEND_ONLY.length * 2 + 2 + 4 + 8 + 2 + JOURNALED.length * 3;

export let db = null;

/**
 * Öffnet die Datenbank über einen Treiber (Browser: SQLite-WebAssembly, Tests: Node).
 * Treiber-Schnittstelle: exec(sql), prepare(sql) → { get, all, run }, function(name, fn), close().
 */
export function openDb(driver) {
  db = driver;
  db.function('chain_hash', (...a) => chainHash(...a));
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  protectionTriggers(db);
  // Falls die App zuvor abgebrochen wurde, Kontext zurücksetzen
  db.prepare('UPDATE ctx SET tx_id=NULL, purge=0 WHERE id=1').run();
  return db;
}

// ---- Transaktionen ----------------------------------------------------------
let current = null; // { txId, events: [], after: [] }
export function tx(fn) {
  if (current) return fn(current);
  db.exec('BEGIN IMMEDIATE');
  const t = { txId: uuid(), events: [], after: [] };
  current = t;
  try {
    db.prepare('UPDATE ctx SET tx_id=? WHERE id=1').run(t.txId);
    const r = fn(t);
    db.prepare('UPDATE ctx SET tx_id=NULL WHERE id=1').run();
    db.exec('COMMIT');
    current = null;
    for (const cb of t.after) {
      try { cb(t); } catch (e) { console.error('Nachlauf-Fehler', e); }
    }
    return r;
  } catch (e) {
    current = null;
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}
export const inTx = () => current;

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
