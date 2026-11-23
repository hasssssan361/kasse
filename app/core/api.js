// Schnittstelle der App: Kasse und Admin-Bereich rufen Funktionen über Pfade auf
// (wie früher beim Server, jetzt direkt im Gerät). Keine Lösch-Schnittstelle außer der
// kontrollierten Löschung alter Tagesabschlüsse.
import { openDb, one, all, run, tx } from './db.js';
import { HttpError, fail, nowIso, int, fmtBerlin, euro, rangeFromQuery, periodRange, todayBerlin } from './util.js';
import * as auth from './auth.js';
import * as pos from './pos.js';
import * as rep from './reports.js';
import * as adm from './manage.js';
import { logEvent, verifyIntegrity, lastAuditHash, createAnchor } from './audit.js';
import { toCsv, toPdf, pdfTable } from './export.js';
import { ensureBaseData, loadDemoData } from './seed.js';
export { subscribe } from './events.js';

const file = (data, contentType, filename) => ({ __file: true, data, contentType, filename });

const TYPE_LABEL = {
  LOGIN: 'Anmeldung', LOGIN_FAILED: 'Anmeldung fehlgeschlagen', LOGOUT: 'Abmeldung', SESSION_EXPIRED: 'Sitzung beendet',
  TABLE_OPENED: 'Tisch eröffnet', TABLE_TAKEOVER: 'Tisch übernommen', ITEM_ADDED: 'Artikel eingegeben', ITEM_QTY_INCREASED: 'Menge erhöht',
  ITEM_CANCELLED: 'STORNO', ITEM_PRICE_CHANGED: 'Preis geändert', ITEM_MOVED: 'Artikel verschoben', TABLE_CHANGED: 'Tischwechsel',
  INVOICE_CREATED: 'Rechnung erstellt', TABLE_CLOSED: 'Tisch abgeschlossen', INVOICE_REVERSED: 'Rechnung storniert',
  TABLE_REOPENED: 'Tisch wiedereröffnet', ORDER_CLOSED_EMPTY: 'Tisch ohne Umsatz geschlossen', DIALOG_ABORTED: 'Dialog abgebrochen',
  APPROVAL_FAILED: 'Freigabe fehlgeschlagen', SHIFT_STARTED: 'Schicht begonnen', SHIFT_CLOSED: 'Schicht abgeschlossen',
  DAY_CLOSED: 'Tagesabschluss', STOCK_MOVEMENT: 'Warenbewegung', ARTICLE_PRICE_CHANGED: 'Artikelpreis geändert (Stammdaten)',
  ARTICLE_CREATED: 'Artikel angelegt', ARTICLE_UPDATED: 'Artikel geändert', CATEGORY_CREATED: 'Kategorie angelegt', CATEGORY_UPDATED: 'Kategorie geändert',
  TABLE_CREATED: 'Tisch angelegt', TABLE_UPDATED: 'Tisch geändert', USER_CREATED: 'Benutzer angelegt', USER_UPDATED: 'Benutzer geändert',
  PIN_CHANGED: 'PIN geändert', ROLE_UPDATED: 'Rechte geändert', SETTINGS_UPDATED: 'Einstellungen geändert', ALERT_ACKNOWLEDGED: 'Warnung geprüft',
  EXPORT_CREATED: 'Export erstellt', INTEGRITY_CHECK: 'Integritätsprüfung', BACKUP_CREATED: 'Sicherung erstellt', ANCHOR_CREATED: 'Sicherungsanker',
  SYSTEM_START: 'App gestartet', DEMO_DATA_CREATED: 'Beispieldaten angelegt', CLOSING_DELETED: 'Tagesabschluss gelöscht',
};
export { TYPE_LABEL };

// ---- Routen ----------------------------------------------------------------------
const routes = [];
const r = (method, pattern, perm, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, perm, handler });
};

// Anmeldung
r('POST', '/api/login', null, (_a, _p, _q, b) => auth.login(b));
r('POST', '/api/logout', 'any', (a, _p, _q, b) => { auth.logout(a, b.reason); return { ok: true }; });
r('GET', '/api/me', 'any', (a) => ({ user: a.user, permissions: a.permissions, kind: a.session.kind, settings: publicSettings() }));
r('POST', '/api/me/pin', 'any', (a, _p, _q, b) => adm.changeOwnPin(a, b, auth.checkPin));

