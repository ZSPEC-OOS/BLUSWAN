// Persistence boundary for sessions. All methods are async so that Firebase,
// IndexedDB, or server-backed stores can replace the in-memory implementation
// without touching the session manager or the runtime.
//
// Store interface:
//   saveSession(session): Promise<void>
//   loadSession(id): Promise<Session|null>
//   listSessions(): Promise<Session[]>
//   deleteSession(id): Promise<void>

export function createInMemorySessionStore() {
  const sessions = new Map()
  return {
    async saveSession(session) { sessions.set(session.id, structuredClone(session)) },
    async loadSession(id) {
      const s = sessions.get(id)
      return s ? structuredClone(s) : null
    },
    async listSessions() { return [...sessions.values()].map(s => structuredClone(s)) },
    async deleteSession(id) { sessions.delete(id) },
  }
}
