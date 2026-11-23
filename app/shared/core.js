// Gemeinsame Funktionen für Kasse und Dashboard
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const euro = (c) => ((c || 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
export const num = (c) => ((c || 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tz = { timeZone: 'Europe/Berlin' };
export const fmtTime = (iso, sec = true) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { ...tz, hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) }) : '');
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { ...tz, day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
export const fmtDT = (iso, sec = true) => (iso ? `${fmtDate(iso)} ${fmtTime(iso, sec)}` : '');
export const todayStr = () => new Date().toLocaleDateString('sv-SE', tz);
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const parseEuro = (s) => {
  const t = String(s ?? '').trim().replace(/\s|€/g, '').replace(/\./g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---- Verbindung zum Rechenkern im Gerät (Web Worker) ------------------------------
// Ein Rechenkern pro Fenster. Er hält die Datenbank und beantwortet Aufträge der Oberfläche.
let worker = null;
let nextId = 1;
const pending = new Map();
const eventHandlers = new Set();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'result') { pending.get(m.id)?.(m.res); pending.delete(m.id); }
    if (m.type === 'event') for (const h of eventHandlers) h(m.kind, m.data);
  };
  worker.onerror = (e) => {
    for (const [id, resolve] of pending) { resolve({ status: 503, body: { error: 'Rechenkern konnte nicht gestartet werden: ' + (e.message || 'unbekannter Fehler') } }); pending.delete(id); }
  };
  // Beim Verlassen der Seite den Rechenkern sofort beenden, damit das nächste Fenster die Datenbank bekommt
  addEventListener('pagehide', () => { try { worker.terminate(); } catch {} });
  // Daten dauerhaft behalten (Browser soll den Speicher nicht automatisch aufräumen)
  try { navigator.storage?.persist?.(); } catch {}
  return worker;
}

// Versionsnummer der App – wird auf dem Anmeldebildschirm und im Admin-Bereich angezeigt,
// damit man nach einem Update sieht, dass die neue Version läuft. Bei jeder Veröffentlichung erhöhen.
export const APP_VERSION = '1.0.0';

// Offline-Betrieb: Service Worker registrieren (liegt im Hauptordner der App)
export function registerOffline() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname }).catch(() => {});
}

