// Stammdaten zwischen Geräten übertragen (ohne Live-Verbindung):
// Gerät A exportiert eine Datei, Gerät B liest sie ein und gleicht sich 1:1 an.
// Übertragen werden: Kategorien, Artikel (mit Varianten), Tische, Tischplan, Rollenrechte, Mitarbeiter (mit PIN),
// Einstellungen. NICHT übertragen: Buchungen, Rechnungen, Protokoll, Lizenz – jedes Gerät bleibt eigenständig.
// Die Datei ist mit einem Übertragungs-Passwort verschlüsselt (AES-GCM), weil sie die PINs enthält.
// Beim Einlesen wird nichts gelöscht: Was in der Datei fehlt, wird deaktiviert. Jede Änderung wird protokolliert.
import { one, all, run, tx } from './db.js';
import { logEvent, logAdmin } from './audit.js';
import { requirePerm, getSettings, publicUser, resetSettingsCache } from './auth.js';
import { fail, nowIso } from './util.js';
import { sha256, randomBytes, base64url } from './crypto.js';
import { saveCategory, saveArticle, saveTable, getPlan, savePlan, listRoles, saveRole, saveSettings } from './manage.js';
import { deviceId } from './license.js';

const FORMAT = 'kassensystem-stammdaten';
const ITER = 200000;
const lc = (s) => String(s ?? '').trim().toLowerCase();
const fromB64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4)), (c) => c.charCodeAt(0));
const subtle = () => globalThis.crypto.subtle;

async function aesKey(password, salt) {
  if (String(password || '').length < 6) fail(400, 'Das Übertragungs-Passwort muss mindestens 6 Zeichen haben');
  const base = await subtle().importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function collect() {
  const cats = all('SELECT * FROM categories ORDER BY sort, id');
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const settings = {};
  for (const r of all("SELECT key, value FROM settings WHERE key<>'floor_plan' ORDER BY key")) settings[r.key] = JSON.parse(r.value);
  return {
    categories: cats.map((c) => ({ name: c.name, kind: c.kind, color: c.color, sort: c.sort, active: c.active })),
    articles: all('SELECT * FROM articles ORDER BY sort, id').map((a) => ({
      name: a.name, category: catName.get(a.category_id), price: a.price, vat: a.vat, plu: a.plu, track_stock: a.track_stock, active: a.active, sort: a.sort,
      variants: all('SELECT name, price FROM article_variants WHERE article_id=? AND active=1 ORDER BY sort, id', a.id).map((v) => ({ name: v.name, price: v.price })),
    })),
    tables: all('SELECT number, name, area, seats, active FROM dining_tables ORDER BY number').map((t) => ({ ...t })),
    plan: getPlan(),
    roles: listRoles().map((r) => ({ code: r.code, permissions: r.permissions })),
    users: all('SELECT personal_nr, name, role, active, pin_hash FROM users ORDER BY personal_nr').map((u) => ({ ...u })),
    settings,
  };
}

export async function exportMaster(actor, password) {
  requirePerm(actor, 'manage');
  const data = collect();
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await aesKey(password, salt);
  const plain = new TextEncoder().encode(JSON.stringify({ checksum: sha256(JSON.stringify(data)), data }));
  const cipher = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain));
  const counts = { kategorien: data.categories.length, artikel: data.articles.length, tische: data.tables.length, mitarbeiter: data.users.length };
  tx(() => logEvent(actor, { type: 'MASTER_EXPORTED', category: 'admin', after: counts }));
  const s = getSettings();
  return {
    format: FORMAT, version: 1, exported_at: nowIso(), business: s.business_name, device: deviceId(), counts,
    enc: { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: ITER, salt: base64url(salt), iv: base64url(iv) },
    payload: base64url(cipher),
  };
}

async function decrypt(pkg, password) {
  if (!pkg || pkg.format !== FORMAT) fail(400, 'Das ist keine Stammdaten-Datei der Kasse');
  if (pkg.version !== 1) fail(400, 'Diese Stammdaten-Datei stammt aus einer neueren App-Version – bitte zuerst die App aktualisieren');
  let plain;
  try {
    const key = await aesKey(password, fromB64(pkg.enc.salt));
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(pkg.enc.iv) }, key, fromB64(pkg.payload));
  } catch (e) {
    if (e?.status) throw e;
    fail(400, 'Falsches Übertragungs-Passwort oder die Datei ist beschädigt');
  }
  const { checksum, data } = JSON.parse(new TextDecoder().decode(plain));
  if (sha256(JSON.stringify(data)) !== checksum) fail(400, 'Die Datei ist beschädigt');
  return data;
}

