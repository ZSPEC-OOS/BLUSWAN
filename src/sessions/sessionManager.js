// Owns live session state. Independent of React, Firebase and storage: persistence is a separate concern
// (see sessionStore.js), which observes this manager through the runtime's events.
import { createSession, updateSession, isValidSession, createMessage } from '../protocol/schemas.js'
import { isValidEvent } from '../protocol/events.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('session')

export function createSessionManager({ now = () => Date.now() } = {}) {
  const sessions = new Map()
  const listeners = new Set()

  function require(id) {
    const s = sessions.get(id)
    if (!s) throw new Error(`Unknown session: ${id}`)
    return s
  }

  function write(session) {
    sessions.set(session.id, session)
    return session
  }

  return {
    create({ workspaceId, model, id } = {}) {
      return write(createSession({ workspaceId, model, id, now: now() }))
    },

    createSession(init) { return this.create(init) },

    /** Puts a previously persisted session into the live set (no events are replayed or subscribers notified). */
    load(session) {
      if (!isValidSession(session)) throw new Error('Cannot load an invalid session')
      sessions.set(session.id, session)
      return session
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

    async delete(id) {
      sessions.delete(id)
    },

    /** @param {(event:object, session:object)=>void} fn */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
