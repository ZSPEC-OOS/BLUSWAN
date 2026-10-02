// Phase 10 server stabilization: health/readiness, environment validation, request ids, headers, CORS, body limits,
// static serving, graceful shutdown, abuse guards and storage fault tolerance. Offline; no provider is contacted.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, ConfigError } from './main.js'
import { parseServerConfig, validateCorsOrigin } from './config.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createFilePersistence, createFileDocStore } from '../persistence/adapters/filePersistence.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createFakeProvider, reply, say } from '../agent/testing/fakeProvider.js'
import { APP_VERSION, PROTOCOL_VERSION } from '../protocol/version.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'blu-stab-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }

async function boot({ env = {}, injected = {} } = {}) {
  const s = await startServer({ env: { BLUSWAN_PORT: '0', BLUSWAN_PERSISTENCE: 'memory', ...env }, injected, heartbeatMs: 40 })
  cleanups.push(() => s.close())
  s.base = `http://127.0.0.1:${s.port}`
  return s
}

describe('health and readiness', () => {
  it('/api/health is unauthenticated, fast, versioned and reveals nothing sensitive', async () => {
    const s = await boot({ env: { BLUSWAN_WORKSPACE_ROOTS: '/secret/place', DEEPSEEK_API_KEY: 'sk-health-secret-0123456789' } })
    const res = await fetch(`${s.base}/api/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { ok: true, service: 'bluswan', version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, auth: 'none' })
    assert.doesNotMatch(JSON.stringify(body), /secret|sk-/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  })
  it('/api/ready is ready without any provider key (the rest of the app is usable)', async () => {
    const s = await boot()
    const res = await fetch(`${s.base}/api/ready`)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ready, true)
    assert.deepEqual(body.providers, { configured: 0 })
  })
  it('/api/ready answers 503 persistence_unavailable when storage cannot be used, without leaking paths', async () => {
    const persistence = createMemoryPersistence()
    persistence.probe = async () => { throw new Error('EACCES /var/lib/private/dir') }
    const s = await boot({ injected: { persistence } })
    const res = await fetch(`${s.base}/api/ready`)
    const body = await res.json()
    assert.equal(res.status, 503)
    assert.equal(body.error.code, 'persistence_unavailable')
    assert.equal(body.checks.persistence, 'unavailable')
    assert.doesNotMatch(JSON.stringify(body), /private|EACCES/)
    assert.equal((await fetch(`${s.base}/api/health`)).status, 200) // liveness is independent of readiness
  })
  it('/api/ready answers 503 workspace_host_unavailable when no configured root is accessible', async () => {
    const s = await boot({ env: { BLUSWAN_WORKSPACE_ROOTS: path.join(tmp(), 'missing') } })
    const res = await fetch(`${s.base}/api/ready`)
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error.code, 'workspace_host_unavailable')
  })
  it('the file persistence probe fails when the data directory is not writable as a directory', async () => {
    const d = tmp(); const blocked = path.join(d, 'file'); fs.writeFileSync(blocked, 'x')
    const p = createFilePersistence({ dir: path.join(blocked, 'data') })
    await assert.rejects(() => p.probe(), (e) => e.code === 'persistence_unavailable')
    await assert.doesNotReject(() => createFilePersistence({ dir: path.join(d, 'ok') }).probe())
  })
})

describe('server environment validation', () => {
  const bad = (env) => parseServerConfig(env).errors.join('\n')
  it('accepts the documented local default', () => assert.equal(parseServerConfig({}).ok, true))
  it('reports every problem at once', () => {
    const e = bad({ BLUSWAN_PORT: 'abc', BLUSWAN_AUTH: 'magic', BLUSWAN_PERSISTENCE: 'sqlite', BLUSWAN_CORS_ORIGIN: '*', NODE_ENV: 'production' })
    for (const re of [/BLUSWAN_PORT/, /BLUSWAN_AUTH must/, /BLUSWAN_PERSISTENCE must/, /BLUSWAN_CORS_ORIGIN/, /WORKSPACE_ROOTS/]) assert.match(e, re)
  })
  it('requires FIREBASE_PROJECT_ID for firebase auth and firebase persistence', () => {
    assert.match(bad({ BLUSWAN_AUTH: 'firebase', BLUSWAN_HOST: '0.0.0.0', BLUSWAN_WORKSPACE_ROOTS: '/srv' }), /FIREBASE_PROJECT_ID/)
    assert.match(bad({ BLUSWAN_PERSISTENCE: 'firebase' }), /FIREBASE_PROJECT_ID/)
  })
  it('keeps the no-auth safety checks: non-loopback and production both refuse', () => {
    assert.match(bad({ BLUSWAN_HOST: '0.0.0.0' }), /loopback/)
    assert.match(bad({ NODE_ENV: 'production', BLUSWAN_WORKSPACE_ROOTS: '/srv' }), /without authentication/)
    assert.equal(parseServerConfig({ NODE_ENV: 'production', BLUSWAN_ALLOW_NO_AUTH: '1', BLUSWAN_WORKSPACE_ROOTS: '/srv' }).ok, true)
  })
  it('requires absolute workspace roots in production', () => {
    assert.match(bad({ BLUSWAN_AUTH: 'firebase', FIREBASE_PROJECT_ID: 'p', BLUSWAN_WORKSPACE_ROOTS: 'relative/path' }), /absolute/)
    assert.equal(parseServerConfig({ BLUSWAN_AUTH: 'firebase', FIREBASE_PROJECT_ID: 'p', BLUSWAN_HOST: '0.0.0.0', BLUSWAN_WORKSPACE_ROOTS: '/srv/a:/srv/b', NODE_ENV: 'production' }).ok, true)
  })
  it('validates the CORS origin: one explicit origin, never a wildcard or a path', () => {
    assert.equal(validateCorsOrigin('https://app.example.com'), null)
    assert.equal(validateCorsOrigin('http://localhost:5173'), null)
    for (const v of ['*', 'app.example.com', 'https://app.example.com/path', 'ftp://x.example']) assert.ok(validateCorsOrigin(v), v)
  })
  it('never echoes secret values in messages or settings', () => {
    const r = parseServerConfig({ OPENAI_API_KEY: 'sk-leak-0123456789abcdef', BLUSWAN_PORT: 'x' })
    assert.doesNotMatch(JSON.stringify(r), /sk-leak/)
    assert.deepEqual(r.settings.providers, ['openai'])
  })
  it('startServer refuses an invalid environment with a ConfigError listing the problems', async () => {
    await assert.rejects(() => startServer({ env: { BLUSWAN_PORT: 'x', BLUSWAN_AUTH: 'nope' } }), (e) => e instanceof ConfigError && e.problems.length >= 2)
  })
  it('reports a busy port as a configuration problem', async () => {
    const a = await boot()
    await assert.rejects(() => startServer({ env: { BLUSWAN_PORT: String(a.port), BLUSWAN_PERSISTENCE: 'memory' } }), /already in use/)
  })
})

describe('request ids, headers and error shape', () => {
  it('every response carries X-Request-ID; errors include it; no stack traces', async () => {
    const s = await boot()
    const res = await fetch(`${s.base}/api/nope`)
    const body = await res.json()
    assert.equal(res.status, 404)
    assert.equal(body.error.requestId, res.headers.get('x-request-id'))
    assert.ok(!JSON.stringify(body).includes('    at '))
    const echoed = await fetch(`${s.base}/api/health`, { headers: { 'X-Request-ID': 'client-req-12345' } })
    assert.equal(echoed.headers.get('x-request-id'), 'client-req-12345')
    const unsafe = await fetch(`${s.base}/api/health`, { headers: { 'X-Request-ID': 'bad id with spaces' } })
    assert.notEqual(unsafe.headers.get('x-request-id'), 'bad id with spaces')
  })
  it('the SSE stream keeps its streaming headers and announces the protocol version', async () => {
    const s = await boot()
    const ac = new AbortController()
    const res = await fetch(`${s.base}/api/stream`, { signal: ac.signal })
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    assert.match(res.headers.get('cache-control'), /no-store/)
    assert.equal(res.headers.get('x-accel-buffering'), 'no')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    const reader = res.body.getReader(); let text = ''
    while (!text.includes('keep-alive')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) }
    assert.match(text, /"kind":"hello"/); assert.match(text, new RegExp(`"protocolVersion":${PROTOCOL_VERSION}`)); assert.match(text, /: keep-alive/) // heartbeat
    ac.abort()
  })
})

describe('CORS', () => {
  const ORIGIN = 'https://app.example.com'
  it('grants exactly the configured origin, including preflight, Authorization and the request id', async () => {
    const s = await boot({ env: { BLUSWAN_CORS_ORIGIN: ORIGIN } })
    const pre = await fetch(`${s.base}/api/bootstrap`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN)
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/)
    const res = await fetch(`${s.base}/api/health`, { headers: { Origin: ORIGIN } })
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN)
    assert.match(res.headers.get('access-control-expose-headers'), /X-Request-ID/)
    const ac = new AbortController()
    const sse = await fetch(`${s.base}/api/stream`, { headers: { Origin: ORIGIN }, signal: ac.signal })
    assert.equal(sse.headers.get('access-control-allow-origin'), ORIGIN); ac.abort()
  })
  it('does not grant any other origin, or any origin when none is configured', async () => {
    const s = await boot({ env: { BLUSWAN_CORS_ORIGIN: ORIGIN } })
    for (const o of ['https://evil.example', 'http://app.example.com', `${ORIGIN}.evil.example`]) {
      const res = await fetch(`${s.base}/api/health`, { headers: { Origin: o } })
      assert.equal(res.headers.get('access-control-allow-origin'), null, o)
      const pre = await fetch(`${s.base}/api/health`, { method: 'OPTIONS', headers: { Origin: o } })
      assert.equal(pre.headers.get('access-control-allow-origin'), null, o)
    }
    const plain = await boot()
    assert.equal((await fetch(`${plain.base}/api/health`, { headers: { Origin: ORIGIN } })).headers.get('access-control-allow-origin'), null)
  })
})

describe('abuse guards and body limits', () => {
  const sess = (s, body) => fetch(`${s.base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  it('rejects an oversized body with 413 payload_too_large and a malformed one with 400', async () => {
    const s = await boot()
    const big = await fetch(`${s.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'x'.repeat(1_100_000) }) })
    assert.equal(big.status, 413)
    assert.equal((await big.json()).error.code, 'payload_too_large')
    const bad = await fetch(`${s.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' })
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error.code, 'invalid_request')
    assert.equal((await fetch(`${s.base}/api/health`)).status, 200) // the server survived
  })
  it('caps live sessions per user and concurrent runs, answering 429 too_many_requests', async () => {
    const gate = { release: null }
    const hold = new Promise(r => { gate.release = r })
    const providerFactory = () => createFakeProvider({ id: 'deepseek', respond: async () => { await hold; return reply(say('ok')) } })
    const credentials = createCredentialStore({ deepseek: { apiKey: 'k', baseUrl: 'x', model: 'm' } })
    const persistence = createMemoryPersistence()
    const { createBluswanService } = await import('./service.js')
    const { createNoAuth } = await import('./auth.js')
    const { createHttpHandler } = await import('./http.js')
    const http = await import('node:http')
    const service = createBluswanService({ persistence, credentials, allowedRoots: [os.tmpdir()], providerFactory, limits: { maxLiveSessions: 2, maxConcurrentRuns: 1 } })
    const server = http.createServer(createHttpHandler({ service, auth: createNoAuth() }))
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise(r => { gate.release(); server.closeAllConnections(); server.close(r) }))
    const s = { base: `http://127.0.0.1:${server.address().port}` }
    const a = await (await sess(s, {})).json(); await sess(s, {})
    const third = await sess(s, {})
    assert.equal(third.status, 429); assert.equal((await third.json()).error.code, 'too_many_requests')
    const send = () => fetch(`${s.base}/api/sessions/${a.session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'go' }) })
    assert.equal((await send()).status, 202)
    await until(async () => (await service.stats()).running === 1)
  })
})

describe('static application serving (same-origin deployment)', () => {
  it('serves the built app with SPA fallback, never escapes the directory, and keeps /api working', async () => {
    const dist = tmp(); fs.mkdirSync(path.join(dist, 'assets')); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>')
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc123xyz.js'), 'console.log(1)'); fs.writeFileSync(path.join(path.dirname(dist), 'outside.txt'), 'secret')
    cleanups.push(() => fs.rmSync(path.join(path.dirname(dist), 'outside.txt'), { force: true }))
    const s = await boot({ env: { BLUSWAN_STATIC_DIR: dist } })
    const home = await fetch(`${s.base}/`); assert.equal(home.status, 200); assert.match(await home.text(), /<title>app<\/title>/)
    assert.equal(home.headers.get('cache-control'), 'no-cache')
    const deep = await fetch(`${s.base}/some/client/route`); assert.match(await deep.text(), /<title>app<\/title>/)
    const js = await fetch(`${s.base}/assets/index-abc123xyz.js`); assert.match(js.headers.get('content-type'), /javascript/); assert.match(js.headers.get('cache-control'), /immutable/)
    assert.equal((await fetch(`${s.base}/missing.js`)).status, 404)
    const trav = await fetch(`${s.base}/..%2Foutside.txt`); assert.notEqual(await trav.text(), 'secret')
    assert.equal((await fetch(`${s.base}/api/health`)).status, 200)
  })
})

describe('graceful shutdown', () => {
  it('flips readiness, ends event streams, cancels the run, flushes persistence and stops accepting connections', async () => {
    const dir = tmp()
    const persistence = createFilePersistence({ dir: path.join(dir, 'data') })
    const credentials = createCredentialStore({ deepseek: { apiKey: 'k', baseUrl: 'x', model: 'm' } })
    const providerFactory = () => createFakeProvider({ id: 'deepseek', respond: () => new Promise(() => {}) }) // never answers
    const s = await startServer({ env: { BLUSWAN_PORT: '0', BLUSWAN_WORKSPACE_ROOTS: os.tmpdir() }, injected: { persistence, credentials, providerFactory }, heartbeatMs: 30, shutdownDeadlineMs: 3000 })
    const base = `http://127.0.0.1:${s.port}`
    const { session } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
    await fetch(`${base}/api/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'work please' }) })
    const ac = new AbortController(); const stream = await fetch(`${base}/api/stream`, { signal: ac.signal })
    const reader = stream.body.getReader(); let ended = false
    const drain = (async () => { for (;;) { const { done } = await reader.read().catch(() => ({ done: true })); if (done) { ended = true; return } } })()
    await until(async () => (await s.service.stats()).running === 1)
    await s.close('test')
    await drain
    assert.equal(ended, true)
    await assert.rejects(() => fetch(`${base}/api/health`)) // no longer accepting
    const stored = await persistence.listSessions('local')
    assert.equal(stored.items.length, 1) // flushed before exit
    assert.notEqual(stored.items[0].status, 'running')
  })
})

describe('file persistence fault tolerance', () => {
  it('quarantines a corrupt record, keeps listing the rest, and leaves temp files from an interrupted write harmless', async () => {
    const dir = tmp(); const store = createFileDocStore({ dir })
    await store.put('users/u/sessionIndex/good', { id: 'good' }, { sortKey: '2' })
    await store.put('users/u/sessionIndex/bad', { id: 'bad' }, { sortKey: '1' })
    fs.writeFileSync(path.join(dir, 'users/u/sessionIndex/bad.json'), '{"revision":1,"data":{"id":') // truncated mid-write
    fs.writeFileSync(path.join(dir, 'users/u/sessionIndex/good.json.123.abc.tmp'), '{"revision":9') // orphaned temp file
    const page = await store.list('users/u/sessionIndex', {})
    assert.deepEqual(page.items.map(i => i.id), ['good'])
    assert.equal(store.quarantined().length, 1)
    assert.ok(fs.readdirSync(path.join(dir, 'users/u/sessionIndex')).some(n => n.includes('.corrupt-')))
    await store.put('users/u/sessionIndex/bad', { id: 'bad2' }, {}) // the slot is usable again
    assert.equal((await store.get('users/u/sessionIndex/bad')).data.id, 'bad2')
  })
  it('get on a corrupt record reports persistence_invalid_record, not a crash, and the server still boots', async () => {
    const dir = tmp(); const store = createFilePersistence({ dir })
    fs.mkdirSync(path.join(dir, 'users/local/settings'), { recursive: true }); fs.writeFileSync(path.join(dir, 'users/local/settings/main.json'), 'not json')
    await assert.rejects(() => store.loadSettings('local'), (e) => e.code === 'persistence_invalid_record')
    const s = await boot({ env: { BLUSWAN_PERSISTENCE: 'file', BLUSWAN_DATA_DIR: dir } })
    const res = await fetch(`${s.base}/api/bootstrap`)
    assert.equal(res.status, 200)
  })
  it('an interrupted write never leaves a partial document (rename is atomic)', async () => {
    const dir = tmp(); const store = createFileDocStore({ dir })
    await store.put('a/b', { v: 1 })
    // simulate a crash after the temp file was written but before the rename
    fs.writeFileSync(path.join(dir, 'a/b.json.999.zzz.tmp'), '{"revision":2,"data":{"v":')
    assert.deepEqual((await store.get('a/b')).data, { v: 1 })
  })
})
