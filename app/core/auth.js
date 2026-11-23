// Benutzer, Anmeldung, Rollen & Rechte, Freigaben, Einstellungen
import { pbkdf2, randomBytes, toHex, fromHex, safeEqual, base64url } from './crypto.js';
import { db, one, all, run, tx } from './db.js';
import { logEvent } from './audit.js';
import { fail, nowIso, uuid, sha256, int } from './util.js';
import { closeSessionClients } from './events.js';

export const PERMISSIONS = {
  pos: 'Kasse bedienen',
  storno_free: 'Stornieren ohne Freigabe',
  price_change: 'Preise ohne Freigabe ändern',
  discount: 'Rabatte ohne Freigabe gewähren',
  reopen: 'Tische ohne Freigabe wiedereröffnen',
  approve: 'Freigaben für andere erteilen',
  day_close: 'Tages- und fremde Schichtabschlüsse',
  stock: 'Warenentnahmen buchen',
  dashboard: 'Administrator-Dashboard einsehen',
  manage: 'Stammdaten, Benutzer und Einstellungen verwalten',
};
export const DEFAULT_ROLES = [
  { code: 'mitarbeiter', name: 'Mitarbeiter', level: 1, permissions: ['pos'] },
  { code: 'schichtleiter', name: 'Schichtleiter', level: 2, permissions: ['pos', 'storno_free', 'price_change', 'discount', 'reopen', 'approve', 'day_close', 'stock'] },
  { code: 'admin', name: 'Administrator', level: 3, permissions: Object.keys(PERMISSIONS) },
];

export const DEFAULT_SETTINGS = {
  business_name: 'Restaurant Musterhaus',
  business_address: 'Musterstraße 1, 20095 Hamburg',
  business_tax_id: '',
  business_day_start_hour: 4,
  storno_approval_always: 0,
  storno_approval_min_value: 2000,
  storno_approval_after_minutes: 10,
  reopen_requires_approval: 1,
  price_change_requires_approval: 1,
  discount_requires_approval: 1,
  move_requires_reason: 0,
  auto_logout_minutes: 5,
  payment_methods: ['Bar', 'EC-Karte', 'Kreditkarte', 'Gutschein', 'Sonstige'],
  alert_storno_count_day: 5,
  alert_storno_ratio_percent: 15,
  alert_quick_storno_seconds: 60,
  alert_quick_storno_count: 3,
  alert_storno_before_close_minutes: 5,
  alert_moves_count_day: 8,
  alert_reopen_count_day: 2,
  alert_price_changes_day: 3,
  alert_close_storno_count: 3,
  alert_close_storno_share_percent: 30,
  alert_discount_percent: 20,
  backup_interval_minutes: 60,
  backup_keep: 200,
  anchor_interval_minutes: 30,
};

let settingsCache = null;
export function getSettings() {
  if (!settingsCache) {
    const s = { ...DEFAULT_SETTINGS };
    for (const r of all('SELECT key, value FROM settings')) s[r.key] = JSON.parse(r.value);
    settingsCache = s;
  }
  return settingsCache;
}
export const resetSettingsCache = () => { settingsCache = null; };

// ---- PIN-Hashing (scrypt) ----------------------------------------------------
// PINs werden nur als PBKDF2-SHA256-Hash mit Zufallssalz gespeichert
const PIN_ITER = 15000;
export function hashPin(pin) {
  const salt = randomBytes(16);
  return `pbkdf2$${PIN_ITER}$${toHex(salt)}$${toHex(pbkdf2(String(pin), salt, PIN_ITER))}`;
}
export function checkPin(pin, stored) {
  const [, iter, salt, hash] = String(stored).split('$');
  return safeEqual(pbkdf2(String(pin), fromHex(salt), Number(iter)), fromHex(hash));
}
export function validatePin(pin, role) {
  const s = String(pin ?? '');
  const min = role === 'admin' ? 6 : 4;
  if (!/^\d+$/.test(s) || s.length < min || s.length > 12) fail(400, `PIN muss aus ${min}–12 Ziffern bestehen`);
  return s;
}

export function rolePermissions(code) {
  const r = one('SELECT permissions FROM roles WHERE code=?', code);
  return r ? JSON.parse(r.permissions) : [];
}
export const can = (actor, perm) => actor.permissions.includes(perm);
export function requirePerm(actor, perm) {
  if (!can(actor, perm)) fail(403, `Keine Berechtigung: ${PERMISSIONS[perm] || perm}`);
}

const publicUser = (u) => ({ id: u.id, personal_nr: u.personal_nr, name: u.name, role: u.role });

// Konto prüfen (für Anmeldung und Freigaben). Fehlversuche werden gezählt und protokolliert.
function verifyCredentials(personalNr, pin, actorForLog, purpose, what) {
  // Bei Freigaben NIE 401 senden – das würde die Kasse abmelden. Stattdessen erneut fragen.
  const extra = purpose === 'login' ? undefined : { needs_approval: true, what };
  const nr = Number(personalNr);
  if (!Number.isInteger(nr) || nr < 1) fail(purpose === 'login' ? 400 : 403, 'Ungültige Personalnummer', extra);
  const u = one('SELECT * FROM users WHERE personal_nr=?', nr);
  const now = nowIso();
  if (u && u.locked_until && u.locked_until > now) {
    fail(423, 'Konto wegen zu vieler Fehlversuche kurz gesperrt. Bitte in 5 Minuten erneut versuchen.', extra);
  }
  if (!u || !u.active || !checkPin(pin ?? '', u.pin_hash)) {
    tx(() => {
      if (u) {
        const fails = u.failed_logins + 1;
        const locked = fails >= 5 ? new Date(Date.now() + 5 * 60000).toISOString() : null;
        run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', locked ? 0 : fails, locked, u.id);
      }
      logEvent(actorForLog, {
        type: purpose === 'login' ? 'LOGIN_FAILED' : 'APPROVAL_FAILED',
        details: { personal_nr: nr, known_user: !!u, user_name: u?.name || null, inactive: u ? !u.active : null, purpose },
      });
    });
    if (purpose === 'login') fail(401, 'Personalnummer oder PIN falsch');
    fail(403, 'Freigabe abgelehnt: Personalnummer oder PIN falsch', extra);
  }
  if (u.failed_logins || u.locked_until) tx(() => run('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?', u.id));
  return u;
}

