// Verwaltung: Stammdaten, Benutzer, Rollen, Einstellungen, Lager, Warnungen, Tagesabschluss
// Jeder administrative Eingriff wird mit Vorher/Nachher protokolliert (admin_actions + audit_log).
import { one, all, run, tx } from './db.js';
import { logAdmin, logEvent, lastAuditHash } from './audit.js';
import { PERMISSIONS, DEFAULT_SETTINGS, getSettings, resetSettingsCache, hashPin, validatePin, requirePerm, publicUser } from './auth.js';
import { fail, int, str, nowIso } from './util.js';
import { shiftReport } from './pos.js';

const plain = (o) => (o ? { ...o } : null);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

// ---- Kategorien -----------------------------------------------------------------
export function saveCategory(actor, id, b) {
  requirePerm(actor, 'manage');
  const data = {
    name: str(b.name, 'einen Namen', { max: 40 }),
    kind: ['speise', 'getraenk', 'sonstiges'].includes(b.kind) ? b.kind : fail(400, 'Ungültige Art'),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#64748b',
    sort: int(b.sort ?? 0, 'Sortierung'),
    active: b.active === undefined ? 1 : bool(b.active),
  };
  return tx(() => {
    if (id) {
      const before = plain(one('SELECT * FROM categories WHERE id=?', int(id, 'Kategorie')));
      if (!before) fail(404, 'Kategorie nicht gefunden');
      run('UPDATE categories SET name=?, kind=?, color=?, sort=?, active=? WHERE id=?', data.name, data.kind, data.color, data.sort, data.active, before.id);
      logAdmin(actor, 'CATEGORY_UPDATED', 'kategorie', before.id, before, plain(one('SELECT * FROM categories WHERE id=?', before.id)));
      return { id: before.id };
    }
    const r = run('INSERT INTO categories(name,kind,color,sort,active) VALUES(?,?,?,?,?)', data.name, data.kind, data.color, data.sort, data.active);
    const nid = Number(r.lastInsertRowid);
    logAdmin(actor, 'CATEGORY_CREATED', 'kategorie', nid, null, plain(one('SELECT * FROM categories WHERE id=?', nid)));
    return { id: nid };
  });
}

