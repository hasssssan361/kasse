// Kassen-Oberfläche. Wichtig: Diese Oberfläche protokolliert NICHTS selbst – jede Aktion geht an den
// Rechenkern im Gerät, der Änderung und Protokolleintrag gemeinsam speichert. Ohne dessen Bestätigung
// wird nichts als gebucht angezeigt.
import { $, $$, esc, euro, fmtTime, fmtDT, h, Api, toast, modal, confirmDialog, debounce, parseEuro, uuid, registerOffline, APP_VERSION } from '../shared/core.js';
import { invoiceHtml } from '../shared/invoice.js';
import { planSvg } from '../shared/plan.js';

registerOffline();

const app = $('#app');
const S = {
  me: null, perms: [], settings: {}, cats: [], arts: [], tables: [], users: [],
  view: 'tables', area: null, tableId: null, data: null, sel: new Set(), cat: null, buf: '', pane: 'catalog', lastAct: Date.now(),
};
const can = (p) => S.perms.includes(p);

let deviceName = 'Kassengerät';
try { deviceName = localStorage.getItem('pos.device') || 'Kassengerät'; } catch {}

const api = new Api('pos.token', () => showLogin('Sitzung beendet – bitte erneut anmelden.'), setConn);

function setConn(ok) {
  $$('.dot').forEach((d) => d.classList.toggle('off', !ok));
  let ov = $('#offline');
  if (!ok && !ov) {
    ov = h(`<div id="offline"><div><h2>Keine Verbindung zum Server</h2><p>Eingaben werden erst nach Bestätigung durch den Server gespeichert.<br>
      Die Kasse versucht automatisch, die Verbindung wiederherzustellen …</p></div></div>`);
    document.body.append(ov);
  } else if (ok && ov) ov.remove();
}

// ---- Als App installieren ---------------------------------------------------------
// Chrome meldet über „beforeinstallprompt“, dass die Kasse installiert werden kann – dann zeigen wir
// einen eigenen Knopf. Läuft sie schon als installierte App, erscheint nichts.
let installEvent = null;
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; renderInstall(); });
addEventListener('appinstalled', () => { installEvent = null; renderInstall(true); });
function renderInstall(justInstalled) {
  const box = $('#install');
  if (!box) return;
  if (justInstalled) {
    box.innerHTML = '<div class="notice ok install-box">Installiert. Bitte die Kasse ab jetzt über das Symbol „Kasse“ auf dem Startbildschirm öffnen.</div>';
    return;
  }
  if (isInstalled()) { box.innerHTML = ''; return; }
  if (installEvent) {
    box.innerHTML = '<button class="btn primary install-box" id="instbtn">Als App installieren</button>';
    $('#instbtn').addEventListener('click', async () => {
      const ev = installEvent;
      installEvent = null;
      ev.prompt();
      const { outcome } = await ev.userChoice.catch(() => ({ outcome: 'dismissed' }));
      if (outcome !== 'accepted') renderInstall();
    });
  } else {
    box.innerHTML = `<div class="notice info install-box small">Noch nicht installiert? In <b>Chrome</b> oben rechts auf <b>⋮</b> tippen
      → <b>„App installieren“</b> (oder „Zum Startbildschirm hinzufügen“).</div>`;
  }
}

// ---- Anmeldung ---------------------------------------------------------------------
function showLogin(msg) {
  api.closeStream();
  S.me = null;
  $$('.modal-back').forEach((m) => m.remove());
  let step = 'nr';
  let nr = '';
  let pin = '';
  app.innerHTML = `<div class="login"><div class="login-card">
    <h1>Kasse</h1><div class="muted small">Mit Personalnummer und PIN anmelden</div>
    <div class="login-step" id="lstep">Personalnummer</div>
    <div class="pin-display" id="ldisp">&nbsp;</div>
    <div class="keypad" id="lpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
      <button data-k="del">⌫</button><button data-k="0">0</button><button data-k="ok" class="go">➜</button></div>
    <div class="login-err" id="lerr">${esc(msg || '')}</div>
    <a class="btn ghost admin-link" href="../admin/">Admin-Bereich</a>
    <div id="install"></div>
    <div class="muted small" style="text-align:center;margin-top:10px">Version ${APP_VERSION}</div></div></div>`;
  renderInstall();
  const disp = () => {
    $('#lstep').textContent = step === 'nr' ? 'Personalnummer' : 'PIN';
    $('#ldisp').textContent = step === 'nr' ? nr || ' ' : '•'.repeat(pin.length) || ' ';
  };
  const press = async (k) => {
    $('#lerr').textContent = '';
    if (k === 'del') { if (step === 'nr') nr = nr.slice(0, -1); else if (pin) pin = pin.slice(0, -1); else step = 'nr'; }
    else if (k === 'ok') {
      if (step === 'nr') { if (nr) step = 'pin'; }
      else {
        try {
          const r = await api.post('/api/login', { personal_nr: Number(nr), pin, device: deviceName, kind: 'kasse' }, { retries: 3 });
          api.setToken(r.token);
          document.removeEventListener('keydown', onKey);
          return start();
        } catch (e) { $('#lerr').textContent = e.message; pin = ''; }
      }
    } else if (step === 'nr' ? nr.length < 6 : pin.length < 12) { if (step === 'nr') nr += k; else pin += k; }
    disp();
  };
  const onKey = (e) => {
    if (!$('#lpad')) return document.removeEventListener('keydown', onKey);
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') press('ok');
  };
  document.addEventListener('keydown', onKey);
  $('#lpad').addEventListener('click', (e) => { const k = e.target.closest('button')?.dataset.k; if (k) press(k); });
  disp();
}

function askDevice() {
  app.innerHTML = `<div class="login"><div class="login-card"><h1>Gerät einrichten</h1>
    <p class="muted">Wie heißt dieses Gerät? Der Name erscheint im Protokoll bei jeder Aktion.</p>
    <label class="field">Gerätename<input type="text" id="dev" maxlength="40" placeholder="z. B. Kasse Theke" value="${esc(deviceName)}"></label>
    <div style="margin-top:14px"><button class="btn primary" id="devok" style="width:100%">Speichern</button></div></div></div>`;
  const ok = () => {
    const v = $('#dev').value.trim();
    if (!v) return;
    deviceName = v;
    try { localStorage.setItem('pos.device', v); } catch {}
    showLogin();
  };
  $('#devok').addEventListener('click', ok);
  $('#dev').addEventListener('keydown', (e) => e.key === 'Enter' && ok());
  $('#dev').focus();
}

