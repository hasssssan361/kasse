// Verwaltung → „Gerät & Übertragung“: Lizenz dieses Geräts, Stammdaten exportieren und auf einem anderen Gerät einlesen.
import { $, esc, h, toast, modal, fmtDate, fmtDT } from '../shared/core.js';

const LABEL = { kategorien: 'Kategorien', artikel: 'Artikel', rollen: 'Rollen', mitarbeiter: 'Mitarbeiter', tische: 'Tische', tischplan: 'Tischplan', einstellungen: 'Einstellungen' };
const list = (o) => Object.entries(o || {}).map(([k, n]) => `${n} ${LABEL[k] || k}`).join(', ') || '–';

export async function deviceTab(box, { api, canEdit, reload }) {
  const lic = (await api.raw('GET', '/api/license')).body;
  box.innerHTML = `
    <div class="card"><h2>Lizenz dieses Geräts</h2>
      <div class="fields">
        <div><div class="small muted">Lizenziert für</div><b>${esc(lic.business || '–')}</b></div>
        <div><div class="small muted">Gerätekennung</div><b class="mono">${esc(lic.device_id)}</b></div>
        <div><div class="small muted">Freigeschaltet am</div><b>${lic.issued ? fmtDate(lic.issued) : '–'}</b></div>
        <div><div class="small muted">Gültig bis</div><b>${lic.expires ? fmtDate(lic.expires) : 'unbegrenzt'}</b></div>
      </div>
      <p class="small muted" style="margin-top:10px">Jedes Gerät braucht einen eigenen Freischaltcode vom Anbieter. Für ein weiteres Gerät dessen Gerätekennung an den Anbieter schicken.</p>
      ${canEdit ? '<button class="btn sm" id="newlic">Neuen Freischaltcode eingeben (z. B. Verlängerung)</button>' : ''}</div>

    <div class="card"><h2>Stammdaten auf ein anderes Gerät übertragen</h2>
      <p class="small muted">Übertragen werden <b>Kategorien, Artikel mit Varianten, Tische, Tischplan, Mitarbeiter mit PIN, Rollenrechte und Einstellungen</b>.
        Buchungen, Rechnungen, Protokoll und Lizenz bleiben auf jedem Gerät für sich. Jedes Gerät arbeitet weiter eigenständig.</p>
      ${canEdit ? `<h3 style="margin:14px 0 6px">1. Auf diesem Gerät exportieren</h3>
      <div class="fields"><label class="field">Übertragungs-Passwort (mind. 6 Zeichen)<input type="password" id="xpw1" autocomplete="new-password"></label>
        <label class="field">Passwort wiederholen<input type="password" id="xpw2" autocomplete="new-password"></label></div>
      <p class="small muted" style="margin:6px 0">Die Datei ist mit diesem Passwort verschlüsselt (sie enthält die PINs). Das Passwort getrennt von der Datei weitergeben.</p>
      <button class="btn primary" id="xexp">Stammdaten exportieren</button>

      <h3 style="margin:18px 0 6px">2. Auf dem anderen Gerät einlesen</h3>
      <div class="fields"><label class="field">Stammdaten-Datei<input type="file" id="xfile" accept=".json,application/json"></label>
        <label class="field">Übertragungs-Passwort<input type="password" id="xpw" autocomplete="off"></label></div>
      <p class="small muted" style="margin:6px 0">Dieses Gerät wird <b>1:1 angeglichen</b>: Neues wird angelegt, Geändertes aktualisiert, was in der Datei fehlt, wird
        deaktiviert (nie gelöscht). Belegte Tische und das eigene Admin-Konto bleiben aktiv. Vorher wird eine Vorschau gezeigt.</p>
      <button class="btn primary" id="ximp">Datei prüfen …</button>` : '<div class="muted">Nur mit dem Recht „Verwaltung“.</div>'}</div>`;
  if (!canEdit) return;

  $('#newlic', box).addEventListener('click', () => {
    const body = h(`<div><label class="field">Freischaltcode<textarea id="lc" rows="4" spellcheck="false" autocapitalize="off"></textarea></label>
      <p class="small muted" style="margin-top:8px">Gerätekennung: <b class="mono">${esc(lic.device_id)}</b></p></div>`);
    modal({ title: 'Freischaltcode eingeben', body, actions: [{ label: 'Abbrechen' }, { label: 'Freischalten', kind: 'primary', onClick: async () => {
      const r = await api.raw('POST', '/api/license', { code: $('#lc', body).value.trim() });
      toast(`Freigeschaltet für ${r.body.business}`, 'ok'); reload();
    } }] });
  });

  $('#xexp', box).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget; // nach einem await ist ev.currentTarget leer
    const p1 = $('#xpw1', box).value, p2 = $('#xpw2', box).value;
    if (p1.length < 6) return toast('Das Passwort muss mindestens 6 Zeichen haben', 'error');
    if (p1 !== p2) return toast('Die Passwörter stimmen nicht überein', 'error');
    btn.disabled = true;
    try {
      await api.download('/api/admin/master-export', 'stammdaten.json', { password: p1 });
      toast('Datei gespeichert (Ordner „Downloads“). Jetzt z. B. per WhatsApp, E-Mail oder USB auf das andere Gerät bringen.', 'ok', 8000);
      $('#xpw1', box).value = $('#xpw2', box).value = '';
    } catch (e) { toast(e.message, 'error', 7000); } finally { btn.disabled = false; }
  });

  $('#ximp', box).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget; // nach einem await ist ev.currentTarget leer
    const f = $('#xfile', box).files[0];
    const password = $('#xpw', box).value;
    if (!f) return toast('Bitte zuerst die Stammdaten-Datei auswählen', 'error');
    if (!password) return toast('Bitte das Übertragungs-Passwort eingeben', 'error');
    let pkg;
    try { pkg = JSON.parse(await f.text()); } catch { return toast('Die Datei ist keine gültige Stammdaten-Datei', 'error'); }
    btn.disabled = true;
    let dry;
    try { dry = await api.post('/api/admin/master-import', { package: pkg, password, dryRun: true }); } catch (e) { btn.disabled = false; return toast(e.message, 'error', 7000); }
    btn.disabled = false;
    const nothing = !Object.keys(dry.neu).length && !Object.keys(dry.geaendert).length && !Object.keys(dry.deaktiviert).length;
    const body = h(`<div>
      <p>Datei von <b>${esc(pkg.business || '–')}</b> (Gerät <span class="mono">${esc(pkg.device || '?')}</span>), erstellt am ${esc(fmtDT(pkg.exported_at, false))}.</p>
      ${nothing ? '<div class="notice ok">Dieses Gerät ist bereits auf dem Stand der Datei.</div>' : `<table class="data" style="margin-top:8px"><tbody>
        <tr><td><b>Neu</b></td><td>${list(dry.neu)}</td></tr>
        <tr><td><b>Geändert</b></td><td>${list(dry.geaendert)}</td></tr>
        <tr><td><b>Deaktiviert</b></td><td>${list(dry.deaktiviert)}</td></tr></tbody></table>`}
      ${dry.hinweise.length ? `<div class="notice" style="margin-top:10px"><b>Hinweise</b><ul style="margin:6px 0 0 18px">${dry.hinweise.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <p class="small muted" style="margin-top:10px">Jede Änderung wird im Protokoll gespeichert. Buchungen und Rechnungen bleiben unverändert.</p></div>`);
    modal({ title: 'Stammdaten übernehmen', wide: true, body, actions: nothing ? [{ label: 'Schließen' }] : [{ label: 'Abbrechen' }, { label: '1:1 übernehmen', kind: 'primary', onClick: async () => {
      const r = await api.post('/api/admin/master-import', { package: pkg, password });
      toast(`Übernommen: neu ${list(r.neu)} · geändert ${list(r.geaendert)} · deaktiviert ${list(r.deaktiviert)}`, 'ok', 9000);
      reload();
    } }] });
  });
}
