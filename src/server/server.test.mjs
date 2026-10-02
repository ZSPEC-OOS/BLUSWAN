// The HTTP/SSE server end to end over real sockets: authentication, ownership, credentials, streaming,
// Stop, permissions, persistence across a restart. The model is scripted; no network beyond localhost.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBluswanService } from './service.js'
import { createHttpHandler } from './http.js'
import { createFirebaseVerifier, createNoAuth } from './auth.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createEnvCredentialStore } from '../providers/credentials/serverCredentialStore.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createFilePersistence } from '../persistence/adapters/filePersistence.js'
import { createFakeProvider, say, call, reply } from '../agent/testing/fakeProvider.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const SECRET = 'sk-server-only-0123456789abcdef'
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const scripted = (...turns) => { let n = 0; return (req) => (req.messages.filter(m => m.role === 'user').at(-1)?.content.startsWith('FOLLOW') ? reply(say('Continuing.')) : turns[n++]?.(req) ?? reply(say('done'))) }

const TOKENS = { 'tok-alice': { id: 'alice', email: 'a@example.com' }, 'tok-bob': { id: 'bob', email: 'b@example.com' } }
const tokenAuth = { mode: 'test', verify: async (t) => { if (!TOKENS[t]) { const { createError } = await import('../protocol/schemas.js'); throw createError({ code: 'unauthenticated', message: 'Sign in to continue.' }) } return TOKENS[t] } }

async function boot({ persistence = createMemoryPersistence(), respond, mode = 'full_auto', credentials, roots = [os.tmpdir()], auth = tokenAuth, seenKeys = [] } = {}) {
  const creds = credentials ?? createCredentialStore({ deepseek: { apiKey: SECRET, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } })
  const service = createBluswanService({
    persistence, credentials: creds, hostId: 'host-1', allowedRoots: roots,
    config: { ...loadRuntimeConfig({}), permissionMode: mode },
    providerFactory: (user, c) => {
      const p = createFakeProvider({ id: 'deepseek', respond: (req) => { seenKeys.push(c.getCredential('deepseek', user).apiKey); return respond(req) } })
      return { ...p, validate: () => c.getCredential('deepseek', user) } // missing credential → normalized configuration_error
    },
    autosave: { debounceMs: 10, retry: { attempts: 2, baseMs: 1 }, sleep: async () => {} },
  })
  const server = http.createServer(createHttpHandler({ service, auth, heartbeatMs: 50 }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const handle = { service, base, persistence, seenKeys, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }) }
  cleanups.push(() => handle.close())
  return handle
}

const api = (base, token) => async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : null }
}

/** Reads the SSE stream into an array of parsed messages. */
async function openStream(base, token) {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
  const messages = []
  const raw = []
  ;(async () => {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true }); raw.push(buf)
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(chunk); if (d) messages.push(JSON.parse(d[1])) }
      }
    } catch { /* aborted */ }
  })()
  cleanups.push(async () => ac.abort())
  await until(() => messages.some(m => m.kind === 'hello'))
  return { messages, status: res.status, close: () => ac.abort(), types: () => messages.filter(m => m.kind === 'event').map(m => m.event.type) }
}

async function repo() { const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup()); return fx }

describe('authentication', () => {
  it('health is open; everything else needs a valid token', async () => {
    const s = await boot({ respond: scripted() })
    assert.equal((await api(s.base)('GET', '/api/health')).status, 200)
    for (const [m, u] of [['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', '/api/bootstrap'], ['GET', '/api/stream'], ['GET', '/api/sessions/x']]) {
      const r = await api(s.base)(m, u, m === 'POST' ? {} : undefined)
      assert.equal(r.status, 401, `${m} ${u}`); assert.equal(r.json.error.code, 'unauthenticated')
    }
    assert.equal((await api(s.base, 'wrong')('GET', '/api/sessions')).status, 401)
    assert.equal((await api(s.base, 'tok-alice')('GET', '/api/me')).json.user.id, 'alice')
  })

  it('verifies Firebase ID tokens (signature, audience, issuer, expiry) without any SDK', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = publicKey.export({ type: 'spki', format: 'pem' })
    const mk = (claims, kid = 'k1', key = privateKey) => {
      const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const head = b({ alg: 'RS256', kid }); const body = b(claims)
      return `${head}.${body}.${crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')}`
    }
    const now = Math.floor(Date.now() / 1000)
    const good = { aud: 'proj', iss: 'https://securetoken.google.com/proj', sub: 'uid-1', email: 'u@example.com', iat: now - 10, exp: now + 3600 }
    const v = createFirebaseVerifier({ projectId: 'proj', fetchCerts: async () => ({ k1: pem }) })
    assert.deepEqual(await v.verify(mk(good)), { id: 'uid-1', email: 'u@example.com' })
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    for (const bad of [mk({ ...good, aud: 'other' }), mk({ ...good, iss: 'https://evil' }), mk({ ...good, exp: now - 5 }), mk({ ...good, sub: '' }), mk(good, 'k1', other), mk(good, 'unknown-kid'), 'garbage', null]) {
      await assert.rejects(() => v.verify(bad), (e) => e.code === 'unauthenticated')
    }
    assert.equal((await createNoAuth().verify(null)).id, 'local')
  })
})

