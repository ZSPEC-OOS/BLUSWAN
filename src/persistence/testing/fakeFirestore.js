// Minimal Admin-style Firestore double: doc get/set/delete, collection queries (orderBy desc / startAfter / limit),
// transactions, recursiveDelete. Enough to exercise the Firestore backend offline.
export function fakeFirestore() {
  const docs = new Map()
  const parent = (p) => p.slice(0, p.lastIndexOf('/'))
  const snap = (path) => { const has = docs.has(path); return { exists: has, id: path.slice(path.lastIndexOf('/') + 1), data: () => (has ? structuredClone(docs.get(path)) : undefined) } }
  const db = {
    doc: (path) => ({ path, get: async () => snap(path), set: async (v) => { docs.set(path, structuredClone(v)) }, delete: async () => { docs.delete(path) } }),
    collection(coll) {
      const q = { after: null, n: Infinity }
      const api = {
        orderBy: () => api, startAfter: (v) => { q.after = v; return api }, limit: (n) => { q.n = n; return api },
        async get() {
          let list = [...docs.entries()].filter(([p, d]) => parent(p) === coll && d.sortKey !== undefined).sort((a, b) => (a[1].sortKey < b[1].sortKey ? 1 : -1))
          if (q.after) list = list.filter(([, d]) => d.sortKey < q.after)
          return { docs: list.slice(0, q.n).map(([p]) => snap(p)) }
        },
      }
      return api
    },
    async runTransaction(fn) {
      const writes = []
      const result = await fn({ get: async (ref) => snap(ref.path), set: (ref, v) => writes.push([ref.path, v]) })
      for (const [p, v] of writes) docs.set(p, structuredClone(v))
      return result
    },
    async recursiveDelete(ref) { for (const p of [...docs.keys()]) if (p === ref.path || p.startsWith(`${ref.path}/`)) docs.delete(p) },
  }
  return db
}