// ---- Start & Grundgerüst -------------------------------------------------------
async function start() {
  try {
    const me = await api.get('/api/me');
    S.me = me.user; S.perms = me.permissions; S.settings = me.settings;
  } catch { return showLogin(); }
  await loadBoot();
  app.innerHTML = `<div class="shell">
    <header class="topbar">
      <span class="brand">${esc(S.settings.business_name)}</span>
      <nav class="nav"><button class="btn" data-nav="tables">Tische</button><button class="btn" data-nav="invoices">Rechnungen</button></nav>
      <div class="mobile-switch hidden" id="mswitch"><button class="btn sm" data-pane="catalog">Artikel</button><button class="btn sm" data-pane="ticket">Bestellung</button></div>
      <span class="clock" id="clock"></span>
      <div class="userchip"><span class="dot"></span><b>${esc(S.me.name)}</b>
        <button class="icon-btn" id="umenu" title="Menü" aria-label="Menü">☰</button>
        <button class="btn sm danger" id="logout">Abmelden</button></div>
    </header><main class="view" id="view"></main></div>`;
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  $$('#mswitch [data-pane]').forEach((b) => b.addEventListener('click', () => { S.pane = b.dataset.pane; const ov = $('.order-view'); if (ov) ov.dataset.pane = S.pane; }));
  $('#logout').addEventListener('click', () => doLogout('Abmeldung'));
  $('#umenu').addEventListener('click', userMenu);
  tick();
  api.stream({ event: onServerEvent });
  go('tables');
}

async function loadBoot() {
  const b = await api.get('/api/pos/bootstrap');
  S.cats = b.categories; S.arts = b.articles; S.variants = b.variants || []; S.tables = b.tables; S.plan = b.plan || { areas: [] }; S.users = b.users; S.settings = b.settings;
  if (!S.cats.find((c) => c.id === S.cat)) S.cat = S.cats[0]?.id ?? null;
}

function tick() {
  const c = $('#clock');
  if (c) c.textContent = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
  const lim = (S.settings.auto_logout_minutes || 0) * 60000;
  if (S.me && lim > 0 && Date.now() - S.lastAct > lim && !$('.modal-back')) return doLogout(`Inaktivität (${S.settings.auto_logout_minutes} Min.)`);
  setTimeout(tick, 1000);
}
['pointerdown', 'keydown'].forEach((t) => document.addEventListener(t, () => { S.lastAct = Date.now(); }, { passive: true }));

async function doLogout(reason) {
  try { await api.post('/api/logout', { reason }, { retries: 2 }); } catch {}
  api.setToken(null);
  showLogin(reason === 'Abmeldung' ? '' : `Automatisch abgemeldet: ${reason}`);
}