describe('ownership', () => {
  it("user B cannot load, change, delete, cancel, stream or see user A's sessions or repositories", async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(() => reply(say('hello'))) })
    const A = api(s.base, 'tok-alice'); const B = api(s.base, 'tok-bob')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const sess = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session
    await A('POST', `/api/sessions/${sess.id}/messages`, { content: 'hi' })
    await until(async () => (await A('GET', `/api/sessions/${sess.id}`)).json.session.status === 'completed')
    await s.service.flush({ id: 'alice' })

    for (const [m, u, body] of [['GET', `/api/sessions/${sess.id}`], ['POST', `/api/sessions/${sess.id}/messages`, { content: 'x' }], ['POST', `/api/sessions/${sess.id}/cancel`, {}], ['DELETE', `/api/sessions/${sess.id}`],
      ['GET', `/api/sessions/${sess.id}/workspace-state`], ['GET', `/api/sessions/${sess.id}/diff?path=a`], ['POST', `/api/sessions/${sess.id}/revert`, { path: 'a' }], ['GET', `/api/sessions/${sess.id}/commands`]]) {
      const r = await B(m, u, body)
      assert.equal(r.status, 404, `${m} ${u}`)
    }
    assert.deepEqual((await B('GET', '/api/sessions')).json.items, [])
    assert.deepEqual((await B('GET', '/api/workspaces')).json.workspaces, [])
    assert.equal((await B('POST', `/api/sessions`, { workspaceId: ws.id })).status, 404, "cannot start a session in Alice's repository")
    assert.equal((await B('POST', `/api/workspaces/${ws.id}/reconnect`, { root: fx.root })).status, 404)
    const bStream = await openStream(s.base, 'tok-bob')
    await A('POST', `/api/sessions/${sess.id}/messages`, { content: 'FOLLOW again' })
    await until(async () => (await A('GET', `/api/sessions/${sess.id}`)).json.session.events.filter(e => e.type === 'session.completed').length === 2)
    assert.equal(bStream.messages.filter(m => m.kind === 'event').length, 0, "B's stream never carries A's events")
    assert.equal((await A('GET', `/api/sessions/${sess.id}`)).status, 200, 'A is unaffected')
  })

  it('opening repositories is limited to the configured roots', async () => {
    const s = await boot({ respond: scripted(), roots: ['/nonexistent-root'] })
    const r = await api(s.base, 'tok-alice')('POST', '/api/workspaces', { root: os.tmpdir() })
    assert.equal(r.status, 403); assert.match(r.json.error.message, /outside the locations/)
  })
})

