// Runtime session ⇄ persisted record. Only serializable canonical state is stored: no abort controllers,
// process handles, stream readers, callbacks or provider clients (the runtime session object never holds
// them, and the validator below rejects functions/symbols anyway). Secrets are scrubbed before anything is written.
import { CURRENT_SCHEMA_VERSION, persistenceError } from './persistence.js'
import { isValidSession, isModelMode, SESSION_STATUSES } from '../protocol/schemas.js'
import { redactSecrets } from '../utils/redact.js'
import { deriveTitle } from '../utils/title.js'

export const LIMITS = Object.freeze({
  maxEvents: 4000, maxToolCalls: 1000, maxToolMessageChars: 20_000, maxCommands: 200, maxStreamChars: 64_000, maxTitleChars: 120,
})
// High-frequency events carry no information the canonical state lacks once a message completes.
const DROPPED_EVENTS = new Set(['assistant.text.delta', 'command.output'])
const SECRET_KEY = /^(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|cookie|set-cookie|password|passwd|secret|client[_-]?secret|private[_-]?key)$/i
const ACTIVE = new Set(['running', 'waiting_permission'])

/** Removes secret-named fields and secret-looking strings from tool/command data. Pure; returns a copy. */
export function scrub(value, { depth = 0 } = {}) {
  if (depth > 12) return '[deep]'
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(v => scrub(v, { depth: depth + 1 }))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, { depth: depth + 1 })
    return out
  }
  return value
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…[truncated for storage]` : s)

function compactMessage(m) {
  const out = { ...m }
  if (m.toolCalls) out.toolCalls = scrub(m.toolCalls)
  if (m.meta) out.meta = scrub(m.meta)
  if (m.role === 'tool') out.content = clip(redactSecrets(m.content), LIMITS.maxToolMessageChars)
  return out
}

/** Significant events only, newest `maxEvents`; heavy fields (command output) live in `commands`, not here. */
export function compactEvents(events) {
  const kept = []
  for (const e of events) {
    if (DROPPED_EVENTS.has(e.type)) continue
    if (e.type === 'command.completed') { const { stdout: _o, stderr: _e, ...rest } = e.data ?? {}; kept.push({ ...e, data: rest }); continue }
    kept.push(e)
  }
  return kept.length > LIMITS.maxEvents ? kept.slice(kept.length - LIMITS.maxEvents) : kept
}

const clipList = (list, n) => (list.length > n ? list.slice(list.length - n) : list)

/**
 * @param {object} session runtime session snapshot
 * @param {{userId:string, commands?:object[], workspaceSnapshot?:object|null, revision?:number, title?:string|null, interrupted?:object|null}} ctx
 */
export function serializeSession(session, { userId, commands = [], workspaceSnapshot = null, revision = 0, title = null, interrupted = null } = {}) {
  if (typeof userId !== 'string' || userId === '') throw persistenceError('persistence_invalid_record', 'A user id is required to persist a session.')
  const firstUser = session.messages.find(m => m.role === 'user')?.content ?? ''
  const record = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: session.id, userId, workspaceId: session.workspaceId ?? null,
    title: title ?? deriveTitle(firstUser).slice(0, LIMITS.maxTitleChars),
    model: { provider: session.model.provider, model: session.model.model },
    modelPreference: isModelMode(session.modelPreference) ? session.modelPreference : null,
    status: session.status,
    messages: session.messages.map(compactMessage),
    events: compactEvents(session.events),
    toolCalls: clipList(scrub(session.toolCalls), LIMITS.maxToolCalls),
    turns: session.turns,
    runs: scrub(session.runs ?? []),
    changedFiles: session.changedFiles,
    contextSummary: scrub(session.contextSummary ?? null),
    contextStats: session.contextStats,
    validationState: scrub(session.validation ?? null),
    tokenUsage: session.tokenUsage,
    commands: clipList(commands.map(boundCommand), LIMITS.maxCommands),
    workspaceSnapshot,
    interrupted,
    createdAt: session.startedAt, updatedAt: session.updatedAt,
    revision,
  }
  return JSON.parse(JSON.stringify(record)) // plain data only: drops undefined, rejects nothing silently-live
}

function boundCommand(c) {
  return scrub({
    ...c,
    stdout: clip(String(c.stdout ?? ''), LIMITS.maxStreamChars), stderr: clip(String(c.stderr ?? ''), LIMITS.maxStreamChars),
  })
}

/** Lightweight record for session lists: no transcript. */
export function toIndex(record) {
  const lastEvent = record.events.at(-1)
  return {
    id: record.id, userId: record.userId, title: record.title, workspaceId: record.workspaceId, status: record.status,
    outcome: record.runs.at(-1)?.outcome ?? null, lastActivityAt: record.updatedAt, createdAt: record.createdAt,
    changedCount: record.changedFiles.length, messageCount: record.messages.length, model: record.model,
    lastEventType: lastEvent?.type ?? null,
  }
}

const isArr = Array.isArray
/** Structural validation of a (migrated) record. Throws persistence_invalid_record. */
export function validateRecord(r) {
  const bad = (why) => { throw persistenceError('persistence_invalid_record', `Stored session is invalid (${why}).`) }
  if (!r || typeof r !== 'object') bad('not an object')
  if (typeof r.id !== 'string' || r.id === '') bad('id')
  if (typeof r.userId !== 'string' || r.userId === '') bad('userId')
  if (!SESSION_STATUSES.includes(r.status)) bad('status')
  if (!r.model || typeof r.model.provider !== 'string' || typeof r.model.model !== 'string') bad('model')
  if (r.modelPreference != null && !isModelMode(r.modelPreference)) bad('modelPreference')
  for (const k of ['messages', 'events', 'toolCalls', 'turns', 'runs', 'changedFiles', 'commands']) if (!isArr(r[k])) bad(k)
  if (!r.messages.every(m => m && typeof m.id === 'string' && typeof m.role === 'string' && typeof m.content === 'string')) bad('messages')
  if (!r.events.every(e => e && typeof e.id === 'string' && typeof e.type === 'string' && typeof e.sessionId === 'string' && e.data && typeof e.data === 'object')) bad('events')
  if (typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') bad('timestamps')
  if (JSON.stringify(r).length > 64 * 1024 * 1024) bad('size')
  return r
}

/** Record → live runtime session fields. Active statuses are NOT preserved (nothing is running after a restart). */
export function toRuntimeSession(record) {
  const session = {
    id: record.id, workspaceId: record.workspaceId ?? null, model: record.model,
    modelPreference: isModelMode(record.modelPreference) ? record.modelPreference : null, // absent in pre-routing records → manual
    messages: record.messages, events: record.events, toolCalls: record.toolCalls, changedFiles: record.changedFiles,
    turns: record.turns, runs: record.runs, validation: record.validationState ?? null, status: record.status,
    contextSummary: record.contextSummary ?? null, tokenUsage: record.tokenUsage,
    contextStats: record.contextStats ?? { compactionCount: 0, lastCompactionAt: null, builds: 0, last: null },
    startedAt: record.createdAt, updatedAt: record.updatedAt,
  }
  if (!isValidSession(session)) throw persistenceError('persistence_invalid_record', 'Stored session is not a valid session.')
  return session
}

export const isActiveStatus = (s) => ACTIVE.has(s)
