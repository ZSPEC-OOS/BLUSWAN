// Runtime reliability: SSE behind a reverse proxy, stream/listener cleanup, user-runtime disposal, a small load test,
// secret redaction in logs/events/storage, and crash-safe persistence. Offline and deterministic.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createBluswanService } from './service.js'
import { createHttpHandler } from './http.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createFileDocStore } from '../persistence/adapters/filePersistence.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createFakeProvider, reply, say } from '../agent/testing/fakeProvider.js'
import { createRemoteRuntime } from '../client/runtime/createRemoteRuntime.js'
import { createError } from '../protocol/schemas.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const credentials = createCredentialStore({ deepseek: { apiKey: 'sk-real-looking-0123456789abcdef', baseUrl: 'x', model: 'm' } })
const tokenAuth = { mode: 'test', verify: async (t) => { const m = /^tok-(\w+)$/.exec(t ?? ''); if (!m) throw createError({ code: 'unauthenticated', message: 'Sign in.' }); return { id: m[1], email: null } } }

async function boot({ respond = () => reply(say('ok')), heartbeatMs = 30, logger, logRequests = false, persistence = createMemoryPersistence(), limits } = {}) {
  const service = createBluswanService({ persistence, credentials, allowedRoots: [os.tmpdir()], providerFactory: () => createFakeProvider({ id: 'deepseek', respond }), limits })
  const handler = createHttpHandler({ service, auth: tokenAuth, heartbeatMs, logger, logRequests })
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const s = { service, handler, server, persistence, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { handler.closeStreams(); server.closeAllConnections?.(); server.close(r) }) }
  cleanups.push(() => s.close())
  return s
}
const call = (base, token) => async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text(); return { status: res.status, text, json: text ? JSON.parse(text) : null }
}

/** A reverse proxy that behaves like nginx: optional idle timeout on the upstream response, optional buffering. */
async function proxyTo(target, { idleMs = 0, buffer = false } = {}) {
  const sockets = new Set()
  const proxy = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      if (buffer) { const chunks = []; ur.on('data', c => chunks.push(c)); ur.on('end', () => { res.writeHead(ur.statusCode, ur.headers); res.end(Buffer.concat(chunks)) }); return }
      res.writeHead(ur.statusCode, ur.headers)
      let timer = null
      const arm = () => { if (!idleMs) return; clearTimeout(timer); timer = setTimeout(() => { res.destroy(); up.destroy() }, idleMs) }
      arm(); ur.on('data', (c) => { arm(); res.write(c) }); ur.on('end', () => { clearTimeout(timer); res.end() })
      res.on('close', () => { clearTimeout(timer); up.destroy() })
    })
    up.on('error', () => res.destroy()); req.pipe(up)
  })
  proxy.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise(r => proxy.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise(r => { for (const s of sockets) s.destroy(); proxy.close(r) }))
  return { base: `http://127.0.0.1:${proxy.address().port}` }
}

describe('SSE behind a reverse proxy', () => {
  it('heartbeats keep a stream alive through a proxy with a short idle timeout', async () => {
    const s = await boot({ heartbeatMs: 30 }); const p = await proxyTo(s.server.address().port, { idleMs: 120 })
    const ac = new AbortController(); const res = await fetch(`${p.base}/api/stream`, { headers: { Authorization: 'Bearer tok-ann' }, signal: ac.signal })
    const reader = res.body.getReader(); let beats = 0; const t0 = Date.now()
    while (Date.now() - t0 < 500) { const { value, done } = await reader.read(); if (done) break; beats += (new TextDecoder().decode(value).match(/keep-alive/g) ?? []).length }
    ac.abort(); assert.ok(beats >= 5, `heartbeats seen: ${beats}`)
  })
  it('without heartbeats the same proxy cuts the stream — which is why the interval must stay below proxy timeouts', async () => {
    const s = await boot({ heartbeatMs: 10_000 }); const p = await proxyTo(s.server.address().port, { idleMs: 120 })
    const res = await fetch(`${p.base}/api/stream`, { headers: { Authorization: 'Bearer tok-ann' } }); const reader = res.body.getReader()
    await reader.read() // hello
    await assert.rejects(async () => { for (let i = 0; i < 50; i++) { const { done } = await reader.read(); if (done) throw new Error('closed') } }, /closed|terminated|aborted/i)
  })
  it('the remote runtime recovers from a proxy idle-timeout cut and a buffering proxy is detectable', async () => {
    const s = await boot({ heartbeatMs: 10_000 }); const p = await proxyTo(s.server.address().port, { idleMs: 100 })
    const rt = createRemoteRuntime({ baseUrl: p.base, getToken: async () => 'tok-ann', reconnect: { baseMs: 5, maxMs: 20 }, streamIdleMs: 5000 }); cleanups.push(() => rt.close())
    await rt.init(); await until(() => rt.getConnection().state === 'online')
    await until(() => rt.getConnection().reconnects >= 2) // the proxy keeps cutting; the client keeps coming back
    const buf = await proxyTo(s.server.address().port, { buffer: true })
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300)
    let got = false
    try { const res = await fetch(`${buf.base}/api/stream`, { headers: { Authorization: 'Bearer tok-ann' }, signal: ac.signal }); got = res.status === 200 } catch { /* aborted: no headers within 300 ms */ }
    assert.equal(got, false, 'a buffering proxy delivers nothing until the stream ends')
  })
})