function go(view, tableId) {
  S.view = view;
  if (tableId !== undefined) S.tableId = tableId;
  $$('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === view || (view === 'order' && b.dataset.nav === 'tables')));
  $('#mswitch')?.classList.toggle('hidden', view !== 'order');
  if (view === 'tables') renderTables();
  if (view === 'order') loadOrder();
  if (view === 'invoices') renderInvoices();
}

const refreshTables = debounce(async () => { S.tables = await api.get('/api/pos/tables'); if (S.view === 'tables') renderTables(); }, 250);
const refreshOrder = debounce(() => { if (S.view === 'order') loadOrder(true); }, 200);
function onServerEvent(ev) {
  if (/^(ARTICLE|CATEGORY|TABLE_CREATED|TABLE_UPDATED|SETTINGS|PLAN)/.test(ev.type)) { loadBoot().then(() => { if (S.view === 'order') renderCatalog(); else if (S.view === 'tables') renderTables(); }); return; }
  refreshTables();
  const t = S.tables.find((x) => x.id === S.tableId);
  if (S.view === 'order' && t && (ev.table_no === t.number || ev.target_table_no === t.number || (S.data?.order && ev.order_id === S.data.order.id))) refreshOrder();
}

// ---- Tische -----------------------------------------------------------------------
function renderTables() {
  if (!S.tables.length) {
    $('#view').innerHTML = `<div class="tables-view"><div class="empty">Noch keine Tische angelegt.<br>
      Bitte im <b>Admin-Bereich</b> unter Verwaltung Tische und Artikel anlegen (oder Beispieldaten laden).<br><br>
      <a class="btn primary" href="../admin/#verwaltung">Zum Admin-Bereich</a></div></div>`;
    return;
  }
  // Bereiche: zuerst die aus dem Tischplan (in dessen Reihenfolge), dann weitere aus der Tischliste
  const planAreas = (S.plan?.areas || []).filter((a) => a.elements.length);
  const areas = [...new Set([...planAreas.map((a) => a.name), ...S.tables.map((t) => t.area)])];
  if (!areas.includes(S.area)) S.area = areas[0];
  const pa = planAreas.find((a) => a.name === S.area);
  let mode = 'plan';
  try { mode = localStorage.getItem('kasse_plan_mode') || 'plan'; } catch {}
  const usePlan = pa && mode === 'plan';
  const v = $('#view');
  const mineCount = S.tables.filter((t) => t.waiter_id === S.me.id).length;
  const cls = (t) => (!t.order_id ? 'free' : t.waiter_id === S.me.id ? 'mine' : 'other');
  const tile = (t) => `<button class="ttile ${cls(t)}" data-t="${t.id}"><span class="no">${t.number}</span><span class="nm">${esc(t.name || t.seats + ' Plätze')}</span>
        ${t.order_id ? `<span class="meta">${esc(t.waiter_name)} · seit ${fmtTime(t.opened_at, false)}${t.reopen_count ? ' · <b>wiedereröffnet</b>' : ''}</span>
        <span class="sum">${euro(t.open_total)}</span>` : '<span class="sum">frei</span>'}</button>`;
  const inArea = S.tables.filter((t) => t.area === S.area);
  let body;
  if (usePlan) {
    const byNo = new Map(S.tables.map((t) => [t.number, t]));
    const planned = new Set(pa.elements.flatMap((e) => (e.type === 'table' ? [e.number] : e.type === 'counter' ? Array.from({ length: e.seat_count || 0 }, (_, i) => e.seat_start + i) : [])));
    const status = (n) => { const t = byNo.get(n); return !t ? { cls: 'none', sub: '' } : { cls: cls(t), sub: t.order_id ? euro(t.open_total) : '' }; };
    const rest = inArea.filter((t) => !planned.has(t.number));
    body = `<div class="plan-wrap"><div id="kplan">${planSvg(pa, { status, crop: true })}</div></div>
      ${rest.length ? `<h3 class="small muted" style="margin:14px 0 8px">Weitere Tische (nicht im Plan)</h3><div class="tgrid">${rest.map(tile).join('')}</div>` : ''}`;
  } else body = `<div class="tgrid">${inArea.map(tile).join('')}</div>`;
  v.innerHTML = `<div class="tables-view">
    <div class="areas">${areas.map((a) => `<button class="chip ${a === S.area ? 'on' : ''}" data-area="${esc(a)}">${esc(a)}
      <span class="badge">${S.tables.filter((t) => t.area === a && t.order_id).length}</span></button>`).join('')}
      ${pa ? `<span class="row" style="gap:4px"><button class="chip ${usePlan ? 'on' : ''}" data-mode="plan">Plan</button><button class="chip ${usePlan ? '' : 'on'}" data-mode="list">Liste</button>
        ${usePlan ? '<button class="chip" data-zoom="-1" aria-label="Verkleinern">−</button><button class="chip" data-zoom="1" aria-label="Vergrößern">+</button>' : ''}</span>` : ''}
      <div class="legend"><span><i style="background:var(--ok)"></i>meine Tische (${mineCount})</span><span><i style="background:var(--warn)"></i>Kollegen</span><span><i style="background:var(--surface-3)"></i>frei</span></div></div>
    ${body}</div>`;
  $$('[data-area]', v).forEach((b) => b.addEventListener('click', () => { S.area = b.dataset.area; renderTables(); }));
  $$('[data-mode]', v).forEach((b) => b.addEventListener('click', () => { try { localStorage.setItem('kasse_plan_mode', b.dataset.mode); } catch {} renderTables(); }));
  const openTable = (id) => { S.sel.clear(); S.buf = ''; S.pane = 'catalog'; go('order', id); };
  $$('[data-t]', v).forEach((b) => b.addEventListener('click', () => openTable(Number(b.dataset.t))));
  const svg = $('#kplan svg', v);
  if (svg) {
    // Auf schmalen Bildschirmen (Handy) größer starten, damit die Tische gut antippbar sind – seitlich wischen
    S.planZoom = S.planZoom || (svg.parentElement.clientWidth < 600 ? 2 : 1);
    svg.style.width = `${S.planZoom * 100}%`;
    $$('[data-zoom]', v).forEach((b) => b.addEventListener('click', () => { S.planZoom = Math.min(4, Math.max(1, S.planZoom + Number(b.dataset.zoom) * 0.5)); svg.style.width = `${S.planZoom * 100}%`; }));
    svg.addEventListener('click', (ev) => {
      const g = ev.target.closest('[data-n]');
      if (!g) return;
      const t = S.tables.find((x) => x.number === Number(g.dataset.n));
      if (!t) return toast(`Platz ${g.dataset.n} ist noch nicht angelegt – bitte den Tischplan im Admin-Bereich speichern`, 'error');
      openTable(t.id);
    });
  }
}

// ---- Bestellung ------------------------------------------------------------------
async function loadOrder(keepSel) {
  try {
    S.data = await api.get(`/api/pos/tables/${S.tableId}`);
  } catch (e) { toast(e.message, 'error'); return go('tables'); }
  if (!keepSel) S.sel.clear();
  for (const id of [...S.sel]) if (!S.data.items.find((i) => i.id === id && i.open_qty > 0)) S.sel.delete(id);
  if (!$('.order-view')) renderOrderShell();
  renderTicket();
}

function renderOrderShell() {
  $('#view').innerHTML = `<div class="order-view" data-pane="${S.pane}">
    <section class="catalog"><div class="cats" id="cats"></div><div class="agrid" id="arts"></div>
      <div class="padbar"><span class="qty-display" id="qd">Menge 1</span>
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => `<button class="d" data-d="${d}">${d}</button>`).join('')}
        <button class="btn sm" id="pclr">C</button><button class="btn sm" id="plu" title="Artikel über Artikelnummer">Art.-Nr.</button></div></section>
    <section class="ticket"><div class="ticket-head" id="thead"></div><div class="lines" id="lines"></div>
      <div class="total" id="ttotal"></div><div class="actions" id="tact"></div></section></div>`;
  $$('.padbar [data-d]').forEach((b) => b.addEventListener('click', () => { if (S.buf.length < 4) S.buf += b.dataset.d; showBuf(); }));
  $('#pclr').addEventListener('click', () => { S.buf = ''; showBuf(); });
  $('#plu').addEventListener('click', () => {
    if (!S.buf) return toast('Erst die Artikelnummer eintippen, dann „Art.-Nr.“ drücken');
    const a = S.arts.find((x) => x.plu === Number(S.buf));
    if (!a) { toast(`Keine Artikelnummer ${S.buf}`, 'error'); S.buf = ''; return showBuf(); }
    const raw = `Art.-Nr. ${S.buf}`;
    S.buf = '';
    showBuf();
    addArticle(a, 1, raw);
  });
  renderCatalog();
}

function showBuf() {
  const q = $('#qd');
  if (!q) return;
  q.textContent = S.buf ? `${S.buf} ×` : 'Menge 1';
  q.classList.toggle('armed', !!S.buf);
}

function renderCatalog() {
  if (!$('#cats')) return;
  $('#cats').innerHTML = S.cats.map((c) => `<button class="cat ${c.id === S.cat ? 'on' : ''}" style="--c:${esc(c.color)}" data-c="${c.id}">${esc(c.name)}</button>`).join('');
  const cat = S.cats.find((c) => c.id === S.cat);
  $('#arts').innerHTML = S.arts.filter((a) => a.category_id === S.cat).map((a) => {
    const vs = variantsOf(a.id);
    return `<button class="art" style="--c:${esc(cat?.color || '')}" data-a="${a.id}">
      <span class="an">${esc(a.name)}${vs.length ? `<span class="vc">${vs.length} Varianten</span>` : ''}</span>
      <span class="row" style="justify-content:space-between"><span class="ap">${vs.length ? 'ab ' : ''}${euro(a.price)}</span>${a.plu ? `<span class="plu">${a.plu}</span>` : ''}</span></button>`;
  }).join('') || '<div class="empty">Keine Artikel in dieser Kategorie</div>';
  $$('#cats [data-c]').forEach((b) => b.addEventListener('click', () => { S.cat = Number(b.dataset.c); renderCatalog(); }));
  $$('#arts [data-a]').forEach((b) => b.addEventListener('click', () => {
    const a = S.arts.find((x) => x.id === Number(b.dataset.a));
    const qty = S.buf ? Math.max(1, Math.min(99, Number(S.buf))) : 1;
    const raw = S.buf ? `${S.buf}×` : null;
    S.buf = '';
    showBuf();
    addArticle(a, qty, raw);
  }));
}

const variantsOf = (articleId) => (S.variants || []).filter((v) => v.article_id === articleId);

// Artikel mit Varianten (z. B. Bacardi: Shot, Longdrink, Flasche): erst Variante wählen
function addArticle(a, qty, raw) {
  const vs = variantsOf(a.id);
  if (!vs.length) return queueAdd(a, null, qty, raw);
  const m = modal({
    title: `${qty > 1 ? qty + ' × ' : ''}${a.name} – Variante wählen`,
    body: `<div class="vpick">${vs.map((v) => `<button class="vbtn" data-v="${v.id}"><b>${esc(v.name)}</b><span>${euro(v.price)}</span></button>`).join('')}</div>`,
    actions: [{ label: 'Abbrechen' }],
  });
  $$('[data-v]', m.body).forEach((b) => b.addEventListener('click', () => {
    m.close('action');
    queueAdd(a, vs.find((v) => v.id === Number(b.dataset.v)), qty, raw);
  }));
}

let adding = Promise.resolve();
function queueAdd(a, v, qty, raw) {
  // Reihenfolge garantieren, auch bei schnellem Tippen
  adding = adding.then(async () => {
    try {
      await api.post('/api/pos/items', { table_id: S.tableId, article_id: a.id, variant_id: v?.id ?? null, qty, raw_input: raw });
      toast(`${qty} × ${a.name}${v ? ` (${v.name})` : ''}`, 'ok', 1200);
      await loadOrder(true);
    } catch (e) { toast(e.message, 'error', 6000); }
  });
}

function renderTicket() {
  const d = S.data;
  const t = d.table;
  const o = d.order;
  const sw = $$('#mswitch [data-pane]');
  const openItems = d.items.filter((i) => i.open_qty > 0);
  if (sw[1]) sw[1].textContent = `Bestellung (${openItems.reduce((s, i) => s + i.open_qty, 0)})`;
  $('#thead').innerHTML = `<button class="btn sm" id="back">←</button><span class="tno">${t.name ? `${esc(t.name)} <small class="muted">Nr. ${t.number}</small>` : `Tisch ${t.number}`}</span>
    <div class="grow small muted">${o ? `${esc(o.waiter_name)} · seit ${fmtTime(o.opened_at, false)}${o.reopen_count ? ` · <span class="badge warn">${o.reopen_count}× wiedereröffnet</span>` : ''}` : 'frei'}</div>`;
  $('#back').addEventListener('click', () => go('tables'));
  const lineHtml = (i) => {
    const sub = [];
    if (i.origin_kind === 'move') { const m = d.moves.find((x) => x.target_item_id === i.id); sub.push(`von Tisch ${m ? m.from_table_no : '?'}`); }
    if (i.origin_kind === 'reopen') sub.push('wiederhergestellt');
    if (i.unit_price !== i.list_price) sub.push(`Preis geändert (Liste ${euro(i.list_price)})`);
    if (i.billed_qty) sub.push(`${i.billed_qty} bezahlt`);
    sub.push(`${fmtTime(i.created_at, false)} ${esc(i.created_by_name)}`);
    return `<div class="line ${S.sel.has(i.id) ? 'sel' : ''}" data-i="${i.id}"><span class="q">${i.open_qty}</span>
      <div><div class="n">${esc(i.article_name)}</div><div class="sub">${euro(i.unit_price)} · ${sub.join(' · ')} · ID ${i.lifecycle_id}</div></div>
      <span class="t">${euro(i.open_qty * i.unit_price)}</span></div>`;
  };
  const hist = [];
  for (const c of d.cancellations) {
    hist.push(c.kind === 'ec'
      ? `<div class="hl"><span>${c.qty}× ${esc(c.article_name)} – mit EC bezahlt (${esc(c.cancelled_by_name)}, ${fmtTime(c.cancelled_at)})</span><span>${euro(c.total)}</span></div>`
      : `<div class="hl st"><span>${c.qty}× ${esc(c.article_name)} storniert – ${esc(c.reason)} (${esc(c.cancelled_by_name)}, ${fmtTime(c.cancelled_at)})</span><span>${euro(c.total)}</span></div>`);
  }
  for (const m of d.moves) {
    const out = m.from_order_id === o?.id;
    hist.push(`<div class="hl"><span>${m.qty}× ${esc(m.article_name)} ${out ? `→ Tisch ${m.to_table_no} verschoben` : `von Tisch ${m.from_table_no} hierher verschoben`} (${esc(m.moved_by_name)}, ${fmtTime(m.moved_at)})</span><span>${euro(m.qty * m.unit_price)}</span></div>`);
  }
  for (const v of d.invoices) hist.push(`<div class="hl"><span>${v.kind === 'storno' ? 'Stornorechnung' : 'Rechnung'} ${esc(v.invoice_no)} (${esc(v.payment_method)}, ${fmtTime(v.closed_at, false)})${v.reversed ? ' – aufgehoben' : ''}</span><span>${euro(v.total)}</span></div>`);
  $('#lines').innerHTML = (openItems.length ? openItems.map(lineHtml).join('') : `<div class="empty">${o ? 'Keine offenen Artikel' : 'Tisch ist frei.<br>Artikel antippen, um den Tisch zu eröffnen.'}</div>`)
    + (hist.length ? `<details class="hist" ${d.cancellations.length ? 'open' : ''}><summary>Verlauf an diesem Tisch (${hist.length})</summary>${hist.join('')}</details>` : '');
  $$('#lines [data-i]').forEach((el) => el.addEventListener('click', () => {
    const id = Number(el.dataset.i);
    if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
    renderTicket();
  }));
  const selItems = openItems.filter((i) => S.sel.has(i.id));
  const selTotal = selItems.reduce((s, i) => s + i.open_qty * i.unit_price, 0);
  $('#ttotal').innerHTML = `<span>${selItems.length ? `${selItems.length} ausgewählt · ${euro(selTotal)}` : 'Offen'}</span><b>${euro(d.open_total)}</b>`;
  const one = selItems.length === 1 ? selItems[0] : null;
  const acts = [
    { id: 'plus', label: '+1', on: !!one && !one.billed_qty && !one.moved_qty && !one.cancelled_qty },
    { id: 'storno', label: 'Storno', kind: 'danger', on: selItems.length === 1 },
    { id: 'move', label: 'Verschieben', on: selItems.length > 0 },
    { id: 'price', label: 'Preis', on: !!one && !one.billed_qty && !one.moved_qty && !one.cancelled_qty },
    { id: 'tchange', label: 'Tischwechsel', on: !!o && openItems.length > 0 },
    { id: 'take', label: 'Übernehmen', on: !!o && o.waiter_id !== S.me.id },
  ];
  $('#tact').innerHTML = acts.map((a) => `<button class="btn ${a.kind || ''}" data-act="${a.id}" ${a.on ? '' : 'disabled'}>${a.label}</button>`).join('')
    + (o && openItems.length === 0
      ? '<button class="btn warn pay" data-act="closeempty">Tisch schließen</button>'
      : `<button class="btn ok pay" data-act="pay" ${openItems.length ? '' : 'disabled'}>${selItems.length ? `Auswahl bezahlen (${euro(selTotal)})` : 'Bezahlen'}</button>`);
  $$('#tact [data-act]').forEach((b) => b.addEventListener('click', () => ACT[b.dataset.act](selItems)));
}

// ---- Freigabe durch Schichtleitung ------------------------------------------------
function askApproval(what, err) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'Freigabe erforderlich',
      body: `<div class="notice">${esc(what || 'Diese Aktion')} muss von einer Schichtleitung oder einem Administrator freigegeben werden.</div>
        ${err ? `<div class="notice danger" style="margin-top:8px">${esc(err)}</div>` : ''}
        <div class="fields" style="margin-top:12px"><label class="field">Personalnummer<input type="text" inputmode="numeric" id="anr" autocomplete="off"></label>
        <label class="field">PIN<input type="password" inputmode="numeric" id="apin" autocomplete="off"></label></div>`,
      actions: [{ label: 'Abbrechen', onClick: () => resolve(null) },
        { label: 'Freigeben', kind: 'primary', onClick: (b) => resolve({ personal_nr: Number($('#anr', b).value), pin: $('#apin', b).value }) }],
      onClose: (r) => { if (r === 'cancel') resolve(null); },
    });
    $('#apin', m.body).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('.modal-foot .primary', m.el).click(); });
  });
}
async function withApproval(fn) {
  const idem = uuid();
  let approver = null;
  let err = null;
  for (;;) {
    try { return await fn(approver, idem); } catch (e) {
      if (!e.data?.needs_approval) throw e;
      approver = await askApproval(e.data.what, approver ? e.message : err);
      if (!approver) throw new Error('Abgebrochen – Aktion wurde nicht ausgeführt.');
      err = null;
    }
  }
}
const logAbort = (dialog, extra = {}) => api.post('/api/pos/ui-event', { dialog, table_no: S.data?.table?.number, order_id: S.data?.order?.id, ...extra }, { retries: 3 }).catch(() => {});

