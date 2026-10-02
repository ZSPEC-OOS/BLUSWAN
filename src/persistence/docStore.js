// Generic persistence adapter built on a tiny document store. Memory, file, IndexedDB and Firestore backends only
// implement DocStore; everything domain-specific (paths, revisions, indexes, ownership scoping) lives here once.
//
//   DocStore {
//     get(path)                              → { data, revision } | null
//     put(path, data, {expectedRevision?, sortKey?}) → revision   (expectedRevision 0 = must not exist; undefined = unconditional)
//     delete(path)                           → boolean
//     list(collectionPath, {limit, startAfter}) → { items: [{ id, data, revision, sortKey }], next }   (newest sortKey first)
//     deleteTree(path)                       → void
//   }
import { assertAdapter, paths, persistenceError } from './persistence.js'
import { migrateSession } from './migration.js'
import { toIndex, validateRecord } from './serializer.js'

const sortKeyOf = (ts, id) => `${String(Math.max(0, Math.trunc(ts))).padStart(15, '0')}|${id}`

export function createPersistence(docs, { migrate = migrateSession } = {}) {
  async function guard(fn) {
    try { return await fn() } catch (e) {
      if (e && typeof e === 'object' && 'retryable' in e && typeof e.code === 'string' && e.code.startsWith('persistence_')) throw e
      throw persistenceError('persistence_unavailable', 'Storage is unavailable.', e)
    }
  }

  const adapter = {
    async saveSession(userId, record, { expectedRevision } = {}) {
      if (record?.userId !== userId) throw persistenceError('persistence_invalid_record', 'Session belongs to a different user.')
      return guard(async () => {
        const body = { ...record }
        delete body.revision
        const revision = await docs.put(paths.session(userId, record.id), body, { expectedRevision })
        const saved = { ...record, revision }
        await docs.put(paths.index(userId, record.id), { ...toIndex(saved) }, { sortKey: sortKeyOf(record.updatedAt, record.id) })
        return saved
      })
    },

    /** Returns the migrated, validated record or null. Corrupt/unsupported records throw normalized errors. */
    async loadSession(userId, sessionId) {
      return guard(async () => {
        const doc = await docs.get(paths.session(userId, sessionId))
        if (!doc) return null
        const migrated = migrate(doc.data)
        if (migrated.userId !== userId) throw persistenceError('persistence_invalid_record', 'Stored session does not belong to this user.')
        return validateRecord({ ...migrated, revision: doc.revision })
      })
    },

    async listSessions(userId, { limit = 50, cursor = null } = {}) {
      return guard(async () => {
        const { items, next } = await docs.list(paths.indexes(userId), { limit: Math.min(Math.max(1, limit), 200), startAfter: cursor })
        return { items: items.map(i => ({ ...i.data, revision: i.revision })), nextCursor: next }
      })
    },

    async deleteSession(userId, sessionId) {
      return guard(async () => {
        const removed = await docs.delete(paths.session(userId, sessionId))
        await docs.delete(paths.index(userId, sessionId))
        return removed
      })
    },

    async saveWorkspace(userId, workspace) {
      return guard(async () => {
        if (workspace?.userId !== userId) throw persistenceError('persistence_invalid_record', 'Workspace belongs to a different user.')
        const revision = await docs.put(paths.workspace(userId, workspace.id), workspace, { sortKey: sortKeyOf(workspace.updatedAt ?? Date.now(), workspace.id) })
        return { ...workspace, revision }
      })
    },
    async loadWorkspace(userId, id) {
      return guard(async () => {
        const doc = await docs.get(paths.workspace(userId, id))
        return doc && doc.data.userId === userId ? { ...doc.data, revision: doc.revision } : null
      })
    },
    async listWorkspaces(userId) {
      return guard(async () => (await docs.list(paths.workspaces(userId), { limit: 200 })).items.map(i => ({ ...i.data, revision: i.revision })))
    },
    async deleteWorkspace(userId, id) { return guard(() => docs.delete(paths.workspace(userId, id))) },

    async saveSettings(userId, settings) {
      return guard(async () => { await docs.put(paths.settings(userId), settings); return settings })
    },
    async loadSettings(userId) {
      return guard(async () => (await docs.get(paths.settings(userId)))?.data ?? null)
    },

    // Feature records owned by one user (GitHub connection, repositories, task workflow): schemaless documents under the user's own path.
    async putDoc(userId, collection, id, data, { expectedRevision, sortKey = '' } = {}) {
      return guard(async () => ({ revision: await docs.put(paths.userDoc(userId, collection, id), JSON.parse(JSON.stringify(data)), { expectedRevision, sortKey: sortKey || sortKeyOf(data?.updatedAt ?? Date.now(), id) }) }))
    },
    async getDoc(userId, collection, id) {
      return guard(async () => { const d = await docs.get(paths.userDoc(userId, collection, id)); return d ? { ...d.data, _revision: d.revision } : null })
    },
    async listDocs(userId, collection, { limit = 200 } = {}) {
      return guard(async () => (await docs.list(paths.userDocs(userId, collection), { limit })).items.map(i => ({ ...i.data, _id: i.id, _revision: i.revision })))
    },
    async deleteDoc(userId, collection, id) { return guard(() => docs.delete(paths.userDoc(userId, collection, id))) },

    /** Cheap health check for readiness: can the backing store be reached/written? Resolves true or throws persistence_unavailable. */
    async probe() { return guard(async () => { await (docs.probe ? docs.probe() : docs.get('system/ready')); return true }) },
    async clearUser(userId) { return guard(() => docs.deleteTree(paths.user(userId))) },
  }
  return assertAdapter(adapter)
}

/** Shared by backends: optimistic-concurrency check. */
export function checkRevision(current, expectedRevision, path) {
  if (expectedRevision === undefined) return
  const have = current?.revision ?? 0
  if (have !== expectedRevision) {
    throw persistenceError('persistence_conflict', `${path} changed elsewhere (have revision ${have}, expected ${expectedRevision}).`)
  }
}

/** Shared by backends: newest-first page of `entries` ([{path,id,data,revision,sortKey}]). */
export function pageOf(entries, { limit = 50, startAfter = null } = {}) {
  const sorted = entries.slice().sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
  const after = startAfter ? sorted.filter(e => e.sortKey < startAfter) : sorted
  const items = after.slice(0, limit)
  return { items, next: after.length > limit ? items.at(-1).sortKey : null }
}