// ---- Artikel ----------------------------------------------------------------------
export function saveArticle(actor, id, b) {
  requirePerm(actor, 'manage');
  const data = {
    name: str(b.name, 'einen Artikelnamen', { max: 60 }),
    category_id: int(b.category_id, 'Kategorie'),
    price: int(b.price, 'Preis (in Cent)', { min: 0, max: 10000000 }),
    vat: int(b.vat ?? 19, 'MwSt-Satz', { min: 0, max: 30 }),
    plu: int(b.plu, 'Artikelnummer', { min: 1, max: 99999, optional: true }),
    track_stock: bool(b.track_stock),
    active: b.active === undefined ? 1 : bool(b.active),
    sort: int(b.sort ?? 0, 'Sortierung'),
  };
  if (!one('SELECT id FROM categories WHERE id=?', data.category_id)) fail(400, 'Kategorie existiert nicht');
  if (data.plu && one('SELECT id FROM articles WHERE plu=? AND id<>?', data.plu, id || 0)) fail(409, 'Artikelnummer bereits vergeben');
  // Varianten (z. B. Bacardi: Shot, Longdrink, Flasche) – jede mit eigenem Preis.
  // b.variants fehlt → Varianten bleiben unverändert; leere Liste → Artikel ohne Varianten.
  let variants = null;
  if (Array.isArray(b.variants)) {
    if (b.variants.length > 10) fail(400, 'Höchstens 10 Varianten');
    variants = b.variants.map((v, i) => ({
      id: v.id ? int(v.id, 'Variante') : null,
      name: str(v.name, `einen Namen für Variante ${i + 1}`, { max: 30 }),
      price: int(v.price, `Preis für Variante ${i + 1}`, { min: 0, max: 10000000 }),
      sort: i,
    }));
    const names = variants.map((v) => v.name.toLowerCase());
    if (new Set(names).size !== names.length) fail(400, 'Variantennamen müssen unterschiedlich sein');
    if (variants.length) data.price = Math.min(...variants.map((v) => v.price)); // „ab“-Preis zur Anzeige
  }
  const variantList = (aid) => all('SELECT id, name, price, active FROM article_variants WHERE article_id=? ORDER BY sort, id', aid).map(plain);
  const saveVariants = (aid) => {
    if (!variants) return;
    const existing = variantList(aid);
    for (const v of variants) {
      if (v.id) {
        if (!existing.some((e) => e.id === v.id)) fail(400, 'Variante gehört nicht zu diesem Artikel');
        run('UPDATE article_variants SET name=?, price=?, sort=?, active=1 WHERE id=?', v.name, v.price, v.sort, v.id);
      } else {
        run('INSERT INTO article_variants(article_id,name,price,sort,active) VALUES(?,?,?,?,1)', aid, v.name, v.price, v.sort);
      }
    }
    // Nicht mehr aufgeführte Varianten werden deaktiviert (nie gelöscht – sie stehen in alten Buchungen)
    for (const e of existing) if (!variants.some((v) => v.id === e.id)) run('UPDATE article_variants SET active=0 WHERE id=?', e.id);
  };
  return tx(() => {
    if (id) {
      const before = plain(one('SELECT * FROM articles WHERE id=?', int(id, 'Artikel')));
      if (!before) fail(404, 'Artikel nicht gefunden');
      before.varianten = variantList(before.id);
      run('UPDATE articles SET name=?, category_id=?, price=?, vat=?, plu=?, track_stock=?, active=?, sort=? WHERE id=?',
        data.name, data.category_id, data.price, data.vat, data.plu, data.track_stock, data.active, data.sort, before.id);
      saveVariants(before.id);
      const after = plain(one('SELECT * FROM articles WHERE id=?', before.id));
      after.varianten = variantList(before.id);
      const priceChanged = before.price !== after.price || JSON.stringify(before.varianten.map((v) => [v.name, v.price, v.active]))
        !== JSON.stringify(after.varianten.map((v) => [v.name, v.price, v.active]));
      logAdmin(actor, priceChanged ? 'ARTICLE_PRICE_CHANGED' : 'ARTICLE_UPDATED', 'artikel', before.id, before, after,
        { article_name: after.name, unit_price: after.price, details: priceChanged ? { alter_preis: before.price, neuer_preis: after.price } : {} });
      return { id: before.id };
    }
    const r = run('INSERT INTO articles(name,category_id,price,vat,plu,track_stock,active,sort) VALUES(?,?,?,?,?,?,?,?)',
      data.name, data.category_id, data.price, data.vat, data.plu, data.track_stock, data.active, data.sort);
    const nid = Number(r.lastInsertRowid);
    saveVariants(nid);
    const created = plain(one('SELECT * FROM articles WHERE id=?', nid));
    created.varianten = variantList(nid);
    logAdmin(actor, 'ARTICLE_CREATED', 'artikel', nid, null, created, { article_name: data.name, unit_price: data.price });
    return { id: nid };
  });
}

// ---- Tische -----------------------------------------------------------------------
export function saveTable(actor, id, b) {
  requirePerm(actor, 'manage');
  const data = {
    number: int(b.number, 'Tischnummer', { min: 1, max: 9999 }),
    name: b.name ? String(b.name).slice(0, 30) : null,
    area: str(b.area || 'Gastraum', 'einen Bereich', { max: 30 }),
    seats: int(b.seats ?? 4, 'Plätze', { min: 0, max: 99 }),
    active: b.active === undefined ? 1 : bool(b.active),
  };
  if (one('SELECT id FROM dining_tables WHERE number=? AND id<>?', data.number, id || 0)) fail(409, 'Tischnummer bereits vergeben');
  return tx(() => {
    if (id) {
      const before = plain(one('SELECT * FROM dining_tables WHERE id=?', int(id, 'Tisch')));
      if (!before) fail(404, 'Tisch nicht gefunden');
      if (!data.active && one("SELECT id FROM orders WHERE table_id=? AND status='open'", before.id)) fail(409, 'Tisch ist belegt und kann nicht deaktiviert werden');
      if (data.number !== before.number && one('SELECT id FROM orders WHERE table_id=?', before.id)) fail(409, 'Tischnummer kann nach der ersten Buchung nicht mehr geändert werden');
      run('UPDATE dining_tables SET number=?, name=?, area=?, seats=?, active=? WHERE id=?', data.number, data.name, data.area, data.seats, data.active, before.id);
      logAdmin(actor, 'TABLE_UPDATED', 'tisch', before.id, before, plain(one('SELECT * FROM dining_tables WHERE id=?', before.id)), { table_no: data.number });
      return { id: before.id };
    }
    const r = run('INSERT INTO dining_tables(number,name,area,seats,active) VALUES(?,?,?,?,?)', data.number, data.name, data.area, data.seats, data.active);
    const nid = Number(r.lastInsertRowid);
    logAdmin(actor, 'TABLE_CREATED', 'tisch', nid, null, plain(one('SELECT * FROM dining_tables WHERE id=?', nid)), { table_no: data.number });
    return { id: nid };
  });
}

