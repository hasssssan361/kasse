// Administrator-Dashboard: eigenständige Anwendung, eigene Anmeldung, nur lesender Zugriff auf das
// Protokoll (es gibt keine Funktion zum Ändern oder Löschen von Protokolleinträgen).
import { $, $$, esc, euro, num, fmtTime, fmtDT, fmtDate, todayStr, h, Api, toast, modal, confirmDialog, debounce, parseEuro, registerOffline } from '../shared/core.js';
import { invoiceHtml } from '../shared/invoice.js';

registerOffline();

const app = $('#app');
const api = new Api('admin.token', () => showLogin('Sitzung beendet – bitte erneut anmelden.'), (ok) => $$('.dot').forEach((d) => d.classList.toggle('off', !ok)), { persist: true });
const isMobile = () => matchMedia('(max-width: 820px)').matches;
// Einfache Strich-Symbole (sehen auf iPhone und Android gleich aus, keine Emojis)
const ICON = {
  live: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  warn: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.5M3 12h.5M3 18h.5"/>',
  storno: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const TITLES = { live: 'Live', warnungen: 'Warnungen', protokoll: 'Protokoll', lebenslauf: 'Artikel-Lebenslauf', rechnungen: 'Rechnungen', stornos: 'Stornierungen',
  verschiebungen: 'Verschiebungen', preise: 'Preisänderungen', mitarbeiter: 'Mitarbeiter', umsatz: 'Umsatz', sollist: 'Soll-Ist', verwaltung: 'Verwaltung', integritaet: 'Manipulationsschutz' };
let ME = null;
let META = null;
let PERMS = [];
const can = (p) => PERMS.includes(p);
let liveFeedPaused = false;

const CATS = [
  ['', 'Alle'], ['storno', 'Stornos'], ['verschiebung', 'Verschiebungen'], ['abschluss', 'Abschlüsse/Rechnungen'], ['preis', 'Preisänderungen'],
  ['wiedereroeffnung', 'Wiedereröffnungen'], ['artikel', 'Artikeleingaben'], ['tisch', 'Tisch'], ['anmeldung', 'An-/Abmeldung'],
  ['eingabe', 'Abgebrochene Dialoge'], ['freigabe', 'Freigaben'], ['schicht', 'Schicht/Tag'], ['lager', 'Lager'], ['admin', 'Admin-Eingriffe'], ['system', 'System'],
];
const label = (t) => META?.type_labels?.[t] || t;
const userName = (id) => META?.users.find((u) => u.id === id)?.name || '';
const evClass = (t) => (t === 'ITEM_CANCELLED' || t === 'INVOICE_REVERSED' ? 'storno' : t === 'ITEM_MOVED' || t === 'TABLE_CHANGED' ? 'move'
  : t === 'TABLE_REOPENED' ? 'reopen' : t.includes('PRICE') ? 'price' : t === 'INVOICE_CREATED' || t === 'TABLE_CLOSED' ? 'bill' : '');
const J = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Ein Ereignis in einem Satz beschreiben
function describe(e) {
  const who = `<b>${esc(e.user_name || 'System')}</b>`;
  const art = e.article_name ? `${e.qty != null ? Math.abs(e.qty) + '× ' : ''}<b>${esc(e.article_name)}</b>` : '';
  const t = e.table_no != null ? `Tisch ${e.table_no}` : '';
  const d = J(e.details_json) || {};
  const a = J(e.after_json) || {};
  const b = J(e.before_json) || {};
  const r = e.reason ? ` – „${esc(e.reason)}“` : '';
  switch (e.type) {
    case 'ITEM_ADDED': return `${who} gibt ${art} ein (${t}, ${euro(e.amount)})${d.eingabe ? ` <span class="muted">[Eingabe ${esc(d.eingabe)}]</span>` : ''}`;
    case 'ITEM_QTY_INCREASED': return `${who} erhöht ${esc(e.article_name)} um ${e.qty} (${t}) auf ${a.menge}`;
    case 'ITEM_CANCELLED': return `<b style="color:var(--danger)">STORNO</b>: ${who} storniert ${art} (${t}, ${euro(e.amount)})${r}<br><span class="small muted">eingegeben von ${esc(d.eingegeben_von)} ${d.sekunden_nach_eingabe != null ? `· ${d.sekunden_nach_eingabe} s nach Eingabe` : ''}${d.freigegeben_von ? ' · Freigabe ' + esc(d.freigegeben_von) : ''}</span>`;
    case 'ITEM_MOVED': return `${who} verschiebt ${art} von Tisch ${e.table_no} → <b>Tisch ${e.target_table_no}</b>${r}`;
    case 'TABLE_CHANGED': return `${who}: Tischwechsel ${e.table_no} → <b>${e.target_table_no}</b>${r}`;
    case 'ITEM_PRICE_CHANGED': return `${who} ändert Preis ${esc(e.article_name)} (${t}) ${euro(b.preis)} → <b>${euro(a.preis)}</b>${r}`;
    case 'TABLE_OPENED': return `${who} eröffnet ${t}${d.via && d.via !== 'Artikeleingabe' ? ` (${esc(d.via)})` : ''}`;
    case 'TABLE_TAKEOVER': return `${who} übernimmt ${t} von ${esc(b.bedienung)}`;
    case 'INVOICE_CREATED': return `${who} erstellt Rechnung <b>${esc(d.rechnungsnummer)}</b> (${t}) über <b>${euro(e.amount)}</b> · ${esc(d.zahlungsart)}${d.rabatt ? ` · Rabatt ${euro(d.rabatt)}` : ''}${d.teilzahlung ? ' · Teilzahlung' : ''}`;
    case 'TABLE_CLOSED': return `${who} schließt ${t} ab${a.rechnung ? ` (${esc(a.rechnung)})` : ''}`;
    case 'INVOICE_REVERSED': return `<b style="color:var(--warn)">${who} hebt Rechnung ${esc(b.rechnung)} auf</b> (Stornorechnung ${esc(d.stornorechnung)})${r}`;
    case 'TABLE_REOPENED': return `<b style="color:var(--warn)">${who} öffnet ${t} wieder</b>${r}`;
    case 'ORDER_CLOSED_EMPTY': return `${who}: ${t} ohne Umsatz geschlossen${r}`;
    case 'DIALOG_ABORTED': return `${who} bricht Dialog „${esc(d.dialog)}“ ab (${t}${e.article_name ? ', ' + esc(e.article_name) : ''})`;
    case 'LOGIN': return `${who} meldet sich an (${esc(d.kind === 'admin' ? 'Dashboard' : 'Kasse')}, ${esc(e.device)})`;
    case 'LOGIN_FAILED': return `Fehlgeschlagene Anmeldung – Personalnr. ${esc(d.personal_nr)}${d.user_name ? ' (' + esc(d.user_name) + ')' : ''} an ${esc(e.device)}`;
    case 'APPROVAL_FAILED': return `${who}: Freigabe fehlgeschlagen (${esc(d.approver || 'Nr. ' + (d.personal_nr ?? ''))})`;
    case 'LOGOUT': return `${who} meldet sich ab${r}`;
    case 'STOCK_MOVEMENT': return `${who} bucht Warenbewegung: ${art}${r}`;
    default: return `${who}: ${esc(label(e.type))} ${t}${art ? ' · ' + art : ''}${r}`;
  }
}

// ---- Anmeldung -------------------------------------------------------------------
function showLogin(msg) {
  api.closeStream();
  app.innerHTML = `<div class="login"><form class="login-card" id="lf"><h1>Admin-Bereich</h1>
    <p class="muted" style="margin:0">Nur für den Inhaber bzw. Administrator.</p>
    <label class="field">Personalnummer<input type="text" inputmode="numeric" id="nr" autocomplete="username" required></label>
    <label class="field">PIN<input type="password" inputmode="numeric" id="pin" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">Anmelden</button><div class="err" id="err">${esc(msg || '')}</div>
    <a class="btn ghost" href="../kasse/">Zurück zur Kasse</a></form></div>`;
  $('#nr').focus();
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const dev = 'Kassengerät (Admin-Bereich)';
      const r = await api.post('/api/login', { personal_nr: Number($('#nr').value), pin: $('#pin').value, device: dev, kind: 'admin' }, { retries: 2 });
      api.setToken(r.token);
      start();
    } catch (er) { $('#err').textContent = er.message; }
  });
}

// ---- Grundgerüst ---------------------------------------------------------------
const NAV = [
  ['Überwachung', [['live', 'Live-Übersicht'], ['warnungen', 'Warnungen'], ['protokoll', 'Aktivitätsprotokoll'], ['lebenslauf', 'Artikel-Lebenslauf']]],
  ['Vorgänge', [['rechnungen', 'Rechnungen'], ['stornos', 'Stornierungen'], ['verschiebungen', 'Verschiebungen'], ['preise', 'Preisänderungen']]],
  ['Auswertung', [['mitarbeiter', 'Mitarbeiter'], ['umsatz', 'Umsatz & Abschlüsse'], ['sollist', 'Soll-Ist (Lager)']]],
  ['System', [['verwaltung', 'Verwaltung'], ['integritaet', 'Manipulationsschutz']]],
];

async function start() {
  try {
    const me = await api.get('/api/me');
    if (me.kind !== 'admin') throw new Error();
    ME = me.user; PERMS = me.permissions;
    META = await api.get('/api/admin/meta');
  } catch { api.setToken(null); return showLogin(); }
  app.innerHTML = `<div class="mtop"><b id="mtitle">Dashboard</b><span class="grow"></span><span class="dot"></span>
      <button class="icon-btn" id="mrefresh" aria-label="Aktualisieren">${svg('refresh')}</button></div>
    <nav class="bnav" id="bnav">
      <a href="#live" data-v="live">${svg('live')}<span>Live</span></a>
      <a href="#warnungen" data-v="warnungen">${svg('warn')}<span>Warnungen</span><b class="bbadge hidden" id="bbadge"></b></a>
      <a href="#protokoll" data-v="protokoll">${svg('list')}<span>Protokoll</span></a>
      <a href="#stornos" data-v="stornos">${svg('storno')}<span>Stornos</span></a>
      <button type="button" id="bmore">${svg('more')}<span>Mehr</span></button></nav>
    <div class="side-back hidden" id="sideback"></div>
    <div class="layout"><aside class="side" id="side"><div class="brand"><span class="dot"></span>${esc(META.settings.business_name)}</div>
    ${NAV.map(([g, items]) => `<div class="grp">${g}</div>${items.map(([k, l]) => `<a href="#${k}" data-v="${k}">${l}${k === 'warnungen' ? '<span class="badge danger hidden" id="abadge"></span>' : ''}</a>`).join('')}`).join('')}
    <div class="foot"><span>${esc(ME.name)} · ${esc(ME.role)}</span><label class="row small"><input type="checkbox" id="sound" checked> Ton bei Storno</label>
    <button class="btn sm" id="pinbtn">PIN ändern</button><button class="btn sm" id="logout">Abmelden und zur Kasse</button></div></aside><main class="content" id="content"></main></div>`;
  $('#pinbtn').addEventListener('click', () => modal({
    title: 'PIN ändern',
    body: `<p class="muted" style="margin-top:0">Administrator-PIN: mindestens 6 Ziffern. Nicht weitergeben.</p>
      <div class="fields"><label class="field">Bisherige PIN<input type="password" inputmode="numeric" id="op" autocomplete="current-password"></label>
      <label class="field">Neue PIN<input type="password" inputmode="numeric" id="np1" autocomplete="new-password"></label>
      <label class="field">Neue PIN wiederholen<input type="password" inputmode="numeric" id="np2" autocomplete="new-password"></label></div>`,
    actions: [{ label: 'Abbrechen' }, {
      label: 'Speichern', kind: 'primary', onClick: async (b) => {
        if ($('#np1', b).value !== $('#np2', b).value) throw new Error('Die neuen PINs stimmen nicht überein');
        await api.post('/api/me/pin', { old_pin: $('#op', b).value, new_pin: $('#np1', b).value });
        toast('PIN geändert', 'ok');
      },
    }],
  }));
  $('#logout').addEventListener('click', async () => { try { await api.post('/api/logout', { reason: 'Abmeldung' }); } catch {} api.setToken(null); location.href = '../kasse/'; });
  const toggleSide = (open) => { $('#side').classList.toggle('open', open); $('#sideback').classList.toggle('hidden', !open); };
  $('#bmore').addEventListener('click', () => toggleSide(!$('#side').classList.contains('open')));
  $('#sideback').addEventListener('click', () => toggleSide(false));
  $('#mrefresh').addEventListener('click', () => { route(); updateAlertBadge(); });
  window.addEventListener('hashchange', route);
  // App kommt aus dem Hintergrund zurück (Handy): Daten auffrischen
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && api.token) { updateAlertBadge(); if (current === 'live') VIEWS.live($('#content'), true); } });
  new MutationObserver(() => requestAnimationFrame(() => labelTables(document))).observe(document.body, { childList: true, subtree: true });
  api.stream({ event: onEvent, alert: onAlert });
  updateAlertBadge();
  route();
}

