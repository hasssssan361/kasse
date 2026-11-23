// Datenbank-Treiber für SQLite-WebAssembly (im Gerät, dauerhaft gespeichert im privaten App-Speicher OPFS)
export function wasmDriver(sqlite3, db) {
  const bindable = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const withStmt = (sql, params, fn) => {
    const st = db.prepare(sql);
    try {
      if (params.length) st.bind(bindable(params));
      return fn(st);
    } finally {
      st.finalize();
    }
  };
  return {
    exec: (sql) => { db.exec(sql); },
    prepare: (sql) => ({
      get: (...p) => withStmt(sql, p, (st) => (st.step() ? st.get({}) : undefined)),
      all: (...p) => withStmt(sql, p, (st) => { const rows = []; while (st.step()) rows.push(st.get({})); return rows; }),
      run: (...p) => {
        withStmt(sql, p, (st) => { st.step(); });
        return { changes: db.changes(), lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(db)) };
      },
    }),
    function: (name, fn) => db.createFunction({ name, arity: -1, deterministic: true, xFunc: (_ctx, ...args) => fn(...args) }),
    close: () => db.close(),
  };
}