// ---- Benutzer ----------------------------------------------------------------------
export const listUsers = () => all('SELECT id, personal_nr, name, role, active, created_at, locked_until FROM users ORDER BY personal_nr');

export function saveUser(actor, id, b) {
  requirePerm(actor, 'manage');
  const role = String(b.role || '');
  if (!one('SELECT code FROM roles WHERE code=?', role)) fail(400, 'Ungültige Rolle');
  const data = {
    personal_nr: int(b.personal_nr, 'Personalnummer', { min: 1, max: 99999 }),
    name: str(b.name, 'einen Namen', { max: 60 }),
    role,
    active: b.active === undefined ? 1 : bool(b.active),
  };
  if (one('SELECT id FROM users WHERE personal_nr=? AND id<>?', data.personal_nr, id || 0)) fail(409, 'Personalnummer bereits vergeben');
  const pin = b.pin ? validatePin(b.pin, role) : null;
  return tx(() => {
    if (id) {
      const before = one('SELECT * FROM users WHERE id=?', int(id, 'Benutzer'));
      if (!before) fail(404, 'Benutzer nicht gefunden');
      if (before.id === actor.user.id && (data.role !== before.role || !data.active)) fail(409, 'Eigene Rolle/Aktivierung kann nicht geändert werden');
      if (before.role === 'admin' && (data.role !== 'admin' || !data.active)
        && one("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").c <= 1) fail(409, 'Mindestens ein aktiver Administrator muss bestehen bleiben');
      if (pin) run('UPDATE users SET pin_hash=?, failed_logins=0, locked_until=NULL WHERE id=?', hashPin(pin), before.id);
      run('UPDATE users SET personal_nr=?, name=?, role=?, active=? WHERE id=?', data.personal_nr, data.name, data.role, data.active, before.id);
      const after = one('SELECT * FROM users WHERE id=?', before.id);
      const clean = (u) => ({ ...publicUser(u), active: u.active });
      logAdmin(actor, 'USER_UPDATED', 'benutzer', before.id, clean(before), clean(after), { details: { pin_geaendert: !!pin } });
      if (!data.active) run("UPDATE sessions SET ended_at=?, end_reason='Konto deaktiviert' WHERE user_id=? AND ended_at IS NULL", nowIso(), before.id);
      return { id: before.id };
    }
    if (!pin) fail(400, 'Bitte eine PIN vergeben');
    const r = run('INSERT INTO users(personal_nr,name,role,pin_hash,active,created_at) VALUES(?,?,?,?,?,?)',
      data.personal_nr, data.name, data.role, hashPin(pin), data.active, nowIso());
    const nid = Number(r.lastInsertRowid);
    logAdmin(actor, 'USER_CREATED', 'benutzer', nid, null, { ...data, id: nid });
    return { id: nid };
  });
}

export function changeOwnPin(actor, b, checkPin) {
  const u = one('SELECT * FROM users WHERE id=?', actor.user.id);
  if (!checkPin(b.old_pin ?? '', u.pin_hash)) fail(401, 'Alte PIN falsch');
  const pin = validatePin(b.new_pin, u.role);
  return tx(() => {
    run('UPDATE users SET pin_hash=? WHERE id=?', hashPin(pin), u.id);
    logAdmin(actor, 'PIN_CHANGED', 'benutzer', u.id, null, null);
    return { ok: true };
  });
}

// ---- Rollen -------------------------------------------------------------------------
export const listRoles = () => all('SELECT * FROM roles ORDER BY level').map((r) => ({ ...r, permissions: JSON.parse(r.permissions) }));
export function saveRole(actor, code, b) {
  requirePerm(actor, 'manage');
  const r = one('SELECT * FROM roles WHERE code=?', String(code));
  if (!r) fail(404, 'Rolle nicht gefunden');
  const perms = (Array.isArray(b.permissions) ? b.permissions : []).filter((p) => PERMISSIONS[p]);
  if (r.code === 'admin' && (!perms.includes('manage') || !perms.includes('dashboard'))) fail(409, 'Administratoren müssen Verwaltung und Dashboard behalten');
  return tx(() => {
    run('UPDATE roles SET permissions=? WHERE code=?', JSON.stringify(perms), r.code);
    logAdmin(actor, 'ROLE_UPDATED', 'rolle', r.code, JSON.parse(r.permissions), perms);
    return { ok: true };
  });
}

