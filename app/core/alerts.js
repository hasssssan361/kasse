// Automatisches Warnsystem. Warnungen sind HINWEISE, kein Beweis für Fehlverhalten.
import { one, all, run, tx } from './db.js';
import { getSettings } from './auth.js';
import { periodRange, todayBerlin, euro, nowIso } from './util.js';
import { publish } from './events.js';

function raise(a) {
  const r = run(`INSERT OR IGNORE INTO alerts(ts,rule,severity,user_id,user_name,title,message,details_json,related_seq,dedupe_key)
                 VALUES(?,?,?,?,?,?,?,?,?,?)`, nowIso(), a.rule, a.severity, a.user_id ?? null, a.user_name ?? null, a.title, a.message,
  a.details ? JSON.stringify(a.details) : null, a.seq ?? null, a.key);
  if (r.changes) {
    const row = one('SELECT * FROM alerts WHERE dedupe_key=?', a.key);
    publish('alert', row);
  }
}

export function evaluate(ev) {
  const s = getSettings();
  const day = todayBerlin(s.business_day_start_hour);
  const [from] = periodRange('day', day, s.business_day_start_hour);
  const uid = ev.user_id;
  const who = ev.user_name;
  const base = { user_id: uid, user_name: who, seq: ev.seq };
  const d = ev.details_json ? JSON.parse(ev.details_json) : {};

  if (ev.type === 'ITEM_CANCELLED') {
    const c = one('SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE cancelled_by=? AND cancelled_at>=?', uid, from);
    const lim = s.alert_storno_count_day;
    if (lim > 0 && c.n >= lim) {
      const level = Math.floor(c.n / lim);
      raise({ ...base, rule: 'viele_stornos', severity: level >= 2 ? 'hoch' : 'mittel', key: `viele_stornos:${uid}:${day}:${level}`,
        title: `Viele Stornierungen: ${who}`,
        message: `${who} hat heute bereits ${c.n} Stornierungen im Wert von ${euro(c.v)} vorgenommen.`, details: { anzahl: c.n, wert: c.v, tag: day } });
    }
    const entered = one("SELECT COALESCE(SUM(qty),0) n FROM audit_log WHERE user_id=? AND type IN ('ITEM_ADDED','ITEM_QTY_INCREASED') AND ts>=?", uid, from).n;
    const cq = one('SELECT COALESCE(SUM(qty),0) n FROM cancellations WHERE cancelled_by=? AND cancelled_at>=?', uid, from).n;
    if (entered >= 10 && cq * 100 / entered >= s.alert_storno_ratio_percent) {
      raise({ ...base, rule: 'storno_quote', severity: 'mittel', key: `storno_quote:${uid}:${day}`,
        title: `Hohe Stornoquote: ${who}`,
        message: `${who}: ${cq} von ${entered} eingegebenen Artikeln storniert (${Math.round(cq * 100 / entered)} %).`, details: { eingegeben: entered, storniert: cq } });
    }
    if (d.sekunden_nach_eingabe != null && d.sekunden_nach_eingabe <= s.alert_quick_storno_seconds) {
      const q = one('SELECT COUNT(*) n FROM cancellations WHERE cancelled_by=? AND cancelled_at>=? AND seconds_after_entry<=?', uid, from, s.alert_quick_storno_seconds).n;
      if (q >= s.alert_quick_storno_count) {
        const level = Math.floor(q / s.alert_quick_storno_count);
        raise({ ...base, rule: 'sofortstorno', severity: level >= 2 ? 'hoch' : 'mittel', key: `sofortstorno:${uid}:${day}:${level}`,
          title: `Eingeben und sofort entfernen: ${who}`,
          message: `${who} hat heute ${q}× Artikel innerhalb von ${s.alert_quick_storno_seconds} Sekunden nach der Eingabe storniert (zuletzt: ${ev.article_name}, Tisch ${ev.table_no}).`,
          details: { anzahl: q } });
      }
    }
    if (d.eingegeben_von_id && d.eingegeben_von_id !== uid) {
      raise({ ...base, rule: 'fremdstorno', severity: 'info', key: `fremdstorno:${ev.seq}`,
        title: `Storno fremder Eingabe: ${who}`,
        message: `${who} hat ${ev.qty}× ${ev.article_name} (Tisch ${ev.table_no}) storniert, eingegeben von ${d.eingegeben_von}.`, details: d });
    }
  }

  if (ev.type === 'TABLE_CLOSED') {
    const o = one('SELECT * FROM orders WHERE id=?', ev.order_id);
    const winFrom = new Date(Date.parse(ev.ts) - s.alert_storno_before_close_minutes * 60000).toISOString();
    const late = one('SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE order_id=? AND cancelled_at>=?', ev.order_id, winFrom);
    if (late.n >= 2) {
      raise({ ...base, rule: 'storno_vor_abschluss', severity: 'mittel', key: `storno_vor_abschluss:${ev.order_id}:${ev.seq}`,
        title: `Stornos kurz vor Abschluss: Tisch ${ev.table_no}`,
        message: `${late.n} Stornierungen (${euro(late.v)}) in den letzten ${s.alert_storno_before_close_minutes} Minuten vor dem Abschluss von Tisch ${ev.table_no} durch ${who}.`,
        details: { anzahl: late.n, wert: late.v, order_id: ev.order_id } });
    }
    if (late.n >= 1) {
      const n = one(`SELECT COUNT(*) n FROM audit_log a WHERE a.type='TABLE_CLOSED' AND a.user_id=? AND a.ts>=? AND EXISTS(
          SELECT 1 FROM cancellations c WHERE c.order_id=a.order_id AND c.cancelled_at>=strftime('%Y-%m-%dT%H:%M:%fZ', a.ts, ?) AND c.cancelled_at<=a.ts)`,
      uid, from, `-${s.alert_storno_before_close_minutes} minutes`).n;
      if (n >= 3) {
        raise({ ...base, rule: 'muster_storno_vor_abschluss', severity: 'hoch', key: `muster_svab:${uid}:${day}:${Math.floor(n / 3)}`,
          title: `Wiederholt Stornos vor Abschluss: ${who}`,
          message: `${who} hat heute ${n} Tische abgeschlossen, bei denen kurz vorher storniert wurde.`, details: { tische: n } });
      }
    }
    const st = one('SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM cancellations WHERE order_id=?', ev.order_id);
    const billed = one("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE order_id=? AND kind='rechnung'", ev.order_id).v;
    const share = st.v + billed > 0 ? st.v * 100 / (st.v + billed) : 0;
    if (st.n >= s.alert_close_storno_count || (st.n > 0 && share >= s.alert_close_storno_share_percent)) {
      raise({ ...base, rule: 'abschluss_viele_stornos', severity: share >= 50 ? 'hoch' : 'mittel', key: `abschluss_stornos:${ev.order_id}:${o?.reopen_count || 0}`,
        title: `Tisch ${ev.table_no} mit vielen Stornos abgeschlossen`,
        message: `${st.n} Stornierungen (${euro(st.v)}, ${Math.round(share)} % des Tischwerts) – abgeschlossen von ${who}.`,
        details: { anzahl: st.n, wert: st.v, abgerechnet: billed, anteil: Math.round(share) } });
    }
  }

  if (ev.type === 'ITEM_MOVED') {
    const n = one("SELECT COUNT(*) n FROM item_moves WHERE moved_by=? AND moved_at>=? AND kind='artikel'", uid, from).n;
    if (s.alert_moves_count_day > 0 && n >= s.alert_moves_count_day) {
      const level = Math.floor(n / s.alert_moves_count_day);
      raise({ ...base, rule: 'viele_verschiebungen', severity: level >= 2 ? 'hoch' : 'mittel', key: `verschiebungen:${uid}:${day}:${level}`,
        title: `Viele Artikelverschiebungen: ${who}`, message: `${who} hat heute ${n} Artikel zwischen Tischen verschoben.`, details: { anzahl: n } });
    }
    const hist = all('SELECT from_table_no, to_table_no FROM item_moves WHERE lifecycle_id=? ORDER BY id', ev.lifecycle_id);
    const visited = new Set([hist[0]?.from_table_no]);
    let back = false;
    for (const h of hist) { if (visited.has(h.to_table_no)) back = true; visited.add(h.to_table_no); }
    if (hist.length >= 3 || back) {
      raise({ ...base, rule: 'artikel_hin_und_her', severity: 'mittel', key: `hin_und_her:${ev.lifecycle_id}:${hist.length}`,
        title: `Artikel mehrfach verschoben: ${ev.article_name}`,
        message: `${ev.article_name} (Artikel-ID ${ev.lifecycle_id}) wurde ${hist.length}× verschoben${back ? ', auch zurück auf einen früheren Tisch' : ''}: ${[hist[0].from_table_no, ...hist.map((h) => h.to_table_no)].join(' → ')}.`,
        details: { weg: hist } });
    }
  }

  if (ev.type === 'TABLE_REOPENED') {
    const o = one('SELECT reopen_count FROM orders WHERE id=?', ev.order_id);
    raise({ ...base, rule: 'wiedereroeffnung', severity: (o?.reopen_count || 0) >= 2 ? 'mittel' : 'info', key: `wiedereroeffnung:${ev.seq}`,
      title: `Tisch ${ev.table_no} wiedereröffnet`, message: `${who} hat Tisch ${ev.table_no} wiedereröffnet. Grund: ${ev.reason}.`, details: { reopen_count: o?.reopen_count } });
    const n = one("SELECT COUNT(*) n FROM audit_log WHERE type='TABLE_REOPENED' AND user_id=? AND ts>=?", uid, from).n;
    if (n >= s.alert_reopen_count_day && s.alert_reopen_count_day > 0) {
      raise({ ...base, rule: 'viele_wiedereroeffnungen', severity: 'hoch', key: `wiedereroeffnungen:${uid}:${day}:${Math.floor(n / s.alert_reopen_count_day)}`,
        title: `Ungewöhnlich viele Wiedereröffnungen: ${who}`, message: `${who} hat heute ${n} Tische wiedereröffnet.`, details: { anzahl: n } });
    }
  }

  if (ev.type === 'ITEM_PRICE_CHANGED') {
    const before = JSON.parse(ev.before_json || '{}');
    if (ev.unit_price < (before.preis ?? 0)) {
      raise({ ...base, rule: 'preissenkung', severity: ev.unit_price === 0 ? 'mittel' : 'info', key: `preissenkung:${ev.seq}`,
        title: `Preis gesenkt: ${ev.article_name}`,
        message: `${who} hat ${ev.article_name} (Tisch ${ev.table_no}) von ${euro(before.preis)} auf ${euro(ev.unit_price)} geändert. Grund: ${ev.reason}.` });
    }
    const n = one("SELECT COUNT(*) n FROM price_changes WHERE changed_by=? AND changed_at>=?", uid, from).n;
    if (n >= s.alert_price_changes_day && s.alert_price_changes_day > 0) {
      raise({ ...base, rule: 'viele_preisaenderungen', severity: 'mittel', key: `preisaenderungen:${uid}:${day}:${Math.floor(n / s.alert_price_changes_day)}`,
        title: `Häufige Preisänderungen: ${who}`, message: `${who} hat heute ${n} Preise an der Kasse geändert.`, details: { anzahl: n } });
    }
  }

  if (ev.type === 'INVOICE_CREATED' && d.rabatt > 0 && d.zwischensumme > 0) {
    const p = Math.round(d.rabatt * 100 / d.zwischensumme);
    if (p >= s.alert_discount_percent) {
      raise({ ...base, rule: 'hoher_rabatt', severity: p >= 50 ? 'hoch' : 'mittel', key: `rabatt:${ev.seq}`,
        title: `Hoher Rabatt: ${p} %`, message: `${who} hat auf Rechnung ${d.rechnungsnummer} (Tisch ${ev.table_no}) ${euro(d.rabatt)} Rabatt gewährt. Grund: ${ev.reason}.` });
    }
  }

  if (ev.type === 'LOGIN_FAILED' || ev.type === 'APPROVAL_FAILED') {
    const since = new Date(Date.now() - 10 * 60000).toISOString();
    const n = one("SELECT COUNT(*) n FROM audit_log WHERE type IN ('LOGIN_FAILED','APPROVAL_FAILED') AND ts>=? AND COALESCE(device,'')=COALESCE(?,'')", since, ev.device).n;
    if (n >= 5) {
      raise({ ...base, rule: 'fehlversuche', severity: 'mittel', key: `fehlversuche:${ev.device}:${Math.floor(Date.now() / 600000)}`,
        title: 'Mehrere fehlgeschlagene Anmeldungen/Freigaben',
        message: `${n} Fehlversuche in 10 Minuten am Gerät „${ev.device || 'unbekannt'}“.`, details: { anzahl: n } });
    }
  }
}

export function evaluateAll(events) {
  if (!events.length) return;
  try {
    tx(() => { for (const ev of events) evaluate(ev); });
  } catch (e) {
    console.error('Warnsystem-Fehler:', e.message);
  }
}
