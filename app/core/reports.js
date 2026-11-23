// Auswertungen, Suchen und Historien (nur lesend)
import { one, all } from './db.js';
import { getSettings } from './auth.js';
import { fail, int, rangeFromQuery, periodRange, todayBerlin, berlinToUtc, berlinParts } from './util.js';
import { tablesOverview, orderView } from './pos.js';

const H = () => getSettings().business_day_start_hour;

function localDt(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) fail(400, 'Ungültiger Zeitpunkt');
  return berlinToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
}

// ---- Aktivitätsprotokoll ------------------------------------------------------
export function auditQuery(q, { forExport = false } = {}) {
  const w = [];
  const p = [];
  if (q.from_dt) { w.push('ts>=?'); p.push(localDt(q.from_dt)); }
  if (q.to_dt) { w.push('ts<?'); p.push(new Date(Date.parse(localDt(q.to_dt)) + 60000).toISOString()); }
  if (q.from || q.to || q.date) {
    const [a, b] = rangeFromQuery(q, H());
    w.push('ts>=? AND ts<?'); p.push(a, b);
  }
  if (q.user_id) { w.push('user_id=?'); p.push(int(q.user_id, 'Mitarbeiter')); }
  if (q.table_no) { w.push('(table_no=? OR target_table_no=?)'); const t = int(q.table_no, 'Tisch'); p.push(t, t); }
  if (q.article) { w.push('article_name LIKE ?'); p.push(`%${q.article}%`); }
  if (q.category) {
    const cats = String(q.category).split(',').filter(Boolean);
    w.push(`category IN (${cats.map(() => '?').join(',')})`); p.push(...cats);
  }
  if (q.type) { w.push('type=?'); p.push(String(q.type)); }
  if (q.order_id) { w.push('order_id=?'); p.push(int(q.order_id, 'Bestellung')); }
  if (q.lifecycle_id) { w.push('lifecycle_id=?'); p.push(int(q.lifecycle_id, 'Artikel-ID')); }
  if (q.after_seq) { w.push('seq>?'); p.push(int(q.after_seq, 'seq')); }
  if (q.q) {
    w.push('(reason LIKE ? OR article_name LIKE ? OR user_name LIKE ? OR details_json LIKE ? OR type LIKE ?)');
    for (let i = 0; i < 5; i++) p.push(`%${q.q}%`);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = one(`SELECT COUNT(*) c FROM audit_log ${where}`, ...p).c;
  const limit = forExport ? 50000 : Math.min(int(q.limit ?? 100, 'limit', { min: 1, max: 1000 }), 1000);
  const offset = forExport ? 0 : int(q.offset ?? 0, 'offset', { min: 0 });
  const rows = all(`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  return { total, rows };
}

export const auditEntry = (seq) => {
  const r = one('SELECT * FROM audit_log WHERE seq=?', int(seq, 'Ereignis'));
  if (!r) fail(404, 'Ereignis nicht gefunden');
  const journal = all('SELECT * FROM db_journal WHERE tx_id=? ORDER BY id', r.tx_id);
  const prev = one('SELECT seq, hash FROM audit_log WHERE seq=?', r.seq - 1);
  const next = one('SELECT seq, prev_hash FROM audit_log WHERE seq=?', r.seq + 1);
  return { entry: r, journal, prev, next };
};

// ---- Artikel-Lebenslauf -------------------------------------------------------
export function lifecycle(itemId) {
  const it = one('SELECT * FROM order_items WHERE id=?', int(itemId, 'Artikel-ID'));
  if (!it) fail(404, 'Artikel-ID nicht gefunden');
  const lid = it.lifecycle_id;
  const items = all(`SELECT i.*, t.number AS table_no, u.name AS created_by_name, o.status AS order_status FROM order_items i
     JOIN orders o ON o.id=i.order_id JOIN dining_tables t ON t.id=o.table_id JOIN users u ON u.id=i.created_by
     WHERE i.lifecycle_id=? ORDER BY i.id`, lid).map((i) => ({ ...i, open_qty: i.qty - i.cancelled_qty - i.moved_qty - i.billed_qty }));
  const orderIds = [...new Set(items.map((i) => i.order_id))];
  const events = all(`SELECT * FROM audit_log WHERE lifecycle_id=? OR (order_id IN (${orderIds.map(() => '?').join(',')})
       AND type IN ('TABLE_OPENED','TABLE_CHANGED','TABLE_TAKEOVER','TABLE_CLOSED','TABLE_REOPENED','INVOICE_REVERSED','INVOICE_CREATED'))
       ORDER BY seq`, lid, ...orderIds);
  const invoices = all(`SELECT DISTINCT v.id, v.invoice_no, v.kind, v.closed_at, v.total, v.table_no, ii.qty, ii.unit_price FROM invoice_items ii JOIN invoices v ON v.id=ii.invoice_id
     WHERE ii.lifecycle_id=? ORDER BY v.id`, lid);
  return { lifecycle_id: lid, root: items[0], items, events, invoices,
    cancellations: all('SELECT * FROM cancellations WHERE lifecycle_id=? ORDER BY id', lid),
    moves: all('SELECT * FROM item_moves WHERE lifecycle_id=? ORDER BY id', lid) };
}

// ---- Tisch-/Bestellungshistorie -------------------------------------------------
export function orderHistory(orderId) {
  const v = orderView(orderId);
  const id = v.order.id;
  const lids = [...new Set(v.items.map((i) => i.lifecycle_id))];
  const events = all(`SELECT * FROM audit_log WHERE order_id=? OR (type='ITEM_MOVED' AND json_extract(details_json,'$.nach_bestellung')=?)
     ORDER BY seq`, id, id);
  const movesIn = all('SELECT * FROM item_moves WHERE to_order_id=? ORDER BY id', id);
  const movesOut = all('SELECT * FROM item_moves WHERE from_order_id=? ORDER BY id', id);
  return { ...v, events, moves_in: movesIn, moves_out: movesOut, lifecycle_ids: lids };
}

// ---- Rechnungen -------------------------------------------------------------
export function invoiceSearch(q) {
  const w = [];
  const p = [];
  if (q.from || q.to || q.date) { const [a, b] = rangeFromQuery(q, H()); w.push('v.closed_at>=? AND v.closed_at<?'); p.push(a, b); }
  if (q.no) { w.push('v.invoice_no LIKE ?'); p.push(`%${q.no}%`); }
  if (q.table_no) { w.push('v.table_no=?'); p.push(int(q.table_no, 'Tisch')); }
  if (q.user_id) { w.push('(v.waiter_id=? OR v.closed_by=?)'); const u = int(q.user_id, 'Mitarbeiter'); p.push(u, u); }
  if (q.kind) { w.push('v.kind=?'); p.push(String(q.kind)); }
  if (q.method) { w.push('v.payment_method=?'); p.push(String(q.method)); }
  if (q.min) { w.push('ABS(v.total)>=?'); p.push(Math.round(Number(q.min) * 100)); }
  if (q.max) { w.push('ABS(v.total)<=?'); p.push(Math.round(Number(q.max) * 100)); }
  if (q.article) { w.push('EXISTS(SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=v.id AND ii.article_name LIKE ?)'); p.push(`%${q.article}%`); }
  if (q.closed_by) { w.push('v.closed_by=?'); p.push(int(q.closed_by, 'Mitarbeiter')); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return all(`SELECT v.id, v.invoice_no, v.kind, v.table_no, v.waiter_name, v.closed_by_name, v.opened_at, v.closed_at, v.subtotal,
      v.discount, v.total, v.payment_method, v.reverses_invoice_id, v.is_final, json_array_length(v.cancelled_json) AS storno_count,
      (SELECT r.invoice_no FROM invoices r WHERE r.reverses_invoice_id=v.id) AS reversed_by,
      (SELECT o.invoice_no FROM invoices o WHERE o.id=v.reverses_invoice_id) AS reverses_no
    FROM invoices v ${where} ORDER BY v.id DESC LIMIT 2000`, ...p);
}
export function invoiceDetail(id) {
  const v = one('SELECT * FROM invoices WHERE id=?', int(id, 'Rechnung'));
  if (!v) fail(404, 'Rechnung nicht gefunden');
  return {
    ...v, items: JSON.parse(v.items_json), cancelled: JSON.parse(v.cancelled_json), vat: JSON.parse(v.vat_json),
    payments: all('SELECT * FROM payments WHERE invoice_id=?', v.id),
    reversed_by: one('SELECT id, invoice_no, closed_at, closed_by_name FROM invoices WHERE reverses_invoice_id=?', v.id) || null,
    reverses: v.reverses_invoice_id ? one('SELECT id, invoice_no FROM invoices WHERE id=?', v.reverses_invoice_id) : null,
    approved_by_name: v.approved_by ? one('SELECT name FROM users WHERE id=?', v.approved_by)?.name : null,
    settings: { name: getSettings().business_name, address: getSettings().business_address, tax_id: getSettings().business_tax_id },
  };
}

// ---- Storni & Verschiebungen ---------------------------------------------------
export function cancellationList(q) {
  const [a, b] = rangeFromQuery(q, H());
  const p = [a, b];
  let extra = '';
  if (q.user_id) { extra += ' AND (c.cancelled_by=? OR c.entered_by=?)'; const u = int(q.user_id, 'Mitarbeiter'); p.push(u, u); }
  if (q.table_no) { extra += ' AND c.table_no=?'; p.push(int(q.table_no, 'Tisch')); }
  // Standard: echte Stornos. kind=ec liefert die wegen EC-Zahlung stornierten Artikel.
  extra += ' AND c.kind=?';
  p.push(q.kind === 'ec' ? 'ec' : 'storno');
  return all(`SELECT c.*, ue.name AS entered_by_name, uc.name AS cancelled_by_name, ua.name AS approved_by_name
     FROM cancellations c JOIN users ue ON ue.id=c.entered_by JOIN users uc ON uc.id=c.cancelled_by LEFT JOIN users ua ON ua.id=c.approved_by
     WHERE c.cancelled_at>=? AND c.cancelled_at<? ${extra} ORDER BY c.id DESC`, ...p);
}
export function moveList(q) {
  const [a, b] = rangeFromQuery(q, H());
  const p = [a, b];
  let extra = '';
  if (q.user_id) { extra += ' AND m.moved_by=?'; p.push(int(q.user_id, 'Mitarbeiter')); }
  if (q.table_no) { extra += ' AND (m.from_table_no=? OR m.to_table_no=?)'; const t = int(q.table_no, 'Tisch'); p.push(t, t); }
  return all(`SELECT m.*, u.name AS moved_by_name, ue.name AS entered_by_name, r.created_at AS entered_at, r.id AS root_id,
       (SELECT t.number FROM order_items ri JOIN orders ro ON ro.id=ri.order_id JOIN dining_tables t ON t.id=ro.table_id WHERE ri.id=m.lifecycle_id) AS original_table_no
     FROM item_moves m JOIN users u ON u.id=m.moved_by JOIN order_items r ON r.id=m.lifecycle_id JOIN users ue ON ue.id=r.created_by
     WHERE m.moved_at>=? AND m.moved_at<? ${extra} ORDER BY m.id DESC`, ...p);
}
export function priceChangeList(q) {
  const [a, b] = rangeFromQuery(q, H());
  return all(`SELECT pc.*, u.name AS changed_by_name, ua.name AS approved_by_name FROM price_changes pc JOIN users u ON u.id=pc.changed_by
     LEFT JOIN users ua ON ua.id=pc.approved_by WHERE pc.changed_at>=? AND pc.changed_at<? ORDER BY pc.id DESC`, a, b);
}

// ---- Mitarbeiter-Auswertung ------------------------------------------------------
export function employeeStats(q) {
  const period = ['day', 'week', 'month'].includes(q.period) ? q.period : 'day';
  const date = q.date || todayBerlin(H());
  const [a, b] = periodRange(period, date, H());
  const users = all('SELECT id, personal_nr, name, role, active FROM users ORDER BY personal_nr');
  const rows = users.map((u) => {
    const ev = (types) => one(`SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM audit_log WHERE user_id=? AND ts>=? AND ts<? AND type IN (${types.map(() => '?').join(',')})`, u.id, a, b, ...types);
    const entered = ev(['ITEM_ADDED', 'ITEM_QTY_INCREASED']);
    const tables = one(`SELECT COUNT(DISTINCT order_id) n FROM audit_log WHERE user_id=? AND ts>=? AND ts<? AND order_id IS NOT NULL
        AND category IN ('artikel','storno','verschiebung','abschluss','tisch','preis','wiedereroeffnung')`, u.id, a, b).n;
    const rev = one("SELECT COALESCE(SUM(total),0) v, SUM(kind='rechnung') n FROM invoices WHERE closed_by=? AND closed_at>=? AND closed_at<?", u.id, a, b);
    const st = one("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='storno' AND cancelled_by=? AND cancelled_at>=? AND cancelled_at<?", u.id, a, b);
    const stOwn = one("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='storno' AND entered_by=? AND cancelled_at>=? AND cancelled_at<?", u.id, a, b);
    const ec = one("SELECT COUNT(DISTINCT order_id) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='ec' AND cancelled_by=? AND cancelled_at>=? AND cancelled_at<?", u.id, a, b);
    const mv = one("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM item_moves WHERE moved_by=? AND moved_at>=? AND moved_at<?", u.id, a, b);
    const reopen = ev(['TABLE_REOPENED']).n;
    const price = ev(['ITEM_PRICE_CHANGED']).n;
    const quick = one("SELECT COUNT(*) n FROM cancellations WHERE kind='storno' AND cancelled_by=? AND cancelled_at>=? AND cancelled_at<? AND seconds_after_entry<=?", u.id, a, b, getSettings().alert_quick_storno_seconds).n;
    const disc = one("SELECT COALESCE(SUM(discount),0) v FROM invoices WHERE closed_by=? AND kind='rechnung' AND closed_at>=? AND closed_at<?", u.id, a, b).v;
    const alerts = one('SELECT COUNT(*) n FROM alerts WHERE user_id=? AND ts>=? AND ts<?', u.id, a, b).n;
    return {
      ...u, tische: tables, artikel_eingegeben: entered.q, umsatz: rev.v, rechnungen: rev.n || 0,
      stornos: st.n, storno_menge: st.q, storno_wert: st.v, stornos_eigener_eingaben: stOwn.n, sofortstornos: quick,
      ec_tische: ec.n, ec_wert: ec.v,
      verschiebungen: mv.n, verschobene_menge: mv.q, wiedereroeffnungen: reopen, preisaenderungen: price, rabatte: disc, warnungen: alerts,
      storno_quote: entered.q ? Math.round(st.q * 1000 / entered.q) / 10 : 0,
    };
  }).filter((r) => r.active || r.artikel_eingegeben || r.umsatz || r.stornos);
  return { period, date, from: a, to: b, rows };
}

// ---- Umsatz -------------------------------------------------------------------
export function revenue(q) {
  const [a, b] = q.from || q.to || q.date ? rangeFromQuery(q, H()) : periodRange('day', todayBerlin(H()), H());
  const byMethod = all('SELECT payment_method AS method, COUNT(*) n, SUM(total) total FROM invoices WHERE closed_at>=? AND closed_at<? GROUP BY payment_method ORDER BY total DESC', a, b);
  const byKind = all('SELECT kind, COUNT(*) n, SUM(total) total, SUM(discount) discount FROM invoices WHERE closed_at>=? AND closed_at<? GROUP BY kind', a, b);
  const byArticle = all(`SELECT ii.article_name, SUM(ii.qty) qty, SUM(ii.total) total FROM invoice_items ii JOIN invoices v ON v.id=ii.invoice_id
       WHERE v.closed_at>=? AND v.closed_at<? GROUP BY ii.article_id, ii.article_name ORDER BY total DESC`, a, b);
  const byCategory = all(`SELECT c.name, SUM(ii.qty) qty, SUM(ii.total) total FROM invoice_items ii JOIN invoices v ON v.id=ii.invoice_id
       JOIN articles ar ON ar.id=ii.article_id JOIN categories c ON c.id=ar.category_id WHERE v.closed_at>=? AND v.closed_at<? GROUP BY c.id ORDER BY total DESC`, a, b);
  const hours = {};
  for (const r of all('SELECT closed_at, total FROM invoices WHERE closed_at>=? AND closed_at<?', a, b)) {
    const h = berlinParts(new Date(r.closed_at)).hour;
    hours[h] = (hours[h] || 0) + r.total;
  }
  const byHour = Object.keys(hours).map(Number).sort((x, y) => x - y).map((h) => ({ h, total: hours[h] }));
  const vat = {};
  for (const r of all('SELECT vat_json FROM invoices WHERE closed_at>=? AND closed_at<?', a, b)) {
    for (const v of JSON.parse(r.vat_json)) {
      vat[v.satz] = vat[v.satz] || { satz: v.satz, brutto: 0, netto: 0, steuer: 0 };
      vat[v.satz].brutto += v.brutto; vat[v.satz].netto += v.netto; vat[v.satz].steuer += v.steuer;
    }
  }
  const st = one("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='storno' AND cancelled_at>=? AND cancelled_at<?", a, b);
  const ec = one("SELECT COUNT(DISTINCT order_id) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='ec' AND cancelled_at>=? AND cancelled_at<?", a, b);
  const total = byMethod.reduce((s, r) => s + r.total, 0);
  return { from: a, to: b, total, byMethod, byKind, byArticle, byCategory, byHour, vat: Object.values(vat), stornos: st, ec };
}

// ---- Soll-Ist (Warenentnahme vs. verkauft) ---------------------------------------
export function sollIst(q) {
  const [a, b] = q.from || q.to || q.date ? rangeFromQuery(q, H()) : periodRange('day', todayBerlin(H()), H());
  const arts = all(`SELECT ar.id, ar.name, ar.track_stock, c.name AS category FROM articles ar JOIN categories c ON c.id=ar.category_id
      ORDER BY c.sort, ar.sort, ar.name`);
  const variants = all('SELECT * FROM article_variants ORDER BY sort, id');
  const n = (sql, ...p) => one(sql, ...p).n;
  const vc = (col, vid) => (vid == null ? `${col} IS NULL` : `${col}=${Number(vid)}`);
  const rows = [];
  for (const ar of arts) {
    const vs = variants.filter((v) => v.article_id === ar.id);
    // Jede Variante wird einzeln gezählt (z. B. Shot, Longdrink, Flasche)
    const units = vs.length
      ? [...vs.map((v) => ({ vid: v.id, name: `${ar.name} – ${v.name}` })), { vid: null, name: ar.name, onlyData: true }]
      : [{ vid: null, name: ar.name }];
    for (const u of units) {
      const r = {
        id: ar.id, variant_id: u.vid, name: u.name, category: ar.category, track_stock: ar.track_stock,
        entnommen: n(`SELECT COALESCE(SUM(CASE kind WHEN 'entnahme' THEN qty ELSE -qty END),0) n FROM stock_movements s
            WHERE s.article_id=? AND ${vc('s.variant_id', u.vid)} AND s.ts>=? AND s.ts<?`, ar.id, a, b),
        verkauft: n(`SELECT COALESCE(SUM(ii.qty),0) n FROM invoice_items ii JOIN invoices v ON v.id=ii.invoice_id JOIN order_items oi ON oi.id=ii.item_id
            WHERE ii.article_id=? AND ${vc('oi.variant_id', u.vid)} AND v.closed_at>=? AND v.closed_at<?`, ar.id, a, b),
        storniert: n(`SELECT COALESCE(SUM(cc.qty),0) n FROM cancellations cc JOIN order_items oi ON oi.id=cc.item_id
            WHERE cc.kind='storno' AND oi.article_id=? AND ${vc('oi.variant_id', u.vid)} AND cc.cancelled_at>=? AND cc.cancelled_at<?`, ar.id, a, b),
        per_ec: n(`SELECT COALESCE(SUM(cc.qty),0) n FROM cancellations cc JOIN order_items oi ON oi.id=cc.item_id
            WHERE cc.kind='ec' AND oi.article_id=? AND ${vc('oi.variant_id', u.vid)} AND cc.cancelled_at>=? AND cc.cancelled_at<?`, ar.id, a, b),
        offen: n(`SELECT COALESCE(SUM(oi.qty-oi.cancelled_qty-oi.moved_qty-oi.billed_qty),0) n FROM order_items oi JOIN orders o ON o.id=oi.order_id
            WHERE oi.article_id=? AND ${vc('oi.variant_id', u.vid)} AND o.status='open'`, ar.id),
      };
      const hasData = r.entnommen || r.verkauft || r.storniert || r.per_ec || r.offen;
      if (u.onlyData ? !hasData : !(ar.track_stock || hasData)) continue;
      // Differenz = entnommen − verkauft − per EC bezahlt − noch auf offenen Tischen
      r.differenz = r.entnommen - r.verkauft - r.per_ec - r.offen;
      rows.push(r);
    }
  }
  const movements = all(`SELECT s.*, ar.name || COALESCE(' – ' || av.name, '') AS article_name, u.name AS user_name FROM stock_movements s
      JOIN articles ar ON ar.id=s.article_id LEFT JOIN article_variants av ON av.id=s.variant_id
      JOIN users u ON u.id=s.user_id WHERE s.ts>=? AND s.ts<? ORDER BY s.id DESC`, a, b);
  return { from: a, to: b, rows, movements };
}

// ---- Live-Übersicht ----------------------------------------------------------
export function live() {
  const h = H();
  const [a, b] = periodRange('day', todayBerlin(h), h);
  const tables = tablesOverview();
  const open = tables.filter((t) => t.order_id).map((t) => ({
    ...t,
    items: all(`SELECT i.id, i.lifecycle_id, i.article_name, i.unit_price, i.qty, i.cancelled_qty, i.moved_qty, i.billed_qty, i.origin_kind, i.created_at, u.name AS created_by_name
        FROM order_items i JOIN users u ON u.id=i.created_by WHERE i.order_id=? ORDER BY i.id`, t.order_id)
      .map((i) => ({ ...i, open_qty: i.qty - i.cancelled_qty - i.moved_qty - i.billed_qty })),
  }));
  const sessions = all(`SELECT s.id, s.device, s.kind, s.created_at, s.last_seen, u.id AS user_id, u.name, u.role, u.personal_nr FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.ended_at IS NULL AND s.last_seen>=? ORDER BY s.created_at`, new Date(Date.now() - 12 * 3600000).toISOString());
  const rev = one("SELECT COALESCE(SUM(total),0) v, SUM(kind='rechnung') n FROM invoices WHERE closed_at>=? AND closed_at<?", a, b);
  const st = one("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='storno' AND cancelled_at>=? AND cancelled_at<?", a, b);
  const ec = one("SELECT COUNT(DISTINCT order_id) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='ec' AND cancelled_at>=? AND cancelled_at<?", a, b);
  const mv = one('SELECT COUNT(*) n FROM item_moves WHERE moved_at>=? AND moved_at<?', a, b).n;
  return {
    day: todayBerlin(h), from: a, tables, open_orders: open, sessions,
    kpi: {
      umsatz: rev.v, rechnungen: rev.n || 0, offene_tische: open.length, offener_wert: open.reduce((s, t) => s + t.open_total, 0),
      stornos: st.n, storno_wert: st.v, ec_tische: ec.n, ec_wert: ec.v, verschiebungen: mv, warnungen_offen: one("SELECT COUNT(*) n FROM alerts WHERE status='offen'").n,
    },
    events: all('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 80'),
    cancellations: all(`SELECT c.*, uc.name AS cancelled_by_name, ue.name AS entered_by_name FROM cancellations c JOIN users uc ON uc.id=c.cancelled_by
        JOIN users ue ON ue.id=c.entered_by WHERE c.kind='storno' AND c.cancelled_at>=? ORDER BY c.id DESC LIMIT 30`, a),
    invoices: invoiceSearch({ from: todayBerlin(h), to: todayBerlin(h) }).slice(0, 30),
  };
}