export class Api {
  // persist=true: Anmeldung übersteht das Schließen der App (Sitzung endet trotzdem nach 14 h)
  constructor(storageKey, onUnauthorized, onConnection, { persist = false } = {}) {
    this.storageKey = storageKey;
    this.onUnauthorized = onUnauthorized;
    this.onConnection = onConnection || (() => {});
    this.store = () => (persist ? localStorage : sessionStorage);
    try { this.token = this.store().getItem(storageKey) || null; } catch { this.token = null; }
    getWorker();
  }
  setToken(t) {
    this.token = t;
    try { t ? this.store().setItem(this.storageKey, t) : this.store().removeItem(this.storageKey); } catch {}
  }
  async raw(method, path, body, idem) {
    const u = new URL(path, 'http://x');
    const id = nextId++;
    const res = await new Promise((resolve) => {
      pending.set(id, resolve);
      getWorker().postMessage({ type: 'call', id, req: { method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body || {}, token: this.token, idem: idem || null } });
    });
    if (res.status === 401 && u.pathname !== '/api/login') {
      this.setToken(null);
      this.onUnauthorized?.();
      throw Object.assign(new Error('Bitte erneut anmelden'), { status: 401 });
    }
    if (res.status === 403 && res.body?.unlicensed) {
      // Lizenz fehlt oder ist abgelaufen → Freischalt-Bildschirm, danach neu laden
      showLicenseScreen(this, { licensed: false, device_id: res.body.device_id, error: res.body.error }).then(() => location.reload());
    }
    if (res.status === 403 && res.body?.setup_required) showSetupScreen(this).then(() => location.reload());
    if (res.status >= 400) throw Object.assign(new Error(res.body?.error || `Fehler ${res.status}`), { status: res.status, data: res.body });
    return res;
  }
  async call(method, path, body, { idem } = {}) {
    const res = await this.raw(method, path, body, idem || (method !== 'GET' ? uuid() : null));
    return res.file ? new Blob([res.file.data], { type: res.file.contentType }) : res.body;
  }
  get(p) { return this.call('GET', p); }
  post(p, b, o) { return this.call('POST', p, b || {}, o); }
  put(p, b) { return this.call('PUT', p, b || {}); }
  async download(path, fallbackName, body = null) {
    const res = await this.raw(body ? 'POST' : 'GET', path, body);
    if (!res.file) throw new Error('Keine Datei erhalten');
    const blob = new Blob([res.file.data], { type: res.file.contentType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = res.file.filename || fallbackName;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  // PDFs: Android zeigt PDFs nicht im Browser an – daher als Datei speichern (öffnet sich im PDF-Betrachter)
  openPdf(path) { return this.download(path, 'rechnung.pdf'); }
  stream(handlers) {
    this.closeStream();
    this.handler = (kind, data) => handlers[kind]?.(data);
    eventHandlers.add(this.handler);
    this.onConnection(true);
  }
  closeStream() { if (this.handler) eventHandlers.delete(this.handler); this.handler = null; }
}

// ---- Lizenz / Freischaltung --------------------------------------------------
// Vor der Anmeldung: Ist dieses Gerät freigeschaltet? Wenn nicht, Freischalt-Bildschirm zeigen.
// Ein Freischaltcode kann auch per Link kommen: …/kasse/#lizenz=CODE
export async function licenseGate(api) {
  const fromLink = (location.hash.match(/[#&]lizenz=([^&]+)/) || [])[1];
  if (fromLink) history.replaceState(null, '', location.pathname + location.search);
  const res = await api.raw('GET', '/api/license').catch((e) => ({ body: { licensed: false, error: e.message } }));
  let st = res.body || {};
  if (!st.licensed || fromLink) st = await showLicenseScreen(api, st, fromLink ? decodeURIComponent(fromLink) : '');
  // Neues Gerät: einmalig eigene Admin-Zugangsdaten festlegen
  if (st.setup_required) await showSetupScreen(api);
  return st;
}

let setupScreen = null;
export function showSetupScreen(api) {
  if (setupScreen) return setupScreen;
  setupScreen = new Promise((resolve) => {
    const el = h(`<div class="lic-screen"><div class="lic-card">
      <h1>Ersteinrichtung</h1>
      <p class="muted">Legen Sie Ihren eigenen Administrator-Zugang fest. Damit melden Sie sich im Admin-Bereich und an der Kasse an.
        Später können Sie alles unter <b>Verwaltung → Benutzer</b> ändern und Mitarbeiter anlegen.</p>
      <div class="fields" style="grid-template-columns:1fr">
        <label class="field">Personalnummer<input id="sn" type="number" inputmode="numeric" min="1" max="99999" value="1"></label>
        <label class="field">Ihr Name<input id="sname" type="text" maxlength="60" autocomplete="name" placeholder="z. B. Max Mustermann"></label>
        <label class="field">PIN (6–12 Ziffern)<input id="sp1" type="password" inputmode="numeric" autocomplete="new-password"></label>
        <label class="field">PIN wiederholen<input id="sp2" type="password" inputmode="numeric" autocomplete="new-password"></label>
      </div>
      <p class="small muted" style="margin-top:10px">Bitte die PIN gut merken – sie kann nicht wiederhergestellt werden.</p>
      <div class="lic-err" id="serr"></div>
      <button class="btn primary" id="sgo" style="width:100%;margin-top:10px">Zugang anlegen</button>
    </div></div>`);
    const err = (m) => { $('#serr', el).textContent = m || ''; };
    const go = async () => {
      err('');
      const b = { personal_nr: Number($('#sn', el).value), name: $('#sname', el).value.trim(), pin: $('#sp1', el).value, pin2: $('#sp2', el).value };
      if (!b.name) return err('Bitte Ihren Namen eingeben.');
      $('#sgo', el).disabled = true;
      try {
        await api.raw('POST', '/api/setup', b);
        toast(`Zugang angelegt – bitte mit Nr. ${b.personal_nr} und Ihrer PIN anmelden`, 'ok', 6000);
        el.remove();
        setupScreen = null;
        resolve();
      } catch (e) { err(e.message); } finally { $('#sgo', el).disabled = false; }
    };
    $('#sgo', el).addEventListener('click', go);
    $('#sp2', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    document.body.append(el);
    setTimeout(() => $('#sname', el).focus(), 50);
  });
  return setupScreen;
}

let licenseScreen = null;
export function showLicenseScreen(api, st, prefill = '') {
  if (licenseScreen) return licenseScreen;
  licenseScreen = new Promise((resolve) => {
    const el = h(`<div class="lic-screen"><div class="lic-card">
      <h1>Gerät freischalten</h1>
      <p class="muted">Diese Kasse wird für jedes Gerät einzeln freigeschaltet. Schicken Sie die Gerätekennung an Ihren Anbieter –
        Sie erhalten dafür einen Freischaltcode. Ihre Daten bleiben dabei unverändert.</p>
      <div class="lic-id-label small muted">Gerätekennung dieses Geräts</div>
      <div class="lic-id mono" id="lid"></div>
      <div class="row" style="margin:8px 0 18px"><button class="btn sm" id="lcopy">Kopieren</button><button class="btn sm" id="lshare">Senden …</button></div>
      <label class="field">Freischaltcode<textarea id="lcode" rows="4" placeholder="Freischaltcode hier einfügen" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></label>
      <div class="lic-err" id="lerr"></div>
      <button class="btn primary" id="lgo" style="width:100%;margin-top:10px">Freischalten</button>
    </div></div>`);
    $('#lid', el).textContent = st.device_id || '…';
    $('#lcode', el).value = prefill;
    const err = (m) => { $('#lerr', el).textContent = m || ''; };
    err(st.licensed ? '' : st.error && !/noch nicht freigeschaltet/.test(st.error) ? st.error : '');
    const idText = () => `Gerätekennung meiner Kasse: ${st.device_id}`;
    $('#lcopy', el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(st.device_id); toast('Gerätekennung kopiert', 'ok'); } catch { toast('Bitte die Kennung abschreiben', 'error'); }
    });
    $('#lshare', el).addEventListener('click', async () => {
      if (navigator.share) { try { await navigator.share({ text: idText() }); } catch {} } else location.href = `mailto:?subject=${encodeURIComponent('Freischaltung Kasse')}&body=${encodeURIComponent(idText())}`;
    });
    const go = async () => {
      const code = $('#lcode', el).value.trim();
      if (!code) return err('Bitte den Freischaltcode einfügen.');
      $('#lgo', el).disabled = true;
      try {
        const r = await api.raw('POST', '/api/license', { code });
        toast(`Freigeschaltet für ${r.body.business || 'diesen Betrieb'}`, 'ok', 5000);
        el.remove();
        licenseScreen = null;
        resolve(r.body);
      } catch (e) { err(e.message); } finally { $('#lgo', el).disabled = false; }
    };
    $('#lgo', el).addEventListener('click', go);
    document.body.append(el);
    if (prefill) go();
  });
  return licenseScreen;
}

// ---- Toasts & Modale ---------------------------------------------------------
export function toast(msg, kind = 'info', ms = 3500) {
  let box = $('#toasts');
  if (!box) { box = h('<div id="toasts" aria-live="polite"></div>'); document.body.append(box); }
  const t = h(`<div class="toast toast-${kind}"></div>`);
  if (msg instanceof Node) t.append(msg); else t.textContent = msg;
  box.prepend(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  t.addEventListener('click', () => t.remove());
  return t;
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2></h2><button class="icon-btn close" aria-label="Schließen">✕</button></div>
      <div class="modal-body"></div><div class="modal-foot"></div></div></div>`);
  $('h2', back).textContent = title;
  const bodyEl = $('.modal-body', back);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    back.remove();
    onClose?.(reason);
  };
  for (const a of actions) {
    const b = h(`<button class="btn ${a.kind || ''}">${esc(a.label)}</button>`);
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      try { const r = await a.onClick?.(bodyEl, close); if (r !== false && a.close !== false) close('action'); } catch (e) { toast(e.message, 'error', 6000); } finally { b.disabled = false; }
    });
    $('.modal-foot', back).append(b);
  }
  $('.close', back).addEventListener('click', () => close('cancel'));
  back.addEventListener('mousedown', (e) => { if (e.target === back) close('cancel'); });
  document.body.append(back);
  const first = $('input,textarea,select', bodyEl);
  if (first) setTimeout(() => first.focus(), 30);
  return { el: back, body: bodyEl, close };
}

export function confirmDialog(title, text, okLabel = 'OK', kind = 'primary') {
  return new Promise((resolve) => {
    modal({ title, body: `<p>${esc(text)}</p>`, actions: [
      { label: 'Abbrechen', onClick: () => resolve(false) },
      { label: okLabel, kind, onClick: () => resolve(true) },
    ], onClose: (r) => { if (r === 'cancel') resolve(false); } });
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
