// Connection state machine of the browser-side remote runtime, driven by a scripted fetch (no server, no timers
// longer than a few ms). Covers boot classification, retry/backoff, offline cache, recovery, version mismatch,
// stream silence, diagnostics and clean shutdown.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteRuntime } from './createRemoteRuntime.js'
import { createClientStore } from '../state/clientStore.js'
import { classifyFailure, describeFailure, validateApiUrl, isMobileClient, checkHealth, backoffDelay, BACKOFF_MS } from './connectivity.js'
import { PROTOCOL_VERSION, APP_VERSION } from '../../protocol/version.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 3000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error(`timeout (${pred})`); await new Promise(r => setTimeout(r, 3)) } }

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req-test-0001', ...headers } })
const HEALTH = { ok: true, service: 'bluswan', version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, auth: 'none' }
const READY = { ok: true, ready: true, checks: { persistence: 'ok', workspaces: 'ok' }, providers: { configured: 1 } }
const ITEM = { id: 'sess-aaaaaaaa', title: 'Saved chat', workspaceId: null, status: 'completed', lastActivityAt: 10, createdAt: 5, model: { provider: 'deepseek', model: 'm' }, changedCount: 0, persistence: 'saved' }
const BOOT = { user: { id: 'local' }, providers: [{ provider: 'deepseek', label: 'DeepSeek', configured: true, model: 'm' }], models: [], defaultModel: { provider: 'deepseek', model: 'm' }, permissionMode: 'auto_edit', workspaces: [], sessions: { items: [ITEM], nextCursor: null } }

/** A scripted runtime server: flip `mode` to change what every endpoint does. */
function fakeServer() {
  const s = {
    mode: 'up', calls: [], streams: [], health: HEALTH, ready: [200, READY], bootstrap: [200, BOOT],
    fetch: async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      s.calls.push(path)
      if (s.mode === 'down') throw new TypeError('fetch failed')
      if (s.mode === 'gateway') return new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
      if (path === '/api/health') return json(200, s.health)
      if (path === '/api/ready') return json(...s.ready)
      if (path === '/api/me') return json(200, { user: { id: 'local' } })
      if (path === '/api/bootstrap') return json(...s.bootstrap)
      if (path === '/api/sessions') return json(200, { items: [ITEM], nextCursor: null })
      if (path === '/api/stream') {
        if (s.streamStatus) return json(s.streamStatus, { error: { code: 'unauthenticated', message: 'Sign in.' } })
        let ctrl
        const body = new ReadableStream({ start(c) { ctrl = c; c.enqueue(new TextEncoder().encode(`id: \ndata: ${JSON.stringify({ kind: 'hello', at: 1, protocolVersion: s.helloProtocol ?? PROTOCOL_VERSION })}\n\n`)) } })
        const entry = { push: (text) => ctrl.enqueue(new TextEncoder().encode(text)), end: () => { try { ctrl.close() } catch { /* already closed */ } }, aborted: false }
        init.signal?.addEventListener('abort', () => { entry.aborted = true; try { ctrl.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ } })
        s.streams.push(entry)
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return json(404, { error: { code: 'not_found', message: 'nope' } })
    },
  }
  return s
}
const memoryCache = () => { const m = new Map(); return { save: async (k, v) => { m.set(k, v) }, load: async (k) => m.get(k) ?? null, clear: async (k) => { m.delete(k) } } }
const make = (server, o = {}) => {
  const states = []
  const runtime = createRemoteRuntime({ baseUrl: 'http://rt.test', fetch: server.fetch, reconnect: { baseMs: 5, maxMs: 20 }, uuid: () => Math.random().toString(36).slice(2), streamIdleMs: 90, probeTimeoutMs: 500, ...o })
  runtime.onConnection((c) => { if (states.at(-1) !== c.state) states.push(c.state) })
  cleanups.push(() => runtime.close())
  return { runtime, states }
}

