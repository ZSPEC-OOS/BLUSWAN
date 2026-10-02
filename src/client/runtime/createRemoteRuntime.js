// The runtime as seen by the browser: the same interface the client store already uses, backed by the BLUSWAN
// server over HTTP + Server-Sent Events. No provider, tool or credential logic lives here; it keeps a local mirror
// of server state, fed by the canonical event stream, so synchronous reads (session lists, transcripts) stay cheap.
//
//  • sessions arrive as a lightweight index and are hydrated on demand (loadSession);
//  • stream events are de-duplicated by id, so a reconnect can never render a message twice;
//  • if the stream drops it reconnects with backoff and re-syncs the open conversations from the server's state;
//  • an optional IndexedDB-backed cache lets the previous session list show while the server is unreachable.
import { PROTOCOL_VERSION, APP_VERSION } from '../../protocol/version.js'
import { ConnectionFailure, classifyFailure, probeHealth, probeReady } from './connectivity.js'

const EMPTY_USAGE = { input: 0, output: 0, reasoning: 0, total: 0 }
const MAX_SEEN = 20_000

/**
 * @param {{baseUrl?:string, getToken?:()=>Promise<string|null>, fetch?:typeof fetch, cache?:object|null, userKey?:string,
 *          reconnect?:{baseMs:number, maxMs:number}, uuid?:()=>string}} options
 */
