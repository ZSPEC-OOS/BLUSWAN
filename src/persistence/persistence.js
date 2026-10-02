// Persistence contract. The runtime and session code depend on this shape only; where bytes actually live
// (memory, files, IndexedDB, Firestore, a database behind the server) is an adapter detail.
//
//   adapter {
//     saveSession(userId, record, {expectedRevision?}) → record with the new `revision`
//     loadSession(userId, sessionId)                   → record | null
//     listSessions(userId, {limit?, cursor?})          → { items: SessionIndex[], nextCursor }
//     deleteSession(userId, sessionId)                 → boolean
//     saveWorkspace(userId, workspace) / loadWorkspace(userId, id) / listWorkspaces(userId) / deleteWorkspace(userId, id)
//     saveSettings(userId, settings)  / loadSettings(userId)
//     clearUser(userId)                                → removes everything stored for that user
//   }
//
// Every call is scoped by userId: a record can only be reached through its owner's path, so guessing another
// user's session id yields "not found", never their data.
import { createError } from '../protocol/schemas.js'

export const CURRENT_SCHEMA_VERSION = 1

export const ADAPTER_METHODS = Object.freeze([
  'saveSession', 'loadSession', 'listSessions', 'deleteSession',
  'saveWorkspace', 'loadWorkspace', 'listWorkspaces', 'deleteWorkspace',
  'saveSettings', 'loadSettings', 'clearUser',
])

export function assertAdapter(adapter) {
  const missing = ADAPTER_METHODS.filter(m => typeof adapter?.[m] !== 'function')
  if (missing.length) throw new TypeError(`Persistence adapter is missing: ${missing.join(', ')}`)
  return adapter
}

export const persistenceError = (code, message, cause) => createError({ code, message, cause })

/** Rejects ids that could escape their collection path. */
export function assertSafeId(id, what = 'id') {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(id) || id === '.' || id === '..') {
    throw persistenceError('persistence_invalid_record', `Invalid ${what}.`)
  }
  return id
}

/** Collections for feature records owned by a user (GitHub connection, repositories, task workflow). */
export const USER_COLLECTIONS = Object.freeze(['github_connection', 'github_repos', 'github_tasks'])
export function assertCollection(c) {
  if (!USER_COLLECTIONS.includes(c)) throw persistenceError('persistence_invalid_record', 'Unknown collection.')
  return c
}

export const paths = Object.freeze({
  session: (u, id) => `users/${assertSafeId(u, 'user id')}/sessions/${assertSafeId(id, 'session id')}`,
  sessions: (u) => `users/${assertSafeId(u, 'user id')}/sessions`,
  index: (u, id) => `users/${assertSafeId(u, 'user id')}/sessionIndex/${assertSafeId(id, 'session id')}`,
  indexes: (u) => `users/${assertSafeId(u, 'user id')}/sessionIndex`,
  workspace: (u, id) => `users/${assertSafeId(u, 'user id')}/workspaces/${assertSafeId(id, 'workspace id')}`,
  workspaces: (u) => `users/${assertSafeId(u, 'user id')}/workspaces`,
  settings: (u) => `users/${assertSafeId(u, 'user id')}/settings/main`,
  userDoc: (u, c, id) => `users/${assertSafeId(u, 'user id')}/${assertCollection(c)}/${assertSafeId(id, 'document id')}`,
  userDocs: (u, c) => `users/${assertSafeId(u, 'user id')}/${assertCollection(c)}`,
  user: (u) => `users/${assertSafeId(u, 'user id')}`,
})
