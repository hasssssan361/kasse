// Export: CSV (Excel-tauglich, Semikolon) und einfaches PDF (ohne Zusatzbibliothek)
const ascii = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 0xff);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(';');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(';'));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
function encodeLine(s) {
  const out = [];
  for (const ch of String(s).replace(/→/g, '->').replace(/×/g, 'x')) {
    const c = ch.codePointAt(0);
    if (WIN[ch]) out.push(WIN[ch]);
    else if (c < 256) out.push(c);
    else out.push(63); // '?'
  }
  const b = [];
  for (const c of out) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) b.push(0x5c);
    b.push(c);
  }
  return Uint8Array.from(b);
}

/**
 * Erzeugt ein A4-PDF aus Textzeilen. Zeile: String oder {text, bold, size}.
 */
export function toPdf(title, lines, { fontSize = 8.5, footer = '' } = {}) {
  const W = 595.28;
  const Hh = 841.89;
  const margin = 36;
  const lh = fontSize * 1.32;
  const maxChars = Math.floor((W - 2 * margin) / (fontSize * 0.6));
  // Zeilen umbrechen
  const wrapped = [];
  for (const l of [{ text: title, bold: true, size: 12 }, '', ...lines]) {
    const o = typeof l === 'string' ? { text: l } : l;
    const size = o.size || fontSize;
    const mc = Math.floor((W - 2 * margin) / (size * 0.6));
    let t = String(o.text ?? '');
    if (!t.length) wrapped.push({ ...o, text: '', size });
    while (t.length) {
      wrapped.push({ ...o, text: t.slice(0, mc), size });
      t = t.length > mc ? '  ' + t.slice(mc) : '';
    }
  }
  void maxChars;
  const perPage = Math.floor((Hh - 2 * margin - 20) / lh);
  const pages = [];
  for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const objs = [];
  const add = (buf) => { objs.push(buf); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add(ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'));
  const f2 = add(ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'));
  const kids = [];
  pages.forEach((pg, pi) => {
    const parts = [ascii('BT\n')];
    let y = Hh - margin;
    for (const l of pg) {
      y -= l.size === fontSize ? lh : l.size * 1.4;
      parts.push(ascii(`/${l.bold ? 'F2' : 'F1'} ${l.size} Tf 1 0 0 1 ${margin} ${y.toFixed(2)} Tm (`));
      parts.push(encodeLine(l.text));
      parts.push(ascii(') Tj\n'));
    }
    parts.push(ascii(`/F1 7 Tf 1 0 0 1 ${margin} 20 Tm (`));
    parts.push(encodeLine(`${footer}${footer ? '  –  ' : ''}Seite ${pi + 1} von ${pages.length}`));
    parts.push(ascii(') Tj\nET\n'));
    const stream = concat(parts);
    const content = add(concat([ascii(`<< /Length ${stream.length} >>\nstream\n`), stream, ascii('\nendstream')]));
    kids.push(add(ascii(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${Hh}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`)));
  });
  objs[catalog - 1] = ascii(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  objs[pagesObj - 1] = ascii(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const chunks = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = concat([ascii(`${i + 1} 0 obj\n`), o, ascii('\nendobj\n')]);
    chunks.push(b);
    pos += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(ascii(xref));
  chunks.push(ascii(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return concat(chunks);
}

// Tabelle als feste Spalten für das PDF
export function pdfTable(columns, rows) {
  const fmt = (v, w, right) => {
    const s = v === null || v === undefined ? '' : String(v);
    const t = s.length > w ? s.slice(0, w - 1) + '…' : s;
    return right ? t.padStart(w) : t.padEnd(w);
  };
  const head = columns.map((c) => fmt(c.label, c.width, c.right)).join(' ');
  const lines = [{ text: head, bold: true }, '-'.repeat(head.length)];
  for (const r of rows) lines.push(columns.map((c) => fmt(typeof c.value === 'function' ? c.value(r) : r[c.key], c.width, c.right)).join(' '));
  return lines;
}