// ---- Einstellungen ----------------------------------------------------------------
export function saveSettings(actor, b) {
  requirePerm(actor, 'manage');
  const cur = getSettings();
  const changes = {};
  for (const [k, v] of Object.entries(b || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    let val = v;
    if (typeof def === 'number') {
      val = Number(v);
      if (!Number.isFinite(val) || val < 0) fail(400, `Ungültiger Wert für ${k}`);
    } else if (Array.isArray(def)) {
      if (!Array.isArray(v) || !v.length) fail(400, `Ungültige Liste für ${k}`);
      val = v.map((x) => String(x).trim()).filter(Boolean);
    } else val = String(v ?? '').slice(0, 200);
    if (JSON.stringify(cur[k]) !== JSON.stringify(val)) changes[k] = { vorher: cur[k], nachher: val };
  }
  if (!Object.keys(changes).length) return { ok: true, changed: 0 };
  return tx(() => {
    for (const [k, c] of Object.entries(changes)) {
      run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(c.nachher));
    }
    resetSettingsCache();
    logAdmin(actor, 'SETTINGS_UPDATED', 'einstellungen', null,
      Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.vorher])),
      Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.nachher])));
    return { ok: true, changed: Object.keys(changes).length };
  });
}

// ---- Lager / Warenentnahme --------------------------------------------------------
export function addStock(actor, b) {
  requirePerm(actor, 'stock');
  const a = one('SELECT * FROM articles WHERE id=?', int(b.article_id, 'Artikel'));
  if (!a) fail(404, 'Artikel nicht gefunden');
  const qty = int(b.qty, 'Menge', { min: 1, max: 100000 });
  const kind = b.kind === 'rueckgabe' ? 'rueckgabe' : 'entnahme';
  // Artikel mit Varianten: Entnahme wird je Variante gebucht (jede Variante wird einzeln gezählt)
  const vs = all('SELECT * FROM article_variants WHERE article_id=? ORDER BY sort, id', a.id);
  let v = null;
  if (vs.length) {
    v = vs.find((x) => x.id === Number(b.variant_id));
    if (!v) fail(400, 'Bitte die Variante wählen');
  }
  const name = v ? `${a.name} – ${v.name}` : a.name;
  return tx(() => {
    const ev = logEvent(actor, {
      type: 'STOCK_MOVEMENT', article_name: name, qty: kind === 'entnahme' ? qty : -qty, reason: b.note || null,
      after: { artikel: name, menge: qty, art: kind }, details: { article_id: a.id, variant_id: v?.id ?? null },
    });
    run('INSERT INTO stock_movements(article_id,variant_id,qty,kind,user_id,ts,note,audit_seq) VALUES(?,?,?,?,?,?,?,?)',
      a.id, v?.id ?? null, qty, kind, actor.user.id, ev.ts, b.note || null, ev.seq);
    if (!a.track_stock) run('UPDATE articles SET track_stock=1 WHERE id=?', a.id);
    return { ok: true };
  });
}

// ---- Warnungen ------------------------------------------------------------------------
export function listAlerts(q) {
  const w = [];
  const p = [];
  if (q.status) { w.push('a.status=?'); p.push(q.status); }
  if (q.user_id) { w.push('a.user_id=?'); p.push(int(q.user_id, 'Mitarbeiter')); }
  if (q.severity) { w.push('a.severity=?'); p.push(q.severity); }
  return all(`SELECT a.*, u.name AS ack_by_name FROM alerts a LEFT JOIN users u ON u.id=a.ack_by ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
              ORDER BY a.id DESC LIMIT 500`, ...p);
}
export function ackAlert(actor, id, b) {
  requirePerm(actor, 'dashboard');
  const a = one('SELECT * FROM alerts WHERE id=?', int(id, 'Warnung'));
  if (!a) fail(404, 'Warnung nicht gefunden');
  if (a.status !== 'offen') fail(409, 'Bereits geprüft');
  const note = b.note ? String(b.note).slice(0, 500) : null;
  return tx(() => {
    run("UPDATE alerts SET status='geprueft', ack_by=?, ack_at=?, ack_note=? WHERE id=?", actor.user.id, nowIso(), note, a.id);
    logAdmin(actor, 'ALERT_ACKNOWLEDGED', 'warnung', a.id, { status: 'offen', titel: a.title }, { status: 'geprüft', notiz: note });
    return { ok: true };
  });
}