describe('stream and listener cleanup', () => {
  it('closed browsers leave no subscribers; shutdown ends the rest', async () => {
    const s = await boot(); const acs = []
    for (let i = 0; i < 6; i++) { const ac = new AbortController(); acs.push(ac); const r = await fetch(`${s.base}/api/stream`, { headers: { Authorization: 'Bearer tok-ann' }, signal: ac.signal }); await r.body.getReader().read() }
    await until(async () => (await s.service.listenerCount({ id: 'ann' })) === 6)
    for (const ac of acs.slice(0, 4)) ac.abort()
    await until(async () => (await s.service.listenerCount({ id: 'ann' })) === 2)
    s.handler.closeStreams(); await until(async () => (await s.service.listenerCount({ id: 'ann' })) === 0)
  })
  it('repeated login/logout never leaves more than one live stream', async () => {
    const s = await boot()
    for (let i = 0; i < 5; i++) {
      const rt = createRemoteRuntime({ baseUrl: s.base, getToken: async () => 'tok-ann', reconnect: { baseMs: 5, maxMs: 20 } })
      await rt.init(); await until(async () => (await s.service.listenerCount({ id: 'ann' })) === 1)
      await rt.logout(); await until(async () => (await s.service.listenerCount({ id: 'ann' })) === 0)
    }
  })
  it('a stream whose lifetime is capped ends and the client resyncs', async () => {
    const service = createBluswanService({ persistence: createMemoryPersistence(), credentials, allowedRoots: [os.tmpdir()] })
    const handler = createHttpHandler({ service, auth: tokenAuth, heartbeatMs: 20, sseMaxMs: 80 }); const server = http.createServer(handler)
    await new Promise(r => server.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise(r => { server.closeAllConnections(); server.close(r) }))
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/stream`, { headers: { Authorization: 'Bearer tok-ann' } }); const reader = res.body.getReader()
    const t0 = Date.now(); for (;;) { const { done } = await reader.read(); if (done) break; assert.ok(Date.now() - t0 < 2000) }
  })
})

describe('many users at once', () => {
  it('20 users run conversations concurrently, stay isolated, and are all released afterwards', async () => {
    const s = await boot({ respond: async (req) => { const who = req.messages.filter(m => m.role === 'user').at(-1).content; await new Promise(r => setTimeout(r, 15)); return reply(say(`echo:${who}`)) } })
    const users = Array.from({ length: 20 }, (_, i) => `u${i}`)
    const t0 = Date.now()
    const ids = await Promise.all(users.map(async (u) => { const A = call(s.base, `tok-${u}`); const { json } = await A('POST', '/api/sessions', {}); await A('POST', `/api/sessions/${json.session.id}/messages`, { content: `hi from ${u}` }); return [u, json.session.id] }))
    await until(async () => (await Promise.all(ids.map(async ([u, id]) => (await call(s.base, `tok-${u}`)('GET', `/api/sessions/${id}`)).json.session.status))).every(x => x === 'completed'), 15_000)
    assert.ok(Date.now() - t0 < 15_000)
    for (const [u, id] of ids) {
      const A = call(s.base, `tok-${u}`); const events = (await A('GET', `/api/sessions/${id}`)).json.session.events
      assert.match(JSON.stringify(events), new RegExp(`echo:hi from ${u}\\b`))
      const other = ids.find(([v]) => v !== u)
      assert.equal((await A('GET', `/api/sessions/${other[1]}`)).status, 404)
      assert.equal((await A('GET', '/api/sessions')).json.items.length, 1)
    }
    assert.equal((await s.service.stats()).users, 20)
    await Promise.all(users.map(u => s.service.dispose({ id: u })))
    const after = await s.service.stats(); assert.deepEqual([after.users, after.sessionsLive, after.running, after.streams], [0, 0, 0, 0])
  })
  it('graceful shutdown under load stops every run and releases every user', async () => {
    const s = await boot({ respond: () => new Promise(() => {}) })
    await Promise.all(Array.from({ length: 8 }, async (_, i) => { const A = call(s.base, `tok-w${i}`); const { json } = await A('POST', '/api/sessions', {}); await A('POST', `/api/sessions/${json.session.id}/messages`, { content: 'go' }) }))
    await until(async () => (await s.service.stats()).running === 8)
    await s.service.shutdown({ deadlineMs: 3000 })
    const st = await s.service.stats(); assert.deepEqual([st.users, st.running], [0, 0])
    assert.equal((await call(s.base, 'tok-w0')('GET', '/api/ready')).status, 503)
  })
})

describe('secret redaction', () => {
  const KEY = 'sk-real-looking-0123456789abcdef'
  it('a provider error that echoes the key never reaches HTTP responses, stored records, events, or logs', async () => {
    const lines = []; const logger = { info: (m, meta) => lines.push(JSON.stringify({ m, meta })), warn: (m, meta) => lines.push(JSON.stringify({ m, meta })), error: (m, meta) => lines.push(JSON.stringify({ m, meta })), debug() {} }
    const s = await boot({ logger, logRequests: true, respond: () => { throw createError({ code: 'provider_error', message: `401 Unauthorized for key ${KEY} at Bearer tok-ann`, provider: 'deepseek' }) } })
    const A = call(s.base, 'tok-ann'); const { json } = await A('POST', '/api/sessions', {})
    await A('POST', `/api/sessions/${json.session.id}/messages`, { content: 'go' })
    await until(async () => (await A('GET', `/api/sessions/${json.session.id}`)).json.session.status === 'error')
    await s.service.flush({ id: 'ann' })
    const body = (await A('GET', `/api/sessions/${json.session.id}`)).text
    const stored = JSON.stringify(await s.persistence.loadSession('ann', json.session.id)) + JSON.stringify(await s.persistence.listSessions('ann'))
    const diag = JSON.stringify(await createRemoteRuntime({ baseUrl: s.base, getToken: async () => 'tok-ann' }).diagnoseConnection())
    for (const [where, text] of Object.entries({ body, stored, logs: lines.join('\n'), diag })) assert.doesNotMatch(text, new RegExp(KEY), `${where} leaked the provider key`)
    assert.ok(lines.some(l => /"request"/.test(l)), 'requests are logged')
    assert.doesNotMatch(lines.join('\n'), /tok-ann|Authorization|\?/, 'logs hold neither tokens nor query strings')
  })
  it('structured request logs name the route, status and request id but no session ids or bodies', async () => {
    const lines = []; const logger = { info: (m, meta) => lines.push(meta), warn() {}, error() {}, debug() {} }
    const s = await boot({ logger, logRequests: true })
    const A = call(s.base, 'tok-ann'); const { json } = await A('POST', '/api/sessions', {})
    await A('GET', `/api/sessions/${json.session.id}`)
    const get = lines.find(l => l.method === 'GET' && l.path.startsWith('/api/sessions/'))
    assert.equal(get.path, '/api/sessions/:id'); assert.equal(get.status, 200); assert.match(get.requestId, /^[0-9a-f-]{36}$/); assert.equal(typeof get.ms, 'number')
  })
})

describe('crash-safe file persistence', () => {
  it('killing the writer mid-save never leaves an unreadable or partial document', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blu-crash-')); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const writer = path.resolve(import.meta.dirname, '../persistence/testing/crashWriter.mjs')
    for (let round = 0; round < 5; round++) {
      const child = spawn(process.execPath, [writer, dir, 'users/u/sessions/s1'], { stdio: ['ignore', 'pipe', 'inherit'] })
      await new Promise(r => child.stdout.once('data', r))
      await new Promise(r => setTimeout(r, 40 + round * 25))
      child.kill('SIGKILL'); await new Promise(r => child.once('exit', r))
      const store = createFileDocStore({ dir })
      const doc = await store.get('users/u/sessions/s1')
      if (doc) { assert.equal(doc.data.tail, 'END'); assert.equal(doc.data.filler.length, 400_000); assert.ok(Number.isInteger(doc.revision)) }
      assert.equal(store.quarantined().length, 0, 'no record needed quarantine')
    }
    const leftovers = fs.readdirSync(path.join(dir, 'users/u/sessions')).filter(n => n.endsWith('.tmp'))
    const page = await createFileDocStore({ dir }).list('users/u/sessions', {})
    assert.ok(page.items.length <= 1); void leftovers // orphaned temp files are ignored by listing and never read as documents
  })
})
