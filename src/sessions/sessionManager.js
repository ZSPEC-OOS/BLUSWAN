// Owns live session state. Independent of React and Firebase; persistence is
// delegated to an injected store.
import { createSession, updateSession, isValidSession, createMessage } from '../protocol/schemas.js'
import { isValidEvent } from '../protocol/events.js'
import { createInMemorySessionStore } from './sessionStore.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('session')

export function createSessionManager({ store = createInMemorySessionStore(), now = () => Date.now() } = {}) {
  const sessions = new Map()
  const listeners = new Set()

  function persist(session) {
    Promise.resolve(store.saveSession(session)).catch(err =>
      log.warn('persist failed', { sessionId: session.id, message: err?.message }))
  }

  function require(id) {
    const s = sessions.get(id)
    if (!s) throw new Error(`Unknown session: ${id}`)
    return s
  }

  function write(session) {
    sessions.set(session.id, session)
    persist(session)
    return session
  }

  return {
    create({ workspaceId, model, id } = {}) {
      return write(createSession({ workspaceId, model, id, now: now() }))
    },

    /** Loads a persisted session into the live set. */
    async restore(id) {
      const s = await store.loadSession(id)
      if (!s || !isValidSession(s)) return null
      sessions.set(s.id, s)
      return s
    },

    get(id) { return sessions.get(id) ?? null },
    list() { return [...sessions.values()] },

    update(id, patch) { return write(updateSession(require(id), patch, now())) },

    appendMessage(id, fields) {
      const s = require(id)
      const message = createMessage({ timestamp: now(), ...fields })
      write(updateSession(s, { messages: [...s.messages, message] }, now()))
      return message
    },

    /** Stores the event on the session and notifies subscribers. */
    appendEvent(id, event) {
      if (!isValidEvent(event) || event.sessionId !== id) throw new Error('Invalid event for session')
      const s = require(id)
      const next = write(updateSession(s, { events: [...s.events, event] }, now()))
      for (const fn of [...listeners]) {
        try { fn(event, next) } catch (err) { log.warn('subscriber threw', { message: err?.message }) }
      }
      return event
    },

    setStatus(id, status) { return write(updateSession(require(id), { status }, now())) },

    cancel(id) { return write(updateSession(require(id), { status: 'cancelled' }, now())) },

    delete(id) {
      sessions.delete(id)
      return Promise.resolve(store.deleteSession(id))
    },

    /** @param {(event:object, session:object)=>void} fn */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