const ROLLBACK = Symbol('vorschau');
export async function importMaster(actor, pkg, password, { dryRun = false } = {}) {
  requirePerm(actor, 'manage');
  const D = await decrypt(pkg, password);
  const sum = { neu: {}, geaendert: {}, deaktiviert: {}, hinweise: [], quelle: { betrieb: pkg.business, geraet: pkg.device, exportiert: pkg.exported_at } };
  const inc = (k, t) => { sum[k][t] = (sum[k][t] || 0) + 1; };
  const note = (m) => sum.hinweise.push(m);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  try {
    return tx(() => {
      // 1. Kategorien (Schlüssel: Name)
      const curC = all('SELECT * FROM categories');
      const inC = new Set(D.categories.map((c) => lc(c.name)));
      for (const c of D.categories) {
        const ex = curC.find((x) => lc(x.name) === lc(c.name));
        const want = { name: c.name, kind: c.kind, color: c.color, sort: c.sort, active: c.active };
        if (!ex) { saveCategory(actor, null, want); inc('neu', 'kategorien'); } else if (!same([ex.name, ex.kind, ex.color, ex.sort, ex.active], [c.name, c.kind, c.color, c.sort, c.active])) { saveCategory(actor, ex.id, want); inc('geaendert', 'kategorien'); }
      }
      for (const ex of curC) if (ex.active && !inC.has(lc(ex.name))) { saveCategory(actor, ex.id, { ...ex, active: 0 }); inc('deaktiviert', 'kategorien'); }

      // 2. Artikel mit Varianten (Schlüssel: Name)
      const catId = new Map(all('SELECT id, name FROM categories').map((c) => [lc(c.name), c.id]));
      const curA = all('SELECT * FROM articles');
      const inA = new Set(D.articles.map((a) => lc(a.name)));
      for (const a of D.articles) {
        const cid = catId.get(lc(a.category));
        if (!cid) { note(`Artikel „${a.name}“ übersprungen: Kategorie fehlt`); continue; }
        const ex = curA.find((x) => lc(x.name) === lc(a.name));
        let plu = a.plu ?? null;
        if (plu && one('SELECT id FROM articles WHERE plu=? AND id<>?', plu, ex?.id || 0)) { note(`Artikelnummer ${plu} von „${a.name}“ ist hier schon vergeben – ohne Nummer übernommen`); plu = null; }
        const exV = ex ? all('SELECT id, name, price, active FROM article_variants WHERE article_id=? ORDER BY sort, id', ex.id) : [];
        const variants = (a.variants || []).map((v) => ({ id: exV.find((e) => lc(e.name) === lc(v.name))?.id, name: v.name, price: v.price }));
        const want = { name: a.name, category_id: cid, price: a.price, vat: a.vat, plu, track_stock: a.track_stock, active: a.active, sort: a.sort, variants };
        if (!ex) { saveArticle(actor, null, want); inc('neu', 'artikel'); continue; }
        const vNow = exV.filter((v) => v.active).map((v) => [v.name, v.price]);
        const vWant = variants.map((v) => [v.name, v.price]);
        if (!same([ex.name, ex.category_id, vWant.length ? 0 : ex.price, ex.vat, ex.plu ?? null, ex.track_stock, ex.active, ex.sort, vNow],
          [a.name, cid, vWant.length ? 0 : a.price, a.vat, plu, a.track_stock, a.active, a.sort, vWant])) { saveArticle(actor, ex.id, want); inc('geaendert', 'artikel'); }
      }
      for (const ex of curA) if (ex.active && !inA.has(lc(ex.name))) { saveArticle(actor, ex.id, { ...ex, active: 0 }); inc('deaktiviert', 'artikel'); }

      // 3. Rollenrechte (feste Rollen)
      const curR = listRoles();
      for (const r of D.roles || []) {
        const ex = curR.find((x) => x.code === r.code);
        if (!ex) { note(`Rolle „${r.code}“ gibt es hier nicht – übersprungen`); continue; }
        if (!same([...ex.permissions].sort(), [...r.permissions].sort())) {
          try { saveRole(actor, r.code, { permissions: r.permissions }); inc('geaendert', 'rollen'); } catch (e) { note(`Rolle „${ex.name}“: ${e.message}`); }
        }
      }

      // 4. Mitarbeiter (Schlüssel: Personalnummer), inkl. PIN
      const clean = (u) => ({ ...publicUser(u), active: u.active });
      const curU = all('SELECT * FROM users');
      const inU = new Set(D.users.map((u) => u.personal_nr));
      for (const u of D.users) {
        if (!one('SELECT code FROM roles WHERE code=?', u.role)) { note(`Mitarbeiter ${u.personal_nr} übersprungen: unbekannte Rolle`); continue; }
        if (!/^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(String(u.pin_hash))) { note(`Mitarbeiter ${u.personal_nr} übersprungen: ungültige PIN-Daten`); continue; }
        const ex = curU.find((x) => x.personal_nr === u.personal_nr);
        if (!ex) {
          const r = run('INSERT INTO users(personal_nr,name,role,pin_hash,active,created_at) VALUES(?,?,?,?,?,?)', u.personal_nr, u.name, u.role, u.pin_hash, u.active ? 1 : 0, nowIso());
          const nid = Number(r.lastInsertRowid);
          logAdmin(actor, 'USER_CREATED', 'benutzer', nid, null, { personal_nr: u.personal_nr, name: u.name, role: u.role, active: u.active, id: nid }, { details: { quelle: 'Stammdaten-Übernahme' } });
          inc('neu', 'mitarbeiter');
          continue;
        }
        const self = ex.id === actor.user.id;
        let role = u.role, active = u.active ? 1 : 0;
        if (self && (role !== ex.role || !active)) { role = ex.role; active = 1; note('Ihr eigenes Konto behält Rolle und Aktivierung'); }
        const pinChanged = ex.pin_hash !== u.pin_hash;
        if (self && pinChanged) note('Ihre eigene PIN ist jetzt die PIN aus der Datei');
        if (same([ex.name, ex.role, ex.active], [u.name, role, active]) && !pinChanged) continue;
        run('UPDATE users SET name=?, role=?, active=?, pin_hash=? WHERE id=?', u.name, role, active, u.pin_hash, ex.id);
        if (pinChanged) run('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?', ex.id);
        logAdmin(actor, 'USER_UPDATED', 'benutzer', ex.id, clean(ex), clean(one('SELECT * FROM users WHERE id=?', ex.id)), { details: { pin_geaendert: pinChanged, quelle: 'Stammdaten-Übernahme' } });
        if (!active) run("UPDATE sessions SET ended_at=?, end_reason='Konto deaktiviert' WHERE user_id=? AND ended_at IS NULL", nowIso(), ex.id);
        inc('geaendert', 'mitarbeiter');
      }
      for (const ex of curU) {
        if (!ex.active || inU.has(ex.personal_nr)) continue;
        if (ex.id === actor.user.id) { note(`Ihr eigenes Konto (Nr. ${ex.personal_nr}) fehlt in der Datei und bleibt aktiv`); continue; }
        run('UPDATE users SET active=0 WHERE id=?', ex.id);
        logAdmin(actor, 'USER_UPDATED', 'benutzer', ex.id, clean(ex), { ...clean(ex), active: 0 }, { details: { quelle: 'Stammdaten-Übernahme' } });
        run("UPDATE sessions SET ended_at=?, end_reason='Konto deaktiviert' WHERE user_id=? AND ended_at IS NULL", nowIso(), ex.id);
        inc('deaktiviert', 'mitarbeiter');
      }
      if (!one("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").c) fail(409, 'Nach der Übernahme gäbe es keinen aktiven Administrator – abgebrochen');

      // 5. Tische (Schlüssel: Nummer)
      const curT = all('SELECT * FROM dining_tables');
      const inT = new Set(D.tables.map((t) => t.number));
      for (const t of D.tables) {
        const ex = curT.find((x) => x.number === t.number);
        const want = { number: t.number, name: t.name, area: t.area, seats: t.seats, active: t.active };
        try {
          if (!ex) { saveTable(actor, null, want); inc('neu', 'tische'); } else if (!same([ex.name || null, ex.area, ex.seats, ex.active], [t.name || null, t.area, t.seats, t.active])) { saveTable(actor, ex.id, want); inc('geaendert', 'tische'); }
        } catch (e) { note(`Tisch ${t.number}: ${e.message}`); }
      }
      for (const ex of curT) {
        if (!ex.active || inT.has(ex.number)) continue;
        try { saveTable(actor, ex.id, { ...ex, active: 0 }); inc('deaktiviert', 'tische'); } catch (e) { note(`Tisch ${ex.number} bleibt aktiv: ${e.message}`); }
      }

      // 6. Tischplan
      if (!same(getPlan(), D.plan?.areas ? D.plan : { areas: [] })) {
        const r = savePlan(actor, D.plan?.areas ? D.plan : { areas: [] });
        inc('geaendert', 'tischplan');
        if (r.tische_neu) note(`${r.tische_neu} Tische aus dem Tischplan zusätzlich angelegt`);
      }

      // 7. Einstellungen
      const sr = saveSettings(actor, D.settings || {});
      if (sr.changed) sum.geaendert.einstellungen = sr.changed;

      if (dryRun) throw ROLLBACK;
      logEvent(actor, { type: 'MASTER_IMPORTED', category: 'admin', reason: `Stammdaten von ${pkg.business || 'anderem Gerät'}`,
        after: { neu: sum.neu, geaendert: sum.geaendert, deaktiviert: sum.deaktiviert }, details: { quelle: sum.quelle, hinweise: sum.hinweise } });
      return sum;
    });
  } catch (e) {
    if (e === ROLLBACK) { resetSettingsCache(); return sum; }
    throw e;
  }
}
