// Unveränderbares, hash-verkettetes Audit-Log
import { db, one, all, tx, inTx, AUDIT_FIELDS, INVOICE_HASH_FIELDS, chainHash, EXPECTED_TRIGGER_COUNT } from './db.js';
import { nowIso, uuid } from './util.js';
import { publish } from './events.js';
import { evaluateAll } from './alerts.js';

export const EVENT_CATEGORY = {
  LOGIN: 'anmeldung', LOGIN_FAILED: 'anmeldung', LOGOUT: 'anmeldung', SESSION_EXPIRED: 'anmeldung',
  TABLE_OPENED: 'tisch', TABLE_TAKEOVER: 'tisch', ORDER_CLOSED_EMPTY: 'abschluss',
  ITEM_ADDED: 'artikel', ITEM_QTY_INCREASED: 'artikel',
  ITEM_CANCELLED: 'storno', DIALOG_ABORTED: 'eingabe',
  ITEM_PRICE_CHANGED: 'preis', ARTICLE_PRICE_CHANGED: 'preis',
  ITEM_MOVED: 'verschiebung', TABLE_CHANGED: 'verschiebung',
  INVOICE_CREATED: 'abschluss', TABLE_CLOSED: 'abschluss',
  INVOICE_REVERSED: 'wiedereroeffnung', TABLE_REOPENED: 'wiedereroeffnung',
  APPROVAL_GRANTED: 'freigabe', APPROVAL_FAILED: 'freigabe',
  SHIFT_STARTED: 'schicht', SHIFT_CLOSED: 'schicht', DAY_CLOSED: 'schicht',
  STOCK_MOVEMENT: 'lager',
  ALERT_ACKNOWLEDGED: 'admin', EXPORT_CREATED: 'admin', INTEGRITY_CHECK: 'admin', BACKUP_CREATED: 'system',
  ANCHOR_CREATED: 'system', SYSTEM_START: 'system',
};
export const categoryOf = (type) => EVENT_CATEGORY[type] || 'admin';

/**
 * Schreibt ein Ereignis ins Audit-Log. Muss innerhalb einer Transaktion laufen,
 * damit Änderung und Protokolleintrag nur gemeinsam gespeichert werden (alles oder nichts).
 */