export function createRemoteRuntime({
  baseUrl = '', getToken = async () => null, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), cache = null, userKey = 'local',
  reconnect = { baseMs: 500, maxMs: 15_000 }, uuid = () => globalThis.crypto.randomUUID(),
  streamIdleMs = 45_000, probeTimeoutMs = 8_000,
} = {}) {
  const sessions = new Map() // id → mirror
  const listeners = new Set()
  const commandOutput = new Map() // `${sessionId}:${commandId}` → record | 'loading'
  let workspaces = []
  let providers = []
  let models = []
  let defaultModel = { provider: '', model: '' }
  let permissionMode = 'auto_edit'
  let user = null
  // Connection state machine (see getConnection): starting → checking_server → authenticating → loading_bootstrap →
  // connecting_stream → online; reconnecting after a dropped stream; offline_cached / server_unreachable /
  // auth_error / server_error when the runtime cannot be used.
  let conn = { state: 'starting', failure: null, attempts: 0, nextRetryAt: null, health: null, readiness: null, lastRequestId: null }
  const connListeners = new Set()
  let usable = false // bootstrap (or a cached session list) is loaded: the app can render
  let offlineIndex = false
  let streamAbort = null
  let attemptAbort = null
  let streamRunning = false
  let driver = null
  let closed = false
  let reconnects = 0
  const wakers = new Set() // sleeping retry timers, woken by a manual retry or close()
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
    const requestId = res.headers?.get?.('x-request-id') ?? json?.error?.requestId ?? null
    if (requestId) conn.lastRequestId = requestId
    if (!res.ok) {
      const gateway = [502, 503, 504].includes(res.status) && !json?.error // a proxy answering for a dead runtime
      throw Object.assign(new Error(gateway ? 'Cannot reach the BLUSWAN server.' : (json?.error?.message ?? `Request failed (${res.status}).`)), { code: gateway ? 'network_error' : (json?.error?.code ?? 'runtime_error'), status: res.status, retryable: gateway || !!json?.error?.retryable, requestId })
    }
    return json
  }

  // ─── mirror ────────────────────────────────────────────────────────────────

  function blank(id, fields = {}) {
    return { id, workspaceId: null, model: { ...defaultModel }, status: 'idle', events: [], messages: [], toolCalls: [], changedFiles: [], runs: [], validation: null,
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
    if (msg.kind === 'hello') {
      if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTOCOL_VERSION) {
        setConn({ state: 'server_error', failure: new ConnectionFailure('client_server_version_mismatch', 'This page and the runtime are different versions.', { stage: 'connecting_stream', code: 'protocol_mismatch' }) })
        streamAbort?.abort()
      }
    } else if (msg.kind === 'event') {
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

  // ─── connection ────────────────────────────────────────────────────────────

  const getConnection = () => ({
    state: conn.state, offlineIndex, reconnects, usable,
    // online = the stream is up; reconnecting still lets requests through, everything else is read-only
    canAct: usable && ['online', 'reconnecting', 'connecting_stream'].includes(conn.state),
    failure: conn.failure ? { kind: conn.failure.kind, message: conn.failure.message, status: conn.failure.status, requestId: conn.failure.requestId ?? conn.lastRequestId, retryable: conn.failure.retryable, stage: conn.failure.stage } : null,
    attempts: conn.attempts, nextRetryAt: conn.nextRetryAt, lastRequestId: conn.lastRequestId, health: conn.health, readiness: conn.readiness,
  })
  const setConn = (patch) => {
    conn = { ...conn, ...patch }
    const view = getConnection()
    for (const fn of [...connListeners]) { try { fn(view) } catch { /* a view must not break the connection */ } }
  }
  const sleep = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(t); wakers.delete(done); resolve() }
    const t = setTimeout(done, ms)
    wakers.add(done)
  })
  const delayFor = (attempt) => Math.min(reconnect.maxMs, reconnect.baseMs * 2 ** attempt)
  const withTimeout = (ms) => {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), ms)
    return { signal: ac.signal, done: () => clearTimeout(t), abort: () => ac.abort() }
  }

  /** Any thrown value → a classified ConnectionFailure (requests throw coded errors, probes throw failures). */
  function toFailure(e, stage) {
    if (e instanceof ConnectionFailure) { e.stage ??= stage; return e }
    if (e?.code === 'network_error' || (e?.status == null && e?.code == null)) return classifyFailure({ networkError: e, stage })
    return classifyFailure({ status: e.status, body: { error: { code: e.code, message: e.message, requestId: e.requestId } }, stage, requestId: e.requestId })
  }

  function applyBootstrap(data) {
    user = data.user; providers = data.providers; models = data.models ?? []; defaultModel = data.defaultModel ?? defaultModel; permissionMode = data.permissionMode; workspaces = data.workspaces
    for (const item of data.sessions.items) applyIndex(item)
  }

  /** One pass of health → ready → token → bootstrap → stream. Throws a ConnectionFailure naming the stage that failed. */
  async function attempt() {
    const first = !usable
    const stage = (name) => { if (first) setConn({ state: name }) }
    const probe = withTimeout(probeTimeoutMs); attemptAbort = probe
    let st = 'checking_server'
    try {
      stage('checking_server')
      const health = await probeHealth({ fetch: fetchImpl, baseUrl, signal: probe.signal })
      const readiness = await probeReady({ fetch: fetchImpl, baseUrl, signal: probe.signal })
      setConn({ health: { version: health.version, protocolVersion: health.protocolVersion, auth: health.auth }, readiness: { checks: readiness.checks ?? null, providers: readiness.providers ?? null } })
      st = 'authenticating'; stage('authenticating')
      try { await getToken() } catch (e) { throw new ConnectionFailure('authentication_failed', 'Your session has expired. Sign in again.', { stage: st, cause: e }) }
      st = 'loading_bootstrap'; stage('loading_bootstrap')
      const data = await request('GET', '/api/bootstrap')
      applyBootstrap(data)
      const wasOffline = offlineIndex
      offlineIndex = false; usable = true
      await cache?.save(userKey, data.sessions.items).catch(() => {})
      setConn({ state: streamRunning ? conn.state : 'connecting_stream', failure: null, nextRetryAt: null, attempts: 0 })
      if (!streamRunning) { streamRunning = true; runStream().finally(() => { streamRunning = false }) }
      if (wasOffline) for (const x of sessions.values()) if ((x.hydrated || x.loadError) && !x.loading) loadSession(x.id, { force: true }).catch(() => {}) // include conversations whose first load failed while offline
    } catch (e) {
      throw toFailure(e, st)
    } finally { probe.done(); if (attemptAbort === probe) attemptAbort = null }
  }

  const stateForFailure = (f) => (f.kind === 'authentication_failed' || f.kind === 'authentication_required' ? 'auth_error' : f.kind === 'server_unreachable' ? 'server_unreachable' : 'server_error')

  /**
   * Runs attempts until the runtime is usable, retrying retryable failures with backoff while `autoRetry`.
   * While only a cached session list is available it keeps trying in the background, so the page recovers by itself.
   * @returns {Promise<boolean>} true once connected to the server
   */
  async function drive({ autoRetry }) {
    let tries = 0
    for (;;) {
      if (closed) return false
      setConn({ attempts: tries })
      try { await attempt(); return true } catch (f) {
        if (closed) return false
        if (!usable && f.retryable && f.kind !== 'authentication_failed') { // first boot failed: fall back to the cached list if there is one
          const cached = await cache?.load(userKey).catch(() => null)
          if (cached?.length) { for (const item of cached) applyIndex(item); usable = true; offlineIndex = true }
        }
        if (usable && offlineIndex && f.retryable) setConn({ state: 'offline_cached', failure: f })
        else if (usable && !offlineIndex) setConn({ failure: f }) // already connected once; the stream loop owns the state
        else setConn({ state: stateForFailure(f), failure: f })
        if (!autoRetry || !f.retryable) return false
        const wait = delayFor(tries++)
        setConn({ nextRetryAt: Date.now() + wait })
        await sleep(wait)
        setConn({ nextRetryAt: null })
      }
    }
  }
  /** Starts (or joins) the connection driver. */
  const ensureDriver = (options) => (driver ??= drive(options).finally(() => { driver = null }))

  // ─── stream ────────────────────────────────────────────────────────────────

  async function openStream() {
    streamAbort = new AbortController()
    const token = await getToken()
    const res = await fetchImpl(`${baseUrl}/api/stream`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: streamAbort.signal })
    if (!res.ok) throw Object.assign(new Error('stream refused'), { status: res.status })
    if (!/text\/event-stream/i.test(res.headers?.get?.('content-type') ?? 'text/event-stream')) throw Object.assign(new Error('not an event stream'), { status: 0, notStream: true })
    setConn({ state: 'online', failure: null })
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
    let last = Date.now()
    // the server sends a heartbeat every 15 s; silence means a proxy or network path has died without telling us
    const watchdog = setInterval(() => { if (Date.now() - last > streamIdleMs) streamAbort?.abort() }, Math.max(10, Math.floor(streamIdleMs / 3)))
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        last = Date.now()
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          const d = /^data: (.*)$/m.exec(chunk)
          if (d) { try { onMessage(JSON.parse(d[1])) } catch { /* ignore a malformed frame */ } }
        }
      }
    } finally { clearInterval(watchdog) }
  }

  async function runStream() {
    let attemptNo = 0
    while (!closed) {
      try {
        await openStream()
        attemptNo = 0
      } catch (e) {
        if (closed) return
        if (e?.status === 401 || e?.status === 403) { setConn({ state: 'auth_error', failure: toFailure(e, 'connecting_stream') }); return }
        if (conn.state === 'server_error' && conn.failure?.kind === 'client_server_version_mismatch') return
      }
      if (closed) return
      if (conn.failure?.kind === 'client_server_version_mismatch') return
      reconnects += 1
      setConn({ state: 'reconnecting' })
      await sleep(delayFor(attemptNo++))
      if (closed) return
      // the runtime may be restarting: wait for health/readiness before trusting the stream again
      try { await resync() } catch (e) {
        const f = toFailure(e, 'resyncing')
        if (f.kind === 'authentication_failed') { setConn({ state: 'auth_error', failure: f }); return }
        if (f.kind === 'client_server_version_mismatch') { setConn({ state: 'server_error', failure: f }); return }
      }
    }
  }

  /** After a dropped stream, ask the server for the truth about every conversation the user has open. */
  async function resync() {
    const probe = withTimeout(probeTimeoutMs)
    try { await probeHealth({ fetch: fetchImpl, baseUrl, signal: probe.signal }) } finally { probe.done() }
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

    /**
     * Connects with retries and returns immediately; progress is observable through getConnection()/onConnection().
     * Resolves true once the runtime is reachable (false if stopped by a non-retryable failure or close()).
     * The app renders as soon as `getConnection().usable` (live bootstrap or a cached session list).
     */
    start({ autoRetry = true } = {}) { return ensureDriver({ autoRetry }) },

    /** One-shot connect (no automatic retry): resolves once the session list is available (or cached), else throws the classified failure. */
    async init() {
      await ensureDriver({ autoRetry: false })
      if (!usable) throw conn.failure ?? new ConnectionFailure('server_unreachable', 'BLUSWAN could not reach its runtime.')
      return runtime
    },

    getConnection,
    onConnection(fn) { connListeners.add(fn); return () => connListeners.delete(fn) },
    /** Manual retry: skips any backoff wait and reruns the whole sequence (health → ready → token → bootstrap → stream). */
    retryConnection() {
      if (closed) return Promise.resolve(false)
      if (driver) { for (const wake of [...wakers]) wake(); return driver }
      if (usable && !offlineIndex) { // connected before; make the stream loop try again now
        for (const wake of [...wakers]) wake()
        if (!streamRunning) return ensureDriver({ autoRetry: true })
        return Promise.resolve(true)
      }
      return ensureDriver({ autoRetry: true })
    },

    /**
     * Independent health report for the "connection details" view: each stage is probed separately with its own timeout.
     * Contains no credentials; the token is used only to ask the server whether it is accepted.
     */
    async diagnoseConnection() {
      const timed = async (fn) => {
        const t0 = Date.now(); const probe = withTimeout(probeTimeoutMs)
        try { return { ok: true, ms: Date.now() - t0, ...(await fn(probe.signal)) } } catch (e) {
          const f = toFailure(e)
          return { ok: false, ms: Date.now() - t0, kind: f.kind, status: f.status, message: f.message, requestId: f.requestId }
        } finally { probe.done() }
      }
      const health = await timed(async (signal) => { const h = await probeHealth({ fetch: fetchImpl, baseUrl, signal }); return { version: h.version, protocolVersion: h.protocolVersion, auth: h.auth } })
      const readiness = health.ok ? await timed(async (signal) => { const r = await probeReady({ fetch: fetchImpl, baseUrl, signal }); return { checks: r.checks ?? null, providers: r.providers ?? null } }) : { ok: false, skipped: true }
      const authentication = health.ok ? await timed(async () => { await getToken(); await request('GET', '/api/me'); return {} }) : { ok: false, skipped: true }
      const bootstrap = authentication.ok ? await timed(async () => { const b = await request('GET', '/api/bootstrap'); return { sessions: b.sessions.items.length, providersConfigured: b.providers.filter(p => p.configured).length } }) : { ok: false, skipped: true }
      const c = getConnection()
      return {
        clientVersion: APP_VERSION, protocolVersion: PROTOCOL_VERSION, apiUrl: baseUrl || '(same origin)',
        health, readiness, authentication, bootstrap,
        stream: { state: c.state, reconnects: c.reconnects, offlineCache: c.offlineIndex },
        lastRequestId: c.lastRequestId,
      }
    },
    getUser: () => user,

    listSessions: () => [...sessions.values()].filter(s => s.status !== 'deleted'),
    getSession: (id) => sessions.get(id) ?? null,
    loadSession,
    getPersistenceStatus: (id) => sessions.get(id)?.persistence ?? 'saved',

    /** Optimistic: the session exists locally at once; the server learns of it with the first message. */
    startSession({ workspaceId = null, model } = {}) {
      const id = uuid()
      const s = blank(id, { workspaceId, model: model ?? { ...defaultModel }, hydrated: true, draft: true, persistence: 'unsaved' })
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
    getModels: () => models,
    getDefaultModel: () => defaultModel,
    /** The model for the session's NEXT run. Drafts change locally; stored sessions ask the server (it refuses mid-run). */
    async setSessionModel(id, model) {
      const s = sessions.get(id)
      if (!s) throw Object.assign(new Error('That conversation is gone.'), { code: 'not_found' })
      if (s.draft) { s.model = { provider: model.provider, model: model.model }; touch(s); return s.model }
      const res = await request('PUT', `/api/sessions/${encodeURIComponent(id)}/model`, model)
      s.model = res.model; touch(s)
      return res.model
    },
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
      closed = true; streamAbort?.abort(); attemptAbort?.abort(); for (const wake of [...wakers]) wake()
      await request('POST', '/api/logout', {}).catch(() => {})
      await cache?.clear(userKey).catch(() => {})
      sessions.clear(); commandOutput.clear(); seen.clear(); listeners.clear(); connListeners.clear(); workspaces = []; providers = []; models = []; usable = false
    },
    /** Stops everything this runtime started: stream, in-flight probes, retry timers and connection listeners. */
    close() { closed = true; streamAbort?.abort(); attemptAbort?.abort(); for (const wake of [...wakers]) wake(); connListeners.clear(); listeners.clear() },
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