describe('credentials', () => {
  it('the provider key is used server-side and never appears in any response or stream', async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(() => reply(call('sh', 'shell', { command: 'echo ok' })), () => reply(say('done'))) })
    const A = api(s.base, 'tok-alice')
    const stream = await openStream(s.base, 'tok-alice')
    const everything = []
    const keep = async (p) => { const r = await p; everything.push(r.text); return r }
    const ws = (await keep(A('POST', '/api/workspaces', { root: fx.root }))).json
    const id = (await keep(A('POST', '/api/sessions', { workspaceId: ws.id }))).json.session.id
    await keep(A('POST', `/api/sessions/${id}/messages`, { content: 'run something' }))
    await until(async () => (await keep(A('GET', `/api/sessions/${id}`))).json.session.status === 'completed')
    for (const u of ['/api/bootstrap', '/api/providers', '/api/settings', '/api/sessions', `/api/sessions/${id}/workspace-state`]) await keep(A('GET', u))
    await s.service.flush({ id: 'alice' })
    assert.ok(s.seenKeys.length >= 1 && s.seenKeys.every(k => k === SECRET), 'the server-side provider call received the key')
    assert.doesNotMatch(everything.join('\n') + JSON.stringify(stream.messages), /sk-server-only/)
    const stored = JSON.stringify(await s.persistence.loadSession('alice', id)) + JSON.stringify(await s.persistence.listSessions('alice'))
    assert.doesNotMatch(stored, /sk-server-only/)
    assert.deepEqual((await A('GET', '/api/providers')).json.providers, [{ provider: 'deepseek', label: 'DeepSeek', configured: true, model: 'deepseek-chat' }])
  })

  it('a missing server credential is a normalized configuration error, not a crash', async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(), credentials: createCredentialStore({ deepseek: { apiKey: '', model: 'deepseek-chat' } }) })
    const A = api(s.base, 'tok-alice')
    const stream = await openStream(s.base, 'tok-alice')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    assert.equal((await A('GET', '/api/providers')).json.providers[0].configured, false)
    await A('POST', `/api/sessions/${id}/messages`, { content: 'hello' })
    await until(() => stream.types().includes('session.failed'))
    const failed = stream.messages.find(m => m.kind === 'event' && m.event.type === 'session.failed').event
    assert.equal(failed.data.error.code, 'configuration_error'); assert.match(failed.data.error.message, /not configured on the server/)
  })

  it('the server credential store refuses to load in a browser and reads only unprefixed variables', () => {
    const store = createEnvCredentialStore({ DEEPSEEK_API_KEY: 'k', VITE_DEEPSEEK_API_KEY: 'browser-visible' })
    assert.equal(store.getCredential('deepseek').apiKey, 'k')
    assert.equal(createEnvCredentialStore({ VITE_DEEPSEEK_API_KEY: 'browser-visible' }).hasCredential('deepseek'), false)
    globalThis.window = {}; globalThis.document = {}
    try { assert.throws(() => createEnvCredentialStore({}), /browser/) } finally { delete globalThis.window; delete globalThis.document }
  })
})

describe('streaming, Stop and permissions across the server boundary', () => {
  it('streams canonical events with unique ids; the client never executes tools', async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('Fixed.')), () => reply(say('Fixed; tests pass.'))) })
    const A = api(s.base, 'tok-alice'); const stream = await openStream(s.base, 'tok-alice')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    assert.equal((await A('POST', `/api/sessions/${id}/messages`, { content: 'Fix the failing add test' })).status, 202)
    await until(() => stream.types().includes('session.completed'))
    const types = stream.types()
    for (const t of ['user.message', 'tool.started', 'file.changed', 'tool.completed', 'validation.completed', 'assistant.text.completed']) assert.ok(types.includes(t), t)
    const ids = stream.messages.filter(m => m.kind === 'event').map(m => m.event.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /a \+ b/)
    const last = stream.messages.filter(m => m.kind === 'event').at(-1)
    assert.ok(last.session.id === id && !('events' in last.session), 'lite snapshots, not whole transcripts, per event')
  })

  it('Stop and busy handling work through the API', async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(() => reply(call('sh', 'shell', { command: 'sleep 30' }))) })
    const A = api(s.base, 'tok-alice'); const stream = await openStream(s.base, 'tok-alice')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A('POST', `/api/sessions/${id}/messages`, { content: 'wait' })
    await until(() => stream.types().includes('tool.started'))
    assert.equal((await A('POST', `/api/sessions/${id}/messages`, { content: 'again' })).status, 409)
    assert.equal((await A('DELETE', `/api/sessions/${id}`)).status, 409, 'cannot delete a running session')
    assert.equal((await A('POST', `/api/sessions/${id}/cancel`, {})).status, 200)
    await until(() => stream.types().includes('session.cancelled'))
    assert.equal((await A('GET', `/api/sessions/${id}`)).json.session.status, 'cancelled')
  })

  it('permission requests are resolved through the server', async () => {
    const fx = await repo()
    const s = await boot({ mode: 'ask', respond: scripted(() => reply(call('w', 'write_file', { path: 'new.txt', content: 'x' })), () => reply(say('created')), () => reply(call('d', 'write_file', { path: 'denied.txt', content: 'y' })), () => reply(say('skipped'))) })
    const A = api(s.base, 'tok-alice'); const stream = await openStream(s.base, 'tok-alice')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A('POST', `/api/sessions/${id}/messages`, { content: 'create new.txt' })
    await until(() => stream.types().includes('permission.requested'))
    const req = stream.messages.find(m => m.event?.type === 'permission.requested').event.data
    await assert.rejects(() => fs.access(path.join(fx.root, 'new.txt')))
    assert.equal((await A('POST', `/api/sessions/${id}/permissions/${req.id}`, { decision: 'maybe' })).status, 400)
    assert.equal((await A('POST', `/api/sessions/${id}/permissions/${req.id}`, { decision: 'approve' })).json.ok, true)
    await until(() => stream.types().includes('session.completed'))
    await fs.access(path.join(fx.root, 'new.txt'))
    await A('POST', `/api/sessions/${id}/messages`, { content: 'create denied.txt' })
    await until(() => stream.types().filter(t => t === 'permission.requested').length === 2)
    const req2 = stream.messages.filter(m => m.event?.type === 'permission.requested').at(-1).event.data
    await A('POST', `/api/sessions/${id}/permissions/${req2.id}`, { decision: 'deny' })
    await until(() => stream.types().filter(t => t === 'session.completed').length === 2)
    await assert.rejects(() => fs.access(path.join(fx.root, 'denied.txt')))
    assert.deepEqual(stream.messages.filter(m => m.event?.type === 'permission.resolved').map(m => m.event.data.decision), ['approved', 'denied'])
  })

  it('review endpoints: state, diff, command output and revert', async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH }), call('sh', 'shell', { command: 'echo out' })), () => reply(say('Fixed.')), () => reply(say('ok'))) })
    const A = api(s.base, 'tok-alice')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A('POST', `/api/sessions/${id}/messages`, { content: 'fix it' })
    await until(async () => (await A('GET', `/api/sessions/${id}`)).json.session.status === 'completed')
    const st = (await A('GET', `/api/sessions/${id}/workspace-state`)).json
    assert.deepEqual(st.files.map(f => f.path), ['src/math.js'])
    assert.match((await A('GET', `/api/sessions/${id}/diff?path=src/math.js`)).json.diff, /\+ {2}return a \+ b/)
    const cmds = (await A('GET', `/api/sessions/${id}/commands`)).json.commands
    const sh = cmds.find(c => c.command === 'echo out')
    assert.equal('stdout' in sh, false)
    assert.equal((await A('GET', `/api/sessions/${id}/commands/${sh.id}`)).json.stdout.trim(), 'out')
    assert.equal((await A('POST', `/api/sessions/${id}/revert`, { path: 'src/math.js' })).json.ok, true)
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /a - b/)
    assert.equal((await A('POST', `/api/sessions/${id}/revert`, { path: 'src/math.js' })).status, 409)
  })
})

