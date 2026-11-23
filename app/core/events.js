// Ereignis-Verteiler innerhalb der App (z. B. Live-Storno-Meldung im Admin-Bereich)
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(kind, data) {
  for (const fn of listeners) {
    try { fn(kind, data); } catch {}
  }
}

export function closeSessionClients() {}