function publicSettings() {
  const s = auth.getSettings();
  return {
    business_name: s.business_name, business_address: s.business_address, auto_logout_minutes: s.auto_logout_minutes,
    payment_methods: s.payment_methods, move_requires_reason: s.move_requires_reason,
    storno_approval_always: s.storno_approval_always, storno_approval_min_value: s.storno_approval_min_value,
    storno_approval_after_minutes: s.storno_approval_after_minutes, reopen_requires_approval: s.reopen_requires_approval,
    price_change_requires_approval: s.price_change_requires_approval, discount_requires_approval: s.discount_requires_approval,
  };
}

// Kasse
r('GET', '/api/pos/bootstrap', 'pos', () => ({
  categories: all('SELECT * FROM categories WHERE active=1 ORDER BY sort, name'),
  articles: all('SELECT * FROM articles WHERE active=1 ORDER BY sort, name'),
  tables: pos.tablesOverview(),
  users: all('SELECT id, name, personal_nr FROM users WHERE active=1 ORDER BY name'),
  settings: publicSettings(),
}));
r('GET', '/api/pos/tables', 'pos', () => pos.tablesOverview());
r('GET', '/api/pos/tables/:id', 'pos', (_a, p) => pos.tableOrder(p.id));
r('POST', '/api/pos/items', 'pos', (a, _p, _q, b) => pos.addItem(a, b));
r('POST', '/api/pos/items/:id/increase', 'pos', (a, p, _q, b) => pos.increaseQty(a, p.id, b));
r('POST', '/api/pos/items/:id/cancel', 'pos', (a, p, _q, b) => pos.cancelItem(a, p.id, b));
r('POST', '/api/pos/items/:id/storno-check', 'pos', (a, p, _q, b) => {
  const it = one('SELECT * FROM order_items WHERE id=?', int(p.id, 'Position'));
  if (!it) fail(404, 'Position nicht gefunden');
  const why = pos.stornoNeedsApproval(it, int(b.qty ?? 1, 'Menge', { min: 1 }));
  return { needs_approval: why.length > 0 && !auth.can(a, 'storno_free'), why };
});
r('POST', '/api/pos/items/:id/price', 'pos', (a, p, _q, b) => pos.changePrice(a, p.id, b));
r('POST', '/api/pos/move', 'pos', (a, _p, _q, b) => pos.moveItems(a, b));
r('POST', '/api/pos/orders/:id/move-table', 'pos', (a, p, _q, b) => pos.moveTable(a, p.id, b));
r('POST', '/api/pos/orders/:id/takeover', 'pos', (a, p, _q, b) => pos.takeover(a, p.id, b));
r('POST', '/api/pos/orders/:id/pay', 'pos', (a, p, _q, b) => pos.pay(a, p.id, b));
r('POST', '/api/pos/orders/:id/close-empty', 'pos', (a, p) => pos.closeEmpty(a, p.id));
r('POST', '/api/pos/ui-event', 'pos', (a, _p, _q, b) => pos.uiEvent(a, b));
r('GET', '/api/pos/invoices', 'pos', (a, _p, q) => {
  const h = auth.getSettings().business_day_start_hour;
  const day = q.date || todayBerlin(h);
  const all_ = auth.can(a, 'approve') || auth.can(a, 'dashboard');
  return rep.invoiceSearch({ from: day, to: day, ...(all_ ? {} : { user_id: a.user.id }), table_no: q.table_no });
});
r('GET', '/api/pos/invoices/:id', 'pos', (a, p) => {
  const d = rep.invoiceDetail(p.id);
  if (!(auth.can(a, 'approve') || auth.can(a, 'dashboard')) && d.waiter_id !== a.user.id && d.closed_by !== a.user.id) fail(403, 'Nur eigene Rechnungen sichtbar');
  return d;
});
r('POST', '/api/pos/invoices/:id/reopen', 'pos', (a, p, _q, b) => pos.reopenInvoice(a, p.id, b));
r('GET', '/api/pos/shift', 'pos', (a) => pos.currentShift(a));
r('POST', '/api/pos/shift/close', 'pos', (a, _p, _q, b) => pos.closeShift(a, b));

