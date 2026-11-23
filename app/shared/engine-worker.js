// Rechenkern der App: läuft im Hintergrund (Web Worker) im Gerät selbst.
// Hier liegen Datenbank, Manipulationsschutz und die gesamte Kassenlogik – die Oberfläche
// schickt nur Aufträge und zeigt Ergebnisse an.
import sqlite3InitModule from '../vendor/sqlite/sqlite3.mjs';
import { init, dispatch, subscribe } from '../core/api.js';
import { wasmDriver } from '../core/wasm-driver.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (...a) => console.warn(...a) });
  // Die Datenbank kann nur von einem Fenster gleichzeitig benutzt werden. Beim Wechsel zwischen
  // Kasse und Admin-Bereich gibt das vorige Fenster sie kurz danach frei – daher mehrere Versuche.
  let pool = null;
  let lastErr = null;
  for (let i = 0; i < 40 && !pool; i++) {
    try {
      pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'kassensystem', clearOnInit: false });
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  if (!pool) {
    const err = new Error('Die Kasse ist bereits in einem anderen Fenster geöffnet. Bitte das andere Fenster schließen.');
    err.cause = lastErr;
    throw err;
  }
  const db = new pool.OpfsSAHPoolDb('/kassensystem.sqlite3');
  init(wasmDriver(sqlite3, db));
  subscribe((kind, data) => postMessage({ type: 'event', kind, data }));
  return db;
})();
ready.catch(() => {});

self.onmessage = async (e) => {
  const m = e.data;
  if (m?.type !== 'call') return;
  let res;
  try {
    await ready;
    res = await dispatch(m.req);
  } catch (err) {
    res = { status: 503, body: { error: err?.message || 'Die Datenbank konnte nicht geöffnet werden.' } };
  }
  postMessage({ type: 'result', id: m.id, res });
};
