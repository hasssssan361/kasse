import { esc, euro, fmtDT } from './core.js';

// Digitale Rechnung als HTML
export function invoiceHtml(d) {
  const items = d.items.map((i) => `<tr><td class="num">${i.qty}</td><td>${esc(i.article_name)}</td><td class="num">${euro(i.unit_price)}</td>
      <td class="num">${i.vat} %</td><td class="num">${euro(i.total)}</td></tr>`).join('');
  const cancelled = d.cancelled.length ? `<h4 style="margin:14px 0 4px">Stornierte Positionen (Historie, nicht berechnet)</h4>
      <table><tr><th>Menge</th><th>Artikel</th><th>Wert</th><th>Eingabe</th><th>Storno</th><th>Grund</th></tr>
      ${d.cancelled.map((c) => `<tr class="cancelled-row"><td class="num">${c.qty}</td><td>${esc(c.article_name)}</td><td class="num">${euro(c.total)}</td>
        <td>${fmtDT(c.entered_at)}<br><small>${esc(c.eingegeben_von)}</small></td><td>${fmtDT(c.cancelled_at)}<br><small>${esc(c.storniert_von)}</small></td><td>${esc(c.reason)}</td></tr>`).join('')}</table>` : '';
  return `<div class="invoice">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div><strong style="font-size:16px">${esc(d.settings.name)}</strong><br><small>${esc(d.settings.address)}</small>
      ${d.settings.tax_id ? `<br><small>St.-Nr./USt-IdNr.: ${esc(d.settings.tax_id)}</small>` : ''}</div>
      <div style="text-align:right"><small>Digitaler Beleg</small></div>
    </div>
    <h3>${d.kind === 'storno' ? 'Stornorechnung' : 'Rechnung'} Nr. ${esc(d.invoice_no)}</h3>
    ${d.reverses ? `<div class="void">Hebt Rechnung ${esc(d.reverses.invoice_no)} auf (Wiedereröffnung).</div>` : ''}
    ${d.reversed_by ? `<div class="void">Aufgehoben durch Stornorechnung ${esc(d.reversed_by.invoice_no)} am ${fmtDT(d.reversed_by.closed_at)} (${esc(d.reversed_by.closed_by_name)}). Die ursprüngliche Rechnung bleibt unverändert archiviert.</div>` : ''}
    <div><small>Tisch <b>${d.table_no}</b> · Bedienung ${esc(d.waiter_name)} · abgeschlossen von ${esc(d.closed_by_name)}<br>
      Eröffnet ${fmtDT(d.opened_at)} · Abschluss ${fmtDT(d.closed_at)}</small></div>
    <table><tr><th class="num">Menge</th><th>Artikel</th><th class="num">Einzel</th><th class="num">MwSt</th><th class="num">Gesamt</th></tr>${items || '<tr><td colspan="5"><i>Keine berechneten Positionen (Nullbeleg)</i></td></tr>'}
      <tr><td></td><td>Zwischensumme</td><td></td><td></td><td class="num">${euro(d.subtotal)}</td></tr>
      ${d.discount ? `<tr><td></td><td>Rabatt (${esc(d.discount_reason || '')}${d.approved_by_name ? ', Freigabe ' + esc(d.approved_by_name) : ''})</td><td></td><td></td><td class="num">−${euro(d.discount)}</td></tr>` : ''}
      <tr class="tot"><td></td><td>Gesamtsumme</td><td></td><td></td><td class="num">${euro(d.total)}</td></tr></table>
    <div><small>Zahlungsart: <b>${esc(d.payment_method)}</b>${d.given != null ? ` · gegeben ${euro(d.given)} · zurück ${euro(d.change_amount)}` : ''}</small></div>
    <div><small>${d.vat.map((v) => `enthaltene MwSt ${v.satz} %: ${euro(v.steuer)} (netto ${euro(v.netto)})`).join(' · ')}</small></div>
    ${cancelled}
    <p class="hash">Prüfsumme: ${esc(d.hash)}</p>
  </div>`;
}