// Dashboard (lesend)
r('GET', '/api/admin/live', 'dashboard', () => rep.live());
r('GET', '/api/admin/meta', 'dashboard', () => ({
  users: all('SELECT id, personal_nr, name, role, active FROM users ORDER BY personal_nr'),
  tables: all('SELECT * FROM dining_tables ORDER BY number'),
  categories: all('SELECT * FROM categories ORDER BY sort, name'),
  articles: all('SELECT * FROM articles ORDER BY sort, name'),
  type_labels: TYPE_LABEL, settings: auth.getSettings(), permissions: auth.PERMISSIONS, roles: adm.listRoles(),
}));
r('GET', '/api/admin/audit', 'dashboard', (_a, _p, q) => rep.auditQuery(q));
r('GET', '/api/admin/audit/:seq', 'dashboard', (_a, p) => rep.auditEntry(p.seq));
r('GET', '/api/admin/lifecycle/:id', 'dashboard', (_a, p) => rep.lifecycle(p.id));
r('GET', '/api/admin/orders/:id', 'dashboard', (_a, p) => rep.orderHistory(p.id));
r('GET', '/api/admin/invoices', 'dashboard', (_a, _p, q) => rep.invoiceSearch(q));
r('GET', '/api/admin/invoices/:id', 'dashboard', (_a, p) => rep.invoiceDetail(p.id));
r('GET', '/api/admin/cancellations', 'dashboard', (_a, _p, q) => rep.cancellationList(q));
r('GET', '/api/admin/moves', 'dashboard', (_a, _p, q) => rep.moveList(q));
r('GET', '/api/admin/price-changes', 'dashboard', (_a, _p, q) => rep.priceChangeList(q));
r('GET', '/api/admin/alerts', 'dashboard', (_a, _p, q) => adm.listAlerts(q));
r('POST', '/api/admin/alerts/:id/ack', 'dashboard', (a, p, _q, b) => adm.ackAlert(a, p.id, b));
r('GET', '/api/admin/employees', 'dashboard', (_a, _p, q) => rep.employeeStats(q));
r('GET', '/api/admin/revenue', 'dashboard', (_a, _p, q) => rep.revenue(q));
r('GET', '/api/admin/stock', 'dashboard', (_a, _p, q) => rep.sollIst(q));
r('POST', '/api/admin/stock', 'stock', (a, _p, _q, b) => adm.addStock(a, b));
r('GET', '/api/admin/closings', 'dashboard', () => adm.listClosings());
r('POST', '/api/admin/closings', 'day_close', (a) => adm.dayClose(a));
r('GET', '/api/admin/shifts', 'dashboard', (_a, _p, q) => adm.listShifts(q));
r('POST', '/api/admin/shifts/close', 'day_close', (a, _p, _q, b) => pos.closeShift(a, b));
r('GET', '/api/admin/integrity', 'dashboard', (a) => {
  const res = verifyIntegrity();
  res.anchors = all('SELECT * FROM anchors ORDER BY id DESC LIMIT 20');
  res.purges = adm.listPurges();
  tx(() => logEvent(a, { type: 'INTEGRITY_CHECK', details: { ok: res.ok, probleme: res.problems.length, ereignisse: res.events } }));
  return res;
});
r('POST', '/api/admin/anchor', 'dashboard', (a) => createAnchor(a, 'manuell'));
r('POST', '/api/admin/closings/:id/delete', 'manage', (a, p, _q, b) => adm.deleteOldestClosing(a, p.id, b));
r('POST', '/api/admin/demo-data', 'manage', (a) => loadDemoData(a));

