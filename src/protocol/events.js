// Canonical runtime event protocol. Provider-native payloads never appear here.
import { newId } from './schemas.js'

export const EVENT_TYPES = Object.freeze([
  'session.started',
  'session.updated',
  'user.message',
  'assistant.text.delta',
  'assistant.text.completed',
  'assistant.reasoning.status',
  'provider.retry',
  'context.compacted',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'file.changed',
  'command.started',
  'command.output',
  'command.completed',
  'permission.requested',
  'validation.started',
  'validation.completed',
  'session.completed',
  'session.failed',
  'session.cancelled',
])

/** @returns {{id:string,type:string,sessionId:string,timestamp:number,data:object}} */
export function createEvent(type, sessionId, data = {}, { id, timestamp } = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`)
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Event requires a sessionId')
  return { id: id ?? newId(), type, sessionId, timestamp: timestamp ?? Date.now(), data: data ?? {} }
}

export function isValidEvent(e) {
  return !!e && typeof e.id === 'string' && EVENT_TYPES.includes(e.type)
    && typeof e.sessionId === 'string' && e.sessionId !== ''
    && typeof e.timestamp === 'number' && !!e.data && typeof e.data === 'object'
}
