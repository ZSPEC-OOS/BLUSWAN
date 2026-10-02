// Minimal in-memory IndexedDB double: open/upgrade, one keyPath store, transactions with get/getAll/put/delete.
export function fakeIndexedDB() {
  const dbs = new Map()
  const done = (value) => { const r = { result: value, error: null, onsuccess: null, onerror: null }; queueMicrotask(() => r.onsuccess?.()); return r }
  return {
    open(name) {
      const open = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        let data = dbs.get(name)
        const fresh = !data
        if (!data) { data = new Map(); dbs.set(name, data) }
        const db = {
          createObjectStore() { return {} },
          transaction() {
            return { objectStore: () => ({
              get: (k) => done(data.has(k) ? structuredClone(data.get(k)) : undefined),
              getAll: () => done([...data.values()].map(v => structuredClone(v))),
              put: (v) => { data.set(v.path, structuredClone(v)); return done(v.path) },
              delete: (k) => { data.delete(k); return done(undefined) },
            }) }
          },
        }
        open.result = db
        if (fresh) open.onupgradeneeded?.()
        open.onsuccess?.()
      })
      return open
    },
  }
}