// Verwaltung
r('POST', '/api/admin/categories', 'manage', (a, _p, _q, b) => adm.saveCategory(a, null, b));
r('PUT', '/api/admin/categories/:id', 'manage', (a, p, _q, b) => adm.saveCategory(a, p.id, b));
r('POST', '/api/admin/articles', 'manage', (a, _p, _q, b) => adm.saveArticle(a, null, b));
r('PUT', '/api/admin/articles/:id', 'manage', (a, p, _q, b) => adm.saveArticle(a, p.id, b));
r('POST', '/api/admin/tables', 'manage', (a, _p, _q, b) => adm.saveTable(a, null, b));
r('PUT', '/api/admin/tables/:id', 'manage', (a, p, _q, b) => adm.saveTable(a, p.id, b));
r('GET', '/api/admin/users', 'manage', () => adm.listUsers());
r('POST', '/api/admin/users', 'manage', (a, _p, _q, b) => adm.saveUser(a, null, b));
r('PUT', '/api/admin/users/:id', 'manage', (a, p, _q, b) => adm.saveUser(a, p.id, b));
r('PUT', '/api/admin/roles/:code', 'manage', (a, p, _q, b) => adm.saveRole(a, p.code, b));
r('PUT', '/api/admin/settings', 'manage', (a, _p, _q, b) => adm.saveSettings(a, b));

// Export (CSV / PDF)
r('GET', '/api/admin/export/:what', 'dashboard', (a, p, q) => exportData(a, p.what, q));
r('GET', '/api/admin/invoices/:id/pdf', 'dashboard', (a, p) => invoicePdf(a, p.id));
r('GET', '/api/pos/invoices/:id/pdf', 'pos', (a, p) => {
  const d = rep.invoiceDetail(p.id);
  if (!(auth.can(a, 'approve') || auth.can(a, 'dashboard')) && d.waiter_id !== a.user.id && d.closed_by !== a.user.id) fail(403, 'Nur eigene Rechnungen');
  return invoicePdf(a, p.id);
});

