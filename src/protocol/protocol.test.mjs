import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_TYPES, createEvent, isValidEvent } from './events.js'
import {
  createSession, updateSession, isValidSession, createMessage, isValidMessage,
  createError, isBluswanError, SESSION_STATUSES,
} from './schemas.js'
import { createSessionManager } from '../sessions/sessionManager.js'

const model = { provider: 'fake', model: 'm1' }

describe('event protocol', () => {
  it('creates a valid event with required fields', () => {
    const e = createEvent('user.message', 's1', { content: 'hi' }, { timestamp: 42 })
    assert.equal(e.type, 'user.message')
    assert.equal(e.sessionId, 's1')
    assert.equal(e.timestamp, 42)
    assert.deepEqual(e.data, { content: 'hi' })
    assert.ok(e.id)
    assert.ok(isValidEvent(e))
  })
  it('stamps a timestamp by default', () => {
    const before = Date.now()
    assert.ok(createEvent('session.started', 's1').timestamp >= before)
  })
  it('rejects unknown types and missing sessionId', () => {
    assert.throws(() => createEvent('bogus', 's1'), /Unknown event type/)
    assert.throws(() => createEvent('session.started', ''), /sessionId/)
    assert.equal(isValidEvent({ id: 'x', type: 'bogus', sessionId: 's', timestamp: 1, data: {} }), false)
    assert.equal(isValidEvent(null), false)
  })
  it('supports every required event type', () => {
    assert.equal(EVENT_TYPES.length, 21)
    for (const t of EVENT_TYPES) assert.ok(isValidEvent(createEvent(t, 's1')))
  })
})

describe('session model', () => {
  it('creates an idle session with timestamps', () => {
    const s = createSession({ model, workspaceId: 'w', now: 100 })
    assert.equal(s.status, 'idle')
    assert.equal(s.startedAt, 100)
    assert.equal(s.updatedAt, 100)
    assert.equal(s.workspaceId, 'w')
    assert.deepEqual(s.messages, [])
    assert.ok(isValidSession(s))
  })
  it('requires a canonical model ref', () => {
    assert.throws(() => createSession({ model: 'deepseek-chat' }), /model/)
  })
  it('updateSession returns a new session and validates status', () => {
    const s = createSession({ model, now: 1 })
    const u = updateSession(s, { status: 'running' }, 5)
    assert.equal(u.status, 'running')
    assert.equal(u.updatedAt, 5)
    assert.equal(s.status, 'idle')
    assert.throws(() => updateSession(s, { status: 'nope' }), /status/)
    assert.equal(updateSession(s, { id: 'other' }).id, s.id)
  })
  it('exposes all required statuses', () => {
    assert.deepEqual([...SESSION_STATUSES].sort(), ['cancelled', 'completed', 'error', 'idle', 'running', 'waiting_permission', 'waiting_user'].sort())
  })
  it('rejects invalid sessions', () => {
    assert.equal(isValidSession(null), false)
    assert.equal(isValidSession({ id: 'x' }), false)
    assert.equal(isValidSession({ ...createSession({ model }), status: 'bad' }), false)
  })
})

describe('messages and errors', () => {
  it('validates message roles', () => {
    assert.ok(isValidMessage(createMessage({ role: 'user', content: 'x' })))
    assert.throws(() => createMessage({ role: 'robot', content: 'x' }), /role/)
  })
  it('creates normalized errors', () => {
    const e = createError({ code: 'rate_limit', message: 'slow', provider: 'p', retryable: true, cause: new Error('boom') })
    assert.ok(isBluswanError(e))
    assert.deepEqual(e.cause, { name: 'Error', message: 'boom' })
    assert.throws(() => createError({ code: 'weird' }), /Unknown error code/)
  })
})

describe('session manager', () => {
  it('appends messages and events and notifies subscribers', () => {
    const m = createSessionManager()
    const s = m.create({ model })
    const seen = []
    const off = m.subscribe((ev, snap) => seen.push([ev.type, snap.events.length]))
    m.appendMessage(s.id, { role: 'user', content: 'hi' })
    m.appendEvent(s.id, createEvent('user.message', s.id))
    assert.equal(m.get(s.id).messages.length, 1)
    assert.equal(m.get(s.id).events.length, 1)
    assert.deepEqual(seen, [['user.message', 1]])
    off()
    m.appendEvent(s.id, createEvent('session.updated', s.id))
    assert.equal(seen.length, 1)
  })
  it('rejects events for another session and unknown sessions', () => {
    const m = createSessionManager()
    const s = m.create({ model })
    assert.throws(() => m.appendEvent(s.id, createEvent('user.message', 'other')), /Invalid event/)
    assert.throws(() => m.setStatus('nope', 'idle'), /Unknown session/)
  })
  it('persists through the store and restores', async () => {
    const m1 = createSessionManager()
    const s = m1.create({ model })
    m1.setStatus(s.id, 'waiting_user')
    await new Promise(r => setImmediate(r))
    const store = { loadSession: async () => m1.get(s.id) }
    const m2 = createSessionManager({ store: { ...store, saveSession: async () => {} } })
    assert.equal((await m2.restore(s.id)).status, 'waiting_user')
  })
})
