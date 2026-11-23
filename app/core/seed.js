// Ersteinrichtung: Rollen, erster Administrator, optional Beispieldaten
import { one, all, run, tx } from './db.js';
import { logEvent } from './audit.js';
import { DEFAULT_ROLES, hashPin, checkPin, validatePin, requirePerm } from './auth.js';
import { nowIso, fail, int, str } from './util.js';

const SYSTEM = { user: null, device: 'Kassengerät' };

export function ensureBaseData({ demo = false } = {}) {
  tx(() => {
    for (const r of DEFAULT_ROLES) {
      if (!one('SELECT code FROM roles WHERE code=?', r.code)) {
        run('INSERT INTO roles(code,name,level,permissions) VALUES(?,?,?,?)', r.code, r.name, r.level, JSON.stringify(r.permissions));
      }
    }
    if (!one('SELECT id FROM users LIMIT 1')) {
      // Erster Zugang: Personalnummer 1, PIN 123456 – sofort ändern (siehe ANLEITUNG.md)
      run('INSERT INTO users(personal_nr,name,role,pin_hash,created_at) VALUES(?,?,?,?,?)', 1, 'Inhaber (Admin)', 'admin', hashPin('123456'), nowIso());
      logEvent(SYSTEM, { type: 'SYSTEM_START', details: { anlass: 'Ersteinrichtung' } });
      logEvent(SYSTEM, { type: 'USER_CREATED', category: 'admin', after: { personal_nr: 1, name: 'Inhaber (Admin)', role: 'admin' }, details: { anlass: 'Ersteinrichtung' } });
    }
  });
  if (demo && !one('SELECT id FROM categories LIMIT 1')) loadDemoData(null);
}

// Beispieldaten zum Ausprobieren: Kategorien, Artikel, Tische und drei Test-Benutzer
export function loadDemoData(actor) {
  if (actor) requirePerm(actor, 'manage');
  if (one('SELECT id FROM categories LIMIT 1') || one('SELECT id FROM dining_tables LIMIT 1')) {
    fail(409, 'Beispieldaten können nur geladen werden, solange noch keine Kategorien und Tische angelegt sind.');
  }
  return tx(() => {
    const cats = [
      ['Alkoholfrei', 'getraenk', '#0ea5e9', 19, [['Cola 0,33 l', 380, 1, 1], ['Cola Zero 0,33 l', 380, 2, 1], ['Apfelschorle 0,4 l', 420, 3, 1],
        ['Mineralwasser 0,75 l', 650, 4, 1], ['Orangensaft 0,2 l', 350, 5, 1], ['Ginger Ale 0,2 l', 390, 6, 1]]],
      ['Bier & Wein', 'getraenk', '#f59e0b', 19, [['Pils 0,4 l', 480, 11, 1], ['Weizen 0,5 l', 550, 12, 1], ['Alkoholfreies Bier 0,33 l', 420, 13, 1],
        ['Hauswein rot 0,2 l', 690, 14, 0], ['Hauswein weiß 0,2 l', 690, 15, 0], ['Aperol Spritz', 850, 16, 0]]],
      ['Heißgetränke', 'getraenk', '#a16207', 19, [['Espresso', 250, 21, 0], ['Cappuccino', 380, 22, 0], ['Latte Macchiato', 420, 23, 0], ['Tee', 320, 24, 0]]],
      ['Vorspeisen', 'speise', '#22c55e', 7, [['Bruschetta', 790, 31, 0], ['Tomatensuppe', 650, 32, 0], ['Gemischter Salat', 890, 33, 0]]],
      ['Pizza', 'speise', '#ef4444', 7, [['Pizza Margherita', 1050, 41, 0], ['Pizza Salami', 1250, 42, 0], ['Pizza Funghi', 1190, 43, 0], ['Pizza Tonno', 1290, 44, 0]]],
      ['Hauptgerichte', 'speise', '#8b5cf6', 7, [['Schnitzel Wiener Art', 1690, 51, 0], ['Rinderhüftsteak 250 g', 2690, 52, 0], ['Spaghetti Bolognese', 1290, 53, 0], ['Lachsfilet', 2190, 54, 0]]],
      ['Desserts', 'speise', '#ec4899', 7, [['Tiramisu', 690, 61, 0], ['Panna Cotta', 650, 62, 0], ['Eis (3 Kugeln)', 590, 63, 0]]],
    ];
    cats.forEach(([name, kind, color, vat, arts], ci) => {
      const c = Number(run('INSERT INTO categories(name,kind,color,sort) VALUES(?,?,?,?)', name, kind, color, ci).lastInsertRowid);
      arts.forEach(([an, price, plu, track], ai) => {
        run('INSERT INTO articles(plu,name,category_id,price,vat,track_stock,sort) VALUES(?,?,?,?,?,?,?)', plu, an, c, price, vat, track, ai);
      });
    });
    for (let i = 1; i <= 16; i++) run('INSERT INTO dining_tables(number,area,seats) VALUES(?,?,?)', i, 'Gastraum', i % 4 === 0 ? 6 : 4);
    for (let i = 21; i <= 26; i++) run('INSERT INTO dining_tables(number,area,seats) VALUES(?,?,?)', i, 'Terrasse', 4);
    run("INSERT INTO dining_tables(number,name,area,seats) VALUES(90,'Theke','Bar',8)");
    const users = [[2, 'Sabine Schichtleitung', 'schichtleiter', '2222'], [10, 'Anna Service', 'mitarbeiter', '1010'], [11, 'Ben Service', 'mitarbeiter', '1111']];
    for (const [nr, name, role, pin] of users) {
      if (!one('SELECT id FROM users WHERE personal_nr=?', nr)) {
        run('INSERT INTO users(personal_nr,name,role,pin_hash,created_at) VALUES(?,?,?,?,?)', nr, name, role, hashPin(pin), nowIso());
      }
    }
    logEvent(actor || SYSTEM, { type: 'DEMO_DATA_CREATED', category: 'admin', details: { kategorien: cats.length, tische: 23, testbenutzer: users.map((u) => u[1]) } });
    return { ok: true };
  });
}