// ---- Export-Logik --------------------------------------------------------------
const label = (t) => TYPE_LABEL[t] || t;
const eur = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
function exportDef(what, q) {
  const s = auth.getSettings();
  switch (what) {
    case 'audit': {
      const { rows } = rep.auditQuery(q, { forExport: true });
      return { title: 'Aktivitätsprotokoll', rows, cols: [
        { label: 'Nr.', key: 'seq', width: 6, right: true }, { label: 'Zeit', value: (r) => fmtBerlin(r.ts), width: 19 },
        { label: 'Aktion', value: (r) => label(r.type), width: 22 }, { label: 'Mitarbeiter', key: 'user_name', width: 16 },
        { label: 'Tisch', value: (r) => (r.target_table_no ? `${r.table_no}->${r.target_table_no}` : r.table_no), width: 7 },
        { label: 'Artikel', key: 'article_name', width: 20 }, { label: 'Menge', key: 'qty', width: 5, right: true },
        { label: 'Preis', value: (r) => eur(r.unit_price), width: 8, right: true }, { label: 'Betrag', value: (r) => eur(r.amount), width: 9, right: true },
        { label: 'Grund', key: 'reason', width: 30 }, { label: 'Vorher', key: 'before_json', width: 0 }, { label: 'Nachher', key: 'after_json', width: 0 },
        { label: 'Details', key: 'details_json', width: 0 }, { label: 'Gerät', key: 'device', width: 0 }, { label: 'Hash', key: 'hash', width: 0 },
      ] };
    }
    case 'cancellations': {
      const rows = rep.cancellationList(q);
      return { title: 'Stornierungen', rows, cols: [
        { label: 'Storno-Zeit', value: (r) => fmtBerlin(r.cancelled_at), width: 19 }, { label: 'Tisch', key: 'table_no', width: 5, right: true },
        { label: 'Artikel', key: 'article_name', width: 20 }, { label: 'Menge', key: 'qty', width: 5, right: true },
        { label: 'Einzel', value: (r) => eur(r.unit_price), width: 8, right: true }, { label: 'Gesamt', value: (r) => eur(r.total), width: 8, right: true },
        { label: 'Eingegeben von', key: 'entered_by_name', width: 14 }, { label: 'Eingabe-Zeit', value: (r) => fmtBerlin(r.entered_at), width: 19 },
        { label: 'Storniert von', key: 'cancelled_by_name', width: 14 }, { label: 'Freigabe', key: 'approved_by_name', width: 12 },
        { label: 'Grund', key: 'reason', width: 30 }, { label: 'Artikel-ID', key: 'lifecycle_id', width: 0 },
      ] };
    }
    case 'moves': {
      const rows = rep.moveList(q);
      return { title: 'Artikelverschiebungen', rows, cols: [
        { label: 'Zeit', value: (r) => fmtBerlin(r.moved_at), width: 19 }, { label: 'Von Tisch', key: 'from_table_no', width: 9, right: true },
        { label: 'Nach Tisch', key: 'to_table_no', width: 10, right: true }, { label: 'Artikel', key: 'article_name', width: 22 },
        { label: 'Menge', key: 'qty', width: 5, right: true }, { label: 'Preis', value: (r) => eur(r.unit_price), width: 8, right: true },
        { label: 'Verschoben von', key: 'moved_by_name', width: 15 }, { label: 'Ursprungstisch', key: 'original_table_no', width: 14, right: true },
        { label: 'Grund', key: 'reason', width: 25 }, { label: 'Art', key: 'kind', width: 0 }, { label: 'Artikel-ID', key: 'lifecycle_id', width: 0 },
      ] };
    }
    case 'invoices': {
      const rows = rep.invoiceSearch(q);
      return { title: 'Rechnungen', rows, cols: [
        { label: 'Nummer', key: 'invoice_no', width: 12 }, { label: 'Art', key: 'kind', width: 9 },
        { label: 'Abschluss', value: (r) => fmtBerlin(r.closed_at), width: 19 }, { label: 'Tisch', key: 'table_no', width: 5, right: true },
        { label: 'Bedienung', key: 'waiter_name', width: 15 }, { label: 'Abgeschl. von', key: 'closed_by_name', width: 15 },
        { label: 'Zahlungsart', key: 'payment_method', width: 12 }, { label: 'Rabatt', value: (r) => eur(r.discount), width: 8, right: true },
        { label: 'Summe', value: (r) => eur(r.total), width: 9, right: true }, { label: 'Stornos', key: 'storno_count', width: 7, right: true },
        { label: 'Status', value: (r) => (r.reversed_by ? `storniert durch ${r.reversed_by}` : r.reverses_no ? `hebt ${r.reverses_no} auf` : 'gültig'), width: 24 },
      ] };
    }
    case 'employees': {
      const d = rep.employeeStats(q);
      return { title: `Mitarbeiter-Auswertung (${({ day: 'Tag', week: 'Woche', month: 'Monat' })[d.period]} ab ${d.date})`, rows: d.rows, cols: [
        { label: 'Nr', key: 'personal_nr', width: 4, right: true }, { label: 'Name', key: 'name', width: 18 },
        { label: 'Tische', key: 'tische', width: 6, right: true }, { label: 'Artikel', key: 'artikel_eingegeben', width: 7, right: true },
        { label: 'Umsatz', value: (r) => eur(r.umsatz), width: 10, right: true }, { label: 'Rechn.', key: 'rechnungen', width: 6, right: true },
        { label: 'Stornos', key: 'stornos', width: 7, right: true }, { label: 'Stornowert', value: (r) => eur(r.storno_wert), width: 10, right: true },
        { label: 'Quote %', key: 'storno_quote', width: 7, right: true }, { label: 'Sofortst.', key: 'sofortstornos', width: 9, right: true },
        { label: 'Verschieb.', key: 'verschiebungen', width: 10, right: true }, { label: 'Wiedereröff.', key: 'wiedereroeffnungen', width: 12, right: true },
        { label: 'Preisänd.', key: 'preisaenderungen', width: 9, right: true }, { label: 'Warnungen', key: 'warnungen', width: 9, right: true },
      ] };
    }
    case 'stock': {
      const d = rep.sollIst(q);
      return { title: 'Soll-Ist-Vergleich Warenentnahme / Verkauf', rows: d.rows, cols: [
        { label: 'Artikel', key: 'name', width: 26 }, { label: 'Kategorie', key: 'category', width: 14 },
        { label: 'Entnommen', key: 'entnommen', width: 10, right: true }, { label: 'Verkauft', key: 'verkauft', width: 9, right: true },
        { label: 'Noch offen', key: 'offen', width: 10, right: true }, { label: 'Storniert', key: 'storniert', width: 9, right: true },
        { label: 'Differenz', key: 'differenz', width: 9, right: true },
      ] };
    }
    case 'revenue': {
      const d = rep.revenue(q);
      return { title: `Umsatzübersicht ${fmtBerlin(d.from, false)} – ${fmtBerlin(d.to, false)}`, rows: d.byArticle, cols: [
        { label: 'Artikel', key: 'article_name', width: 30 }, { label: 'Menge', key: 'qty', width: 7, right: true },
        { label: 'Umsatz', value: (r) => eur(r.total), width: 12, right: true },
      ], extra: [
        `Gesamtumsatz: ${euro(d.total)}`, ...d.byMethod.map((m) => `  ${m.method}: ${euro(m.total)} (${m.n} Belege)`),
        ...d.vat.map((v) => `  MwSt ${v.satz} %: Netto ${euro(v.netto)}, Steuer ${euro(v.steuer)}, Brutto ${euro(v.brutto)}`),
        `Stornierte Positionen: ${d.stornos.n} (${euro(d.stornos.v)})`, '',
      ] };
    }
    default:
      void s;
      fail(404, 'Unbekannter Export');
  }
}