// Zeilen mit Mengenwahl
function picker(items, initial = (i) => i.open_qty) {
  const qty = new Map(items.map((i) => [i.id, initial(i)]));
  const el = h(`<div class="pick">${items.map((i) => `<div class="pl" data-i="${i.id}"><div><b>${esc(i.article_name)}</b><div class="small muted">${euro(i.unit_price)} · offen ${i.open_qty}</div></div>
      <div class="stepper"><button data-s="-1">−</button><span>${qty.get(i.id)}</span><button data-s="1">+</button></div></div>`).join('')}</div>`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const row = b.closest('[data-i]');
    const it = items.find((x) => x.id === Number(row.dataset.i));
    const v = Math.max(0, Math.min(it.open_qty, qty.get(it.id) + Number(b.dataset.s)));
    qty.set(it.id, v);
    $('span', row).textContent = v;
    el.dispatchEvent(new Event('change'));
  });
  el.lines = () => items.filter((i) => qty.get(i.id) > 0).map((i) => ({ item_id: i.id, qty: qty.get(i.id), item: i }));
  return el;
}

function tablePicker(excludeId, onPick) {
  const el = h(`<div class="tpick">${S.tables.filter((t) => t.id !== excludeId).map((t) => `<button data-t="${t.id}" class="${t.order_id ? 'busy' : ''}">${t.number}<small>${t.order_id ? esc(t.waiter_name.split(' ')[0]) : 'frei'}</small></button>`).join('')}</div>`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
    onPick(Number(b.dataset.t));
  });
  return el;
}

