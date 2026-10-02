// Cloud backend on Firestore, through the Admin-style API (server side):
//   db.doc(path) → { get(), set(), delete() }, db.collection(path).orderBy().limit().startAfter().get(),
//   db.runTransaction(fn), db.recursiveDelete(ref)
// All Firebase specifics live here; nothing else imports Firebase. Records are stored as JSON strings split into
// chunks (Firestore documents are limited to 1 MiB), under users/{uid}/…, so a record is only reachable through its
// owner's path. `firestore.rules` additionally denies any direct client access to this data.
import { createPersistence, checkRevision } from '../docStore.js'

const CHUNK = 250_000 // characters; ≤ ~750 KB even for 3-byte code points

export function createFirestoreDocStore({ db }) {
  const chunksOf = (path) => `${path}/c`
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'))

  async function readData(snap, path) {
    const d = snap.data()
    const parts = [d.json ?? '']
    for (let i = 0; i < (d.chunks ?? 0); i++) parts.push((await db.doc(`${chunksOf(path)}/${i}`).get()).data()?.json ?? '')
    return JSON.parse(parts.join(''))
  }

  return {
    async get(path) {
      const snap = await db.doc(path).get()
      if (!snap.exists) return null
      return { data: await readData(snap, path), revision: snap.data().revision }
    },
    async put(path, data, { expectedRevision, sortKey = '' } = {}) {
      const json = JSON.stringify(data)
      const head = json.slice(0, CHUNK)
      const rest = []
      for (let i = CHUNK; i < json.length; i += CHUNK) rest.push(json.slice(i, i + CHUNK))
      return db.runTransaction(async (tx) => {
        const ref = db.doc(path)
        const snap = await tx.get(ref)
        const current = snap.exists ? snap.data() : null
        checkRevision(current, expectedRevision, path)
        const revision = (current?.revision ?? 0) + 1
        rest.forEach((part, i) => tx.set(db.doc(`${chunksOf(path)}/${i}`), { json: part }))
        tx.set(ref, { json: head, chunks: rest.length, revision, sortKey, collection: parentOf(path) })
        return revision
      })
    },
    async delete(path) {
      const ref = db.doc(path)
      const snap = await ref.get()
      if (!snap.exists) return false
      await db.recursiveDelete(ref)
      return true
    },
    async list(collection, { limit = 50, startAfter = null } = {}) {
      let q = db.collection(collection).orderBy('sortKey', 'desc')
      if (startAfter) q = q.startAfter(startAfter)
      const snaps = (await q.limit(limit + 1).get()).docs
      const page = snaps.slice(0, limit)
      const items = []
      for (const s of page) items.push({ id: s.id, data: await readData(s, `${collection}/${s.id}`), revision: s.data().revision, sortKey: s.data().sortKey })
      return { items, next: snaps.length > limit ? items.at(-1).sortKey : null }
    },
    async deleteTree(prefix) { await db.recursiveDelete(db.doc(prefix)) },
  }
}

export const createFirebasePersistence = (options) => createPersistence(createFirestoreDocStore(options))