function exportData(actor, what, q) {
  const def = exportDef(what, q);
  const format = q.format === 'pdf' ? 'pdf' : 'csv';
  const filters = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'format'));
  tx(() => logEvent(actor, { type: 'EXPORT_CREATED', details: { export: what, format, filter: filters, zeilen: def.rows.length } }));
  const name = `${what}-${nowIso().slice(0, 10)}.${format}`;
  if (format === 'csv') {
    const body = toCsv(def.cols, def.rows);
    return file(body, 'text/csv; charset=utf-8', name);
  } else {
    const filterTxt = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
    const lines = [`Erstellt: ${fmtBerlin(nowIso())} von ${actor.user.name}   Filter: ${filterTxt || 'keine'}   Einträge: ${def.rows.length}`, '',
      ...(def.extra || []), ...pdfTable(def.cols.filter((c) => c.width > 0), def.rows)];
    const last = lastAuditHash();
    const pdf = toPdf(`${auth.getSettings().business_name} – ${def.title}`, lines, { footer: `Protokollstand Ereignis ${last?.seq} / ${last?.hash.slice(0, 16)}…` });
    return file(pdf, 'application/pdf', name);
  }
}

export function invoiceLines(d) {
  const L = [];
  L.push(d.settings.address);
  if (d.settings.tax_id) L.push(`Steuernummer/USt-IdNr.: ${d.settings.tax_id}`);
  L.push('');
  L.push({ text: `${d.kind === 'storno' ? 'STORNORECHNUNG' : 'RECHNUNG'} Nr. ${d.invoice_no}`, bold: true, size: 11 });
  if (d.reverses) L.push(`hebt Rechnung ${d.reverses.invoice_no} auf`);
  if (d.reversed_by) L.push(`!! Diese Rechnung wurde durch Stornorechnung ${d.reversed_by.invoice_no} am ${fmtBerlin(d.reversed_by.closed_at)} aufgehoben (Tisch wiedereröffnet).`);
  L.push(`Tisch: ${d.table_no}    Bedienung: ${d.waiter_name}    Abgeschlossen von: ${d.closed_by_name}`);
  L.push(`Eröffnet: ${fmtBerlin(d.opened_at)}    Abschluss: ${fmtBerlin(d.closed_at)}`);
  L.push('');
  L.push(...pdfTable([
    { label: 'Menge', key: 'qty', width: 6, right: true }, { label: 'Artikel', key: 'article_name', width: 40 },
    { label: 'Einzel', value: (r) => eur(r.unit_price), width: 10, right: true }, { label: 'MwSt', value: (r) => `${r.vat}%`, width: 5, right: true },
    { label: 'Gesamt', value: (r) => eur(r.total), width: 11, right: true }, { label: 'Pos-ID', key: 'item_id', width: 8, right: true },
  ], d.items));
  L.push('');
  L.push(`Zwischensumme: ${euro(d.subtotal)}`);
  if (d.discount) L.push(`Rabatt: -${euro(d.discount)} (${d.discount_reason || ''}${d.approved_by_name ? ', Freigabe: ' + d.approved_by_name : ''})`);
  L.push({ text: `GESAMTSUMME: ${euro(d.total)}`, bold: true, size: 11 });
  L.push(`Zahlungsart: ${d.payment_method}${d.given != null ? `   gegeben: ${euro(d.given)}   zurück: ${euro(d.change_amount)}` : ''}`);
  for (const v of d.vat) L.push(`  enthaltene MwSt ${v.satz} %: ${euro(v.steuer)} (netto ${euro(v.netto)})`);
  if (d.cancelled.length) {
    L.push('');
    L.push({ text: 'Stornierte Positionen dieses Tisches (Historie, nicht berechnet):', bold: true });
    L.push(...pdfTable([
      { label: 'Menge', key: 'qty', width: 6, right: true }, { label: 'Artikel', key: 'article_name', width: 24 },
      { label: 'Wert', value: (r) => eur(r.total), width: 9, right: true }, { label: 'Eingabe', value: (r) => `${fmtBerlin(r.entered_at)} ${r.eingegeben_von}`, width: 32 },
      { label: 'Storno', value: (r) => `${fmtBerlin(r.cancelled_at)} ${r.storniert_von}`, width: 32 }, { label: 'Grund', key: 'reason', width: 20 },
    ], d.cancelled));
  }
  L.push('');
  L.push(`Prüfsumme (SHA-256): ${d.hash}`);
  L.push('Digitaler Beleg – unveränderbar archiviert.');
  return L;
}

