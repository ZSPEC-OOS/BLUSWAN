// Storage-schema migrations. `schemaVersion` describes the stored data layout only. Each step is an explicit
// function from version N to N+1; records newer than this build understands are refused, never guessed at.
import { CURRENT_SCHEMA_VERSION, persistenceError } from './persistence.js'

/** version → function(record) returning the record at version + 1. Empty until the layout changes. */
export const SESSION_MIGRATIONS = Object.freeze({})

/**
 * @param {object} record persisted session record
 * @param {{migrations?:Record<number,Function>, target?:number}} [options] (injectable so the mechanism is testable)
 */
export function migrateSession(record, { migrations = SESSION_MIGRATIONS, target = CURRENT_SCHEMA_VERSION } = {}) {
  if (!record || typeof record !== 'object' || !Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) {
    throw persistenceError('persistence_invalid_record', 'Stored session has no valid schema version.')
  }
  if (record.schemaVersion > target) {
    throw persistenceError('persistence_schema_unsupported', `Stored session uses schema ${record.schemaVersion}; this version supports up to ${target}.`)
  }
  let current = record
  while (current.schemaVersion < target) {
    const step = migrations[current.schemaVersion]
    if (typeof step !== 'function') throw persistenceError('persistence_schema_unsupported', `No migration from schema ${current.schemaVersion}.`)
    let next
    try { next = step(structuredClone(current)) } catch (e) { throw persistenceError('persistence_invalid_record', 'Stored session could not be migrated.', e) }
    if (!next || next.schemaVersion !== current.schemaVersion + 1) throw persistenceError('persistence_invalid_record', 'Migration produced an invalid record.')
    current = next
  }
  return current
}
