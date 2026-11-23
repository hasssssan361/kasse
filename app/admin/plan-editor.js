// Tischplan-Editor (Admin-Bereich → Verwaltung → Tischplan)
// Elemente per Finger/Maus verschieben, am blauen Anfasser in der Größe ändern, Eigenschaften unten bearbeiten.
// Gespeichert wird erst mit „Plan speichern“ – dann legt die Kasse fehlende Tische automatisch an (protokolliert).
import { $, $$, esc, h, toast, modal, confirmDialog } from '../shared/core.js';
import { planSvg, spots, NEW_AREA, SIDES, counterSeats, seatList } from '../shared/plan.js';

const SNAP = 10;
const snap = (v) => Math.round(v / SNAP) * SNAP;
const TYPE_NAME = { table: 'Tisch', counter: 'Tresen', entrance: 'Eingang', slot: 'Spielautomat', zone: 'Bereich (z. B. Terrasse)' };
const SHAPE_NAME = { rect: 'Rechteck', square: 'Quadrat', circle: 'Kreis' };

export function planEditor(box, { META, api, canEdit, onSaved }) {
  const plan = structuredClone(META.plan?.areas?.length ? META.plan : { areas: [NEW_AREA()] });
  let ai = 0;
  let sel = null;
  let selSeat = null; // ausgewählter Tresenplatz { side, i }
  let dirty = false;
  let zoom = 1;
  const area = () => plan.areas[ai];
  const elOf = (id) => area().elements.find((e) => e.id === id);
  const setDirty = (d = true) => { dirty = d; const b = $('#pdirty', box); if (b) b.style.display = dirty ? '' : 'none'; };
  const uid = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Nummern: im Plan belegte Nummern; vorhandene Tische mit freier Nummer werden beim Speichern übernommen
  const usedNums = (skip) => new Set(plan.areas.flatMap((a) => a.elements.filter((e) => e !== skip).flatMap((e) => spots(e).map((s) => s.number))));
  const nextNumber = () => { const u = usedNums(); let n = 1; while (u.has(n)) n++; return n; };
  // k nächste freie Nummern (gemeinsame fortlaufende Nummerierung von Tischen, Tresenplätzen und Automaten)
  const nextNumbers = (k) => { const u = usedNums(); const out = []; let n = 1; while (out.length < k) { if (!u.has(n)) out.push(n); n++; } return out; };

  // Ältere Pläne angleichen: Tresen → Platzlisten je Seite; Automaten ohne Nummer bekommen eine
  let upgraded = false;
  for (const a of plan.areas) for (const e of a.elements) {
    if (e.type === 'counter' && !e.seats) { e.seats = counterSeats(e); delete e.seat_count; delete e.seat_start; delete e.seat_side; upgraded = true; }
  }
  for (const a of plan.areas) for (const e of a.elements) if (e.type === 'slot' && !e.number) { e.number = nextNumber(); upgraded = true; }

  // Freien Platz für ein neues Element suchen (Raster), sonst Mitte
  function place(w, hh) {
    const A = area();
    // Abstand 50 rundum (Tresenplätze sitzen bis zu 41 Einheiten außerhalb des Tresens)
    const hit = (x, y) => A.elements.some((e) => e.type !== 'zone' && x < e.x + e.w + 50 && x + w + 50 > e.x && y < e.y + e.h + 50 && y + hh + 50 > e.y);
    for (let y = 40; y + hh <= A.h - 20; y += 40) for (let x = 40; x + w <= A.w - 20; x += 40) if (!hit(x, y)) return { x, y };
    return { x: snap((A.w - w) / 2), y: snap((A.h - hh) / 2) };
  }
  function add(type, shape = 'rect') {
    const D = {
      table: { rect: [140, 90, 6], square: [90, 90, 4], circle: [90, 90, 4] }[shape],
      counter: [360, 70], entrance: [170, 50], slot: shape === 'square' ? [80, 80] : [70, 110], zone: [520, 300],
    }[type];
    const e = { id: uid(), type, shape, w: D[0], h: D[1], label: '' };
    if (type === 'table') Object.assign(e, { number: nextNumber(), seats: D[2] });
    if (type === 'counter') Object.assign(e, { seats: { unten: nextNumbers(6), rechts: [], oben: [], links: [] }, label: 'Tresen' });
    if (type === 'entrance') e.label = 'Eingang';
    if (type === 'slot') Object.assign(e, { label: 'Automat', number: nextNumber() });
    if (type === 'zone') e.label = 'Terrasse';
    Object.assign(e, type === 'zone' ? { x: 20, y: snap(area().h - D[1] - 20) } : place(e.w, e.h));
    area().elements.push(e);
    sel = e.id;
    setDirty();
    draw(true);
  }

  box.innerHTML = `<div class="plan-ed">
    <div class="row" id="pareas" style="margin-bottom:8px"></div>
    ${canEdit ? `<div class="row" style="margin-bottom:8px">
      <span class="small muted" style="width:100%">Hinzufügen:</span>
      <button class="btn sm" data-add="table" data-shape="rect">▭ Tisch</button>
      <button class="btn sm" data-add="table" data-shape="square">◻ Tisch</button>
      <button class="btn sm" data-add="table" data-shape="circle">◯ Tisch</button>
      <button class="btn sm" data-add="counter">Tresen</button>
      <button class="btn sm" data-add="entrance">Eingang</button>
      <button class="btn sm" data-add="slot" data-shape="square">◻ Automat</button>
      <button class="btn sm" data-add="slot" data-shape="rect">▯ Automat</button>
      <button class="btn sm" data-add="zone">Terrasse / Bereich</button></div>` : ''}
    <div class="row" style="margin-bottom:6px;justify-content:space-between">
      <span class="small muted">${canEdit ? 'Objekt mit dem Finger ziehen = verschieben, blauer Punkt = Größe ändern, leere Fläche ziehen = Ansicht verschieben.' : 'Nur ansehen – Ändern erfordert das Recht „Verwaltung“.'}</span>
      <span class="row"><button class="btn sm" id="pzo" aria-label="Verkleinern">−</button><button class="btn sm" id="pzi" aria-label="Vergrößern">+</button></span></div>
    <div class="plan-wrap"><div id="pcv"></div></div>
    <div id="pprops" style="margin-top:10px"></div>
    ${canEdit ? `<div class="row plan-savebar">
      <span class="badge warn" id="pdirty" style="display:none">ungespeicherte Änderungen</span><span style="flex:1"></span>
      <button class="btn" id="preset">Verwerfen</button><button class="btn primary" id="psave">Plan speichern</button></div>` : ''}</div>`;

  // ---- Bereiche (Gastraum, Terrasse, …) ----
  function drawAreas() {
    $('#pareas', box).innerHTML = plan.areas.map((a, i) => `<button class="chip ${i === ai ? 'on' : ''}" data-ai="${i}">${esc(a.name)}${i === ai && canEdit ? ' ✎' : ''}</button>`).join('')
      + (canEdit ? '<button class="chip" id="padd">+ Bereich</button>' : '');
    $$('[data-ai]', box).forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.ai);
      if (i === ai && canEdit) return editArea();
      ai = i; sel = null; draw(true);
    }));
    $('#padd', box)?.addEventListener('click', () => {
      const n = plan.areas.length === 1 && !plan.areas.some((a) => a.name === 'Terrasse') ? 'Terrasse' : `Bereich ${plan.areas.length + 1}`;
      plan.areas.push({ ...NEW_AREA(), name: n });
      ai = plan.areas.length - 1; sel = null; setDirty(); draw(true); editArea();
    });
  }
  function editArea() {
    const A = area();
    const body = h(`<div class="fields"><label class="field">Name<input name="name" value="${esc(A.name)}" maxlength="30"></label>
      <label class="field">Breite<input name="w" type="number" value="${A.w}" min="400" max="4000" step="100"></label>
      <label class="field">Höhe<input name="h" type="number" value="${A.h}" min="300" max="4000" step="100"></label></div>
      <p class="small muted" style="margin-top:10px">Der Name erscheint an der Kasse als Reiter (z. B. „Gastraum“, „Terrasse“). Tische dieses Bereichs bekommen ihn beim Speichern.</p>`);
    const actions = [];
    if (plan.areas.length > 1) actions.push({ label: 'Bereich entfernen', kind: 'danger', onClick: async () => {
      if (A.elements.length && !(await confirmDialog('Bereich entfernen', `„${A.name}“ mit ${A.elements.length} Elementen aus dem Plan entfernen? Bereits angelegte Tische bleiben bestehen und können unter „Tische“ deaktiviert werden.`, 'Entfernen', 'danger'))) return false;
      plan.areas.splice(ai, 1); ai = 0; sel = null; setDirty(); draw(true);
    } });
    actions.push({ label: 'Abbrechen' }, { label: 'Übernehmen', kind: 'primary', onClick: () => {
      const name = $('[name=name]', body).value.trim();
      if (!name) { toast('Bitte einen Namen angeben', 'error'); return false; }
      if (plan.areas.some((a, i) => i !== ai && a.name.toLowerCase() === name.toLowerCase())) { toast('Diesen Bereich gibt es schon', 'error'); return false; }
      const w = Math.min(4000, Math.max(400, Number($('[name=w]', body).value) || A.w));
      const hh = Math.min(4000, Math.max(300, Number($('[name=h]', body).value) || A.h));
      Object.assign(A, { name, w, h: hh });
      for (const e of A.elements) { e.w = Math.min(e.w, w); e.h = Math.min(e.h, hh); e.x = Math.min(e.x, w - e.w); e.y = Math.min(e.y, hh - e.h); }
      setDirty(); draw(true);
    } });
    modal({ title: 'Bereich bearbeiten', body, actions });
  }

  // ---- Zeichnen ----
  let svg = null;
  function draw(full) {
    const html = planSvg(area(), { edit: canEdit, sel, seat: selSeat });
    if (full || !svg) {
      drawAreas();
      $('#pcv', box).innerHTML = html;
      svg = $('svg', $('#pcv', box));
      svg.style.width = `${zoom * 100}%`;
      bind();
      drawProps();
    } else {
      const t = document.createElement('template');
      t.innerHTML = html;
      svg.replaceChildren(...t.content.firstElementChild.childNodes);
    }
  }
  const toPlan = (ev) => { const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };

  function bind() {
    if (!canEdit) return;
    // Touch: Die Zeichenfläche gehört beim Bearbeiten ganz dem Finger (touch-action: none, siehe CSS),
    // sonst wertet der Browser die Bewegung als Scrollen und bricht das Ziehen ab.
    // Leere Fläche ziehen = Ansicht verschieben; Element ziehen = Element verschieben.
    // Wichtig: Während des Ziehens wird das Element unter dem Finger nicht neu erzeugt, nur verschoben.
    let drag = null;
    let raf = 0;
    const wrap = svg.closest('.plan-wrap');
    svg.addEventListener('contextmenu', (ev) => ev.preventDefault());
    svg.addEventListener('touchmove', (ev) => ev.preventDefault(), { passive: false });
    svg.addEventListener('pointerdown', (ev) => {
      if (drag) return; // zweiter Finger: ignorieren
      ev.preventDefault();
      try { svg.setPointerCapture(ev.pointerId); } catch {}
      const hdl = ev.target.closest('.hdl');
      const g = ev.target.closest('.pe');
      if (!hdl && !g) {
        drag = { mode: 'pan', id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, sl: wrap.scrollLeft, wy: scrollY, moved: false };
        return;
      }
      const id = hdl ? sel : g.dataset.id;
      const e = elOf(id);
      if (!e) return;
      // Tresenplatz angetippt → diesen Platz bearbeiten (Ziehen verschiebt weiter den ganzen Tresen)
      const seatEl = !hdl && ev.target.closest('.seat');
      if (!hdl) selSeat = seatEl ? { side: seatEl.dataset.side, i: Number(seatEl.dataset.i) } : null;
      const node = hdl ? null : g;
      drag = { mode: hdl ? 'size' : 'move', id: ev.pointerId, eid: id, node, p0: toPlan(ev), o: { ...e }, moved: false, wasSel: id === sel };
      if (!hdl && id !== sel) {
        // Auswahl nur optisch markieren – das Element unter dem Finger bleibt dasselbe DOM-Element
        sel = id;
        $$('.selbox,.hdl', svg).forEach((n) => n.remove());
        node.classList.add('sel');
      }
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      ev.preventDefault();
      if (drag.mode === 'pan') {
        const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        wrap.scrollLeft = drag.sl - dx;
        scrollTo(scrollX, drag.wy - dy);
        return;
      }
      const e = elOf(drag.eid);
      const A = area();
      const p = toPlan(ev);
      const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      if (drag.mode === 'move') {
        e.x = Math.min(Math.max(snap(drag.o.x + dx), 0), A.w - e.w);
        e.y = Math.min(Math.max(snap(drag.o.y + dy), 0), A.h - e.h);
        // Nur verschieben (transform), nicht neu zeichnen
        drag.node.setAttribute('transform', `translate(${e.x - drag.o.x} ${e.y - drag.o.y})`);
        $$('.selbox,.hdl', svg).forEach((n) => n.remove());
        return;
      } else {
        const min = e.type === 'counter' ? 40 : 30;
        let w = Math.max(min, snap(drag.o.w + dx)), hh = Math.max(min, snap(drag.o.h + dy));
        if (e.shape !== 'rect') w = hh = Math.max(w, hh);
        e.w = Math.min(w, A.w - e.x); e.h = Math.min(hh, A.h - e.y);
        if (e.shape !== 'rect') e.w = e.h = Math.min(e.w, e.h);
      }
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
    });
    const end = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (d.mode === 'pan') { if (!d.moved && sel) { sel = null; selSeat = null; draw(); drawProps(); } return; }
      if (d.moved) setDirty();
      draw(); drawProps(); // jetzt (Finger ist weg) sauber neu zeichnen: Auswahlrahmen, Anfasser, Eigenschaften
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  // ---- Eigenschaften des ausgewählten Elements ----
  function drawProps() {
    const P = $('#pprops', box);
    const e = sel && elOf(sel);
    if (!e) {
      const A = area();
      const n = A.elements.reduce((s, x) => s + spots(x).length, 0);
      P.innerHTML = `<div class="small muted">${esc(A.name)}: ${A.elements.length} Elemente, ${n} buchbare Plätze.${canEdit ? ' Element antippen, um es zu bearbeiten.' : ''}</div>`;
      return;
    }
    const f = (k, l, type = 'text', extra = '') => `<label class="field">${l}<input name="${k}" type="${type}" value="${esc(e[k] ?? '')}" ${extra} ${canEdit ? '' : 'disabled'}></label>`;
    const shapes = e.type === 'table' ? ['rect', 'square', 'circle'] : e.type === 'slot' ? ['square', 'rect'] : [];
    P.innerHTML = `<div class="card" style="padding:12px"><div class="row" style="justify-content:space-between;margin-bottom:10px">
        <b>${TYPE_NAME[e.type]}${e.type === 'table' ? ' ' + e.number : ''}</b>
        ${shapes.length ? `<span class="row">${shapes.map((s) => `<button class="chip ${e.shape === s ? 'on' : ''}" data-shape="${s}" ${canEdit ? '' : 'disabled'}>${SHAPE_NAME[s]}</button>`).join('')}</span>` : ''}</div>
      <div class="fields">
        ${e.type === 'table' ? f('number', 'Tischnummer', 'number', 'min="1" max="9999"') + f('seats', 'Plätze', 'number', 'min="0" max="99"') + f('label', 'Bezeichnung (optional)', 'text', 'maxlength="30" placeholder="z. B. Fenster"') : ''}
        ${e.type === 'counter' ? f('label', 'Bezeichnung', 'text', 'maxlength="30"') + SIDES.map((sd) => `<label class="field">Plätze ${sd}<input name="cnt_${sd}" type="number" min="0" max="30" value="${counterSeats(e)[sd].length}" ${canEdit ? '' : 'disabled'}></label>`).join('') : ''}
        ${e.type === 'slot' ? f('number', 'Platznummer (buchbar)', 'number', 'min="1" max="9999"') : ''}
        ${['entrance', 'slot', 'zone'].includes(e.type) ? f('label', 'Beschriftung', 'text', 'maxlength="30"') : ''}
        ${f('w', 'Breite', 'number', 'min="20" step="10"')}${e.shape === 'rect' ? f('h', 'Höhe', 'number', 'min="20" step="10"') : ''}
      </div>
      ${e.type === 'counter' ? (() => {
        const seat = selSeat && counterSeats(e)[selSeat.side]?.[selSeat.i];
        return `<p class="small muted" style="margin-top:8px">Jeder Gastplatz ist an der Kasse buchbar wie ein Tisch. Einen Platz im Plan antippen, um seine Nummer zu ändern.</p>
        ${seat ? `<div class="fields" style="margin-top:8px"><label class="field">Nummer des ausgewählten Platzes (${selSeat.side})<input name="seatnum" type="number" min="1" max="9999" value="${seat}"></label></div>` : ''}
        <div class="row" style="margin-top:8px"><span class="small">Alle Plätze fortlaufend nummerieren ab</span><input id="pren" type="number" min="1" max="9999" style="width:90px" value="${seatList(e)[0]?.number || nextNumber()}"><button class="btn sm" id="prenb">Nummerieren</button></div>`;
      })() : ''}
      ${e.type === 'slot' ? '<p class="small muted" style="margin-top:8px">An Automaten kann gebucht werden wie an einem Tisch (Nummer steht im Bildschirm).</p>' : ''}
      ${canEdit ? `<div class="row" style="margin-top:12px">
        ${e.shape === 'rect' ? '<button class="btn sm" id="prot">Drehen 90°</button>' : ''}
        <button class="btn sm" id="pdup">Duplizieren</button><button class="btn sm danger" id="pdel">Entfernen</button></div>` : ''}</div>`;
    if (!canEdit) return;
    const A = area();
    $$('input,select', P).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.name;
      let v = inp.type === 'number' ? Math.round(Number(inp.value)) : inp.value;
      if (inp.type === 'number' && !Number.isFinite(v)) return drawProps();
      if (k === 'w' || k === 'h') {
        v = Math.max(20, Math.min(v, k === 'w' ? A.w : A.h));
        if (e.shape !== 'rect') e.w = e.h = Math.min(v, A.w, A.h); else e[k] = v;
        e.x = Math.min(e.x, A.w - e.w); e.y = Math.min(e.y, A.h - e.h);
      } else if (k === 'number') {
        if (v < 1 || usedNums(e).has(v)) { toast(v < 1 ? 'Ungültige Nummer' : `Nummer ${v} ist im Plan schon vergeben`, 'error'); return drawProps(); }
        e.number = v;
      } else if (k.startsWith('cnt_')) {
        const sd = k.slice(4);
        const seats = counterSeats(e);
        const want = Math.max(0, Math.min(30, v));
        if (want > seats[sd].length) seats[sd].push(...nextNumbers(want - seats[sd].length));
        else seats[sd] = seats[sd].slice(0, want);
        e.seats = seats;
        if (selSeat && !seats[selSeat.side]?.[selSeat.i]) selSeat = null;
      } else if (k === 'seatnum') {
        const seats = counterSeats(e);
        const others = new Set([...usedNums(e), ...seatList(e).filter((x) => !(x.side === selSeat.side && x.i === selSeat.i)).map((x) => x.number)]);
        if (v < 1 || others.has(v)) { toast(v < 1 ? 'Ungültige Nummer' : `Nummer ${v} ist im Plan schon vergeben`, 'error'); return drawProps(); }
        seats[selSeat.side][selSeat.i] = v;
        e.seats = seats;
      } else e[k] = v;
      setDirty(); draw(); drawProps();
    }));
    $$('[data-shape]', P).forEach((b) => b.addEventListener('click', () => {
      e.shape = b.dataset.shape;
      if (e.shape !== 'rect') e.w = e.h = Math.min(e.w, e.h);
      else if (e.w === e.h) e.w = Math.min(snap(e.w * 1.5), A.w - e.x);
      setDirty(); draw(); drawProps();
    }));
    $('#prenb', P)?.addEventListener('click', () => {
      const start = Math.round(Number($('#pren', P).value));
      const list = seatList(e);
      const used = usedNums(e);
      const nums = list.map((_, k) => start + k);
      const clash = nums.find((n) => used.has(n));
      if (!(start >= 1) || clash) return toast(clash ? `Nummer ${clash} ist im Plan schon vergeben` : 'Ungültige Nummer', 'error');
      const seats = counterSeats(e);
      list.forEach((x, k) => { seats[x.side][x.i] = nums[k]; });
      e.seats = seats;
      setDirty(); draw(); drawProps();
    });
    $('#prot', P)?.addEventListener('click', () => {
      [e.w, e.h] = [Math.min(e.h, A.w), Math.min(e.w, A.h)];
      if (e.type === 'counter') { const s = counterSeats(e); e.seats = { links: s.unten, oben: s.links, rechts: s.oben, unten: s.rechts }; selSeat = null; }
      e.x = Math.min(e.x, A.w - e.w); e.y = Math.min(e.y, A.h - e.h);
      setDirty(); draw(); drawProps();
    });
    $('#pdup', P).addEventListener('click', () => {
      const c = { ...structuredClone(e), id: uid(), ...place(e.w, e.h) };
      if (c.type === 'table') c.number = nextNumber();
      if (c.type === 'slot') c.number = nextNumber();
      if (c.type === 'counter') { const s = counterSeats(e); const fresh = nextNumbers(seatList(e).length); let k = 0; c.seats = Object.fromEntries(SIDES.map((sd) => [sd, s[sd].map(() => fresh[k++])])); }
      A.elements.push(c); sel = c.id; setDirty(); draw(); drawProps();
    });
    $('#pdel', P).addEventListener('click', () => {
      A.elements = A.elements.filter((x) => x !== e); sel = null; selSeat = null; setDirty(); draw(); drawProps();
    });
  }

  // ---- Zoom, Speichern, Verwerfen ----
  const setZoom = (z) => { zoom = Math.min(4, Math.max(1, z)); svg.style.width = `${zoom * 100}%`; };
  $('#pzi', box).addEventListener('click', () => setZoom(zoom + 0.5));
  $('#pzo', box).addEventListener('click', () => setZoom(zoom - 0.5));
  $$('[data-add]', box).forEach((b) => b.addEventListener('click', () => add(b.dataset.add, b.dataset.shape || 'rect')));
  $('#preset', box)?.addEventListener('click', async () => { if (!dirty || await confirmDialog('Verwerfen', 'Alle ungespeicherten Änderungen am Plan verwerfen?', 'Verwerfen', 'danger')) onSaved(); });
  $('#psave', box)?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      const r = await api.put('/api/admin/plan', plan);
      setDirty(false);
      toast(r.tische_neu ? `Plan gespeichert – ${r.tische_neu} Tische/Plätze neu angelegt` : 'Plan gespeichert (protokolliert)', 'ok');
      onSaved();
    } catch (e) { toast(e.message, 'error', 7000); } finally { b.disabled = false; }
  });
  addEventListener('beforeunload', (ev) => { if (dirty && document.contains(box)) { ev.preventDefault(); ev.returnValue = ''; } });
  draw(true);
  if ($('#pcv', box).clientWidth < 600) setZoom(2); // Handy: größer starten, seitlich wischen
  if (upgraded && canEdit) {
    setDirty();
    toast('Plan an die neue Version angepasst (Automaten haben Nummern bekommen) – bitte prüfen und „Plan speichern“', 'info', 9000);
  }
  return { isDirty: () => dirty };
}