function invoicePdf(actor, id) {
  const d = rep.invoiceDetail(id);
  const pdf = toPdf(d.settings.name, invoiceLines(d), { fontSize: 8.5, footer: `Rechnung ${d.invoice_no}` });
  void actor;
  return file(pdf, 'application/pdf', `rechnung-${d.invoice_no}.pdf`);
}


// ---- Start und Aufruf ---------------------------------------------------------------
export function init(driver, { demo = false } = {}) {
  openDb(driver);
  ensureBaseData({ demo });
  run('DELETE FROM idempotency WHERE created_at<?', new Date(Date.now() - 2 * 86400000).toISOString());
}

const idemCache = new Map();
/**
 * Führt einen Aufruf aus. Ergebnis: { status, body } oder { status, file:{data,contentType,filename} }.
 */
export async function dispatch({ method, path, query = {}, body = {}, token = null, idem = null }) {
  try {
    const route = routes.find((x) => x.method === method && x.re.test(path));
    if (!route) return { status: 404, body: { error: 'Unbekannte Funktion' } };
    const m = route.re.exec(path);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let actor = null;
    if (route.perm) {
      actor = auth.authenticate(token);
      if (!actor) return { status: 401, body: { error: 'Bitte erneut anmelden' } };
      if (route.perm !== 'any') auth.requirePerm(actor, route.perm);
      if (path.startsWith('/api/admin/') && actor.session.kind !== 'admin') fail(403, 'Bitte im Admin-Bereich anmelden');
    }
    if (idem && actor) {
      const prev = one('SELECT status, response FROM idempotency WHERE key=? AND user_id=?', idem, actor.user.id);
      if (prev) return { status: prev.status, body: JSON.parse(prev.response) };
    }
    const result = await route.handler(actor, params, query, body || {});
    if (result && result.__file) return { status: 200, file: result };
    if (idem && actor) run('INSERT OR IGNORE INTO idempotency(key,user_id,created_at,status,response) VALUES(?,?,?,?,?)', idem, actor.user.id, nowIso(), 200, JSON.stringify(result ?? null));
    return { status: 200, body: result ?? null };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
    const msg = String(e?.message || e);
    if (msg.includes('MANIPULATIONSSCHUTZ')) return { status: 409, body: { error: msg.replace(/^.*MANIPULATIONSSCHUTZ: /, 'Manipulationsschutz: ') } };
    if (msg.includes('one_open_order_per_table') || msg.includes('UNIQUE constraint failed: orders')) return { status: 409, body: { error: 'Tisch ist bereits belegt' } };
    if (msg.includes('CHECK constraint failed')) return { status: 409, body: { error: 'Ungültige Mengenänderung abgelehnt' } };
    console.error(e);
    return { status: 500, body: { error: 'Interner Fehler – die Aktion wurde NICHT gespeichert.' } };
  }
}
void idemCache; void periodRange; void rangeFromQuery; void openDb;
