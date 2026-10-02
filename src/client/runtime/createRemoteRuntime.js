// The runtime as seen by the browser: the same interface the client store already uses, backed by the BLUSWAN
// server over HTTP + Server-Sent Events. No provider, tool or credential logic lives here; it keeps a local mirror
// of server state, fed by the canonical event stream, so synchronous reads (session lists, transcripts) stay cheap.
//
//  • sessions arrive as a lightweight index and are hydrated on demand (loadSession);
//  • stream events are de-duplicated by id, so a reconnect can never render a message twice;
//  • if the stream drops it reconnects with backoff and re-syncs the open conversations from the server's state;
//  • an optional IndexedDB-backed cache lets the previous session list show while the server is unreachable.
const EMPTY_USAGE = { input: 0, output: 0, reasoning: 0, total: 0 }
const MAX_SEEN = 20_000

/**
 * @param {{baseUrl?:string, getToken?:()=>Promise<string|null>, fetch?:typeof fetch, cache?:object|null, userKey?:string,
 *          reconnect?:{baseMs:number, maxMs:number}, uuid?:()=>string}} options
 */
export function createRemoteRuntime({
  baseUrl = '', getToken = async () => null, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), cache = null, userKey = 'local',
  reconnect = { baseMs: 500, maxMs: 15_000 }, uuid = () => globalThis.crypto.randomUUID(),
} = {}) {
  const sessions = new Map() // id → mirror
  const listeners = new Set()
  const commandOutput = new Map() // `${sessionId}:${commandId}` → record | 'loading'
  let workspaces = []
  let providers = []
  let permissionMode = 'auto_edit'
  let user = null
  let connection = 'connecting' // connecting | online | reconnecting | offline
  let offlineIndex = false
  let streamAbort = null
  let closed = false
  let reconnects = 0
  const seen = new Set()

  const notify = (event, session) => { for (const fn of [...listeners]) { try { fn(event, session) } catch { /* a view must not break the stream */ } } }
  /** Re-renders subscribers after a change that is not a runtime event (loading finished, save status, connection). */
  const touch = (session) => notify({ id: `local_${uuid()}`, type: 'session.updated', sessionId: session.id, timestamp: Date.now(), data: { local: true } }, session)

  async function request(method, url, body) {
    const token = await getToken()
    let res
    try {
      res = await fetchImpl(`${baseUrl}${url}`, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      throw Object.assign(new Error('Cannot reach the BLUSWAN server.'), { code: 'network_error', retryable: true, cause: e })
    }
    const text = await res.text()
    const json = text ? (() => { try { return JSON.parse(text) } catch { return null } })() : null
    if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `Request failed (${res.status}).`), { code: json?.error?.code ?? 'runtime_error', status: res.status, retryable: !!json?.error?.retryable })
    return json
  }

  // ─── mirror ────────────────────────────────────────────────────────────────

  function blank(id, fields = {}) {
    return { id, workspaceId: null, model: { provider: 'deepseek', model: '' }, status: 'idle', events: [], messages: [], toolCalls: [], changedFiles: [], runs: [], validation: null,
      tokenUsage: { ...EMPTY_USAGE }, startedAt: Date.now(), updatedAt: Date.now(), hydrated: false, loading: false, persistence: 'saved', title: null, commands: [], buffered: [], ...fields }
  }

  function applyIndex(item) {
    const existing = sessions.get(item.id)
    const fields = { title: item.title, workspaceId: item.workspaceId, status: item.status, updatedAt: item.lastActivityAt, startedAt: item.createdAt, model: item.model, changedCount: item.changedCount ?? 0, persistence: item.persistence ?? existing?.persistence ?? 'saved' }
    if (existing) { if (!existing.hydrated) Object.assign(existing, fields); else existing.title = item.title; return existing }
    const s = blank(item.id, fields)
    sessions.set(item.id, s)
    return s
  }

  function applyLite(s, lite) {
    Object.assign(s, { status: lite.status, workspaceId: lite.workspaceId, model: lite.model, changedFiles: lite.changedFiles, validation: lite.validation, tokenUsage: lite.tokenUsage, updatedAt: lite.updatedAt })
  }

  function addEvent(s, event) {
    if (seen.has(event.id)) return false
    seen.add(event.id)
    if (seen.size > MAX_SEEN) for (const id of [...seen].slice(0, MAX_SEEN / 2)) seen.delete(id)
    s.events.push(event)
    if (event.type === 'command.completed') {
      const i = s.commands.findIndex(c => c.id === event.data.id)
      if (i >= 0) s.commands[i] = event.data; else s.commands.push(event.data)
      commandOutput.delete(`${s.id}:${event.data.id}`)
    }
    return true
  }

  function onMessage(msg) {
    if (msg.kind === 'event') {
      let s = sessions.get(msg.sessionId)
      if (!s) { s = blank(msg.sessionId, { workspaceId: msg.session.workspaceId, model: msg.session.model, startedAt: msg.session.startedAt }); sessions.set(s.id, s) }
      applyLite(s, msg.session)
      if (s.loading) { s.buffered.push(msg.event); return }
      if (!s.hydrated) { touch(s); return } // transcript is loaded when the session is opened
      if (addEvent(s, msg.event)) notify(msg.event, s)
    } else if (msg.kind === 'persistence') {
      const s = sessions.get(msg.sessionId)
      if (s) { s.persistence = msg.status; touch(s) }
    }
  }

  // ─── stream ────────────────────────────────────────────────────────────────

  async function openStream() {
    streamAbort = new AbortController()
    const token = await getToken()
    const res = await fetchImpl(`${baseUrl}/api/stream`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: streamAbort.signal })
    if (!res.ok) throw Object.assign(new Error('stream refused'), { status: res.status })
    connection = 'online'
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        const d = /^data: (.*)$/m.exec(chunk)
        if (d) { try { onMessage(JSON.parse(d[1])) } catch { /* ignore a malformed frame */ } }
      }
    }
  }

  async function runStream() {
    let attempt = 0
    while (!closed) {
      try {
        await openStream()
        attempt = 0
      } catch (e) {
        if (closed) return
        if (e?.status === 401 || e?.status === 403) { connection = 'offline'; return }
      }
      if (closed) return
      connection = 'reconnecting'; reconnects += 1
      for (const s of sessions.values()) touch(s)
      await new Promise(r => setTimeout(r, Math.min(reconnect.maxMs, reconnect.baseMs * 2 ** attempt++)))
      if (!closed) await resync().catch(() => {})
    }
  }

  /** After a dropped stream, ask the server for the truth about every conversation the user has open. */
  async function resync() {
    const boot = await request('GET', '/api/sessions')
    for (const item of boot.items) applyIndex(item)
    for (const s of sessions.values()) if (s.hydrated && !s.loading) await loadSession(s.id, { force: true }).catch(() => {})
  }

  // ─── interface used by the client store ────────────────────────────────────

  async function loadSession(id, { force = false } = {}) {
    const s = sessions.get(id)
    if (!s || (s.hydrated && !force) || s.loading || s.draft) return s
    s.loading = true; s.loadError = null; touch(s)
    try {
      const data = await request('GET', `/api/sessions/${encodeURIComponent(id)}`)
      const known = new Set(s.events.map(e => e.id))
      const merged = [...data.session.events]
      for (const e of s.events) if (!merged.some(x => x.id === e.id)) merged.push(e)
      for (const e of s.buffered) if (!merged.some(x => x.id === e.id) && !known.has(e.id)) merged.push(e)
      s.events = merged.sort((a, b) => a.timestamp - b.timestamp)
      for (const e of merged) seen.add(e.id)
      s.commands = data.commands
      applyLite(s, data.session)
      s.persistence = data.persistence ?? s.persistence
      s.workspaceState = data.workspace
      s.hydrated = true; s.loadReplaced = true
    } catch (e) {
      s.loadError = e
    } finally {
      s.loading = false; s.buffered = []
      touch(s)
    }
    return s
  }

  const runtime = {
    kind: 'remote',

    /** Loads bootstrap data and opens the stream. Resolves once the session list is available (or cached). */
    async init() {
      try {
        const data = await request('GET', '/api/bootstrap')
        user = data.user; providers = data.providers; permissionMode = data.permissionMode; workspaces = data.workspaces
        for (const item of data.sessions.items) applyIndex(item)
        offlineIndex = false
        await cache?.save(userKey, data.sessions.items).catch(() => {})
      } catch (e) {
        const cached = await cache?.load(userKey).catch(() => null)
        if (!cached?.length || e.status === 401) throw e
        for (const item of cached) applyIndex(item)
        offlineIndex = true; connection = 'offline'
      }
      if (!offlineIndex) runStream()
      return runtime
    },

    getConnection: () => ({ state: connection, offlineIndex, reconnects }),
    retryConnection: async () => { connection = 'reconnecting'; await runtime.init(); },
    getUser: () => user,

    listSessions: () => [...sessions.values()].filter(s => s.status !== 'deleted'),
    getSession: (id) => sessions.get(id) ?? null,
    loadSession,
    getPersistenceStatus: (id) => sessions.get(id)?.persistence ?? 'saved',

    /** Optimistic: the session exists locally at once; the server learns of it with the first message. */
    startSession({ workspaceId = null, model } = {}) {
      const id = uuid()
      const s = blank(id, { workspaceId, model: model ?? { provider: 'deepseek', model: '' }, hydrated: true, draft: true, persistence: 'unsaved' })
      sessions.set(id, s)
      return s
    },

    async sendMessage(id, content) {
      const s = sessions.get(id)
      if (!s) throw Object.assign(new Error('That conversation is gone.'), { code: 'not_found' })
      if (s.draft) { // register the draft with the server, using the client-chosen id
        await request('POST', '/api/sessions', { id, workspaceId: s.workspaceId, model: s.model })
        s.draft = false
      }
      s.status = 'running'; touch(s)
      try { await request('POST', `/api/sessions/${encodeURIComponent(id)}/messages`, { content }) } catch (e) { s.status = 'idle'; touch(s); throw e }
    },

    cancelSession(id) { request('POST', `/api/sessions/${encodeURIComponent(id)}/cancel`, {}).catch(() => {}); return true },
    approvePermission(id, pid) { request('POST', `/api/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(pid)}`, { decision: 'approve' }).catch(() => {}); return true },
    denyPermission(id, pid) { request('POST', `/api/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(pid)}`, { decision: 'deny' }).catch(() => {}); return true },
    getPendingPermissions: () => [],

    async deleteSession(id) {
      const s = sessions.get(id)
      if (s && !s.draft) await request('DELETE', `/api/sessions/${encodeURIComponent(id)}`)
      sessions.delete(id)
      return true
    },

    getPermissionMode: () => permissionMode,
    setPermissionMode(mode) { permissionMode = mode; request('PUT', '/api/settings', { permissionMode: mode }).catch(() => {}) },
    async saveSettings(patch) { return request('PUT', '/api/settings', patch) },

    checkModel(model) {
      const p = providers.find(x => x.provider === model.provider)
      if (!p?.configured) return { ok: false, code: 'configuration_error', reason: 'no_api_key', message: `${p?.label ?? 'The model provider'} is not configured on the server.` }
      if (!model.model) return { ok: false, code: 'configuration_error', reason: 'no_model', message: 'No model is configured.' }
      return { ok: true }
    },
    listProviders: () => providers.map(p => p.provider),
    getProviderStatus: () => providers,

    canOpenWorkspaces: () => true,
    listWorkspaces: () => workspaces,
    async openWorkspace(spec) {
      const ws = await request('POST', '/api/workspaces', spec)
      workspaces = [...workspaces.filter(w => w.id !== ws.id), ws]
      return ws
    },
    async reconnectWorkspace(id, root) {
      const ws = await request('POST', `/api/workspaces/${encodeURIComponent(id)}/reconnect`, { root })
      workspaces = workspaces.map(w => (w.id === id ? ws : w))
      for (const s of sessions.values()) if (s.workspaceId === id) await loadSession(s.id, { force: true }).catch(() => {})
      return ws
    },

    // review workspace
    getWorkspaceState: (id) => request('GET', `/api/sessions/${encodeURIComponent(id)}/workspace-state`),
    getFileDiff: (id, path, { from } = {}) => request('GET', `/api/sessions/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`),
    revertFile: (id, path) => request('POST', `/api/sessions/${encodeURIComponent(id)}/revert`, { path }),
    listCommands: (id) => sessions.get(id)?.commands ?? [],
    getCommand(id, commandId) {
      const key = `${id}:${commandId}`
      const have = commandOutput.get(key)
      if (have && have !== 'loading') return have
      const meta = sessions.get(id)?.commands.find(c => c.id === commandId)
      if (!have && meta) {
        commandOutput.set(key, 'loading')
        request('GET', `/api/sessions/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}`)
          .then(rec => { commandOutput.set(key, rec) }).catch(() => { commandOutput.delete(key) })
          .finally(() => { const s = sessions.get(id); if (s) touch(s) })
      }
      return meta ? { ...meta, stdout: '', stderr: '', outputPending: true } : null
    },

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },

    /** Sign-out: stop the stream, tell the server, drop everything held for this user. */
    async logout() {
      closed = true; streamAbort?.abort()
      await request('POST', '/api/logout', {}).catch(() => {})
      await cache?.clear(userKey).catch(() => {})
      sessions.clear(); commandOutput.clear(); seen.clear(); listeners.clear(); workspaces = []; providers = []
    },
    close() { closed = true; streamAbort?.abort() },
  }
  return runtime
}

/** Session-index cache (IndexedDB or any docStore): lets the list show offline. Namespaced per user. */
export function createIndexCache(docs) {
  const path = (u) => `users/${u}/cache/sessionIndex`
  return {
    async save(userKey, items) { await docs.put(path(userKey), { items: items.slice(0, 200), savedAt: Date.now() }) },
    async load(userKey) { return (await docs.get(path(userKey)))?.data.items ?? null },
    async clear(userKey) { await docs.delete(path(userKey)) },
  }
}
