// Browser backend on IndexedDB (large transcripts do not belong in localStorage). Used as an offline-capable
// cache of the session index and records for the signed-in user; it is never the source of truth when a
// server is connected. `indexedDB` is injectable so the backend is testable without a browser.
import { createPersistence, checkRevision, pageOf } from '../docStore.js'

const STORE = 'docs'
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

export function openIndexedDb(indexedDB, name = 'bluswan') {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1)
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: 'path' }) }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
}

export function createIndexedDbDocStore({ db }) {
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE)
  const all = async () => req(tx('readonly').getAll())
  return {
    async get(path) { const d = await req(tx('readonly').get(path)); return d ? { data: d.data, revision: d.revision } : null },
    async put(path, data, { expectedRevision, sortKey = '' } = {}) {
      const store = tx('readwrite')
      const current = await req(store.get(path))
      checkRevision(current, expectedRevision, path)
      const revision = (current?.revision ?? 0) + 1
      await req(store.put({ path, collection: path.slice(0, path.lastIndexOf('/')), data, revision, sortKey }))
      return revision
    },
    async delete(path) { const store = tx('readwrite'); const had = !!(await req(store.get(path))); await req(store.delete(path)); return had },
    async list(collection, opts) {
      const entries = (await all()).filter(d => d.collection === collection).map(d => ({ id: d.path.slice(d.path.lastIndexOf('/') + 1), data: d.data, revision: d.revision, sortKey: d.sortKey }))
      return pageOf(entries, opts)
    },
    async deleteTree(prefix) {
      const store = tx('readwrite')
      for (const d of await req(store.getAll())) if (d.path === prefix || d.path.startsWith(`${prefix}/`)) await req(store.delete(d.path))
    },
  }
}

export async function createLocalPersistence({ indexedDB = globalThis.indexedDB, name } = {}) {
  if (!indexedDB) throw new Error('IndexedDB is not available')
  return createPersistence(createIndexedDbDocStore({ db: await openIndexedDb(indexedDB, name) }))
}
