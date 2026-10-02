// Domain-level session persistence for one user. The rest of the app talks to this, never to an adapter or Firebase.
import { assertAdapter } from './persistence.js'

export function createSessionRepository(adapter, { userId }) {
  assertAdapter(adapter)
  return {
    userId,
    /** Create or replace; pass `expectedRevision` to refuse overwriting newer data. */
    saveSessionRecord: (record, opts) => adapter.saveSession(userId, record, opts),
    createSessionRecord: (record) => adapter.saveSession(userId, record, { expectedRevision: 0 }),
    updateSessionRecord: (record, expectedRevision) => adapter.saveSession(userId, record, { expectedRevision }),
    getSessionRecord: (id) => adapter.loadSession(userId, id),
    listSessionRecords: (opts) => adapter.listSessions(userId, opts),
    deleteSessionRecord: (id) => adapter.deleteSession(userId, id),
  }
}