export function login({ personal_nr, pin, device, kind }) {
  const dev = String(device || 'Kassengerät').slice(0, 50);
  const k = kind === 'admin' ? 'admin' : 'kasse';
  const anon = { user: null, device: dev };
  const u = verifyCredentials(personal_nr, pin, anon, 'login');
  const perms = rolePermissions(u.role);
  if (k === 'admin' && !perms.includes('dashboard')) {
    tx(() => logEvent({ user: u, device: dev }, { type: 'LOGIN_FAILED', details: { reason: 'Keine Dashboard-Berechtigung', kind: k } }));
    fail(403, 'Keine Berechtigung für das Administrator-Dashboard');
  }
  if (k === 'kasse' && !perms.includes('pos')) fail(403, 'Keine Berechtigung für die Kasse');
  const token = base64url(randomBytes(32));
  const sid = uuid();
  return tx(() => {
    const now = nowIso();
    run('INSERT INTO sessions(id,token_hash,user_id,device,kind,created_at,last_seen) VALUES(?,?,?,?,?,?,?)',
      sid, sha256(token), u.id, dev, k, now, now);
    const session = { id: sid, device: dev };
    const actor = { user: u, session, device: dev, permissions: perms };
    logEvent(actor, { type: 'LOGIN', details: { kind: k } });
    if (k === 'kasse' && !one('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL', u.id)) {
      run('INSERT INTO shifts(user_id,started_at) VALUES(?,?)', u.id, now);
      logEvent(actor, { type: 'SHIFT_STARTED' });
    }
    return { token, user: publicUser(u), permissions: perms, kind: k };
  });
}

export function logout(actor, reason) {
  tx(() => {
    run('UPDATE sessions SET ended_at=?, end_reason=? WHERE id=? AND ended_at IS NULL', nowIso(), reason || 'Abmeldung', actor.session.id);
    logEvent(actor, { type: 'LOGOUT', reason: reason || 'Abmeldung' });
  });
  closeSessionClients(actor.session.id);
}

const SESSION_MAX_HOURS = 14;
export function authenticate(token) {
  if (!token) return null;
  const s = one(`SELECT s.*, u.name, u.personal_nr, u.role, u.active FROM sessions s JOIN users u ON u.id=s.user_id
                 WHERE s.token_hash=?`, sha256(token));
  if (!s || s.ended_at) return null;
  if (!s.active || Date.now() - Date.parse(s.created_at) > SESSION_MAX_HOURS * 3600000) {
    const user = { id: s.user_id, name: s.name, role: s.role, personal_nr: s.personal_nr };
    tx(() => {
      run('UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?', nowIso(), s.active ? 'Sitzung abgelaufen' : 'Konto deaktiviert', s.id);
      logEvent({ user, session: s, device: s.device }, { type: 'SESSION_EXPIRED', reason: s.active ? 'Sitzung abgelaufen' : 'Konto deaktiviert' });
    });
    return null;
  }
  const now = nowIso();
  if (Date.now() - Date.parse(s.last_seen) > 30000) run('UPDATE sessions SET last_seen=? WHERE id=?', now, s.id);
  return {
    user: { id: s.user_id, name: s.name, role: s.role, personal_nr: s.personal_nr },
    session: { id: s.id, device: s.device, kind: s.kind, created_at: s.created_at },
    device: s.device,
    permissions: rolePermissions(s.role),
  };
}

/**
 * Freigabe durch Schichtleiter/Administrator. Hat der Handelnde selbst das Recht `skipPerm`,
 * ist keine Freigabe nötig (er wird dann selbst als Freigebender vermerkt).
 */
export function resolveApproval(actor, required, skipPerm, approver, what) {
  if (!required) return { required: false, approved_by: null };
  if (can(actor, skipPerm)) return { required: true, approved_by: actor.user.id, approved_by_name: actor.user.name, self: true };
  if (!approver || !approver.personal_nr) fail(409, `Freigabe erforderlich: ${what}`, { needs_approval: true, what });
  const u = verifyCredentials(approver.personal_nr, approver.pin, actor, 'approval', what);
  if (!rolePermissions(u.role).includes('approve')) {
    tx(() => logEvent(actor, { type: 'APPROVAL_FAILED', details: { approver: u.name, reason: 'Keine Freigabeberechtigung', what } }));
    fail(403, `${u.name} darf keine Freigaben erteilen`, { needs_approval: true, what });
  }
  if (u.id === actor.user.id) fail(403, 'Eigene Freigabe nicht möglich', { needs_approval: true, what });
  return { required: true, approved_by: u.id, approved_by_name: u.name, self: false };
}

export { publicUser };