let current = null;
function route() {
  const v = (location.hash || '#live').slice(1).split('?')[0];
  $$('.side a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  const inBar = ['live', 'warnungen', 'protokoll', 'stornos'].includes(v);
  $$('#bnav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  $('#bmore')?.classList.toggle('on', !inBar);
  if ($('#mtitle')) $('#mtitle').textContent = TITLES[v] || 'Dashboard';
  $('#side')?.classList.remove('open');
  $('#sideback')?.classList.add('hidden');
  $$('.drawer-back, .drawer').forEach((x) => x.remove());
  window.scrollTo(0, 0);
  current = v;
  const fn = VIEWS[v] || VIEWS.live;
  $('#content').innerHTML = '<div class="muted">Lade …</div>';
  Promise.resolve(fn($('#content'))).then(() => enhanceFilters($('#content'))).catch((e) => { $('#content').innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; });
}
const qs = () => new URLSearchParams((location.hash.split('?')[1]) || '');

// ---- Echtzeit --------------------------------------------------------------------
let audioCtx = null;
function beep() {
  if (!$('#sound')?.checked) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch {}
}
const liveRefresh = debounce(() => { if (current === 'live') VIEWS.live($('#content'), true); }, 400);
function onEvent(e) {
  if (e.type === 'ITEM_CANCELLED') {
    const d = J(e.details_json) || {};
    toast(h(`<div><b>STORNO · Tisch ${e.table_no} · ${fmtTime(e.ts)}</b><br>${esc(e.user_name)}: ${e.qty}× ${esc(e.article_name)} (${euro(e.amount)})<br><small>Grund: ${esc(e.reason)}${d.eingegeben_von && d.eingegeben_von !== e.user_name ? ` · eingegeben von ${esc(d.eingegeben_von)}` : ''}</small></div>`), 'storno', 12000)
      .addEventListener('click', () => openEvent(e.seq));
    beep();
  } else if (e.type === 'TABLE_REOPENED' || e.type === 'INVOICE_REVERSED' || e.type === 'ITEM_PRICE_CHANGED') {
    toast(h(`<div><b>${esc(label(e.type))} · Tisch ${e.table_no ?? ''}</b><br>${esc(e.user_name)} ${e.reason ? '– ' + esc(e.reason) : ''}</div>`), 'warn', 8000);
  }
  if (current === 'live' && !liveFeedPaused) {
    const feed = $('#feed');
    if (feed) { feed.prepend(evRow(e, true)); while (feed.children.length > 120) feed.lastChild.remove(); }
    liveRefresh();
  }
}
function onAlert(a) {
  toast(h(`<div><b>Warnung (${esc(a.severity)}): ${esc(a.title)}</b><br><small>${esc(a.message)}</small></div>`), a.severity === 'hoch' ? 'error' : 'warn', 10000)
    .addEventListener('click', () => { location.hash = '#warnungen'; });
  updateAlertBadge();
  if (current === 'warnungen') route();
}
async function updateAlertBadge() {
  try {
    const list = await api.get('/api/admin/alerts?status=offen');
    for (const id of ['#abadge', '#bbadge']) { const b = $(id); if (b) { b.textContent = list.length; b.classList.toggle('hidden', !list.length); } }
  } catch {}
}

function evRow(e, isNew, withDate) {
  const t = withDate ? `${fmtDate(e.ts).slice(0, 6)}<br>${fmtTime(e.ts)}` : fmtTime(e.ts);
  const el = h(`<div class="ev ${evClass(e.type)} ${isNew ? 'new' : ''}"><span class="t">${t}</span><span>${describe(e)}</span></div>`);
  el.addEventListener('click', () => openEvent(e.seq));
  return el;
}

// ---- Drawer ------------------------------------------------------------------------
// Detailansicht: am PC seitlich, am Handy als Vollbild. Die Zurück-Taste des Handys schließt sie.
function drawer(title, html, buttons = []) {
  const had = !!$('.drawer');
  $$('.drawer-back, .drawer').forEach((x) => x.remove());
  const back = h('<div class="drawer-back"></div>');
  const d = h(`<aside class="drawer"><div class="dh"><button class="icon-btn dback" aria-label="Zurück">${svg('back')}</button><h2>${esc(title)}</h2></div><div class="dbtns"></div><div class="db"></div></aside>`);
  for (const b of buttons) { const btn = h(`<button class="btn sm">${esc(b.label)}</button>`); btn.addEventListener('click', b.onClick); $('.dbtns', d).append(btn); }
  if (!buttons.length) $('.dbtns', d).remove();
  const x = h('<button class="icon-btn dclose" aria-label="Schließen">✕</button>');
  const remove = () => { back.remove(); d.remove(); };
  const close = () => { if (history.state?.drawer) history.back(); else remove(); };
  x.addEventListener('click', close); back.addEventListener('click', close); $('.dback', d).addEventListener('click', close);
  $('.dh', d).append(x);
  if (typeof html === 'string') $('.db', d).innerHTML = html; else $('.db', d).append(html);
  document.body.append(back, d);
  if (had && history.state?.drawer) history.replaceState({ drawer: 1 }, ''); else history.pushState({ drawer: 1 }, '');
  return { el: d, close };
}
window.addEventListener('popstate', () => $$('.drawer-back, .drawer').forEach((x) => x.remove()));

// Vorher/Nachher lesbar statt als Rohdaten
const MONEY = /(preis|price|summe|betrag|amount|wert|total|rabatt|^gegeben$|rueckgeld|umsatz|brutto|netto|steuer)/i;
const humanKey = (k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
function readable(v, k = '') {
  if (v === null || v === undefined || v === '') return '<span class="muted">–</span>';
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  if (typeof v === 'number') return MONEY.test(k) && !/anzahl|menge|qty|count|prozent|anteil|satz|(^|_)id$/i.test(k) ? euro(v) : String(v);
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? fmtDT(v) : esc(v);
  if (Array.isArray(v)) return v.length ? `<div class="kvlist">${v.map((x) => `<div>${readable(x, k)}</div>`).join('')}</div>` : '<span class="muted">keine</span>';
  return `<dl class="kv2">${Object.entries(v).map(([kk, vv]) => `<dt>${esc(humanKey(kk))}</dt><dd>${readable(vv, kk)}</dd>`).join('')}</dl>`;
}
const pretty = (s) => {
  const o = J(s);
  if (o == null) return '<span class="muted">–</span>';
  return `<div class="readable">${readable(o)}</div><details class="raw"><summary>Rohdaten</summary><pre class="json">${esc(JSON.stringify(o, null, 2))}</pre></details>`;
};

// Vorher/Nachher als Gegenüberstellung; geänderte Felder hervorgehoben
function compareHtml(bs, as) {
  const b = J(bs); const a = J(as);
  const flat = (o) => o === null || (typeof o === 'object' && !Array.isArray(o));
  if (!flat(b) || !flat(a) || (!b && !a)) {
    return `<div class="ba"><div><div class="small muted">Vorher</div>${pretty(bs)}</div><div><div class="small muted">Nachher</div>${pretty(as)}</div></div>`;
  }
  const keys = [...new Set([...Object.keys(b || {}), ...Object.keys(a || {})])];
  const rows = keys.map((k) => {
    const bv = b ? b[k] : undefined; const av = a ? a[k] : undefined;
    const changed = JSON.stringify(bv) !== JSON.stringify(av);
    return `<tr class="${changed ? 'chg' : ''}"><th>${esc(humanKey(k))}</th><td>${b ? readable(bv, k) : '<span class="muted">–</span>'}</td><td>${a ? readable(av, k) : '<span class="muted">–</span>'}</td></tr>`;
  }).join('');
  return `<table class="cmp"><thead><tr><th></th><th>Vorher</th><th>Nachher</th></tr></thead><tbody>${rows}</tbody></table>
    <details class="raw"><summary>Rohdaten</summary><pre class="json">${esc(JSON.stringify({ vorher: b, nachher: a }, null, 2))}</pre></details>`;
}

// Tabellen erhalten Spaltennamen je Zelle → am Handy als Karten darstellbar
function labelTables(root) {
  for (const t of $$('table.data', root)) {
    const heads = $$('thead th', t).map((th) => th.textContent.trim());
    for (const tr of $$('tbody tr', t)) {
      if (tr.dataset.lab === String(heads.length)) continue;
      $$(':scope > td', tr).forEach((td, i) => { if (!td.hasAttribute('colspan')) td.dataset.label = heads[i] || ''; });
      tr.dataset.lab = String(heads.length);
    }
  }
}

async function openEvent(seq) {
  const { entry: e, journal, prev, next } = await api.get(`/api/admin/audit/${seq}`);
  const chainOk = (!prev || prev.hash === e.prev_hash) && (!next || next.prev_hash === e.hash);
  const btns = [];
  if (e.lifecycle_id) btns.push({ label: 'Artikel-Lebenslauf', onClick: () => openLifecycle(e.item_id || e.lifecycle_id) });
  if (e.order_id) btns.push({ label: 'Tisch-Historie', onClick: () => openOrder(e.order_id) });
  drawer(`Ereignis #${e.seq} – ${label(e.type)}`, `
    <p style="margin-top:0">${describe(e)}</p>
    <dl class="kv"><dt>Ereignis-Nr.</dt><dd>${e.seq} <span class="mono">${esc(e.event_id)}</span></dd>
      <dt>Zeit (Server)</dt><dd><b>${fmtDT(e.ts)}</b> <span class="muted small">${esc(e.ts)}</span></dd>
      <dt>Art</dt><dd>${esc(label(e.type))} <span class="badge">${esc(e.category)}</span> ${e.source === 'client' ? '<span class="badge info">vom Gerät gemeldet</span>' : ''}</dd>
      <dt>Mitarbeiter</dt><dd>${esc(e.user_name || 'System')} ${e.user_id ? `(ID ${e.user_id}, ${esc(e.role)})` : ''}</dd>
      <dt>Gerät / Sitzung</dt><dd>${esc(e.device || '')} <span class="mono">${esc(e.session_id || '')}</span></dd>
      <dt>Tisch</dt><dd>${e.table_no ?? '–'}${e.target_table_no ? ' → ' + e.target_table_no : ''}</dd>
      <dt>Artikel</dt><dd>${esc(e.article_name || '–')}${e.lifecycle_id ? ` <span class="badge accent">Artikel-ID ${e.lifecycle_id}</span>` : ''}${e.item_id && e.item_id !== e.lifecycle_id ? ` <span class="badge">Position ${e.item_id}</span>` : ''}</dd>
      <dt>Menge / Preis / Betrag</dt><dd>${e.qty ?? '–'} / ${e.unit_price != null ? euro(e.unit_price) : '–'} / ${e.amount != null ? euro(e.amount) : '–'}</dd>
      <dt>Begründung</dt><dd>${esc(e.reason || '–')}</dd></dl>
    <h3 style="margin:16px 0 8px;font-size:15px">Ursprünglicher und neuer Zustand</h3>
    ${compareHtml(e.before_json, e.after_json)}
    <h3 style="margin:16px 0 8px;font-size:15px">Details</h3>${pretty(e.details_json)}
    <h3 style="margin:16px 0 8px;font-size:15px">Fälschungsschutz</h3>
    <dl class="kv"><dt>Hash</dt><dd class="mono">${esc(e.hash)}</dd><dt>Vorgänger-Hash</dt><dd class="mono">${esc(e.prev_hash)}</dd>
      <dt>Verkettung</dt><dd>${chainOk ? '<span class="badge ok">mit Vorgänger und Nachfolger konsistent</span>' : '<span class="badge danger">INKONSISTENT</span>'}</dd></dl>
    <h3 style="margin:16px 0 8px;font-size:15px">Datenbank-Änderungsjournal dieser Transaktion (${journal.length})</h3>
    <p class="small muted" style="margin-top:0">Automatisch von der Datenbank aufgezeichnet, unabhängig von der Kassen-Software.</p>
    ${journal.map((j) => `<details style="margin-bottom:6px"><summary class="small"><b>${esc(j.op)}</b> ${esc(j.tbl)} #${esc(j.row_id)}</summary>
      <div class="ba" style="margin-top:6px"><div>${pretty(j.old_json)}</div><div>${pretty(j.new_json)}</div></div></details>`).join('') || '<span class="muted small">keine Datenänderung</span>'}`, btns);
}

async function openLifecycle(itemId) {
  const d = await api.get(`/api/admin/lifecycle/${itemId}`);
  drawer(`Artikel-Lebenslauf · ID ${d.lifecycle_id}`, lifecycleHtml(d)).el.addEventListener('click', (ev) => {
    const s = ev.target.closest('[data-seq]'); if (s) openEvent(Number(s.dataset.seq));
  });
}
function lifecycleHtml(d) {
  const r = d.root;
  const totals = d.items.reduce((a, i) => ({ st: a.st + i.cancelled_qty, b: a.b + i.billed_qty, o: a.o + i.open_qty }), { st: 0, b: 0, o: 0 });
  return `<dl class="kv"><dt>Artikel</dt><dd><b>${esc(r.article_name)}</b> · Listenpreis ${euro(r.list_price)}</dd>
    <dt>Erste Eingabe</dt><dd>${fmtDT(r.created_at)} von <b>${esc(r.created_by_name)}</b> auf <b>Tisch ${r.table_no}</b> (Menge ${r.qty}${r.raw_input ? `, Eingabe „${esc(r.raw_input)}“` : ''})</dd>
    <dt>Aktueller Stand</dt><dd>${totals.o} offen · <b>${d.invoices.reduce((s, v) => s + v.qty, 0)} gültig abgerechnet</b>${d.invoices.some((v) => v.kind === 'storno') ? ` (${totals.b}× abgerechnet, davon ${-d.invoices.filter((v) => v.kind === 'storno').reduce((s, v) => s + v.qty, 0)}× per Stornorechnung aufgehoben)` : ''} · ${totals.st} storniert</dd>
    <dt>Positionen</dt><dd>${d.items.map((i) => `<div class="small">#${i.id} Tisch ${i.table_no}: Menge ${i.qty} (${i.origin_kind === 'entry' ? 'Eingabe' : i.origin_kind === 'move' ? 'durch Verschiebung' : 'durch Wiedereröffnung'}) – offen ${i.open_qty}, storniert ${i.cancelled_qty}, verschoben ${i.moved_qty}, abgerechnet ${i.billed_qty}</div>`).join('')}</dd>
    <dt>Rechnungen</dt><dd>${d.invoices.map((v) => `<div class="small">${esc(v.invoice_no)} (${v.kind}) · Tisch ${v.table_no} · ${v.qty}× · ${fmtDT(v.closed_at)}</div>`).join('') || '–'}</dd></dl>
    <h3 style="margin:16px 0 6px;font-size:15px">Chronologie (vom ersten Tastendruck bis zur Abrechnung)</h3>
    <div class="timeline">${d.events.map((e) => `<div class="tl ${evClass(e.type)}" data-seq="${e.seq}" style="cursor:pointer"><div class="tt">${fmtDT(e.ts)} · #${e.seq}</div><div class="tx">${describe(e)}</div></div>`).join('')}</div>`;
}

async function openOrder(orderId) {
  const d = await api.get(`/api/admin/orders/${orderId}`);
  const o = d.order;
  const dr = drawer(`Tisch-Historie · Tisch ${o.table_no} · Vorgang ${o.id}`, `
    <dl class="kv"><dt>Status</dt><dd>${o.status === 'open' ? '<span class="badge ok">offen</span>' : o.status === 'merged' ? '<span class="badge">zusammengelegt/ohne Umsatz</span>' : '<span class="badge">abgeschlossen</span>'} ${o.reopen_count ? `<span class="badge warn">${o.reopen_count}× wiedereröffnet</span>` : ''}</dd>
      <dt>Eröffnet</dt><dd>${fmtDT(o.opened_at)} von ${esc(o.opened_by_name)}</dd><dt>Bedienung</dt><dd>${esc(o.waiter_name)}</dd>
      <dt>Abgeschlossen</dt><dd>${o.closed_at ? fmtDT(o.closed_at) + ' von ' + esc(userName(o.closed_by)) : '–'}</dd>
      <dt>Rechnungen</dt><dd>${d.invoices.map((v) => `<a href="#" data-inv="${v.id}">${esc(v.invoice_no)}</a> ${v.kind === 'storno' ? '(Storno)' : ''} ${euro(v.total)}${v.reversed ? ' – aufgehoben' : ''}`).join('<br>') || '–'}</dd>
      <dt>Herein verschoben</dt><dd>${d.moves_in.map((m) => `${m.qty}× ${esc(m.article_name)} von Tisch ${m.from_table_no}`).join('<br>') || '–'}</dd>
      <dt>Hinaus verschoben</dt><dd>${d.moves_out.map((m) => `${m.qty}× ${esc(m.article_name)} nach Tisch ${m.to_table_no}`).join('<br>') || '–'}</dd></dl>
    <h3 style="margin:16px 0 6px;font-size:15px">Alle Positionen (auch stornierte/verschobene)</h3>
    <div class="table-wrap"><table class="data"><thead><tr><th>ID</th><th>Artikel</th><th class="num">Menge</th><th class="num">Preis</th><th>Status</th><th>Eingabe</th></tr></thead><tbody>
    ${d.items.map((i) => `<tr class="click" data-life="${i.id}"><td>${i.lifecycle_id}</td><td>${esc(i.article_name)}</td><td class="num">${i.qty}</td><td class="num">${euro(i.unit_price)}</td>
      <td class="small">${[i.open_qty && `${i.open_qty} offen`, i.billed_qty && `${i.billed_qty} bezahlt`, i.cancelled_qty && `<span style="color:var(--danger)">${i.cancelled_qty} storniert</span>`, i.moved_qty && `${i.moved_qty} verschoben`].filter(Boolean).join(', ')}</td>
      <td class="small">${fmtTime(i.created_at)} ${esc(i.created_by_name)}</td></tr>`).join('')}</tbody></table></div>
    <h3 style="margin:16px 0 6px;font-size:15px">Chronologie</h3>
    <div class="timeline">${d.events.map((e) => `<div class="tl ${evClass(e.type)}" data-seq="${e.seq}" style="cursor:pointer"><div class="tt">${fmtDT(e.ts)} · #${e.seq}</div><div class="tx">${describe(e)}</div></div>`).join('')}</div>`);
  dr.el.addEventListener('click', (ev) => {
    const s = ev.target.closest('[data-seq]'); if (s) return openEvent(Number(s.dataset.seq));
    const l = ev.target.closest('[data-life]'); if (l) return openLifecycle(Number(l.dataset.life));
    const i = ev.target.closest('[data-inv]'); if (i) { ev.preventDefault(); openInvoice(Number(i.dataset.inv)); }
  });
}

async function openInvoice(id) {
  const d = await api.get(`/api/admin/invoices/${id}`);
  modal({ title: `${d.kind === 'storno' ? 'Stornorechnung' : 'Rechnung'} ${d.invoice_no}`, wide: true, body: invoiceHtml(d), actions: [
    { label: 'Tisch-Historie', onClick: () => openOrder(d.order_id) },
    { label: 'PDF', onClick: () => api.openPdf(`/api/admin/invoices/${id}/pdf`), close: false },
    { label: 'Schließen', kind: 'primary' }] });
}

// ---- Hilfen für Listen -----------------------------------------------------------
const userOptions = (sel) => `<option value="">Alle Mitarbeiter</option>${META.users.map((u) => `<option value="${u.id}" ${String(sel) === String(u.id) ? 'selected' : ''}>${esc(u.name)} (${u.personal_nr})</option>`).join('')}`;
function exportButtons(what, getQuery) {
  const w = h('<span class="row"><button class="btn sm" data-f="csv">CSV</button><button class="btn sm" data-f="pdf">PDF</button></span>');
  w.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f; if (!f) return;
    const q = new URLSearchParams({ ...getQuery(), format: f });
    try { await api.download(`/api/admin/export/${what}?${q}`, `${what}.${f}`); toast('Export erstellt (wird protokolliert)', 'ok'); } catch (er) { toast(er.message, 'error'); }
  });
  return w;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));
function rangeInputs(from = todayStr(), to = todayStr()) {
  return `<label>Von<input type="date" name="from" value="${from}"></label><label>Bis<input type="date" name="to" value="${to}"></label>`;
}
// Filter: am Handy einklappbar, mit Schnellwahl Heute/Gestern/Woche/Monat
const shiftDay = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function quickDates(mode) {
  const t = todayStr();
  if (mode === 'gestern') { const y = shiftDay(t, -1); return [y, y]; }
  if (mode === 'woche') { const wd = (new Date(t + 'T12:00:00Z').getUTCDay() + 6) % 7; return [shiftDay(t, -wd), t]; }
  if (mode === 'monat') return [t.slice(0, 8) + '01', t];
  return [t, t];
}
function enhanceFilters(root) {
  const f = $('form.filters#f', root);
  if (!f || f.closest('.fbox')) return;
  const hasRange = $('[name=from]', f) || $('[name=from_dt]', f);
  const box = h(`<details class="fbox"><summary><span>Filter</span><span class="fsum muted small"></span></summary></details>`);
  f.replaceWith(box);
  box.append(f);
  if (hasRange) {
    const q = h(`<div class="quick chips">${[['heute', 'Heute'], ['gestern', 'Gestern'], ['woche', 'Diese Woche'], ['monat', 'Dieser Monat']].map(([k, l]) => `<button type="button" class="chip" data-q="${k}">${l}</button>`).join('')}</div>`);
    box.before(q);
    q.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]'); if (!b) return;
      const [a, z] = quickDates(b.dataset.q);
      if ($('[name=from]', f)) { $('[name=from]', f).value = a; $('[name=to]', f).value = z; }
      if ($('[name=from_dt]', f)) { $('[name=from_dt]', f).value = a + 'T00:00'; $('[name=to_dt]', f).value = z === todayStr() ? '' : z + 'T23:59'; }
      $$('.chip', q).forEach((x) => x.classList.toggle('on', x === b));
      f.requestSubmit();
    });
  }
  const sum = () => {
    const v = formVals(f);
    const parts = [];
    if (v.from || v.to) parts.push(v.from === v.to ? fmtDate(v.from + 'T12:00:00Z') : `${fmtDate(v.from + 'T12:00:00Z')} – ${fmtDate(v.to + 'T12:00:00Z')}`);
    if (v.from_dt) parts.push('ab ' + fmtDate(v.from_dt + ':00') + (v.to_dt ? ' bis ' + fmtDate(v.to_dt + ':00') : ''));
    if (v.user_id) parts.push(userName(Number(v.user_id)));
    if (v.table_no) parts.push('Tisch ' + v.table_no);
    if (v.period) parts.push({ day: 'Tag', week: 'Woche', month: 'Monat' }[v.period] + ' ' + fmtDate(v.date + 'T12:00:00Z'));
    $('.fsum', box).textContent = parts.join(' · ');
  };
  f.addEventListener('submit', () => { sum(); if (isMobile()) box.open = false; });
  sum();
  box.open = !isMobile();
}

const formVals = (el) => Object.fromEntries($$('input[name],select[name]', el).map((i) => [i.name, i.type === 'checkbox' ? (i.checked ? '1' : '') : i.value]));

// ---- Ansichten -------------------------------------------------------------------
const VIEWS = {};

VIEWS.live = async (el, soft) => {
  const d = await api.get('/api/admin/live');
  const k = d.kpi;
  const html = `<div class="head"><h1>Live-Übersicht</h1><span class="muted small">Geschäftstag ${fmtDate(d.from)} · aktualisiert ${fmtTime(new Date().toISOString())}</span></div>
    ${k.warnungen_offen ? `<a class="alertbar" href="#warnungen">${svg('warn')}<span><b>${k.warnungen_offen} offene Warnung${k.warnungen_offen > 1 ? 'en' : ''}</b> – jetzt prüfen</span><span>›</span></a>` : ''}
    <div class="kpis live-kpis">
      <div class="kpi"><div class="l">Umsatz heute</div><div class="v">${euro(k.umsatz)}</div></div>
      <div class="kpi"><div class="l">Rechnungen</div><div class="v">${k.rechnungen}</div></div>
      <div class="kpi"><div class="l">Offene Tische</div><div class="v">${k.offene_tische}</div></div>
      <div class="kpi"><div class="l">Offener Wert</div><div class="v">${euro(k.offener_wert)}</div></div>
      <div class="kpi ${k.stornos ? 'danger' : ''}"><div class="l">Stornos</div><div class="v">${k.stornos} · ${euro(k.storno_wert)}</div></div>
      <div class="kpi"><div class="l">Verschiebungen</div><div class="v">${k.verschiebungen}</div></div>
      <div class="kpi ${k.warnungen_offen ? 'warn' : ''}"><div class="l">Offene Warnungen</div><div class="v">${k.warnungen_offen}</div></div>
    </div>
    <div class="cols live-cols"><div>
      <div class="card c-tables"><h2>Geöffnete Tische <span class="badge">${d.open_orders.length}</span></h2>
        <div class="otables">${d.open_orders.map((t) => `<div class="otable" data-order="${t.order_id}"><div class="top"><b>Tisch ${t.number}</b><span class="num"><b>${euro(t.open_total)}</b></span></div>
          <div class="small muted">${esc(t.waiter_name)} · seit ${fmtTime(t.opened_at, false)}${t.reopen_count ? ' · <span style="color:var(--warn)">wiedereröffnet</span>' : ''}</div>
          <div class="cnt">${t.items.reduce((s, i) => s + i.open_qty, 0)} Artikel offen${t.items.some((i) => i.cancelled_qty) ? ` · <span style="color:var(--danger)">${t.items.reduce((s, i) => s + i.cancelled_qty, 0)} storniert</span>` : ''}${t.items.some((i) => i.moved_qty) ? ` · ${t.items.reduce((s, i) => s + i.moved_qty, 0)} verschoben` : ''}</div>
          <ul>${t.items.map((i) => `<li class="${i.open_qty === 0 && i.cancelled_qty ? 'x' : ''}"><span>${i.open_qty || i.qty}× ${esc(i.article_name)}${i.cancelled_qty ? ` <span style="color:var(--danger)">(−${i.cancelled_qty} Storno)</span>` : ''}${i.moved_qty ? ` <span style="color:var(--info)">(${i.moved_qty} versch.)</span>` : ''}${i.origin_kind === 'move' ? ' <span class="muted">↪</span>' : ''}</span><span class="num">${euro(i.open_qty * i.unit_price)}</span></li>`).join('')}</ul></div>`).join('') || '<div class="muted">Keine Tische geöffnet</div>'}</div></div>
      <div class="card c-stornos"><h2>Stornos heute <span class="badge danger">${d.cancellations.length}</span></h2>
        <div class="feed mfeed">${d.cancellations.map((c) => `<div class="ev storno" data-seq="${c.audit_seq}"><span class="t">${fmtTime(c.cancelled_at, false)}</span><span><b>${esc(c.cancelled_by_name)}</b>: ${c.qty}× ${esc(c.article_name)} · Tisch ${c.table_no} · <b class="nw">${euro(c.total)}</b><br><span class="small muted">„${esc(c.reason)}“${c.entered_by !== c.cancelled_by ? ` · Eingabe ${esc(c.entered_by_name)}` : ''}</span></span></div>`).join('') || '<div class="muted">Keine Stornos</div>'}</div>
        <div class="table-wrap desk-only"><table class="data"><thead><tr><th>Zeit</th><th>Tisch</th><th>Artikel</th><th class="num">Wert</th><th>Storniert von</th><th>Grund</th></tr></thead><tbody>
        ${d.cancellations.map((c) => `<tr class="click storno" data-seq="${c.audit_seq}"><td>${fmtTime(c.cancelled_at)}</td><td>${c.table_no}</td><td>${c.qty}× ${esc(c.article_name)}</td><td class="num">${euro(c.total)}</td><td>${esc(c.cancelled_by_name)}${c.entered_by !== c.cancelled_by ? `<br><small class="muted">Eingabe: ${esc(c.entered_by_name)}</small>` : ''}</td><td>${esc(c.reason)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Keine Stornos</td></tr>'}</tbody></table></div></div>
      <div class="card c-inv"><h2>Abgeschlossene Rechnungen heute</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>Nr.</th><th>Zeit</th><th>Tisch</th><th>Bedienung</th><th>Zahlung</th><th class="num">Summe</th></tr></thead><tbody>
        ${d.invoices.map((v) => `<tr class="click ${v.kind === 'storno' ? 'storno' : ''}" data-inv="${v.id}"><td>${esc(v.invoice_no)}</td><td>${fmtTime(v.closed_at)}</td><td>${v.table_no}</td><td>${esc(v.waiter_name)}</td><td>${esc(v.payment_method)}</td><td class="num">${euro(v.total)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Noch keine</td></tr>'}</tbody></table></div></div>
    </div><div>
      <div class="card c-sess"><h2>Angemeldet <span class="badge ok">${d.sessions.length}</span></h2>
        ${d.sessions.map((s) => `<div class="row small" style="justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span><b>${esc(s.name)}</b> <span class="badge">${s.kind === 'admin' ? 'Dashboard' : 'Kasse'}</span></span><span class="muted">${esc(s.device)} · seit ${fmtTime(s.created_at, false)}</span></div>`).join('') || '<div class="muted">Niemand angemeldet</div>'}</div>
      <div class="card c-feed"><h2>Letzte Aktivitäten <span class="badge accent">live</span><span class="grow"></span><label class="small row" style="font-weight:600"><input type="checkbox" id="pause"> anhalten</label></h2><div class="feed" id="feed"></div></div>
    </div></div>`;
  if (soft && current !== 'live') return;
  const scroll = $('#feed')?.scrollTop || 0;
  el.innerHTML = html;
  const feed = $('#feed');
  for (const e of d.events) feed.append(evRow(e));
  feed.scrollTop = scroll;
  $('#pause').checked = liveFeedPaused;
  $('#pause').addEventListener('change', (e) => { liveFeedPaused = e.target.checked; });
  $$('[data-order]', el).forEach((x) => x.addEventListener('click', () => openOrder(Number(x.dataset.order))));
  $$('[data-seq]', el).forEach((x) => x.addEventListener('click', () => openEvent(Number(x.dataset.seq))));
  $$('[data-inv]', el).forEach((x) => x.addEventListener('click', () => openInvoice(Number(x.dataset.inv))));
};

VIEWS.protokoll = async (el) => {
  const q0 = qs();
  let offset = 0;
  el.innerHTML = `<div class="head"><h1>Aktivitätsprotokoll</h1><span id="exp"></span></div>
    <div class="catchips" id="cats">${CATS.map(([k, l]) => `<button class="chip ${(q0.get('category') || '') === k ? 'on' : ''}" data-c="${k}">${l}</button>`).join('')}</div>
    <form class="filters" id="f">
      <label>Mitarbeiter<select name="user_id">${userOptions(q0.get('user_id'))}</select></label>
      <label>Von (Datum & Uhrzeit)<input type="datetime-local" name="from_dt" value="${q0.get('from_dt') || todayStr() + 'T00:00'}"></label>
      <label>Bis (Datum & Uhrzeit)<input type="datetime-local" name="to_dt" value="${q0.get('to_dt') || ''}"></label>
      <label>Tisch<input type="number" name="table_no" min="1" value="${q0.get('table_no') || ''}"></label>
      <label>Artikel<input type="text" name="article" value="${esc(q0.get('article') || '')}"></label>
      <label>Freitext<input type="search" name="q" placeholder="Grund, Name …" value="${esc(q0.get('q') || '')}"></label>
      <input type="hidden" name="category" value="${esc(q0.get('category') || '')}">
      <button class="btn primary" type="submit">Filtern</button></form>
    <div class="feed mfeed" id="mfeed"></div><div class="table-wrap desk-only"><table class="data"><thead><tr><th>#</th><th>Zeit</th><th>Aktion</th><th>Mitarbeiter</th><th>Tisch</th><th>Artikel</th><th class="num">Menge</th><th class="num">Preis</th><th>Vorher → Nachher / Grund</th></tr></thead><tbody id="rows"></tbody></table></div>
    <div class="pager"><span class="muted small" id="cnt"></span><button class="btn sm" id="prev">‹ Neuere</button><button class="btn sm" id="next">Ältere ›</button></div>`;
  const getQ = () => clean(formVals($('#f')));
  $('#exp').append(exportButtons('audit', getQ));
  const load = async () => {
    const r = await api.get(`/api/admin/audit?${new URLSearchParams({ ...getQ(), limit: 100, offset })}`);
    $('#cnt').textContent = `${r.total} Einträge · ${offset + 1}–${Math.min(offset + 100, r.total)}`;
    $('#prev').disabled = offset === 0;
    $('#next').disabled = offset + 100 >= r.total;
    $('#rows').innerHTML = r.rows.map((e) => {
      const b = J(e.before_json); const a = J(e.after_json);
      const ba = b || a ? `<span class="small muted">${esc(JSON.stringify(b ?? '–')).slice(0, 80)} → ${esc(JSON.stringify(a ?? '–')).slice(0, 80)}</span>` : '';
      return `<tr class="click ${evClass(e.type) === 'storno' ? 'storno' : ''}" data-seq="${e.seq}"><td class="muted">${e.seq}</td><td style="white-space:nowrap">${fmtDT(e.ts)}</td>
        <td><b>${esc(label(e.type))}</b></td><td>${esc(e.user_name || 'System')}</td><td>${e.table_no ?? ''}${e.target_table_no ? ' → ' + e.target_table_no : ''}</td>
        <td>${esc(e.article_name || '')}</td><td class="num">${e.qty ?? ''}</td><td class="num">${e.unit_price != null ? num(e.unit_price) : ''}</td>
        <td>${e.reason ? `„${esc(e.reason)}“<br>` : ''}${ba}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="muted">Keine Einträge für diesen Filter</td></tr>';
    $$('#rows [data-seq]').forEach((tr) => tr.addEventListener('click', () => openEvent(Number(tr.dataset.seq))));
    const mf = $('#mfeed'); mf.innerHTML = '';
    for (const e of r.rows) mf.append(evRow(e, false, true));
    if (!r.rows.length) mf.innerHTML = '<div class="muted">Keine Einträge für diesen Filter</div>';
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); offset = 0; load(); });
  $('#cats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-c]'); if (!c) return;
    $$('#cats .chip').forEach((x) => x.classList.toggle('on', x === c));
    $('#f [name=category]').value = c.dataset.c; offset = 0; load();
  });
  $('#prev').addEventListener('click', () => { offset = Math.max(0, offset - 100); load(); });
  $('#next').addEventListener('click', () => { offset += 100; load(); });
  await load();
};

VIEWS.lebenslauf = async (el) => {
  el.innerHTML = `<div class="head"><h1>Artikel-Lebenslauf</h1></div>
    <div class="card"><p style="margin-top:0">Jede Eingabe erhält eine eindeutige <b>Artikel-ID</b>. Über sie lässt sich die komplette Geschichte nachvollziehen – vom ersten Tastendruck über Stornos und Verschiebungen bis zur Rechnung. Die ID steht in der Kasse bei jeder Position, im Protokoll und auf Rechnungen (Pos-ID).</p>
    <form class="row" id="lf"><input type="number" min="1" id="lid" placeholder="Artikel-ID oder Positions-Nr." style="max-width:260px"><button class="btn primary">Anzeigen</button></form></div><div id="lres"></div>
    <div class="card"><h2>Zuletzt eingegebene Artikel</h2><div id="recent" class="muted">Lade …</div></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await api.get(`/api/admin/lifecycle/${Number($('#lid').value)}`);
      $('#lres').innerHTML = `<div class="card">${lifecycleHtml(d)}</div>`;
      $$('#lres [data-seq]').forEach((x) => x.addEventListener('click', () => openEvent(Number(x.dataset.seq))));
    } catch (er) { toast(er.message, 'error'); }
  });
  const r = await api.get('/api/admin/audit?type=ITEM_ADDED&limit=30');
  $('#recent').innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Artikel-ID</th><th>Zeit</th><th>Artikel</th><th>Tisch</th><th>Mitarbeiter</th></tr></thead><tbody>
    ${r.rows.map((e) => `<tr class="click" data-l="${e.lifecycle_id}"><td><b>${e.lifecycle_id}</b></td><td>${fmtDT(e.ts)}</td><td>${e.qty}× ${esc(e.article_name)}</td><td>${e.table_no}</td><td>${esc(e.user_name)}</td></tr>`).join('')}</tbody></table></div>`;
  $$('#recent [data-l]').forEach((x) => x.addEventListener('click', () => openLifecycle(Number(x.dataset.l))));
};

VIEWS.rechnungen = async (el) => {
  el.innerHTML = `<div class="head"><h1>Rechnungen</h1><span id="exp"></span></div>
    <form class="filters" id="f">${rangeInputs()}<label>Rechnungs-Nr.<input type="text" name="no"></label><label>Tisch<input type="number" name="table_no"></label>
    <label>Mitarbeiter<select name="user_id">${userOptions()}</select></label><label>Art<select name="kind"><option value="">Alle</option><option value="rechnung">Rechnungen</option><option value="storno">Stornorechnungen</option></select></label>
    <label>Zahlungsart<select name="method"><option value="">Alle</option>${META.settings.payment_methods.map((m) => `<option>${esc(m)}</option>`).join('')}<option>Keine Zahlung</option></select></label>
    <label>Artikel enthalten<input type="text" name="article"></label><label>Betrag ab (€)<input type="text" name="min" inputmode="decimal"></label><label>Betrag bis (€)<input type="text" name="max" inputmode="decimal"></label>
    <button class="btn primary">Suchen</button></form><div id="res"></div>`;
  const getQ = () => { const v = clean(formVals($('#f'))); if (v.min) v.min = v.min.replace(',', '.'); if (v.max) v.max = v.max.replace(',', '.'); return v; };
  $('#exp').append(exportButtons('invoices', getQ));
  const load = async () => {
    const rows = await api.get(`/api/admin/invoices?${new URLSearchParams(getQ())}`);
    const sum = rows.reduce((s, r) => s + r.total, 0);
    $('#res').innerHTML = `<p class="muted">${rows.length} Belege · Summe ${euro(sum)}</p><div class="table-wrap"><table class="data"><thead><tr><th>Nr.</th><th>Abschluss</th><th>Tisch</th><th>Bedienung</th><th>Abgeschl. von</th><th>Zahlung</th><th class="num">Rabatt</th><th class="num">Summe</th><th>Status</th></tr></thead><tbody>
      ${rows.map((v) => `<tr class="click ${v.kind === 'storno' ? 'storno' : ''}" data-inv="${v.id}"><td><b>${esc(v.invoice_no)}</b></td><td>${fmtDT(v.closed_at)}</td><td>${v.table_no}</td><td>${esc(v.waiter_name)}</td><td>${esc(v.closed_by_name)}</td>
        <td>${esc(v.payment_method)}</td><td class="num">${v.discount ? euro(v.discount) : ''}</td><td class="num"><b>${euro(v.total)}</b></td>
        <td>${v.kind === 'storno' ? `<span class="badge danger">hebt ${esc(v.reverses_no)} auf</span>` : v.reversed_by ? `<span class="badge warn">aufgehoben durch ${esc(v.reversed_by)}</span>` : '<span class="badge ok">gültig</span>'}${v.storno_count ? ` <span class="badge">${v.storno_count} Storno-Pos.</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Keine Rechnungen gefunden</td></tr>'}</tbody></table></div>`;
    $$('#res [data-inv]').forEach((x) => x.addEventListener('click', () => openInvoice(Number(x.dataset.inv))));
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
};

VIEWS.stornos = async (el) => {
  el.innerHTML = `<div class="head"><h1>Stornierungen</h1><span id="exp"></span></div>
    <form class="filters" id="f">${rangeInputs()}<label>Mitarbeiter<select name="user_id">${userOptions(qs().get('user_id'))}</select></label><label>Tisch<input type="number" name="table_no"></label><button class="btn primary">Anzeigen</button></form><div id="res"></div>`;
  const getQ = () => clean(formVals($('#f')));
  $('#exp').append(exportButtons('cancellations', getQ));
  const load = async () => {
    const rows = await api.get(`/api/admin/cancellations?${new URLSearchParams(getQ())}`);
    $('#res').innerHTML = `<div class="kpis"><div class="kpi danger"><div class="l">Anzahl</div><div class="v">${rows.length}</div></div><div class="kpi danger"><div class="l">Gesamtwert</div><div class="v">${euro(rows.reduce((s, r) => s + r.total, 0))}</div></div>
      <div class="kpi"><div class="l">davon fremde Eingaben</div><div class="v">${rows.filter((r) => r.entered_by !== r.cancelled_by).length}</div></div><div class="kpi"><div class="l">mit Freigabe</div><div class="v">${rows.filter((r) => r.approved_by).length}</div></div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Storno-Zeit</th><th>Tisch</th><th>Artikel</th><th class="num">Menge</th><th class="num">Einzel</th><th class="num">Gesamt</th><th>Eingegeben</th><th>Storniert von</th><th>Freigabe</th><th>Grund</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="click storno" data-seq="${c.audit_seq}"><td>${fmtDT(c.cancelled_at)}</td><td>${c.table_no}</td><td>${esc(c.article_name)} <span class="muted small">ID ${c.lifecycle_id}</span></td><td class="num">${c.qty}</td><td class="num">${euro(c.unit_price)}</td><td class="num"><b>${euro(c.total)}</b></td>
        <td>${fmtDT(c.entered_at)}<br><small>${esc(c.entered_by_name)}</small></td><td>${esc(c.cancelled_by_name)}<br><small class="muted">${c.seconds_after_entry < 120 ? c.seconds_after_entry + ' s nach Eingabe' : Math.round(c.seconds_after_entry / 60) + ' Min. nach Eingabe'}</small></td><td>${esc(c.approved_by_name || '–')}</td><td>${esc(c.reason)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">Keine Stornierungen</td></tr>'}</tbody></table></div>`;
    $$('#res [data-seq]').forEach((x) => x.addEventListener('click', () => openEvent(Number(x.dataset.seq))));
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
};

VIEWS.verschiebungen = async (el) => {
  el.innerHTML = `<div class="head"><h1>Artikelverschiebungen</h1><span id="exp"></span></div>
    <form class="filters" id="f">${rangeInputs()}<label>Mitarbeiter<select name="user_id">${userOptions()}</select></label><label>Tisch<input type="number" name="table_no"></label><button class="btn primary">Anzeigen</button></form><div id="res"></div>`;
  const getQ = () => clean(formVals($('#f')));
  $('#exp').append(exportButtons('moves', getQ));
  const load = async () => {
    const rows = await api.get(`/api/admin/moves?${new URLSearchParams(getQ())}`);
    $('#res').innerHTML = `<p class="muted">${rows.length} Verschiebungen · Wert ${euro(rows.reduce((s, r) => s + r.qty * r.unit_price, 0))}</p><div class="table-wrap"><table class="data"><thead><tr><th>Zeit</th><th>Von → Nach</th><th>Artikel</th><th class="num">Menge</th><th class="num">Preis</th><th>Verschoben von</th><th>Ursprünglich gebucht</th><th>Art</th><th>Grund</th></tr></thead><tbody>
      ${rows.map((m) => `<tr class="click" data-life="${m.lifecycle_id}"><td>${fmtDT(m.moved_at)}</td><td><b>${m.from_table_no} → ${m.to_table_no}</b></td><td>${esc(m.article_name)} <span class="muted small">ID ${m.lifecycle_id}</span></td><td class="num">${m.qty}</td><td class="num">${euro(m.unit_price)}</td>
        <td>${esc(m.moved_by_name)}</td><td>Tisch ${m.original_table_no} · ${fmtDT(m.entered_at)} · ${esc(m.entered_by_name)}</td><td>${m.kind === 'tischwechsel' ? 'Tischwechsel' : 'Artikel'}</td><td>${esc(m.reason || '–')}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Keine Verschiebungen</td></tr>'}</tbody></table></div>`;
    $$('#res [data-life]').forEach((x) => x.addEventListener('click', () => openLifecycle(Number(x.dataset.life))));
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
};

VIEWS.preise = async (el) => {
  el.innerHTML = `<div class="head"><h1>Preisänderungen an der Kasse</h1></div><form class="filters" id="f">${rangeInputs()}<button class="btn primary">Anzeigen</button></form><div id="res"></div>
    <div class="card" style="margin-top:14px"><h2>Preisänderungen in den Stammdaten</h2><div id="res2"></div></div>`;
  const load = async () => {
    const q = clean(formVals($('#f')));
    const rows = await api.get(`/api/admin/price-changes?${new URLSearchParams(q)}`);
    $('#res').innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Zeit</th><th>Tisch</th><th>Artikel</th><th class="num">Menge</th><th class="num">Alt</th><th class="num">Neu</th><th>Mitarbeiter</th><th>Freigabe</th><th>Grund</th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="click" data-seq="${p.audit_seq}"><td>${fmtDT(p.changed_at)}</td><td>${p.table_no}</td><td>${esc(p.article_name)}</td><td class="num">${p.qty}</td><td class="num">${euro(p.old_price)}</td><td class="num"><b>${euro(p.new_price)}</b></td><td>${esc(p.changed_by_name)}</td><td>${esc(p.approved_by_name || '–')}</td><td>${esc(p.reason)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Keine Preisänderungen</td></tr>'}</tbody></table></div>`;
    $$('#res [data-seq]').forEach((x) => x.addEventListener('click', () => openEvent(Number(x.dataset.seq))));
    const r2 = await api.get(`/api/admin/audit?type=ARTICLE_PRICE_CHANGED&from=${q.from || ''}&to=${q.to || ''}`);
    $('#res2').innerHTML = r2.rows.map((e) => { const d = J(e.details_json) || {}; return `<div class="ev" data-seq="${e.seq}"><span class="t">${fmtDT(e.ts, false)}</span><span><b>${esc(e.user_name)}</b>: ${esc(e.article_name)} ${euro(d.alter_preis)} → <b>${euro(d.neuer_preis)}</b></span></div>`; }).join('') || '<span class="muted">Keine</span>';
    $$('#res2 [data-seq]').forEach((x) => x.addEventListener('click', () => openEvent(Number(x.dataset.seq))));
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
};

VIEWS.warnungen = async (el) => {
  const st = qs().get('status') ?? 'offen';
  el.innerHTML = `<div class="head"><h1>Warnungen</h1></div>
    <div class="notice info" style="margin-bottom:12px">Warnungen sind Hinweise auf ungewöhnliche Vorgänge – <b>kein Beweis für Fehlverhalten</b>. Bitte jeden Fall im Protokoll prüfen und mit den Beteiligten klären.</div>
    <div class="tabs"><a class="chip ${st === 'offen' ? 'on' : ''}" href="#warnungen?status=offen">Offen</a><a class="chip ${st === 'geprueft' ? 'on' : ''}" href="#warnungen?status=geprueft">Geprüft</a><a class="chip ${st === '' ? 'on' : ''}" href="#warnungen?status=">Alle</a></div>
    <div class="alerts" id="al"></div>`;
  const list = await api.get(`/api/admin/alerts?status=${st}`);
  $('#al').innerHTML = list.map((a) => `<div class="alert-card ${a.severity} ${a.status === 'geprueft' ? 'done' : ''}">
      <div class="row"><b>${esc(a.title)}</b><span class="badge ${a.severity === 'hoch' ? 'danger' : a.severity === 'mittel' ? 'warn' : 'info'}">${esc(a.severity)}</span><span class="grow"></span><span class="small muted">${fmtDT(a.ts)}</span></div>
      <div>${esc(a.message)}</div>
      <div class="row">${a.related_seq ? `<button class="btn sm" data-seq="${a.related_seq}">Auslösendes Ereignis</button>` : ''}${a.user_id ? `<a class="btn sm" href="#protokoll?user_id=${a.user_id}&from_dt=${todayStr()}T00:00">Protokoll ${esc(a.user_name)}</a>` : ''}
      ${a.status === 'offen' ? `<button class="btn sm primary" data-ack="${a.id}">Als geprüft markieren</button>` : `<span class="small muted">geprüft von ${esc(a.ack_by_name)} am ${fmtDT(a.ack_at)}${a.ack_note ? ' – „' + esc(a.ack_note) + '“' : ''}</span>`}</div></div>`).join('') || '<div class="muted">Keine Warnungen</div>';
  $$('#al [data-seq]').forEach((b) => b.addEventListener('click', () => openEvent(Number(b.dataset.seq))));
  $$('#al [data-ack]').forEach((b) => b.addEventListener('click', () => modal({
    title: 'Warnung als geprüft markieren', body: '<label class="field">Notiz (Ergebnis der Prüfung)<textarea id="note" maxlength="500"></textarea></label>',
    actions: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async (body) => { await api.post(`/api/admin/alerts/${b.dataset.ack}/ack`, { note: $('#note', body).value }); updateAlertBadge(); route(); } }],
  })));
};

VIEWS.mitarbeiter = async (el) => {
  el.innerHTML = `<div class="head"><h1>Mitarbeiter-Auswertung</h1><span id="exp"></span></div>
    <form class="filters" id="f"><label>Zeitraum<select name="period"><option value="day">Tag</option><option value="week">Woche</option><option value="month">Monat</option></select></label>
    <label>Datum<input type="date" name="date" value="${todayStr()}"></label><button class="btn primary">Anzeigen</button></form><div id="res"></div>`;
  const getQ = () => clean(formVals($('#f')));
  $('#exp').append(exportButtons('employees', getQ));
  const load = async () => {
    const d = await api.get(`/api/admin/employees?${new URLSearchParams(getQ())}`);
    $('#res').innerHTML = `<p class="muted">${fmtDT(d.from, false)} bis ${fmtDT(d.to, false)}</p><div class="table-wrap"><table class="data"><thead><tr><th>Mitarbeiter</th><th class="num">Tische</th><th class="num">Artikel eingeg.</th><th class="num">Umsatz</th><th class="num">Rechnungen</th>
      <th class="num">Stornos</th><th class="num">Stornowert</th><th class="num">Quote</th><th class="num">Sofort-St.</th><th class="num">Verschieb.</th><th class="num">Wiedereröff.</th><th class="num">Preisänd.</th><th class="num">Rabatte</th><th class="num">Warnungen</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="click" data-u="${r.id}"><td><b>${esc(r.name)}</b><br><small class="muted">Nr. ${r.personal_nr} · ${esc(r.role)}</small></td><td class="num">${r.tische}</td><td class="num">${r.artikel_eingegeben}</td><td class="num">${euro(r.umsatz)}</td><td class="num">${r.rechnungen}</td>
        <td class="num">${r.stornos ? `<b style="color:var(--danger)">${r.stornos}</b>` : 0}</td><td class="num">${euro(r.storno_wert)}</td><td class="num">${r.storno_quote >= 15 ? `<b style="color:var(--danger)">${r.storno_quote} %</b>` : r.storno_quote + ' %'}</td>
        <td class="num">${r.sofortstornos}</td><td class="num">${r.verschiebungen}</td><td class="num">${r.wiedereroeffnungen}</td><td class="num">${r.preisaenderungen}</td><td class="num">${euro(r.rabatte)}</td><td class="num">${r.warnungen}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">Quote = stornierte Menge ÷ eingegebene Menge. Sofort-Stornos = Storno innerhalb von ${META.settings.alert_quick_storno_seconds} Sekunden nach Eingabe. Klick auf eine Zeile öffnet das Protokoll dieses Mitarbeiters.</p>`;
    $$('#res [data-u]').forEach((tr) => tr.addEventListener('click', () => {
      const from = new Date(d.from); const to = new Date(d.to);
      const loc = (x) => x.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16).replace(' ', 'T');
      location.hash = `#protokoll?user_id=${tr.dataset.u}&from_dt=${loc(from)}&to_dt=${loc(new Date(to - 60000))}`;
    }));
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
};

// Ältesten Tagesabschluss mit allen Einzelheiten löschen (nur Administrator, mit Bestätigung)
function deleteClosing(id, done) {
  modal({
    title: 'Tagesabschluss löschen',
    body: `<div class="notice danger">Gelöscht werden dieser Tagesabschluss <b>und alle Einzelheiten seines Zeitraums</b>: Protokoll, Stornos,
      Verschiebungen, Preisänderungen, Rechnungen und abgeschlossene Tische. Das lässt sich nicht rückgängig machen.</div>
      <p class="small muted">Tische, die über den Abschluss hinaus offen waren, behalten ihren aktuellen Stand. Dass gelöscht wurde, von wem und
      wie viel, bleibt dauerhaft im Protokoll stehen.</p>
      <label class="field">Zur Bestätigung <b>LÖSCHEN</b> eingeben<input type="text" id="cfm" autocomplete="off"></label>`,
    actions: [{ label: 'Abbrechen' }, {
      label: 'Endgültig löschen', kind: 'danger', onClick: async (b) => {
        const r = await api.post(`/api/admin/closings/${id}/delete`, { confirm: $('#cfm', b).value });
        toast(`Gelöscht: ${r.counts.protokolleintraege} Protokolleinträge, ${r.counts.rechnungen} Rechnungen, ${r.counts.stornos} Stornos`, 'ok', 6000);
        done();
      },
    }],
  });
}

VIEWS.umsatz = async (el) => {
  el.innerHTML = `<div class="head"><h1>Umsatz & Abschlüsse</h1><span id="exp"></span></div>
    <form class="filters" id="f">${rangeInputs()}<button class="btn primary">Anzeigen</button></form><div id="res"></div>
    <div class="cols" style="margin-top:14px"><div class="card"><h2>Tagesabschlüsse <span class="grow"></span>${can('day_close') ? '<button class="btn sm warn" id="dclose">Tagesabschluss jetzt</button>' : ''}</h2>
      <p class="small muted" style="margin-top:0">Tagesabschlüsse und alle Einzelheiten bleiben gespeichert, bis der älteste Abschluss hier gelöscht wird.</p><div id="cl"></div></div>
    <div class="card"><h2>Schichten</h2><div id="sh"></div></div></div>`;
  const getQ = () => clean(formVals($('#f')));
  $('#exp').append(exportButtons('revenue', getQ));
  const bars = (rows, key, lab) => { const max = Math.max(1, ...rows.map((r) => r[key])); return `<div class="bars">${rows.map((r) => `<div class="bar"><span>${lab(r)}</span><span class="track"><span class="fill" style="width:${Math.max(0, r[key]) * 100 / max}%"></span></span><span class="num">${euro(r[key])}</span></div>`).join('')}</div>`; };
  const load = async () => {
    const d = await api.get(`/api/admin/revenue?${new URLSearchParams(getQ())}`);
    $('#res').innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Umsatz</div><div class="v">${euro(d.total)}</div></div>
      ${d.byKind.map((k) => `<div class="kpi ${k.kind === 'storno' ? 'warn' : ''}"><div class="l">${k.kind === 'storno' ? 'Stornorechnungen' : 'Rechnungen'}</div><div class="v">${k.n} · ${euro(k.total)}</div></div>`).join('')}
      <div class="kpi danger"><div class="l">Stornierte Positionen</div><div class="v">${d.stornos.n} · ${euro(d.stornos.v)}</div></div></div>
      <div class="cols"><div class="card"><h2>Nach Zahlungsart</h2>${bars(d.byMethod, 'total', (r) => `${esc(r.method)} (${r.n})`)}</div>
      <div class="card"><h2>Nach Kategorie</h2>${bars(d.byCategory, 'total', (r) => esc(r.name))}</div></div>
      <div class="cols" style="margin-top:14px"><div class="card"><h2>Nach Uhrzeit</h2>${bars(d.byHour, 'total', (r) => `${String(r.h).padStart(2, '0')}–${String((r.h + 1) % 24).padStart(2, '0')} Uhr`)}</div>
      <div class="card"><h2>Umsatzsteuer</h2><table class="data"><thead><tr><th>Satz</th><th class="num">Netto</th><th class="num">Steuer</th><th class="num">Brutto</th></tr></thead><tbody>${d.vat.map((v) => `<tr><td>${v.satz} %</td><td class="num">${euro(v.netto)}</td><td class="num">${euro(v.steuer)}</td><td class="num">${euro(v.brutto)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card" style="margin-top:14px"><h2>Nach Artikel</h2><div class="table-wrap"><table class="data"><thead><tr><th>Artikel</th><th class="num">Menge</th><th class="num">Umsatz</th></tr></thead><tbody>${d.byArticle.map((a) => `<tr><td>${esc(a.article_name)}</td><td class="num">${a.qty}</td><td class="num">${euro(a.total)}</td></tr>`).join('')}</tbody></table></div></div>`;
  };
  const loadClosings = async () => {
    const cl = await api.get('/api/admin/closings');
    $('#cl').innerHTML = cl.map((c) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><b>${fmtDT(c.to_ts, false)}</b> · ${esc(c.closed_by_name)} · Umsatz <b>${euro(c.data.total)}</b>
      <div class="small muted">${fmtDT(c.from_ts, false)} – ${fmtDT(c.to_ts, false)} · Belege ${esc(c.data.rechnungen?.erste || '–')} bis ${esc(c.data.rechnungen?.letzte || '–')} · Stornos ${c.data.stornos.n} (${euro(c.data.stornos.v)}) · Rabatte ${euro(c.data.rabatte)}</div>
      <div class="small muted">${c.data.byMethod.map((m) => `${esc(m.method)} ${euro(m.total)}`).join(' · ')} · Protokollstand #${c.audit_seq}</div>
      ${can('manage') && c.id === cl[cl.length - 1].id ? `<button class="btn sm danger" data-delclose="${c.id}" style="margin-top:6px">Diesen (ältesten) Abschluss mit allen Einzelheiten löschen</button>` : ''}</div>`).join('') || '<span class="muted">Noch keine Tagesabschlüsse</span>';
    $$('[data-delclose]').forEach((b) => b.addEventListener('click', () => deleteClosing(Number(b.dataset.delclose), loadClosings)));
    const sh = await api.get('/api/admin/shifts?limit=50');
    $('#sh').innerHTML = sh.map((s) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><b>${esc(s.user_name)}</b> ${s.ended_at ? '<span class="badge">abgeschlossen</span>' : '<span class="badge ok">läuft</span>'}
      <div class="small muted">${fmtDT(s.started_at, false)} – ${s.ended_at ? fmtDT(s.ended_at, false) : 'jetzt'} · Umsatz ${euro(s.report.umsatz)} · ${Object.entries(s.report.nach_zahlungsart).map(([k, v]) => `${esc(k)} ${euro(v)}`).join(' · ')} · Stornos ${s.report.stornos}</div>
      ${!s.ended_at && can('day_close') ? `<button class="btn sm" data-shclose="${s.user_id}">Schicht abschließen</button>` : ''}</div>`).join('') || '<span class="muted">Keine Schichten</span>';
    $$('[data-shclose]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Schicht abschließen', 'Schichtabrechnung dieses Mitarbeiters jetzt unveränderbar abschließen?', 'Abschließen', 'warn'))) return;
      try { await api.post('/api/admin/shifts/close', { user_id: Number(b.dataset.shclose) }); toast('Schicht abgeschlossen', 'ok'); loadClosings(); } catch (e) { toast(e.message, 'error'); }
    }));
  };
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('#dclose')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Tagesabschluss', 'Alle Vorgänge seit dem letzten Tagesabschluss werden zusammengefasst und unveränderbar gespeichert.', 'Tagesabschluss erstellen', 'warn'))) return;
    try { const r = await api.post('/api/admin/closings', {}); toast(`Tagesabschluss gespeichert: ${euro(r.data.total)}`, 'ok'); loadClosings(); } catch (e) { toast(e.message, 'error'); }
  });
  await Promise.all([load(), loadClosings()]);
};