describe('failure classification', () => {
  const kind = (o) => classifyFailure(o).kind
  it('maps transport and HTTP results to the documented categories', () => {
    assert.equal(kind({ networkError: new TypeError('x') }), 'server_unreachable')
    assert.equal(kind({ status: 502 }), 'server_unreachable')
    assert.equal(kind({ status: 504, body: { error: null } }), 'server_unreachable')
    assert.equal(kind({ status: 404 }), 'server_unreachable')
    assert.equal(kind({ status: 401, body: { error: { code: 'unauthenticated' } } }), 'authentication_failed')
    assert.equal(kind({ status: 403, body: { error: { code: 'forbidden' } } }), 'authentication_failed')
    assert.equal(kind({ status: 503, body: { error: { code: 'persistence_unavailable' } } }), 'persistence_unavailable')
    assert.equal(kind({ status: 503, body: { error: { code: 'workspace_host_unavailable' } } }), 'workspace_host_unavailable')
    assert.equal(kind({ status: 503, body: { error: { code: 'configuration_error' } } }), 'configuration_error')
    assert.equal(kind({ status: 503, body: { error: { code: 'server_not_ready' } } }), 'server_not_ready')
    assert.equal(kind({ status: 426, body: { error: { code: 'protocol_mismatch' } } }), 'client_server_version_mismatch')
    assert.equal(kind({ status: 500, body: { error: { code: 'runtime_error' } } }), 'unknown_server_error')
  })
  it('only transient kinds are retryable', () => {
    for (const k of ['server_unreachable', 'server_not_ready', 'persistence_unavailable', 'workspace_host_unavailable', 'unknown_server_error']) assert.equal(classifyFailure({ status: k === 'server_unreachable' ? 502 : 503, body: { error: { code: k === 'unknown_server_error' ? 'runtime_error' : k } } }).retryable, true, k)
    for (const [status, code] of [[401, 'unauthenticated'], [503, 'configuration_error'], [426, 'protocol_mismatch']]) assert.equal(classifyFailure({ status, body: { error: { code } } }).retryable, false, code)
  })
  it('health must identify a compatible BLUSWAN runtime', () => {
    assert.throws(() => checkHealth({ ok: true, service: 'other' }), (e) => e.kind === 'server_unreachable')
    assert.throws(() => checkHealth({ ...HEALTH, protocolVersion: PROTOCOL_VERSION + 1 }), (e) => e.kind === 'client_server_version_mismatch')
    assert.equal(checkHealth(HEALTH), HEALTH)
  })
  it('messages are specific and never claim saved state unless it is known', () => {
    for (const k of ['server_unreachable', 'server_not_ready', 'authentication_failed', 'persistence_unavailable', 'workspace_host_unavailable', 'configuration_error', 'client_server_version_mismatch', 'unknown_server_error']) {
      const d = describeFailure(k); assert.ok(d.title && d.detail && d.actions.length, k)
      assert.doesNotMatch(JSON.stringify(d), /stored on the server/i, k)
    }
    assert.match(describeFailure('server_not_ready').title, /starting/)
    assert.deepEqual(describeFailure('client_server_version_mismatch').actions[0], 'reload')
    assert.match(describeFailure('server_unreachable', { savedKnown: true }).note, /already saved/)
    assert.equal(describeFailure('server_unreachable').note, undefined)
  })
  it('backoff follows 0.5, 1, 2, 4, 8, 15 seconds and stays at 15', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(n => backoffDelay(n)), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000])
    assert.deepEqual([...BACKOFF_MS], [500, 1000, 2000, 4000, 8000, 15000])
  })
})

