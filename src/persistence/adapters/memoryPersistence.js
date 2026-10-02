// In-memory backend: tests and ephemeral sessions. Values are cloned in and out, like a real store.
import { createPersistence, checkRevision, pageOf } from '../docStore.js'

export function createMemoryDocStore() {
  const docs = new Map() // path → { data, revision, sortKey }
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'))
  return {
    async get(path) { const d = docs.get(path); return d ? { data: structuredClone(d.data), revision: d.revision } : null },
    async put(path, data, { expectedRevision, sortKey = '' } = {}) {
      checkRevision(docs.get(path), expectedRevision, path)
      const revision = (docs.get(path)?.revision ?? 0) + 1
      docs.set(path, { data: structuredClone(data), revision, sortKey })
      return revision
    },
    async delete(path) { return docs.delete(path) },
    async list(collection, opts) {
      const entries = [...docs.entries()].filter(([p]) => parentOf(p) === collection)
        .map(([p, d]) => ({ id: p.slice(p.lastIndexOf('/') + 1), data: structuredClone(d.data), revision: d.revision, sortKey: d.sortKey }))
      return pageOf(entries, opts)
    },
    async deleteTree(prefix) { for (const p of [...docs.keys()]) if (p === prefix || p.startsWith(`${prefix}/`)) docs.delete(p) },
    _size: () => docs.size,
  }
}

export const createMemoryPersistence = () => createPersistence(createMemoryDocStore())