VIEWS.sollist = async (el) => {
  el.innerHTML = `<div class="head"><h1>Soll-Ist-Kontrolle (Lager)</h1><span id="exp"></span></div>
    <div class="notice info" style="margin-bottom:12px">Buchen Sie hier jede Warenentnahme aus dem Lager (z. B. 24 Flaschen Cola an die Theke). Das System vergleicht mit den tatsächlich abgerechneten Artikeln. <b>Differenz</b> = entnommen − verkauft − noch auf offenen Tischen. Eine positive Differenz bedeutet: Ware ist weg, aber nicht verbucht (oder Bruch/Schwund).</div>
    ${can('stock') ? `<div class="card"><h2>Warenbewegung buchen</h2><form class="filters" id="sf" style="margin:0"><label>Artikel<select name="article_id">${META.articles.filter((a) => a.active).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
      <label>Menge (Stück)<input type="number" name="qty" min="1" required></label><label>Art<select name="kind"><option value="entnahme">Entnahme aus Lager</option><option value="rueckgabe">Rückgabe ins Lager</option></select></label>
      <label>Notiz<input type="text" name="note" maxlength="200"></label><button class="btn primary">Buchen</button></form></div>` : ''}
    <form class="filters" id="f" style="margin-top:14px">${rangeInputs()}<button class="btn primary">Anzeigen</button></form><div id="res"></div>`;
  const getQ = () => clean(formVals($('#f')));
  $('#exp').append(exportButtons('stock', getQ));
  const load = async () => {
    const d = await api.get(`/api/admin/stock?${new URLSearchParams(getQ())}`);
    $('#res').innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Artikel</th><th>Kategorie</th><th class="num">Entnommen</th><th class="num">Verkauft</th><th class="num">Noch offen</th><th class="num">Storniert</th><th class="num">Differenz</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.category)}</td><td class="num">${r.entnommen}</td><td class="num">${r.verkauft}</td><td class="num">${r.offen}</td><td class="num">${r.storniert}</td>
        <td class="num ${r.differenz > 0 ? 'diff-neg' : r.differenz < 0 ? 'diff-pos' : ''}">${r.differenz > 0 ? '+' : ''}${r.differenz}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Keine Lagerartikel – Artikel in der Verwaltung als „Lagerartikel“ markieren oder eine Entnahme buchen.</td></tr>'}</tbody></table></div>
      <div class="card" style="margin-top:14px"><h2>Buchungen im Zeitraum</h2>${d.movements.map((m) => `<div class="small" style="padding:3px 0">${fmtDT(m.ts)} · <b>${m.kind === 'entnahme' ? '+' : '−'}${m.qty} ${esc(m.article_name)}</b> · ${esc(m.user_name)}${m.note ? ' · ' + esc(m.note) : ''}</div>`).join('') || '<span class="muted">Keine</span>'}</div>`;
  };
  $('#sf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formVals($('#sf'));
    try { await api.post('/api/admin/stock', { article_id: Number(v.article_id), qty: Number(v.qty), kind: v.kind, note: v.note }); toast('Gebucht', 'ok'); $('#sf [name=qty]').value = ''; load(); } catch (er) { toast(er.message, 'error'); }
  });
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
};

// ---- Verwaltung ----------------------------------------------------------------------
VIEWS.verwaltung = async (el) => {
  const tab = qs().get('tab') || 'artikel';
  const T = [['artikel', 'Artikel'], ['kategorien', 'Kategorien'], ['tische', 'Tische'], ['benutzer', 'Benutzer'], ['rollen', 'Rollen & Rechte'], ['einstellungen', 'Einstellungen']];
  el.innerHTML = `<div class="head"><h1>Verwaltung</h1></div>${!can('manage') ? '<div class="notice">Nur lesender Zugriff – Änderungen erfordern das Recht „Verwaltung“.</div>' : ''}
    <div class="tabs">${T.map(([k, l]) => `<a class="chip ${k === tab ? 'on' : ''}" href="#verwaltung?tab=${k}">${l}</a>`).join('')}</div>
    <p class="small muted">Jede Änderung wird mit Vorher/Nachher im Protokoll als Admin-Eingriff gespeichert. Löschen ist nicht möglich – nur Deaktivieren.</p><div id="vw"></div>`;
  META = await api.get('/api/admin/meta');
  const box = $('#vw');
  const reload = () => route();
  if (can('manage') && !META.categories.length && !META.tables.length) {
    const n = h(`<div class="notice info" style="margin-bottom:12px">Noch keine Artikel und Tische angelegt. Zum Ausprobieren können Beispieldaten geladen werden
      (Getränke, Speisen, 23 Tische und drei Test-Benutzer: Nr. 2 Schichtleitung PIN 2222, Nr. 10 und 11 Mitarbeiter PIN 1010 / 1111).
      <div style="margin-top:8px"><button class="btn sm primary" id="demo">Beispieldaten laden</button></div></div>`);
    $('#vw').before(n);
    $('#demo', n).addEventListener('click', async () => {
      try { await api.post('/api/admin/demo-data', {}); toast('Beispieldaten geladen', 'ok'); reload(); } catch (e) { toast(e.message, 'error'); }
    });
  }
  const saveForm = (title, fields, values, onSave) => {
    const body = h(`<div class="fields">${fields.map((f) => {
      const v = values[f.k] ?? f.def ?? '';
      if (f.type === 'select') return `<label class="field">${f.l}<select name="${f.k}">${f.opts.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(v) === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select></label>`;
      if (f.type === 'check') return `<label class="field"><span>${f.l}</span><input type="checkbox" name="${f.k}" ${v ? 'checked' : ''} style="width:22px;height:22px"></label>`;
      return `<label class="field">${f.l}<input type="${f.type || 'text'}" name="${f.k}" value="${esc(v)}" ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}></label>`;
    }).join('')}</div>`);
    modal({ title, body, actions: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async () => { await onSave(formVals(body)); toast('Gespeichert (protokolliert)', 'ok'); reload(); } }] });
  };
  const addBtn = (lbl, fn) => { if (!can('manage')) return; const b = h(`<button class="btn primary" style="margin-bottom:10px">${lbl}</button>`); b.addEventListener('click', fn); box.prepend(b); };

  if (tab === 'artikel') {
    const catName = (id) => META.categories.find((c) => c.id === id)?.name || '';
    const F = [{ k: 'name', l: 'Name' }, { k: 'category_id', l: 'Kategorie', type: 'select', opts: META.categories.map((c) => [c.id, c.name]) },
      { k: 'price', l: 'Preis (€)', ph: '3,80' }, { k: 'vat', l: 'MwSt-Satz', type: 'select', opts: [[19, '19 %'], [7, '7 %'], [0, '0 %']] },
      { k: 'plu', l: 'Artikelnummer (optional)', type: 'number' }, { k: 'sort', l: 'Sortierung', type: 'number', def: 0 },
      { k: 'track_stock', l: 'Lagerartikel (Soll-Ist)', type: 'check' }, { k: 'active', l: 'Aktiv', type: 'check', def: 1 }];
    const save = (id) => async (v) => {
      const price = parseEuro(v.price);
      if (price == null || Number.isNaN(price)) throw new Error('Ungültiger Preis');
      const b = { ...v, price, category_id: Number(v.category_id), vat: Number(v.vat), plu: v.plu || null, track_stock: !!v.track_stock, active: !!v.active };
      if (id) await api.put(`/api/admin/articles/${id}`, b); else await api.post('/api/admin/articles', b);
    };
    box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Nr.</th><th>Artikel</th><th>Kategorie</th><th class="num">Preis</th><th>MwSt</th><th>Lager</th><th>Status</th></tr></thead><tbody>
      ${META.articles.map((a) => `<tr class="click" data-id="${a.id}"><td>${a.plu ?? ''}</td><td><b>${esc(a.name)}</b></td><td>${esc(catName(a.category_id))}</td><td class="num">${euro(a.price)}</td><td>${a.vat} %</td><td>${a.track_stock ? '✓' : ''}</td><td>${a.active ? '<span class="badge ok">aktiv</span>' : '<span class="badge">inaktiv</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    addBtn('+ Artikel', () => saveForm('Neuer Artikel', F, {}, save(null)));
    if (can('manage')) $$('[data-id]', box).forEach((tr) => tr.addEventListener('click', () => { const a = META.articles.find((x) => x.id === Number(tr.dataset.id)); saveForm(`Artikel bearbeiten: ${a.name}`, F, { ...a, price: num(a.price) }, save(a.id)); }));
  }
  if (tab === 'kategorien') {
    const F = [{ k: 'name', l: 'Name' }, { k: 'kind', l: 'Art', type: 'select', opts: [['speise', 'Speisen'], ['getraenk', 'Getränke'], ['sonstiges', 'Sonstiges']] },
      { k: 'color', l: 'Farbe', type: 'color', def: '#3b82f6' }, { k: 'sort', l: 'Sortierung', type: 'number', def: 0 }, { k: 'active', l: 'Aktiv', type: 'check', def: 1 }];
    const save = (id) => async (v) => { const b = { ...v, sort: Number(v.sort || 0), active: !!v.active }; if (id) await api.put(`/api/admin/categories/${id}`, b); else await api.post('/api/admin/categories', b); };
    box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Kategorie</th><th>Art</th><th>Farbe</th><th>Status</th></tr></thead><tbody>
      ${META.categories.map((c) => `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.kind)}</td><td><span style="display:inline-block;width:18px;height:18px;border-radius:4px;background:${esc(c.color)}"></span></td><td>${c.active ? '<span class="badge ok">aktiv</span>' : '<span class="badge">inaktiv</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    addBtn('+ Kategorie', () => saveForm('Neue Kategorie', F, {}, save(null)));
    if (can('manage')) $$('[data-id]', box).forEach((tr) => tr.addEventListener('click', () => { const c = META.categories.find((x) => x.id === Number(tr.dataset.id)); saveForm(`Kategorie: ${c.name}`, F, c, save(c.id)); }));
  }
  if (tab === 'tische') {
    const F = [{ k: 'number', l: 'Tischnummer', type: 'number' }, { k: 'name', l: 'Bezeichnung (optional)' }, { k: 'area', l: 'Bereich', def: 'Gastraum' },
      { k: 'seats', l: 'Plätze', type: 'number', def: 4 }, { k: 'active', l: 'Aktiv', type: 'check', def: 1 }];
    const save = (id) => async (v) => { const b = { ...v, number: Number(v.number), seats: Number(v.seats || 0), active: !!v.active }; if (id) await api.put(`/api/admin/tables/${id}`, b); else await api.post('/api/admin/tables', b); };
    box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Tisch</th><th>Bezeichnung</th><th>Bereich</th><th>Plätze</th><th>Status</th></tr></thead><tbody>
      ${META.tables.map((t) => `<tr class="click" data-id="${t.id}"><td><b>${t.number}</b></td><td>${esc(t.name || '')}</td><td>${esc(t.area)}</td><td>${t.seats}</td><td>${t.active ? '<span class="badge ok">aktiv</span>' : '<span class="badge">inaktiv</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    addBtn('+ Tisch', () => saveForm('Neuer Tisch', F, {}, save(null)));
    if (can('manage')) $$('[data-id]', box).forEach((tr) => tr.addEventListener('click', () => { const t = META.tables.find((x) => x.id === Number(tr.dataset.id)); saveForm(`Tisch ${t.number}`, F, t, save(t.id)); }));
  }
  if (tab === 'benutzer') {
    if (!can('manage')) { box.innerHTML = '<div class="muted">Keine Berechtigung</div>'; return; }
    const users = await api.get('/api/admin/users');
    const F = (isNew) => [{ k: 'personal_nr', l: 'Personalnummer', type: 'number' }, { k: 'name', l: 'Name' },
      { k: 'role', l: 'Rolle', type: 'select', opts: META.roles.map((r) => [r.code, r.name]) },
      { k: 'pin', l: isNew ? 'PIN (Mitarbeiter ≥ 4, Admin ≥ 6 Ziffern)' : 'Neue PIN (leer = unverändert)', type: 'password' }, { k: 'active', l: 'Aktiv', type: 'check', def: 1 }];
    const save = (id) => async (v) => { const b = { ...v, personal_nr: Number(v.personal_nr), active: !!v.active }; if (!b.pin) delete b.pin; if (id) await api.put(`/api/admin/users/${id}`, b); else await api.post('/api/admin/users', b); };
    box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Nr.</th><th>Name</th><th>Rolle</th><th>Seit</th><th>Status</th></tr></thead><tbody>
      ${users.map((u) => `<tr class="click" data-id="${u.id}"><td><b>${u.personal_nr}</b></td><td>${esc(u.name)}</td><td>${esc(META.roles.find((r) => r.code === u.role)?.name || u.role)}</td><td>${fmtDate(u.created_at)}</td>
        <td>${u.active ? '<span class="badge ok">aktiv</span>' : '<span class="badge">deaktiviert</span>'}${u.locked_until && u.locked_until > new Date().toISOString() ? ' <span class="badge danger">gesperrt</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    addBtn('+ Benutzer', () => saveForm('Neuer Benutzer', F(true), {}, save(null)));
    $$('[data-id]', box).forEach((tr) => tr.addEventListener('click', () => { const u = users.find((x) => x.id === Number(tr.dataset.id)); saveForm(`Benutzer: ${u.name}`, F(false), u, save(u.id)); }));
  }
  if (tab === 'rollen') {
    const P = META.permissions;
    box.innerHTML = `<div class="card"><div class="perm-grid"><div class="hd">Recht</div>${META.roles.map((r) => `<div class="hd" style="text-align:center">${esc(r.name)}</div>`).join('')}
      ${Object.entries(P).map(([k, l]) => `<div>${esc(l)}</div>${META.roles.map((r) => `<div style="text-align:center"><input type="checkbox" data-r="${r.code}" data-p="${k}" ${r.permissions.includes(k) ? 'checked' : ''} ${can('manage') ? '' : 'disabled'} style="width:20px;height:20px"></div>`).join('')}`).join('')}</div>
      ${can('manage') ? '<div style="margin-top:12px"><button class="btn primary" id="saveRoles">Rechte speichern</button></div>' : ''}</div>`;
    $('#saveRoles')?.addEventListener('click', async () => {
      try {
        for (const r of META.roles) {
          const perms = $$(`[data-r="${r.code}"]`, box).filter((c) => c.checked).map((c) => c.dataset.p);
          if (JSON.stringify(perms.slice().sort()) !== JSON.stringify(r.permissions.slice().sort())) await api.put(`/api/admin/roles/${r.code}`, { permissions: perms });
        }
        toast('Rechte gespeichert (protokolliert)', 'ok'); reload();
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  if (tab === 'einstellungen') {
    const s = META.settings;
    const G = [
      ['Betrieb (Rechnungskopf)', [['business_name', 'Name'], ['business_address', 'Adresse'], ['business_tax_id', 'Steuernummer / USt-IdNr.'], ['business_day_start_hour', 'Geschäftstag beginnt um (Uhr)', 'number']]],
      ['Freigaben', [['storno_approval_always', 'Jede Stornierung braucht Freigabe (1 = ja)', 'number'], ['storno_approval_min_value', 'Storno-Freigabe ab Wert (Cent, 0 = aus)', 'number'],
        ['storno_approval_after_minutes', 'Storno-Freigabe, wenn Artikel älter als (Min., 0 = aus)', 'number'], ['reopen_requires_approval', 'Wiedereröffnung braucht Freigabe (1/0)', 'number'],
        ['price_change_requires_approval', 'Preisänderung braucht Freigabe (1/0)', 'number'], ['discount_requires_approval', 'Rabatt braucht Freigabe (1/0)', 'number'], ['move_requires_reason', 'Verschiebung nur mit Grund (1/0)', 'number']]],
      ['Kasse', [['auto_logout_minutes', 'Automatische Abmeldung nach (Min., 0 = aus)', 'number'], ['payment_methods', 'Zahlungsarten (kommagetrennt)', 'list']]],
      ['Warnsystem (Schwellen)', [['alert_storno_count_day', 'Stornos je Mitarbeiter/Tag', 'number'], ['alert_storno_ratio_percent', 'Stornoquote in %', 'number'], ['alert_quick_storno_seconds', 'Sofort-Storno: innerhalb Sekunden', 'number'],
        ['alert_quick_storno_count', 'Sofort-Stornos je Tag', 'number'], ['alert_storno_before_close_minutes', 'Storno vor Abschluss: Minuten', 'number'], ['alert_moves_count_day', 'Verschiebungen je Tag', 'number'],
        ['alert_reopen_count_day', 'Wiedereröffnungen je Tag', 'number'], ['alert_price_changes_day', 'Preisänderungen je Tag', 'number'], ['alert_close_storno_count', 'Abschluss mit ≥ Stornos', 'number'],
        ['alert_close_storno_share_percent', 'Abschluss: Stornoanteil ≥ %', 'number'], ['alert_discount_percent', 'Rabatt ab %', 'number']]],
    ];
    box.innerHTML = `<form id="sf">${G.map(([g, fs]) => `<div class="card"><h2>${g}</h2><div class="fields">${fs.map(([k, l, t]) => `<label class="field">${l}<input type="${t === 'number' ? 'number' : 'text'}" name="${k}" value="${esc(t === 'list' ? s[k].join(', ') : s[k])}" ${can('manage') ? '' : 'disabled'}></label>`).join('')}</div></div>`).join('')}
      ${can('manage') ? '<button class="btn primary" style="margin-top:12px">Einstellungen speichern</button>' : ''}</form>`;
    $('#sf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formVals($('#sf'));
      const out = {};
      for (const [, fs] of G) for (const [k, , t] of fs) out[k] = t === 'number' ? Number(v[k]) : t === 'list' ? v[k].split(',').map((x) => x.trim()).filter(Boolean) : v[k];
      try { const r = await api.put('/api/admin/settings', out); toast(r.changed ? `${r.changed} Einstellung(en) gespeichert` : 'Keine Änderung', 'ok'); reload(); } catch (er) { toast(er.message, 'error'); }
    });
  }
};

VIEWS.integritaet = async (el) => {
  el.innerHTML = '<div class="head"><h1>Manipulationsschutz</h1></div><div class="muted">Prüfe gesamte Hash-Kette …</div>';
  const r = await api.get('/api/admin/integrity');
  el.innerHTML = `<div class="head"><h1>Manipulationsschutz</h1><button class="btn" id="anc">Sicherungsanker jetzt</button><button class="btn primary" id="again">Erneut prüfen</button></div>
    <div class="card"><div class="ok-big" style="color:${r.ok ? 'var(--ok)' : 'var(--danger)'}">${r.ok ? '✓ Keine Manipulation festgestellt' : `✗ ${r.problems.length} Auffälligkeit(en) gefunden`}</div>
      <p class="muted small">Geprüft ${fmtDT(r.checked_at)}: ${r.events} Protokolleinträge, ${r.invoices} Rechnungen, ${r.journal} Journaleinträge, ${r.triggers} Schutz-Trigger.</p>
      ${r.problems.map((p) => `<div class="notice danger" style="margin-top:6px"><b>${esc(p.art)}:</b> ${esc(p.text)}</div>`).join('')}
      <dl class="kv" style="margin-top:12px"><dt>Letztes Ereignis</dt><dd>#${r.last_seq}</dd><dt>Aktueller Ketten-Hash</dt><dd class="mono">${esc(r.last_hash)}</dd></dl></div>
    <div class="card"><h2>So funktioniert der Schutz</h2><ul style="margin:0;padding-left:20px;line-height:1.7">
      <li>Jede Aktion wird sofort in der Datenbank im Gerät gespeichert – Änderung und Protokolleintrag immer gemeinsam (alles oder nichts).</li>
      <li>Fortlaufende Ereignisnummern; jeder Eintrag enthält den <b>SHA-256-Hash</b> des Vorgängers. Jede nachträgliche Änderung bricht die Kette.</li>
      <li>Die <b>Datenbank selbst</b> verweigert Änderungen und Löschungen im Protokoll, an Rechnungen, Stornos, Verschiebungen und Positionen (Trigger) – auch für Administratoren.</li>
      <li>Ein <b>Änderungsjournal</b> zeichnet jede Zeilenänderung automatisch auf. Änderungen, die nicht über die Kassensoftware erfolgen, werden hier gemeldet.</li>
      <li><b>Sicherungsanker</b> (Ereignisnummer + Hash): Wer sich den aktuellen Hash gelegentlich notiert oder fotografiert, kann später auch eine komplette Neuberechnung der Kette erkennen.</li>
      <li>Alte Tagesabschlüsse lassen sich nur kontrolliert löschen (ältester zuerst, mit Bestätigung). Die Prüfung beginnt dann am Ende des gelöschten Zeitraums; die Löschung selbst bleibt im Protokoll.</li></ul></div>
    <div class="cols"><div class="card"><h2>Sicherungsanker</h2>${r.anchors.map((a) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--border)">${fmtDT(a.ts)} · Ereignis #${a.seq} · ${esc(a.kind)}<br><span class="mono">${esc(a.hash)}</span></div>`).join('') || '<span class="muted">Noch keine</span>'}</div>
    <div class="card"><h2>Gelöschte Zeiträume</h2>${r.purges.map((p) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--border)"><b>${fmtDT(p.from_ts, false)} – ${fmtDT(p.to_ts, false)}</b><br>gelöscht am ${fmtDT(p.ts)} von ${esc(p.user_name)} · ${p.counts.protokolleintraege} Protokolleinträge, ${p.counts.rechnungen} Rechnungen, ${p.counts.stornos} Stornos</div>`).join('') || '<span class="muted">Noch nichts gelöscht</span>'}</div></div>`;
  $('#again').addEventListener('click', route);
  $('#anc').addEventListener('click', async () => { try { const a = await api.post('/api/admin/anchor', {}); toast(`Anker gesetzt: Ereignis #${a.seq}`, 'ok'); route(); } catch (e) { toast(e.message, 'error'); } });
};

if (api.token) start(); else showLogin();