// ---- Tagesabschluss --------------------------------------------------------------------
export function dayClose(actor) {
  requirePerm(actor, 'day_close');
  return tx(() => {
    const last = one('SELECT to_ts FROM day_closings ORDER BY id DESC LIMIT 1');
    const from = last?.to_ts || (one('SELECT MIN(ts) t FROM audit_log')?.t || nowIso());
    const to = nowIso();
    const data = {
      ...revenueRange(from, to),
      offene_tische: one("SELECT COUNT(*) n FROM orders WHERE status='open'").n,
      rechnungen: all('SELECT MIN(invoice_no) erste, MAX(invoice_no) letzte, COUNT(*) n FROM invoices WHERE closed_at>=? AND closed_at<?', from, to)[0],
    };
    const ev = logEvent(actor, { type: 'DAY_CLOSED', amount: data.total, after: data, details: { von: from, bis: to } });
    run('INSERT INTO day_closings(from_ts,to_ts,closed_by,data_json,audit_seq,audit_hash) VALUES(?,?,?,?,?,?)', from, to, actor.user.id, JSON.stringify(data), ev.seq, ev.hash);
    return { from, to, data, audit_seq: ev.seq, audit_hash: ev.hash };
  });
}
function revenueRange(a, b) {
  const byMethod = all('SELECT payment_method AS method, COUNT(*) n, SUM(total) total FROM invoices WHERE closed_at>=? AND closed_at<? GROUP BY payment_method', a, b).map(plain);
  const total = byMethod.reduce((s, r) => s + r.total, 0);
  const storno = plain(one("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='storno' AND cancelled_at>=? AND cancelled_at<?", a, b));
  const ec = plain(one("SELECT COUNT(DISTINCT audit_seq) n, COUNT(DISTINCT order_id) tische, COALESCE(SUM(total),0) v FROM cancellations WHERE kind='ec' AND cancelled_at>=? AND cancelled_at<?", a, b));
  const reversals = plain(one("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM invoices WHERE kind='storno' AND closed_at>=? AND closed_at<?", a, b));
  const discounts = one("SELECT COALESCE(SUM(discount),0) v FROM invoices WHERE kind='rechnung' AND closed_at>=? AND closed_at<?", a, b).v;
  return { total, byMethod, stornos: storno, ec_zahlungen: ec, stornorechnungen: reversals, rabatte: discounts };
}
/**
 * Löscht den ÄLTESTEN Tagesabschluss zusammen mit allen Einzelheiten seines Zeitraums
 * (Protokoll, Stornos, Verschiebungen, Preisänderungen, Rechnungen, abgeschlossene Tische …).
 * Regeln: nur Administratoren, nur in zeitlicher Reihenfolge, nur mit Bestätigung.
 * Tische, die über den Abschluss hinaus offen waren, behalten ihren aktuellen Stand.
 * Die Löschung selbst wird dauerhaft protokolliert; die verbleibende Hash-Kette bleibt prüfbar.
 */