const REASONS = ['Falsch eingegeben', 'Gast hat abbestellt', 'Reklamation', 'Nicht lieferbar', 'Doppelt eingegeben'];
function reasonField(chips = REASONS, placeholder = 'Grund eingeben') {
  const el = h(`<div><div class="chips">${chips.map((r) => `<button class="chip" type="button">${esc(r)}</button>`).join('')}</div>
    <input type="text" maxlength="300" placeholder="${esc(placeholder)}" style="margin-top:8px"></div>`);
  el.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    $$('.chip', el).forEach((x) => x.classList.toggle('on', x === c));
    $('input', el).value = c.textContent;
  });
  el.value = () => $('input', el).value.trim();
  return el;
}

// ---- Aktionen ------------------------------------------------------------------
const ACT = {
  async plus([it]) {
    try { await api.post(`/api/pos/items/${it.id}/increase`, { qty: 1, raw_input: '+1' }); await loadOrder(true); } catch (e) { toast(e.message, 'error'); }
  },

  storno([it]) {
    const pk = picker([it], () => 1);
    const rf = reasonField();
    const body = h('<div></div>');
    body.append(h(`<div class="notice info">Stornierungen werden dauerhaft mit Ihrem Namen, Uhrzeit und Grund protokolliert und dem Administrator sofort angezeigt.</div>`));
    const s1 = h('<div class="section"><div class="lbl">Menge</div></div>'); s1.append(pk);
    const s2 = h('<div class="section"><div class="lbl">Stornogrund (Pflicht)</div></div>'); s2.append(rf);
    body.append(s1, s2);
    let done = false;
    modal({
      title: `Storno: ${it.article_name}`, body,
      actions: [{ label: 'Abbrechen', onClick: () => {} }, {
        label: 'Stornieren', kind: 'danger', onClick: async () => {
          const l = pk.lines()[0];
          if (!l) throw new Error('Menge wählen');
          if (rf.value().length < 3) throw new Error('Bitte einen Stornogrund angeben');
          await withApproval((approver, idem) => api.post(`/api/pos/items/${it.id}/cancel`, { qty: l.qty, reason: rf.value(), approver }, { idem }));
          done = true;
          toast(`${l.qty} × ${it.article_name} storniert`, 'warn');
          S.sel.clear();
          await loadOrder();
        },
      }],
      onClose: () => { if (!done) logAbort('storno', { item_id: it.id, article_name: it.article_name, inputs: { grund: rf.value() } }); },
    });
  },

  move(items) {
    let target = null;
    const pk = picker(items);
    const rf = reasonField(['Gast umgesetzt', 'Getrennte Rechnung', 'Falscher Tisch'], S.settings.move_requires_reason ? 'Grund (Pflicht)' : 'Grund (optional)');
    const body = h('<div></div>');
    const s1 = h('<div class="section" style="margin-top:0"><div class="lbl">Artikel & Menge</div></div>'); s1.append(pk);
    const s2 = h('<div class="section"><div class="lbl">Ziel-Tisch</div></div>'); s2.append(tablePicker(S.tableId, (id) => { target = id; }));
    const s3 = h('<div class="section"><div class="lbl">Grund</div></div>'); s3.append(rf);
    body.append(s1, s2, s3);
    let done = false;
    modal({
      title: `Artikel von Tisch ${S.data.table.number} verschieben`, body, wide: true,
      actions: [{ label: 'Abbrechen' }, {
        label: 'Verschieben', kind: 'primary', onClick: async () => {
          const lines = pk.lines();
          if (!lines.length) throw new Error('Keine Menge gewählt');
          if (!target) throw new Error('Bitte Ziel-Tisch wählen');
          const r = await api.post('/api/pos/move', { items: lines.map((l) => ({ item_id: l.item_id, qty: l.qty })), to_table_id: target, reason: rf.value() || null });
          done = true;
          const tt = S.tables.find((x) => x.id === target);
          toast(`${r.moved} Position(en) auf Tisch ${tt?.number} verschoben`, 'ok');
          S.sel.clear();
          refreshTables();
          await loadOrder();
        },
      }],
      onClose: () => { if (!done) logAbort('verschieben', { inputs: { ziel: target } }); },
    });
  },

  price([it]) {
    const body = h(`<div><div class="notice info">Preisänderungen werden protokolliert${S.settings.price_change_requires_approval && !can('price_change') ? ' und benötigen eine Freigabe' : ''}.</div>
      <div class="fields" style="margin-top:12px"><label class="field">Bisheriger Preis<input type="text" value="${euro(it.unit_price)}" disabled></label>
      <label class="field">Neuer Einzelpreis (€)<input type="text" inputmode="decimal" id="np" placeholder="z. B. 3,50"></label></div>
      <div class="section"><div class="lbl">Grund (Pflicht)</div></div></div>`);
    const rf = reasonField(['Happy Hour', 'Personalessen', 'Kulanz', 'Falscher Preis hinterlegt']);
    $('.section', body).append(rf);
    let done = false;
    modal({
      title: `Preis ändern: ${it.article_name}`, body,
      actions: [{ label: 'Abbrechen' }, {
        label: 'Preis ändern', kind: 'primary', onClick: async () => {
          const raw = $('#np', body).value;
          const np = parseEuro(raw);
          if (np == null || Number.isNaN(np) || np < 0) throw new Error('Ungültiger Preis');
          if (!rf.value()) throw new Error('Bitte einen Grund angeben');
          await withApproval((approver, idem) => api.post(`/api/pos/items/${it.id}/price`, { new_price: np, reason: rf.value(), approver, raw_input: raw }, { idem }));
          done = true;
          toast('Preis geändert', 'ok');
          await loadOrder(true);
        },
      }],
      onClose: () => { if (!done) logAbort('preis', { item_id: it.id, article_name: it.article_name, inputs: { preis: $('#np', body)?.value } }); },
    });
  },

  tchange() {
    let target = null;
    const rf = reasonField(['Gast umgesetzt', 'Tische zusammengelegt'], 'Grund (optional)');
    const body = h('<div><p class="muted" style="margin-top:0">Alle offenen Artikel wechseln auf den Ziel-Tisch. Ist er belegt, werden die Bestellungen zusammengelegt.</p></div>');
    body.append(tablePicker(S.tableId, (id) => { target = id; }));
    const s = h('<div class="section"><div class="lbl">Grund</div></div>'); s.append(rf); body.append(s);
    let done = false;
    modal({
      title: `Tischwechsel von Tisch ${S.data.table.number}`, body, wide: true,
      actions: [{ label: 'Abbrechen' }, {
        label: 'Tisch wechseln', kind: 'primary', onClick: async () => {
          if (!target) throw new Error('Bitte Ziel-Tisch wählen');
          await api.post(`/api/pos/orders/${S.data.order.id}/move-table`, { to_table_id: target, reason: rf.value() || null });
          done = true;
          toast('Tischwechsel durchgeführt', 'ok');
          refreshTables();
          go('order', target);
        },
      }],
      onClose: () => { if (!done) logAbort('tischwechsel', { inputs: { ziel: target } }); },
    });
  },

  async take() {
    if (!(await confirmDialog('Tisch übernehmen', `Tisch ${S.data.table.number} von ${S.data.order.waiter_name} übernehmen? Der Wechsel wird protokolliert.`, 'Übernehmen'))) return;
    try { await api.post(`/api/pos/orders/${S.data.order.id}/takeover`, {}); toast('Tisch übernommen', 'ok'); await loadOrder(true); } catch (e) { toast(e.message, 'error'); }
  },

  async closeempty() {
    if (!(await confirmDialog('Tisch schließen', 'Der Tisch hat keine offenen Artikel mehr. Jetzt schließen?', 'Schließen', 'warn'))) return;
    try { await api.post(`/api/pos/orders/${S.data.order.id}/close-empty`, {}); toast('Tisch geschlossen', 'ok'); go('tables'); } catch (e) { toast(e.message, 'error'); }
  },

  pay(selItems) {
    const open = S.data.items.filter((i) => i.open_qty > 0);
    const items = selItems.length ? selItems : open;
    const pk = picker(items);
    let method = null;
    let disc = { on: false, type: 'percent' };
    const body = h(`<div>
      <div class="section" style="margin-top:0"><div class="lbl">Positionen</div><div id="pk"></div></div>
      <div class="section"><div class="lbl">Zahlungsart</div><div class="chips" id="pm">${S.settings.payment_methods.map((m) => `<button class="chip" data-m="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>
      <div class="section hidden" id="cash"><div class="lbl">Gegeben (€)</div><div class="row"><input type="text" inputmode="decimal" id="given" style="max-width:160px" placeholder="optional">
        <span class="chips" id="quick"></span></div><div id="change" class="small" style="margin-top:6px"></div></div>
      <div class="section hidden notice info" id="ecinfo">Bei <b>EC-Zahlung</b> werden die Artikel storniert und mit dem Vermerk „Mit EC bezahlt“ festgehalten.</div>
      <div class="section" id="dsec"><label class="row" style="font-weight:700"><input type="checkbox" id="dOn"> Rabatt gewähren</label>
        <div id="dBox" class="hidden" style="margin-top:8px"><div class="row"><span class="chips"><button class="chip on" data-dt="percent">%</button><button class="chip" data-dt="amount">€</button></span>
          <input type="text" inputmode="decimal" id="dVal" style="max-width:120px" placeholder="Wert"><input type="text" id="dReason" class="grow" maxlength="200" placeholder="Grund (Pflicht)"></div></div></div>
      <div class="sumrow"><span>Zu zahlen</span><span id="due"></span></div></div>`);
    $('#pk', body).append(pk);
    const calc = () => {
      const lines = pk.lines();
      const sub = lines.reduce((s, l) => s + l.qty * l.item.unit_price, 0);
      let d = 0;
      if (disc.on) {
        const v = disc.type === 'percent' ? Number(String($('#dVal', body).value).replace(',', '.')) : parseEuro($('#dVal', body).value);
        if (v > 0) d = disc.type === 'percent' ? Math.round(sub * Math.min(v, 100) / 100) : Math.min(v, sub);
      }
      const due = sub - d;
      $('#due', body).innerHTML = d ? `<s class="muted small">${euro(sub)}</s> ${euro(due)}` : euro(due);
      const g = parseEuro($('#given', body).value);
      $('#change', body).innerHTML = g ? (g >= due ? `Rückgeld: <b>${euro(g - due)}</b>` : '<span style="color:var(--danger)">Betrag reicht nicht</span>') : '';
      const q = [due, Math.ceil(due / 500) * 500, Math.ceil(due / 1000) * 1000, Math.ceil(due / 2000) * 2000, 5000].filter((v, i, a) => v >= due && a.indexOf(v) === i).slice(0, 4);
      $('#quick', body).innerHTML = q.map((v) => `<button class="chip" data-g="${v}">${euro(v)}</button>`).join('');
      return { lines, sub, d, due, g };
    };
    pk.addEventListener('change', calc);
    $('#pm', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      method = b.dataset.m;
      const isEc = method === S.settings.ec_method_name;
      $$('#pm .chip', body).forEach((x) => x.classList.toggle('on', x === b));
      $('#cash', body).classList.toggle('hidden', method !== 'Bar');
      $('#ecinfo', body).classList.toggle('hidden', !isEc);
      $('#dsec', body).classList.toggle('hidden', isEc);
      if (isEc && disc.on) { disc.on = false; $('#dOn', body).checked = false; $('#dBox', body).classList.add('hidden'); calc(); }
      const okBtn = $('.modal-foot .ok', body.closest('.modal'));
      if (okBtn) okBtn.textContent = isEc ? 'Mit EC zahlen' : 'Zahlung abschließen';
    });
    $('#quick', body).addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (b) { $('#given', body).value = (Number(b.dataset.g) / 100).toFixed(2).replace('.', ','); calc(); } });
    $('#given', body).addEventListener('input', calc);
    $('#dOn', body).addEventListener('change', (e) => { disc.on = e.target.checked; $('#dBox', body).classList.toggle('hidden', !disc.on); calc(); });
    $$('[data-dt]', body).forEach((b) => b.addEventListener('click', () => { disc.type = b.dataset.dt; $$('[data-dt]', body).forEach((x) => x.classList.toggle('on', x === b)); calc(); }));
    $('#dVal', body).addEventListener('input', calc);
    calc();
    let done = false;
    modal({
      title: `Bezahlen – Tisch ${S.data.table.number}`, body, wide: true,
      actions: [{ label: 'Abbrechen' }, {
        label: 'Zahlung abschließen', kind: 'ok', onClick: async () => {
          const c = calc();
          if (!c.lines.length) throw new Error('Keine Positionen gewählt');
          if (!method) throw new Error('Bitte Zahlungsart wählen');
          if (method === S.settings.ec_method_name) {
            // EC: Sicherheitsabfrage, dann alle gewählten Artikel stornieren (Vermerk „Mit EC bezahlt“)
            const n = c.lines.reduce((s, l) => s + l.qty, 0);
            const ok = await yesNo('Mit EC zahlen?', `Sind Sie sicher? ${n} Artikel (${euro(c.sub)}) werden storniert und im Admin-Bereich mit dem Vermerk „Mit EC bezahlt“ festgehalten.`);
            if (!ok) return false;
            const allSel = c.lines.length === open.length && c.lines.every((l) => l.qty === l.item.open_qty);
            const r = await api.post(`/api/pos/orders/${S.data.order.id}/ec-pay`, { items: allSel ? null : c.lines.map((l) => ({ item_id: l.item_id, qty: l.qty })) });
            done = true;
            S.sel.clear();
            refreshTables();
            toast(`Mit EC bezahlt: ${euro(r.total)} – Artikel storniert und vermerkt`, 'ok', 4000);
            if (r.closed) go('tables'); else await loadOrder();
            return true;
          }
          if (method === 'Bar' && c.g && c.g < c.due) throw new Error('Gegebener Betrag reicht nicht');
          let discount = null;
          if (disc.on && c.d > 0) {
            const reason = $('#dReason', body).value.trim();
            if (!reason) throw new Error('Bitte einen Rabattgrund angeben');
            discount = disc.type === 'percent'
              ? { type: 'percent', value: Number(String($('#dVal', body).value).replace(',', '.')), reason }
              : { type: 'amount', value: parseEuro($('#dVal', body).value), reason };
          }
          const allSelected = c.lines.length === open.length && c.lines.every((l) => l.qty === l.item.open_qty);
          const r = await withApproval((approver, idem) => api.post(`/api/pos/orders/${S.data.order.id}/pay`, {
            items: allSelected ? null : c.lines.map((l) => ({ item_id: l.item_id, qty: l.qty })), method,
            given: method === 'Bar' && c.g ? c.g : null, discount, approver,
          }, { idem }));
          done = true;
          S.sel.clear();
          refreshTables();
          showInvoice(r.invoice_id, r.change != null ? `Rückgeld: ${euro(r.change)}` : null);
          if (r.closed) go('tables'); else await loadOrder();
        },
      }],
      onClose: () => { if (!done) logAbort('bezahlen', { inputs: { zahlungsart: method, gegeben: $('#given', body)?.value, rabatt: disc.on ? $('#dVal', body)?.value : null } }); },
    });
  },
};

// Sicherheitsabfrage mit „Ja“ / „Nein“
function yesNo(title, text) {
  return new Promise((resolve) => {
    modal({
      title, body: `<p style="margin:0;font-size:16px">${esc(text)}</p>`,
      actions: [{ label: 'Nein', onClick: () => resolve(false) }, { label: 'Ja', kind: 'ok', onClick: () => resolve(true) }],
      onClose: (r) => { if (r === 'cancel') resolve(false); },
    });
  });
}

// ---- Rechnungen ------------------------------------------------------------------
async function showInvoice(id, note) {
  try {
    const d = await api.get(`/api/pos/invoices/${id}`);
    const canReopen = d.kind === 'rechnung' && !d.reversed_by;
    modal({
      title: `${d.kind === 'storno' ? 'Stornorechnung' : 'Rechnung'} ${d.invoice_no}`, wide: true,
      body: `${note ? `<div class="notice ok" style="font-size:20px;margin-bottom:12px">${esc(note)}</div>` : ''}${invoiceHtml(d)}`,
      actions: [
        { label: 'PDF', onClick: () => api.openPdf(`/api/pos/invoices/${id}/pdf`), close: false },
        ...(canReopen ? [{ label: 'Tisch wiedereröffnen', kind: 'warn', onClick: () => reopen(d) }] : []),
        { label: 'Schließen', kind: 'primary' },
      ],
    });
  } catch (e) { toast(e.message, 'error'); }
}

function reopen(d) {
  const rf = reasonField(['Falsche Zahlungsart', 'Gast bestellt nach', 'Fehlerhafte Abrechnung']);
  const body = h(`<div><div class="notice">Die Rechnung ${esc(d.invoice_no)} bleibt unverändert archiviert. Es wird eine Stornorechnung erstellt und der Tisch mit allen Positionen wieder geöffnet.</div>
    <div class="section"><div class="lbl">Grund (Pflicht)</div></div></div>`);
  $('.section', body).append(rf);
  let done = false;
  modal({
    title: `Tisch ${d.table_no} wiedereröffnen`, body,
    actions: [{ label: 'Abbrechen' }, {
      label: 'Wiedereröffnen', kind: 'warn', onClick: async () => {
        if (!rf.value()) throw new Error('Bitte einen Grund angeben');
        const r = await withApproval((approver, idem) => api.post(`/api/pos/invoices/${d.id}/reopen`, { reason: rf.value(), approver }, { idem }));
        done = true;
        $$('.modal-back').forEach((m) => m.remove());
        toast(`Tisch wiedereröffnet (Stornorechnung ${r.storno_invoice_no})`, 'warn');
        refreshTables();
        go('order', r.table_id);
      },
    }],
    onClose: () => { if (!done) logAbort('wiedereroeffnen', { inputs: { rechnung: d.invoice_no } }); },
  });
}

async function renderInvoices() {
  const v = $('#view');
  v.innerHTML = '<div class="inv-list"><div class="empty">Lade …</div></div>';
  try {
    const list = await api.get('/api/pos/invoices');
    v.innerHTML = `<div class="inv-list"><h2 style="margin-bottom:10px">Rechnungen heute ${can('approve') ? '(alle)' : '(eigene)'}</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>Nr.</th><th>Zeit</th><th>Tisch</th><th>Bedienung</th><th>Zahlungsart</th><th class="num">Summe</th><th>Status</th></tr></thead>
      <tbody>${list.map((r) => `<tr class="click ${r.kind === 'storno' ? 'storno' : ''}" data-id="${r.id}"><td>${esc(r.invoice_no)}</td><td>${fmtTime(r.closed_at)}</td><td>${r.table_no}</td>
        <td>${esc(r.waiter_name)}</td><td>${esc(r.payment_method)}</td><td class="num">${euro(r.total)}</td>
        <td>${r.kind === 'storno' ? `<span class="badge danger">Storno zu ${esc(r.reverses_no)}</span>` : r.reversed_by ? `<span class="badge warn">aufgehoben</span>` : '<span class="badge ok">gültig</span>'}
        ${r.storno_count ? ` <span class="badge">${r.storno_count} Storno</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Noch keine Rechnungen heute</td></tr>'}</tbody></table></div></div>`;
    $$('[data-id]', v).forEach((tr) => tr.addEventListener('click', () => showInvoice(Number(tr.dataset.id))));
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Menü: Schicht, PIN -------------------------------------------------------------
function userMenu() {
  modal({
    title: S.me.name,
    body: `<div style="display:grid;gap:8px"><button class="btn" id="mshift">Meine Schicht / Schichtabrechnung</button><button class="btn" id="mpin">PIN ändern</button>
      <button class="btn" id="mdev">Gerätename: ${esc(deviceName)}</button></div>`,
    actions: [{ label: 'Schließen' }],
  });
  $('#mshift').addEventListener('click', () => { $$('.modal-back').forEach((m) => m.remove()); shiftDialog(); });
  $('#mpin').addEventListener('click', () => { $$('.modal-back').forEach((m) => m.remove()); pinDialog(); });
  $('#mdev').addEventListener('click', async () => {
    const n = prompt('Neuer Gerätename (gilt ab der nächsten Anmeldung):', deviceName);
    if (n && n.trim()) { deviceName = n.trim(); try { localStorage.setItem('pos.device', deviceName); } catch {} toast('Gespeichert'); }
  });
}

async function shiftDialog() {
  const r = await api.get('/api/pos/shift');
  if (!r.shift) return toast('Keine offene Schicht');
  const p = r.report;
  modal({
    title: 'Schichtabrechnung',
    body: `<p class="muted" style="margin-top:0">Schicht seit ${fmtDT(r.shift.started_at)}</p>
      <table class="data"><tbody>
      <tr><td>Umsatz (abgeschlossene Rechnungen)</td><td class="num"><b>${euro(p.umsatz)}</b></td></tr>
      ${Object.entries(p.nach_zahlungsart).map(([k, v]) => `<tr><td>&nbsp;&nbsp;${esc(k)}</td><td class="num">${euro(v)}</td></tr>`).join('')}
      <tr><td>Rechnungen / Stornorechnungen</td><td class="num">${p.rechnungen} / ${p.stornorechnungen}</td></tr>
      <tr><td>Artikel eingegeben</td><td class="num">${p.artikel_eingegeben}</td></tr>
      <tr><td>Stornos</td><td class="num">${p.stornos} (${euro(p.storno_wert)})</td></tr>
      <tr><td>Mit EC bezahlt (storniert)</td><td class="num">${p.ec_tische ?? 0} Tische (${euro(p.ec_wert)})</td></tr>
      <tr><td>Rabatte</td><td class="num">${euro(p.rabatte)}</td></tr></tbody></table>
      ${p.offene_tische.length ? `<div class="notice" style="margin-top:10px">Noch offene Tische: ${p.offene_tische.join(', ')}</div>` : ''}`,
    actions: [{ label: 'Schließen' }, {
      label: 'Schicht abschließen', kind: 'warn', onClick: async () => {
        if (!(await confirmDialog('Schicht abschließen', 'Die Schichtabrechnung wird unveränderbar gespeichert und Sie werden abgemeldet.', 'Abschließen', 'warn'))) return false;
        await api.post('/api/pos/shift/close', {});
        toast('Schicht abgeschlossen', 'ok');
        doLogout('Schichtende');
      },
    }],
  });
}

function pinDialog() {
  modal({
    title: 'PIN ändern',
    body: `<div class="fields"><label class="field">Alte PIN<input type="password" inputmode="numeric" id="op"></label>
      <label class="field">Neue PIN<input type="password" inputmode="numeric" id="np1"></label><label class="field">Wiederholen<input type="password" inputmode="numeric" id="np2"></label></div>`,
    actions: [{ label: 'Abbrechen' }, {
      label: 'Speichern', kind: 'primary', onClick: async (b) => {
        if ($('#np1', b).value !== $('#np2', b).value) throw new Error('Neue PINs stimmen nicht überein');
        await api.post('/api/me/pin', { old_pin: $('#op', b).value, new_pin: $('#np1', b).value });
        toast('PIN geändert', 'ok');
      },
    }],
  });
}

// ---- Los geht's -------------------------------------------------------------------
if (api.token) start(); else showLogin();