export function logEvent(actor, e) {
  const t = inTx();
  if (!t) throw new Error('logEvent nur innerhalb einer Transaktion');
  const last = lastAuditHash();
  let ts = nowIso();
  if (last && ts < last.ts) ts = last.ts; // Systemuhr zurückgestellt -> nie rückdatieren
  const j = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const row = {
    seq: (last?.seq || 0) + 1,
    event_id: uuid(),
    ts,
    tx_id: t.txId,
    type: e.type,
    category: e.category || categoryOf(e.type),
    user_id: actor?.user?.id ?? null,
    user_name: actor?.user?.name ?? null,
    role: actor?.user?.role ?? null,
    session_id: actor?.session?.id ?? null,
    device: actor?.device ?? actor?.session?.device ?? null,
    table_no: e.table_no ?? null,
    target_table_no: e.target_table_no ?? null,
    order_id: e.order_id ?? null,
    item_id: e.item_id ?? null,
    lifecycle_id: e.lifecycle_id ?? null,
    article_name: e.article_name ?? null,
    qty: e.qty ?? null,
    unit_price: e.unit_price ?? null,
    amount: e.amount ?? null,
    before_json: j(e.before),
    after_json: j(e.after),
    reason: e.reason ?? null,
    details_json: j(e.details),
    source: e.source || 'server',
  };
  row.prev_hash = last?.hash || 'GENESIS';
  row.hash = chainHash(row.prev_hash, ...AUDIT_FIELDS.map((f) => row[f]));
  const cols = [...AUDIT_FIELDS, 'prev_hash', 'hash'];
  db.prepare(`INSERT INTO audit_log(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  t.events.push(row);
  if (!t.publishHooked) {
    t.publishHooked = true;
    t.after.push((tt) => {
      for (const ev of tt.events) publish('event', ev);
      evaluateAll(tt.events);
    });
  }
  return row;
}

export function logAdmin(actor, action, targetType, targetId, before, after, extra = {}) {
  const ev = logEvent(actor, {
    type: action, before, after, ...extra,
    details: { target_type: targetType, target_id: targetId, ...(extra.details || {}) },
  });
  db.prepare(`INSERT INTO admin_actions(audit_seq,ts,admin_id,admin_name,action,target_type,target_id,before_json,after_json)
              VALUES(?,?,?,?,?,?,?,?,?)`).run(ev.seq, ev.ts, actor.user.id, actor.user.name, action, targetType,
    targetId == null ? null : String(targetId), ev.before_json, ev.after_json);
  return ev;
}

// Letzter Eintrag – nach einer Löschung alter Zeiträume ggf. der gespeicherte Endpunkt der gelöschten Kette
export const lastPurge = () => one('SELECT * FROM purges ORDER BY id DESC LIMIT 1');
export const lastAuditHash = () => one('SELECT seq, hash, ts FROM audit_log ORDER BY seq DESC LIMIT 1')
  || (() => { const p = lastPurge(); return p ? { seq: p.audit_seq, hash: p.audit_hash, ts: '' } : null; })();

// ---- Integritätsprüfung -----------------------------------------------------
export function verifyIntegrity() {
  const problems = [];
  let count = 0;
  const purge = lastPurge();
  let prev = purge?.audit_hash || 'GENESIS';
  let expected = (purge?.audit_seq || 0) + 1;
  let lastTs = '';
  for (const r of all('SELECT * FROM audit_log ORDER BY seq')) {
    count++;
    if (r.seq !== expected) problems.push({ art: 'Lücke', text: `Ereignis ${expected} bis ${r.seq - 1} fehlen (gelöscht?)` });
    if (r.prev_hash !== prev) problems.push({ art: 'Kette', text: `Ereignis ${r.seq}: Verweis auf Vorgänger stimmt nicht` });
    const h = chainHash(r.prev_hash, ...AUDIT_FIELDS.map((f) => r[f]));
    if (h !== r.hash) problems.push({ art: 'Hash', text: `Ereignis ${r.seq}: Inhalt wurde nachträglich verändert` });
    if (r.ts < lastTs) problems.push({ art: 'Zeit', text: `Ereignis ${r.seq}: Zeitstempel rückdatiert` });
    prev = r.hash;
    expected = r.seq + 1;
    lastTs = r.ts;
    if (problems.length > 200) break;
  }
  // Rechnungen
  let invPrev = purge?.invoice_hash || 'GENESIS';
  let invCount = 0;
  const years = purge ? JSON.parse(purge.invoice_seq_json) : {};
  for (const r of all('SELECT * FROM invoices ORDER BY id')) {
    invCount++;
    if (r.prev_hash !== invPrev) problems.push({ art: 'Rechnung', text: `Rechnung ${r.invoice_no}: Kette unterbrochen` });
    const h = chainHash(r.prev_hash, ...INVOICE_HASH_FIELDS.map((f) => r[f]));
    if (h !== r.hash) problems.push({ art: 'Rechnung', text: `Rechnung ${r.invoice_no}: Inhalt verändert` });
    years[r.year] = (years[r.year] || 0) + 1;
    if (r.seq_in_year !== years[r.year]) problems.push({ art: 'Rechnung', text: `Rechnungsnummer ${r.invoice_no}: Lücke in der Nummernfolge` });
    const items = all('SELECT item_id,article_name,qty,unit_price,total FROM invoice_items WHERE invoice_id=? ORDER BY id', r.id);
    const snap = JSON.parse(r.items_json).map((i) => ({ item_id: i.item_id, article_name: i.article_name, qty: i.qty, unit_price: i.unit_price, total: i.total }));
    if (JSON.stringify(items.map((i) => ({ ...i }))) !== JSON.stringify(snap)) problems.push({ art: 'Rechnung', text: `Rechnung ${r.invoice_no}: Positionen weichen vom Original ab` });
    invPrev = r.hash;
  }
  // Journal: Änderungen außerhalb der Kassensoftware?
  const foreign = all(`SELECT id, ts, tbl, row_id, op FROM db_journal WHERE tx_id IS NULL ORDER BY id LIMIT 50`);
  for (const f of foreign) problems.push({ art: 'Fremdzugriff', text: `Datenbank direkt verändert: ${f.op} in ${f.tbl} (Zeile ${f.row_id}) am ${f.ts}` });
  const orphan = all(`SELECT DISTINCT j.tx_id FROM db_journal j WHERE j.tx_id IS NOT NULL AND j.tbl IN ('orders','order_items')
                      AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.tx_id=j.tx_id) LIMIT 20`);
  for (const o of orphan) problems.push({ art: 'Journal', text: `Änderung an Bestellungen ohne Protokolleintrag (Transaktion ${o.tx_id.slice(0, 8)})` });
  const jseq = one(`SELECT seq FROM sqlite_sequence WHERE name='db_journal'`)?.seq || 0;
  const jcnt = one('SELECT COUNT(*) c, MIN(id) mi, MAX(id) m FROM db_journal');
  const jStart = (purge?.journal_id || 0) + 1;
  const jOk = jcnt.c === 0 ? jseq <= (purge?.journal_id || 0) : (jcnt.mi === jStart && jcnt.m - jcnt.mi + 1 === jcnt.c && jseq === jcnt.m);
  if (!jOk) problems.push({ art: 'Journal', text: 'Einträge im Änderungsjournal fehlen (gelöscht?)' });
  // Schutz-Trigger vorhanden?
  const trig = one(`SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'`).c;
  if (trig < EXPECTED_TRIGGER_COUNT()) problems.push({ art: 'Schutz', text: `Schutz-Trigger fehlen (${trig} von ${EXPECTED_TRIGGER_COUNT()})` });
  // Anker: gespeicherte Hashes müssen noch zum Log passen
  for (const a of all('SELECT * FROM anchors ORDER BY id')) {
    const r = one('SELECT hash FROM audit_log WHERE seq=?', a.seq);
    if (!r || r.hash !== a.hash) problems.push({ art: 'Anker', text: `Sicherungsanker #${a.id} (Ereignis ${a.seq}) passt nicht mehr zum Protokoll` });
  }
  const last = lastAuditHash();
  return {
    ok: problems.length === 0,
    events: count,
    invoices: invCount,
    journal: jcnt.c,
    triggers: trig,
    last_seq: last?.seq || 0,
    last_hash: last?.hash || null,
    checked_at: nowIso(),
    problems,
  };
}

export function createAnchor(actor, kind = 'manuell') {
  return tx(() => {
    const ev = logEvent(actor, { type: 'ANCHOR_CREATED', details: { kind } });
    const inv = one('SELECT hash FROM invoices ORDER BY id DESC LIMIT 1');
    db.prepare('INSERT INTO anchors(ts,seq,hash,invoice_hash,kind) VALUES(?,?,?,?,?)').run(ev.ts, ev.seq, ev.hash, inv?.hash || null, kind);
    return { ts: ev.ts, seq: ev.seq, hash: ev.hash, invoice_hash: inv?.hash || null, kind };
  });
}