describe('restart and recovery over HTTP', () => {
  it('a new server over the same storage lists sessions, restores the transcript and continues the conversation', async () => {
    const fx = await repo()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-srv-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const s1 = await boot({ persistence: createFilePersistence({ dir }), respond: scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('Fixed.')), () => reply(say('Fixed; tests pass.'))) })
    const A1 = api(s1.base, 'tok-alice')
    const ws = (await A1('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A1('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    assert.deepEqual((await A1('GET', '/api/sessions')).json.items, [], 'an empty draft is not listed or stored')
    await A1('POST', `/api/sessions/${id}/messages`, { content: 'Fix the failing add test' })
    await until(async () => (await A1('GET', `/api/sessions/${id}`)).json.session.status === 'completed')
    await s1.service.flush({ id: 'alice' })
    assert.equal((await s1.persistence.loadSession('alice', id)).status, 'completed')
    assert.equal((await s1.persistence.listSessions('alice')).items[0].status, 'completed')
    await s1.close()

    const s2 = await boot({ persistence: createFilePersistence({ dir }), respond: scripted() })
    const A2 = api(s2.base, 'tok-alice')
    const boot2 = (await A2('GET', '/api/bootstrap')).json
    assert.deepEqual(boot2.sessions.items.map(i => [i.id, i.title, i.status, i.changedCount]), [[id, 'Fix the failing add test', 'completed', 1]])
    assert.equal(boot2.workspaces.find(w => w.id === ws.id).available, true, 'the repository is re-attached from its stored reference')
    const opened = (await A2('GET', `/api/sessions/${id}`)).json
    assert.equal(opened.session.events.filter(e => e.type === 'assistant.text.completed').at(-1).data.text, 'Fixed; tests pass.')
    assert.equal(opened.workspace, 'ok'); assert.equal(opened.session.validation.currentStatus, 'passed')
    assert.equal((await A2('POST', `/api/sessions/${id}/messages`, { content: 'FOLLOW UP: what changed?' })).status, 202)
    await until(async () => (await A2('GET', `/api/sessions/${id}`)).json.session.events.some(e => e.type === 'assistant.text.completed' && e.data.text === 'Continuing.'))
    assert.deepEqual((await boot2 && (await A2('GET', '/api/sessions', undefined)).json.items.length), 1)
  })

  it('concurrent requests for one stored session share a single hydration', async () => {
    const fx = await repo()
    const persistence = createMemoryPersistence()
    const s1 = await boot({ persistence, respond: scripted(() => reply(say('hello'))) })
    const A1 = api(s1.base, 'tok-alice')
    const ws = (await A1('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A1('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A1('POST', `/api/sessions/${id}/messages`, { content: 'hi' })
    await until(async () => (await A1('GET', `/api/sessions/${id}`)).json.session.status === 'completed')
    await s1.service.flush({ id: 'alice' }); await s1.close()
    const s2 = await boot({ persistence, respond: scripted() })
    const A2 = api(s2.base, 'tok-alice')
    const results = await Promise.all([A2('GET', `/api/sessions/${id}`), A2('GET', `/api/sessions/${id}/workspace-state`), A2('GET', `/api/sessions/${id}/commands`), A2('GET', `/api/sessions/${id}`)])
    assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200])
  })

  it('records operational metrics without content, including rejected records', async () => {
    const fx = await repo()
    const persistence = createMemoryPersistence()
    const s1 = await boot({ persistence, respond: scripted(() => reply(say('hello'))) })
    const A1 = api(s1.base, 'tok-alice')
    const ws = (await A1('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A1('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A1('POST', `/api/sessions/${id}/messages`, { content: 'hi' })
    await until(async () => (await A1('GET', `/api/sessions/${id}`)).json.session.status === 'completed')
    await s1.service.flush({ id: 'alice' }); await s1.close()
    const rec = await persistence.loadSession('alice', id)
    await persistence.saveSession('alice', { ...rec, messages: 'garbage' }, { expectedRevision: rec.revision })
    const s2 = await boot({ persistence, respond: scripted() })
    const r = await api(s2.base, 'tok-alice')('GET', `/api/sessions/${id}`)
    assert.equal(r.status, 422); assert.equal(r.json.error.code, 'persistence_invalid_record')
    const m = await s2.service.persistenceMetrics({ id: 'alice' })
    assert.equal(m.invalidRecords, 1)
    assert.doesNotMatch(JSON.stringify(m), /hello|hi/)
  })

  it('logout drops in-memory state but keeps stored sessions; accounts do not share caches', async () => {
    const fx = await repo()
    const s = await boot({ respond: scripted(() => reply(say('hello'))) })
    const A = api(s.base, 'tok-alice'); const B = api(s.base, 'tok-bob')
    const ws = (await A('POST', '/api/workspaces', { root: fx.root })).json
    const id = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A('POST', `/api/sessions/${id}/messages`, { content: 'hi' })
    await until(async () => (await A('GET', `/api/sessions/${id}`)).json.session.status === 'completed')
    assert.equal((await A('POST', '/api/logout', {})).status, 200)
    assert.deepEqual((await B('GET', '/api/sessions')).json.items, [])
    assert.equal((await A('GET', '/api/sessions')).json.items.length, 1, 'stored sessions survive logout')
    assert.equal((await A('GET', `/api/sessions/${id}`)).status, 200)
  })
})

describe('resource cleanup', () => {
  it('closing an event stream releases its listener; reconnecting does not accumulate listeners', async () => {
    const s = await boot({ respond: scripted() })
    const user = TOKENS['tok-alice']
    assert.equal(await s.service.listenerCount(user), 0)
    const streams = []
    for (let i = 0; i < 5; i++) streams.push(await openStream(s.base, 'tok-alice'))
    await until(async () => (await s.service.listenerCount(user)) === 5)
    for (const st of streams) st.close()
    await until(async () => (await s.service.listenerCount(user)) === 0)
  })
  it('logout releases the user\'s streams and runtime', async () => {
    const s = await boot({ respond: scripted() })
    const user = TOKENS['tok-alice']
    await openStream(s.base, 'tok-alice')
    await until(async () => (await s.service.listenerCount(user)) === 1)
    await api(s.base, 'tok-alice')('POST', '/api/logout', {})
    assert.equal(await s.service.listenerCount(user), 0)
  })
})

describe('error handling', () => {
  it('returns normalized errors without stack traces or secrets', async () => {
    const s = await boot({ respond: scripted() })
    const A = api(s.base, 'tok-alice')
    const bad = await fetch(`${s.base}/api/sessions`, { method: 'POST', headers: { Authorization: 'Bearer tok-alice', 'Content-Type': 'application/json' }, body: '{not json' })
    assert.equal(bad.status, 400)
    const nf = await A('GET', '/api/nope'); assert.equal(nf.status, 404)
    assert.doesNotMatch(nf.text, /at .*\.js:\d+|node_modules/)
    assert.equal((await A('POST', '/api/sessions/does-not-exist/messages', { content: 'x' })).status, 404)
    assert.equal((await A('GET', '/api/sessions/..%2F..%2Fetc')).status, 404)
  })
})