// ---- Ersteinrichtung nach der Freischaltung ------------------------------------------
// Ein neues Gerät hat nur einen vorläufigen Administrator (Nr. 1, PIN 123456). Bevor sich jemand anmelden kann,
// legt der Kunde einmalig seine eigenen Zugangsdaten fest. Geräte, die schon benutzt werden (weitere Benutzer,
// Buchungen oder geänderte PIN), gelten als eingerichtet – dort erscheint die Ersteinrichtung nie.
export function setupRequired() {
  if (one("SELECT value FROM meta WHERE key='setup_done'")) return false;
  const users = all('SELECT * FROM users');
  const needed = users.length === 1 && !one('SELECT id FROM orders LIMIT 1') && checkPin('123456', users[0].pin_hash);
  if (!needed) run("INSERT OR IGNORE INTO meta(key,value) VALUES('setup_done',?)", nowIso());
  return needed;
}

export function completeSetup(b) {
  if (!setupRequired()) fail(409, 'Die Ersteinrichtung ist bereits abgeschlossen. Zugangsdaten bitte unter Verwaltung → Benutzer ändern.');
  const personal_nr = int(b.personal_nr, 'Personalnummer', { min: 1, max: 99999 });
  const name = str(b.name, 'Ihren Namen', { max: 60 });
  const pin = validatePin(b.pin, 'admin');
  if (String(b.pin2 ?? '') !== pin) fail(400, 'Die beiden PINs stimmen nicht überein');
  const u = one('SELECT * FROM users');
  return tx(() => {
    run('UPDATE users SET personal_nr=?, name=?, pin_hash=?, failed_logins=0, locked_until=NULL WHERE id=?', personal_nr, name, hashPin(pin), u.id);
    run("INSERT OR IGNORE INTO meta(key,value) VALUES('setup_done',?)", nowIso());
    logEvent({ user: { id: u.id, name, role: 'admin' }, device: 'Kassengerät' }, {
      type: 'SETUP_COMPLETED', category: 'admin', before: { personal_nr: u.personal_nr, name: u.name }, after: { personal_nr, name, role: 'admin' },
      details: { pin_festgelegt: true },
    });
    return { ok: true, personal_nr, name };
  });
}
