// Datenbank-Treiber für die automatischen Tests (Node.js eigenes SQLite).
// In der App übernimmt das app/core/wasm-driver.js mit SQLite-WebAssembly.
import { DatabaseSync } from 'node:sqlite';

export function nodeDriver(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        get: (...p) => st.get(...p),
        all: (...p) => st.all(...p),
        run: (...p) => { const r = st.run(...p); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      };
    },
    function: (name, fn) => db.function(name, { varargs: true, deterministic: true }, fn),
    close: () => db.close(),
  };
}