export function deleteOldestClosing(actor, id, b) {
  requirePerm(actor, 'manage');
  const c = one('SELECT * FROM day_closings WHERE id=?', int(id, 'Tagesabschluss'));
  if (!c) fail(404, 'Tagesabschluss nicht gefunden');
  const oldest = one('SELECT id FROM day_closings ORDER BY id LIMIT 1');
  if (oldest.id !== c.id) fail(409, 'Es kann nur der älteste Tagesabschluss gelöscht werden – bitte in zeitlicher Reihenfolge löschen.');
  if (String(b?.confirm || '').trim().toUpperCase() !== 'LÖSCHEN') fail(400, 'Zur Bestätigung bitte LÖSCHEN eingeben');
  const cut = c.audit_seq;
  return tx(() => {
    const lastEv = one('SELECT seq, hash FROM audit_log WHERE seq=?', cut);
    if (!lastEv) fail(409, 'Protokoll dieses Zeitraums ist nicht vollständig vorhanden');
    // Abgeschlossene Tische, die nach dem Abschluss nicht mehr bearbeitet wurden
    const orderIds = all(`SELECT o.id FROM orders o WHERE o.status<>'open'
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.order_id=o.id AND a.seq<=?)
        AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.order_id=o.id AND a.seq>?)`, cut, cut).map((r) => r.id);
    const inList = orderIds.length ? orderIds.join(',') : '0';
    const invs = all('SELECT id, year, seq_in_year, hash FROM invoices WHERE audit_seq<=? ORDER BY id', cut);
    const prev = one('SELECT * FROM purges ORDER BY id DESC LIMIT 1');
    const seqs = prev ? JSON.parse(prev.invoice_seq_json) : {};
    for (const v of invs) seqs[v.year] = Math.max(seqs[v.year] || 0, v.seq_in_year);
    const journalCut = Math.max(prev?.journal_id || 0,
      one('SELECT MAX(j.id) m FROM db_journal j WHERE j.tx_id IN (SELECT tx_id FROM audit_log WHERE seq<=?)', cut).m || 0);
    const invIn = invs.length ? invs.map((v) => v.id).join(',') : '0';

    run('UPDATE ctx SET purge=1 WHERE id=1');
    const counts = {};
    const del = (label, sql, ...p) => { counts[label] = run(sql, ...p).changes; };
    del('rechnungspositionen', `DELETE FROM invoice_items WHERE invoice_id IN (${invIn})`);
    del('zahlungen', `DELETE FROM payments WHERE invoice_id IN (${invIn})`);
    del('rechnungen', `DELETE FROM invoices WHERE id IN (${invIn})`);
    del('stornos', 'DELETE FROM cancellations WHERE audit_seq<=?', cut);
    del('verschiebungen', 'DELETE FROM item_moves WHERE audit_seq<=?', cut);
    del('preisaenderungen', 'DELETE FROM price_changes WHERE audit_seq<=?', cut);
    del('positionen', `DELETE FROM order_items WHERE order_id IN (${inList})`);
    del('tischvorgaenge', `DELETE FROM orders WHERE id IN (${inList})`);
    del('lagerbuchungen', 'DELETE FROM stock_movements WHERE audit_seq<=?', cut);
    del('admin_eingriffe', 'DELETE FROM admin_actions WHERE audit_seq<=?', cut);
    del('anker', 'DELETE FROM anchors WHERE seq<=?', cut);
    del('warnungen', 'DELETE FROM alerts WHERE related_seq<=? OR (related_seq IS NULL AND ts<=?)', cut, c.to_ts);
    del('schichten', 'DELETE FROM shifts WHERE ended_at IS NOT NULL AND ended_at<=?', c.to_ts);
    run('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at<=?', c.to_ts);
    del('protokolleintraege', 'DELETE FROM audit_log WHERE seq<=?', cut);
    del('journaleintraege', 'DELETE FROM db_journal WHERE id<=?', journalCut);
    run('DELETE FROM day_closings WHERE id=?', c.id);
    run('UPDATE ctx SET purge=0 WHERE id=1');

    const lastInv = invs[invs.length - 1];
    run(`INSERT INTO purges(ts,user_id,user_name,closing_id,from_ts,to_ts,audit_seq,audit_hash,invoice_id,invoice_hash,invoice_seq_json,journal_id,counts_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, nowIso(), actor.user.id, actor.user.name, c.id, c.from_ts, c.to_ts, lastEv.seq, lastEv.hash,
    lastInv?.id ?? prev?.invoice_id ?? null, lastInv?.hash ?? prev?.invoice_hash ?? null, JSON.stringify(seqs), journalCut, JSON.stringify(counts));
    logAdmin(actor, 'CLOSING_DELETED', 'tagesabschluss', c.id,
      { zeitraum_von: c.from_ts, zeitraum_bis: c.to_ts, umsatz: JSON.parse(c.data_json).total },
      { geloescht: counts });
    return { ok: true, counts };
  });
}
export const listPurges = () => all('SELECT * FROM purges ORDER BY id DESC').map((p) => ({ ...p, counts: JSON.parse(p.counts_json) }));

export const listClosings = () => all(`SELECT d.*, u.name AS closed_by_name FROM day_closings d JOIN users u ON u.id=d.closed_by ORDER BY d.id DESC LIMIT 200`)
  .map((d) => ({ ...d, data: JSON.parse(d.data_json) }));
export const listShifts = (q) => all(`SELECT s.*, u.name AS user_name, e.name AS ended_by_name FROM shifts s JOIN users u ON u.id=s.user_id
    LEFT JOIN users e ON e.id=s.ended_by ORDER BY s.id DESC LIMIT ?`, int(q.limit ?? 200, 'limit', { min: 1, max: 2000 }))
  .map((s) => ({ ...s, report: s.report_json ? JSON.parse(s.report_json) : shiftReport(s.user_id, s.started_at, '9999') }));

export { lastAuditHash };