describe('API URL validation', () => {
  it('accepts same-origin (empty) and normalizes absolute URLs', () => {
    assert.deepEqual(validateApiUrl(''), { ok: true, url: '', warnings: [] })
    assert.equal(validateApiUrl('https://rt.example.com/').url, 'https://rt.example.com')
  })
  it('rejects non-URLs, other schemes and embedded credentials', () => {
    for (const v of ['rt.example.com', 'ftp://x', 'javascript:alert(1)', 'https://user:pw@rt.example.com']) assert.equal(validateApiUrl(v).ok, false, v)
  })
  it('warns when a page served elsewhere points at localhost, with mobile-specific wording', () => {
    const w = validateApiUrl('http://localhost:8787', { page: { hostname: 'app.example.com', protocol: 'https:' }, mobile: true }).warnings
    assert.ok(w.some(x => x.code === 'localhost_api_from_remote_page' && /this device/i.test(x.message)))
    assert.equal(validateApiUrl('http://localhost:8787', { page: { hostname: 'localhost', protocol: 'http:' } }).warnings.length, 0)
  })
  it('warns about mixed content', () => {
    assert.ok(validateApiUrl('http://rt.example.com', { page: { hostname: 'app.example.com', protocol: 'https:' } }).warnings.some(x => x.code === 'mixed_content'))
  })
  it('detects phones and tablets', () => {
    assert.equal(isMobileClient({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), true)
    assert.equal(isMobileClient({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', maxTouchPoints: 0 }), false)
  })
})

describe('boot sequence', () => {
  it('goes health → ready → authenticating → bootstrap → stream → online, in that order', async () => {
    const server = fakeServer(); const { runtime, states } = make(server)
    assert.equal(await runtime.start(), true)
    await until(() => runtime.getConnection().state === 'online')
    assert.deepEqual(states, ['starting', 'checking_server', 'authenticating', 'loading_bootstrap', 'connecting_stream', 'online'])
    assert.deepEqual(server.calls.slice(0, 4), ['/api/health', '/api/ready', '/api/bootstrap', '/api/stream'])
    const c = runtime.getConnection()
    assert.equal(c.usable, true); assert.equal(c.canAct, true); assert.equal(c.health.protocolVersion, PROTOCOL_VERSION); assert.deepEqual(c.readiness.checks, READY.checks)
  })
  it('an unreachable runtime is reported, retried with backoff, and recovers without a reload', async () => {
    const server = fakeServer(); server.mode = 'down'; const { runtime, states } = make(server)
    runtime.start()
    await until(() => runtime.getConnection().state === 'server_unreachable' && runtime.getConnection().attempts >= 2)
    assert.equal(runtime.getConnection().failure.kind, 'server_unreachable'); assert.equal(runtime.getConnection().usable, false)
    server.mode = 'up'
    await until(() => runtime.getConnection().state === 'online')
    assert.ok(states.includes('server_unreachable')); assert.equal(runtime.listSessions().length, 1)
  })
  it('a gateway page for a dead upstream (502/HTML) is "unreachable", not an application error', async () => {
    const server = fakeServer(); server.mode = 'gateway'; const { runtime } = make(server)
    runtime.start(); await until(() => runtime.getConnection().failure?.kind === 'server_unreachable')
    assert.equal(runtime.getConnection().failure.status, 502)
  })
  it('readiness failures are classified (storage) and retried; recovery proceeds', async () => {
    const server = fakeServer(); server.ready = [503, { ok: false, ready: false, error: { code: 'persistence_unavailable', message: 'Storage is unavailable.' } }]
    const { runtime } = make(server); runtime.start()
    await until(() => runtime.getConnection().failure?.kind === 'persistence_unavailable')
    assert.equal(runtime.getConnection().state, 'server_error'); assert.equal(runtime.getConnection().failure.stage, 'checking_server')
    server.ready = [200, READY]; await until(() => runtime.getConnection().state === 'online')
  })
  it('missing provider keys do not stop the boot', async () => {
    const server = fakeServer(); server.ready = [200, { ...READY, providers: { configured: 0 } }]; server.bootstrap = [200, { ...BOOT, providers: [{ provider: 'deepseek', configured: false }] }]
    const { runtime } = make(server); await runtime.start(); assert.equal(runtime.getConnection().usable, true)
  })
  it('authentication failure stops retrying and asks the user to sign in', async () => {
    const server = fakeServer(); server.bootstrap = [401, { error: { code: 'unauthenticated', message: 'Your session has expired. Sign in again.' } }]
    const { runtime } = make(server); assert.equal(await runtime.start(), false)
    const c = runtime.getConnection(); assert.equal(c.state, 'auth_error'); assert.equal(c.failure.kind, 'authentication_failed'); assert.equal(c.failure.retryable, false)
    const before = server.calls.length; await new Promise(r => setTimeout(r, 60)); assert.equal(server.calls.length, before, 'no automatic retries')
  })
  it('a token that cannot be obtained is an authentication failure', async () => {
    const { runtime } = make(fakeServer(), { getToken: async () => { throw new Error('refresh failed') } })
    assert.equal(await runtime.start(), false); assert.equal(runtime.getConnection().state, 'auth_error')
  })
  it('a protocol mismatch stops with a reload prompt and never loads data', async () => {
    const server = fakeServer(); server.health = { ...HEALTH, protocolVersion: PROTOCOL_VERSION + 1 }
    const { runtime } = make(server); assert.equal(await runtime.start(), false)
    assert.equal(runtime.getConnection().failure.kind, 'client_server_version_mismatch'); assert.ok(!server.calls.includes('/api/bootstrap'))
  })
  it('a runtime that upgrades while connected is detected from the stream hello', async () => {
    const server = fakeServer(); server.helloProtocol = PROTOCOL_VERSION + 1; const { runtime } = make(server)
    await runtime.start(); await until(() => runtime.getConnection().failure?.kind === 'client_server_version_mismatch')
    const streams = server.streams.length; await new Promise(r => setTimeout(r, 80)); assert.equal(server.streams.length, streams, 'does not reconnect to an incompatible runtime')
  })
  it('init() (one-shot) resolves when usable and throws the classified failure otherwise', async () => {
    const down = fakeServer(); down.mode = 'down'
    await assert.rejects(() => make(down).runtime.init(), (e) => e.kind === 'server_unreachable' && /could not reach/.test(e.message))
    const up = fakeServer(); const { runtime } = make(up); assert.equal(await runtime.init(), runtime)
  })
  it('manual retry skips the backoff wait', async () => {
    const server = fakeServer(); server.mode = 'down'; const { runtime } = make(server, { reconnect: { baseMs: 60_000, maxMs: 60_000 } })
    runtime.start(); await until(() => runtime.getConnection().nextRetryAt)
    server.mode = 'up'; const t0 = Date.now(); await runtime.retryConnection()
    assert.ok(Date.now() - t0 < 1000); assert.equal(runtime.getConnection().usable, true)
  })
})

describe('offline cache', () => {
  it('shows cached sessions when the runtime is down, disables actions, and reconnects by itself', async () => {
    const cache = memoryCache(); const server = fakeServer()
    const first = make(server, { cache, userKey: 'u1' }); await first.runtime.init(); first.runtime.close()
    const down = fakeServer(); down.mode = 'down'
    const { runtime, states } = make(down, { cache, userKey: 'u1' })
    runtime.start(); await until(() => runtime.getConnection().usable) // start() keeps retrying in the background, so it is not awaited
    const c = runtime.getConnection()
    assert.equal(c.state, 'offline_cached'); assert.equal(c.usable, true); assert.equal(c.canAct, false); assert.equal(c.offlineIndex, true)
    assert.deepEqual(runtime.listSessions().map(s => s.title), ['Saved chat'])
    down.mode = 'up'
    await until(() => runtime.getConnection().state === 'online')
    assert.equal(runtime.getConnection().offlineIndex, false); assert.equal(runtime.getConnection().canAct, true)
    assert.deepEqual(states.slice(0, 3), ['starting', 'checking_server', 'offline_cached'])
  })
  it('does not reuse another user\'s cache', async () => {
    const cache = memoryCache(); await cache.save('someone', [ITEM])
    const down = fakeServer(); down.mode = 'down'
    const { runtime } = make(down, { cache, userKey: 'other' }); await runtime.start({ autoRetry: false })
    assert.equal(runtime.getConnection().usable, false); assert.equal(runtime.listSessions().length, 0)
  })
  it('an expired session never falls back to the cache', async () => {
    const cache = memoryCache(); await cache.save('u1', [ITEM]); const server = fakeServer(); server.bootstrap = [401, { error: { code: 'unauthenticated', message: 'x' } }]
    const { runtime } = make(server, { cache, userKey: 'u1' }); await runtime.start()
    assert.equal(runtime.getConnection().state, 'auth_error'); assert.equal(runtime.getConnection().usable, false)
  })
  it('the client store disables send/approve/model/workspace/revert while offline and says why', async () => {
    const cache = memoryCache(); await cache.save('u1', [ITEM]); const down = fakeServer(); down.mode = 'down'
    const { runtime } = make(down, { cache, userKey: 'u1' }); runtime.start(); await until(() => runtime.getConnection().usable)
    const store = createClientStore({ runtime, settings: null, workspaceStorage: null })
    cleanups.push(() => store.destroy())
    store.newSession()
    const snap = store.getSnapshot()
    assert.equal(snap.canAct, false); assert.equal(snap.active.composer.disabled, true); assert.match(snap.active.composer.reason, /offline/i)
    assert.deepEqual(store.sendMessage('hello'), { ok: false, reason: 'offline' })
    assert.equal(store.approvePermission('p'), false); assert.equal(store.cancel(), false)
    assert.deepEqual(await store.openWorkspace({ root: '/x' }), { ok: false })
    assert.deepEqual(await store.workspace.confirmRevert(), { ok: false })
    assert.equal(snap.connection.state, 'offline_cached')
  })
})

describe('event stream resilience', () => {
  it('reconnects after the server closes the stream, resyncing without duplicating sessions', async () => {
    const server = fakeServer(); const { runtime } = make(server); await runtime.start()
    await until(() => server.streams.length === 1 && runtime.getConnection().state === 'online')
    server.streams[0].end()
    await until(() => server.streams.length === 2 && runtime.getConnection().state === 'online')
    assert.equal(runtime.listSessions().length, 1); assert.ok(runtime.getConnection().reconnects >= 1)
  })
  it('treats prolonged silence (a dead proxy path) as a drop and reconnects', async () => {
    const server = fakeServer(); const { runtime } = make(server); await runtime.start()
    await until(() => server.streams.length === 1)
    await until(() => server.streams.length >= 2) // no heartbeat arrives → watchdog aborts and reconnects
    assert.equal(server.streams[0].aborted, true)
  })
  it('heartbeats keep a quiet stream alive', async () => {
    const server = fakeServer(); const { runtime } = make(server); await runtime.start(); await until(() => server.streams.length === 1)
    const beat = setInterval(() => server.streams[0].push(': keep-alive\n\n'), 25)
    await new Promise(r => setTimeout(r, 300)); clearInterval(beat)
    assert.equal(server.streams.length, 1)
  })
  it('malformed frames are ignored and the stream stays up', async () => {
    const server = fakeServer(); const { runtime } = make(server); await runtime.start(); await until(() => server.streams.length === 1)
    server.streams[0].push('data: {not json\n\n'); server.streams[0].push('garbage\n\n')
    await new Promise(r => setTimeout(r, 30)); assert.equal(runtime.getConnection().state, 'online')
  })
  it('a 401 on the stream ends in auth_error without a reconnect storm', async () => {
    const server = fakeServer(); server.streamStatus = 401; const { runtime } = make(server); await runtime.start()
    await until(() => runtime.getConnection().state === 'auth_error')
    const n = server.calls.length; await new Promise(r => setTimeout(r, 80)); assert.equal(server.calls.length, n)
  })
  it('keeps retrying through a server outage (stream refused with 500/503) and recovers', async () => {
    const server = fakeServer(); const { runtime } = make(server); await runtime.start(); await until(() => server.streams.length === 1)
    server.mode = 'down'; server.streams[0].end()
    await until(() => runtime.getConnection().state === 'reconnecting'); await new Promise(r => setTimeout(r, 60))
    server.mode = 'up'; await until(() => runtime.getConnection().state === 'online')
  })
})

describe('diagnostics and lifecycle', () => {
  it('diagnoseConnection reports each stage and contains no credentials', async () => {
    const server = fakeServer(); const { runtime } = make(server, { getToken: async () => 'SECRET-TOKEN-VALUE' }); await runtime.start()
    const d = await runtime.diagnoseConnection()
    for (const k of ['apiUrl', 'health', 'readiness', 'authentication', 'bootstrap', 'stream', 'clientVersion', 'protocolVersion']) assert.ok(k in d, k)
    assert.equal(d.health.ok, true); assert.equal(d.readiness.ok, true); assert.equal(d.authentication.ok, true); assert.equal(d.bootstrap.ok, true); assert.equal(d.bootstrap.sessions, 1)
    assert.doesNotMatch(JSON.stringify(d), /SECRET-TOKEN/)
  })
  it('diagnoseConnection pinpoints the failing stage and skips what cannot work', async () => {
    const server = fakeServer(); server.mode = 'down'; const { runtime } = make(server)
    const d = await runtime.diagnoseConnection()
    assert.equal(d.health.ok, false); assert.equal(d.health.kind, 'server_unreachable'); assert.equal(d.readiness.skipped, true); assert.equal(d.bootstrap.skipped, true)
  })
  it('close() stops the stream, pending probes and retry timers', async () => {
    const server = fakeServer(); const { runtime } = make(server); await runtime.start(); await until(() => server.streams.length === 1)
    runtime.close(); await until(() => server.streams[0].aborted)
    const n = server.calls.length; await new Promise(r => setTimeout(r, 80)); assert.equal(server.calls.length, n, 'no activity after close')
    const down = fakeServer(); down.mode = 'down'; const b = make(down, { reconnect: { baseMs: 10, maxMs: 10 } }); b.runtime.start()
    await until(() => down.calls.length >= 2); b.runtime.close(); const m = down.calls.length; await new Promise(r => setTimeout(r, 80)); assert.equal(down.calls.length, m, 'retry timer cancelled')
  })
  it('repeated start/close cycles leave no stream open', async () => {
    const server = fakeServer()
    for (let i = 0; i < 5; i++) { const { runtime } = make(server); await runtime.start(); await until(() => server.streams.length === i + 1); runtime.close() }
    await until(() => server.streams.every(s => s.aborted))
  })
})
