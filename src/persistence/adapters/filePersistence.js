// File backend for a single-user / local-development server: one JSON file per document under `dir`.
// Writes are atomic (temp file + rename) and serialized per path so revision checks are race-free in-process.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createPersistence, checkRevision, pageOf } from '../docStore.js'
import { persistenceError } from '../persistence.js'

export function createFileDocStore({ dir }) {
  const root = path.resolve(dir)
  const locks = new Map()
  const file = (p) => {
    const abs = path.resolve(root, `${p}.json`)
    if (!abs.startsWith(root + path.sep)) throw new Error('path escapes storage root')
    return abs
  }
  const withLock = (p, fn) => {
    const run = (locks.get(p) ?? Promise.resolve()).catch(() => {}).then(fn)
    locks.set(p, run)
    return run.finally(() => { if (locks.get(p) === run) locks.delete(p) })
  }
  // A document that is not valid JSON (a crash mid-write on a filesystem without atomic rename, manual edits, disk damage)
  // is moved aside as `<name>.corrupt-<time>` so it can be inspected and never blocks the server from starting.
  const quarantined = []
  const quarantine = async (abs) => {
    const aside = `${abs}.corrupt-${Date.now()}`
    await fs.rename(abs, aside).catch(() => {})
    quarantined.push(path.basename(aside))
  }
  const read = async (p) => {
    const abs = file(p)
    let text
    try { text = await fs.readFile(abs, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    try {
      const d = JSON.parse(text)
      if (!d || typeof d !== 'object' || !('data' in d)) throw new SyntaxError('not a document')
      return d
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      await quarantine(abs)
      throw persistenceError('persistence_invalid_record', 'A stored record was unreadable and has been set aside.')
    }
  }

  return {
    async get(p) { const d = await read(p); return d ? { data: d.data, revision: d.revision } : null },
    put: (p, data, { expectedRevision, sortKey = '' } = {}) => withLock(p, async () => {
      const current = await read(p)
      checkRevision(current, expectedRevision, p)
      const revision = (current?.revision ?? 0) + 1
      const abs = file(p)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ revision, sortKey, data }))
      await fs.rename(tmp, abs)
      return revision
    }),
    delete: (p) => withLock(p, async () => { try { await fs.unlink(file(p)); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }),
    async list(collection, opts) {
      const abs = path.resolve(root, collection)
      let names = []
      try { names = (await fs.readdir(abs)).filter(n => n.endsWith('.json')) } catch (e) { if (e.code !== 'ENOENT') throw e }
      const entries = []
      for (const n of names) {
        const d = await read(`${collection}/${n.slice(0, -5)}`).catch((e) => { if (e?.code === 'persistence_invalid_record') return null; throw e })
        if (d) entries.push({ id: n.slice(0, -5), data: d.data, revision: d.revision, sortKey: d.sortKey })
      }
      return pageOf(entries, opts)
    },
    /** Readiness: the data directory exists and is writable. */
    async probe() {
      await fs.mkdir(root, { recursive: true })
      const tmp = path.join(root, `.probe-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
      await fs.writeFile(tmp, 'ok'); await fs.unlink(tmp)
    },
    quarantined: () => [...quarantined],
    async deleteTree(prefix) { await fs.rm(path.resolve(root, prefix), { recursive: true, force: true }) },
  }
}

export const createFilePersistence = (options) => createPersistence(createFileDocStore(options))
