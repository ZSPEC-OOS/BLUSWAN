// Canonical BLUSWAN data schemas: messages, sessions, normalized errors.
// Nothing in this module is provider-specific.

import { redactSecrets } from '../utils/redact.js'

export const MESSAGE_ROLES = Object.freeze(['system', 'user', 'assistant', 'tool'])

export const SESSION_STATUSES = Object.freeze([
  'idle',
  'running',
  'waiting_permission',
  'waiting_user',
  'completed',
  'error',
  'cancelled',
])

export const ERROR_CODES = Object.freeze([
  'configuration_error',
  'authentication_error',
  'rate_limit',
  'provider_error',
  'network_error',
  'cancelled',
  'invalid_response',
  'runtime_error',
  'provider_timeout',
  'session_busy',
  'max_turns',
  'loop_detected',
  'no_progress',
])

export function newId() {
  return globalThis.crypto.randomUUID()
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{code:string,message:string,provider:(string|null),retryable:boolean,cause:(*)}} BluswanError
 */

/** @returns {BluswanError} */
export function createError({ code, message, provider = null, retryable = false, cause } = {}) {
  if (!ERROR_CODES.includes(code)) throw new Error(`Unknown error code: ${code}`)
  return { code, message: redactSecrets(message ?? code), provider, retryable: !!retryable, cause: serializeCause(cause) }
}

export function isBluswanError(value) {
  return !!value && typeof value === 'object' && ERROR_CODES.includes(value.code)
    && typeof value.message === 'string' && typeof value.retryable === 'boolean'
}

// Causes are reduced to plain data so errors can be persisted and rendered safely.
function serializeCause(cause) {
  if (cause === undefined || cause === null) return null
  if (cause instanceof Error) return { name: cause.name, message: redactSecrets(cause.message) }
  if (typeof cause === 'object') return cause
  return { message: redactSecrets(cause) }
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function createMessage({ role, content, toolCalls, toolCallId, name, reasoning, id, timestamp } = {}) {
  if (!MESSAGE_ROLES.includes(role)) throw new Error(`Invalid message role: ${role}`)
  if (typeof content !== 'string') throw new Error('Message content must be a string')
  return {
    id: id ?? newId(),
    role,
    content,
    timestamp: timestamp ?? Date.now(),
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(name ? { name } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

export function isValidMessage(m) {
  return !!m && typeof m.id === 'string' && MESSAGE_ROLES.includes(m.role)
    && typeof m.content === 'string' && typeof m.timestamp === 'number'
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * @param {{workspaceId?:(string|null), model:{provider:string,model:string}, id?:string, now?:number}} init
 */
export function createSession({ workspaceId = null, model, id, now = Date.now() } = {}) {
  if (!isModelRef(model)) throw new Error('createSession requires model = { provider, model }')
  return {
    id: id ?? newId(),
    workspaceId,
    model: { provider: model.provider, model: model.model },
    messages: [],
    events: [],
    toolCalls: [],
    changedFiles: [],
    turns: [],
    status: 'idle',
    contextSummary: null,
    tokenUsage: { input: 0, output: 0, reasoning: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
  }
}

/** Returns a new session with `patch` applied and `updatedAt` refreshed. */
export function updateSession(session, patch = {}, now = Date.now()) {
  if (!isValidSession(session)) throw new Error('Cannot update an invalid session')
  if ('status' in patch && !SESSION_STATUSES.includes(patch.status)) {
    throw new Error(`Invalid session status: ${patch.status}`)
  }
  const { id: _id, startedAt: _startedAt, ...allowed } = patch
  return { ...session, ...allowed, updatedAt: now }
}

export function isModelRef(m) {
  return !!m && typeof m.provider === 'string' && m.provider !== ''
    && typeof m.model === 'string'
}

export function isValidSession(s) {
  return !!s && typeof s.id === 'string' && isModelRef(s.model)
    && SESSION_STATUSES.includes(s.status)
    && Array.isArray(s.messages) && Array.isArray(s.events)
    && Array.isArray(s.toolCalls) && Array.isArray(s.changedFiles)
    && typeof s.startedAt === 'number' && typeof s.updatedAt === 'number'
}
