// The whole stack: browser store → remote runtime → HTTP/SSE → server runtime → tools/git/validation → storage.
// "Restarting" = a new server and a new browser runtime over the same storage. Only the model is scripted.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRemoteRuntime, createIndexCache } from './createRemoteRuntime.js'
import { createClientStore } from '../state/clientStore.js'
import { createSettingsStore, scrubLegacySecrets } from '../settings/settingsStore.js'
import { createBluswanService } from '../../server/service.js'
import { createHttpHandler } from '../../server/http.js'
import { createNoAuth } from '../../server/auth.js'
import { createCredentialStore } from '../../providers/credentials/credentialStore.js'
import { createFilePersistence } from '../../persistence/adapters/filePersistence.js'
import { createMemoryPersistence } from '../../persistence/adapters/memoryPersistence.js'
import { createIndexedDbDocStore, openIndexedDb } from '../../persistence/adapters/localPersistence.js'
import { fakeIndexedDB } from '../../persistence/testing/fakeIndexedDb.js'
import { createFakeProvider, say, call, reply } from '../../agent/testing/fakeProvider.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../../config/runtimeConfig.js'

const SECRET = 'sk-never-in-the-browser-0123456789'
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 10000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const scripted = (...turns) => { let n = 0; return (req) => (req.messages.filter(m => m.role === 'user').at(-1)?.content.startsWith('FOLLOW') ? reply(say('Continuing from where we left off.')) : turns[n++]?.(req) ?? reply(say('done'))) }

async function startServer({ persistence, respond, userId = 'alice', mode = 'full_auto', providerIds = ['deepseek'] }) {
  const service = createBluswanService({
    persistence, hostId: 'host-1', allowedRoots: [os.tmpdir()], config: { ...loadRuntimeConfig({}), permissionMode: mode },
    credentials: createCredentialStore(Object.fromEntries(providerIds.map(id => [id, { apiKey: SECRET, baseUrl: `https://${id}.example.test`, model: id === 'deepseek' ? 'deepseek-chat' : 'kimi-k2-thinking' }]))),
    providerFactory: () => providerIds.map(id => { const model = id === 'deepseek' ? 'deepseek-chat' : 'kimi-k2-thinking'; const p = createFakeProvider({ id, respond: (req, n, emit) => respond({ ...req, providerId: id }, n, emit) }); return { ...p, stream: p.stream, listModels: () => [{ provider: id, id: model, displayName: model, capabilities: p.capabilities(model), known: true }] } }),
    autosave: { debounceMs: 10, retry: { attempts: 2, baseMs: 1 }, sleep: async () => {} },
  })
  const server = http.createServer(createHttpHandler({ service, auth: createNoAuth({ userId }), heartbeatMs: 50 }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const handle = { service, base: `http://127.0.0.1:${server.address().port}`, kill: () => new Promise(r => { server.closeAllConnections(); server.close(r) }), dropStreams: () => server.closeAllConnections() }
  cleanups.push(async () => { await service.dispose({ id: userId }).catch(() => {}); await handle.kill() })
  return handle
}

async function startClient(server, { cache = null, fetchSpy = null, userKey = 'alice' } = {}) {
  const responses = []
  const spyFetch = async (url, init) => {
    fetchSpy?.(url, init)
    const res = await fetch(url, init)
    if (!String(url).endsWith('/api/stream')) responses.push(await res.clone().text())
    return res
  }
  const runtime = createRemoteRuntime({ baseUrl: server.base, fetch: spyFetch, cache, userKey, reconnect: { baseMs: 5, maxMs: 20 } })
  await runtime.init()
  const settings = createSettingsStore({ storage: null })
  const store = createClientStore({ runtime, settings, selectModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }), workspaceStorage: null, debounceMs: 5 })
  cleanups.push(async () => { store.destroy(); runtime.close() })
  const settle = async () => { await store.workspace.idle(); await new Promise(r => setTimeout(r, 20)); await store.workspace.idle() }
  return { runtime, store, settings, responses, settle, snap: () => store.getSnapshot(), view: () => store.getSnapshot().active.view }
}

const fixture = async () => { const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup()); return fx }

describe('Durable end to end: persist → restart → restore → continue', () => {
  it('a coding session survives a full restart of server and browser, with workspace, evidence and context intact', async () => {
    const fx = await fixture()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-e2e-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const respond1 = scripted(() => reply(call('r', 'read_file', { path: 'src/math.js' })), () => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('Fixed add().')), () => reply(say('Fixed add(); the tests pass.')))
    const s1 = await startServer({ persistence: createFilePersistence({ dir }), respond: respond1 })
    const c1 = await startClient(s1)

    // open a repository, start a conversation, let the agent work
    assert.equal((await c1.store.openWorkspace({ root: fx.root })).ok, true)
    const id = c1.snap().activeId
    const sent = c1.store.sendMessage('Fix the failing add test')
    assert.equal(sent.ok, true); await sent.done
    await until(() => c1.view().status === 'completed')
    await c1.settle()
    assert.deepEqual(c1.snap().active.review.changedFiles.map(f => f.path), ['src/math.js'])
    assert.equal(c1.snap().active.review.validation.state, 'current')
    await s1.service.flush({ id: 'alice' })
    await until(() => c1.snap().active.persistence === 'saved')

    // the provider key never reached the browser
    assert.doesNotMatch(c1.responses.join('\n') + JSON.stringify(c1.snap()), /sk-never-in-the-browser/)

    // ─── restart everything ───
    c1.store.destroy(); c1.runtime.close(); await s1.kill()
    const requests = []
    const s2 = await startServer({ persistence: createFilePersistence({ dir }), respond: (req) => { requests.push(req); return scripted()(req) } })
    const gets = []
    const c2 = await startClient(s2, { fetchSpy: (url, init) => { if ((init?.method ?? 'GET') === 'GET') gets.push(String(url)) } })

    // the list arrives without any transcript
    assert.deepEqual(c2.snap().sessions.map(s => [s.id, s.title, s.status]), [[id, 'Fix the failing add test', 'completed']])
    assert.equal(gets.some(u => new RegExp(`/api/sessions/${id}$`).test(u)) && c2.snap().active === null, false)
    // the most recent conversation opens and hydrates on demand
    await until(() => c2.snap().active && !c2.snap().active.loading && c2.view().entries.length > 0)
    await c2.settle()
    const entries = c2.view().entries
    assert.equal(entries[0].kind, 'user'); assert.equal(entries[0].text, 'Fix the failing add test')
    assert.equal(entries.filter(e => e.kind === 'assistant').at(-1).text, 'Fixed add(); the tests pass.')
    assert.ok(entries.some(e => e.kind === 'activity' && e.items.some(i => i.files?.some(f => f.path === 'src/math.js'))))
    // workspace re-attached and reconciled from reality
    assert.equal(c2.snap().active.workspace.available, true); assert.equal(c2.snap().active.workspace.name, path.basename(fx.root))
    assert.deepEqual(c2.snap().active.review.changedFiles.map(f => f.path), ['src/math.js'])
    assert.equal(c2.snap().active.review.validation.state, 'current')
    // follow-up continues the same conversation, workspace and context
    const follow = c2.store.sendMessage('FOLLOW UP: continue from where we left off')
    assert.equal(follow.ok, true); await follow.done
    await until(() => c2.view().entries.some(e => e.kind === 'assistant' && e.text.startsWith('Continuing')))
    assert.match(JSON.stringify(requests.at(-1).messages), /Fix the failing add test/)
    assert.equal(c2.snap().sessions.length, 1)
    assert.doesNotMatch(c2.responses.join('\n') + JSON.stringify(c2.snap()), /sk-never-in-the-browser/)
  })

  it('a run interrupted by a crash restores as interrupted; applied work is visible; nothing is replayed', async () => {
    const fx = await fixture()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-e2e-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const real = createFilePersistence({ dir })
    let crashed = false
    const persistence = { ...real, saveSession: async (...a) => (crashed ? a[1] : real.saveSession(...a)) } // after the "crash" nothing more is written
    const s1 = await startServer({ persistence, respond: scripted(() => reply(call('w', 'write_file', { path: 'half.txt', content: 'before the crash\n' })), () => reply(call('sh', 'shell', { command: 'sleep 30' }))) })
    const c1 = await startClient(s1)
    await c1.store.openWorkspace({ root: fx.root })
    const id = c1.snap().activeId
    c1.store.sendMessage('Create half.txt then wait')
    await until(() => c1.view().entries.some(e => e.kind === 'activity' && e.items.some(i => i.tool === 'shell' && i.status === 'running')))
    await s1.service.flush({ id: 'alice' })
    crashed = true
    c1.store.destroy(); c1.runtime.close()
    await s1.service.dispose({ id: 'alice' }); await s1.kill()
    assert.equal((await real.loadSession('alice', id)).status, 'running', 'that is what the crashed process left behind')

    const requests = []
    const s2 = await startServer({ persistence: real, respond: (req) => { requests.push(req); return scripted()(req) } })
    const c2 = await startClient(s2)
    await until(() => c2.snap().active && c2.view().entries.length > 0)
    await c2.settle()
    assert.equal(c2.view().status, 'interrupted'); assert.equal(c2.snap().active.interrupted, true)
    assert.ok(c2.view().entries.some(e => e.kind === 'outcome' && e.outcome === 'interrupted'))
    assert.ok(!c2.view().entries.some(e => e.kind === 'activity' && e.items.some(i => i.status === 'running')))
    assert.equal(c2.snap().sessions[0].status, 'interrupted')
    assert.deepEqual(c2.snap().active.review.changedFiles.map(f => f.path), ['half.txt'], 'work applied before the crash is discovered')
    assert.equal(c2.snap().active.composer.disabled, false)
    assert.equal(requests.length, 0, 'no model request was made on restore')
    await c2.store.sendMessage('FOLLOW UP: please continue').done
    await until(() => c2.view().status === 'completed')
    assert.equal(requests.length, 1)
  })
})

describe('lazy loading, reconnect and de-duplication', () => {
  it('loads only the list at startup and one transcript when a conversation is opened', async () => {
    const fx = await fixture()
    const persistence = createMemoryPersistence()
    const s1 = await startServer({ persistence, respond: scripted(() => reply(say('one')), () => reply(say('two'))) })
    const c1 = await startClient(s1)
    await c1.store.openWorkspace({ root: fx.root })
    await c1.store.sendMessage('first').done; await until(() => c1.view().status === 'completed')
    c1.store.newSession(); await c1.store.sendMessage('second').done; await until(() => c1.view().status === 'completed')
    await s1.service.flush({ id: 'alice' }); await s1.kill(); c1.store.destroy(); c1.runtime.close()

    const s2 = await startServer({ persistence, respond: scripted() })
    const urls = []
    const c2 = await startClient(s2, { fetchSpy: (u, i) => urls.push(`${i?.method ?? 'GET'} ${u}`) })
    assert.equal(c2.snap().sessions.length, 2)
    const transcriptGets = () => urls.filter(u => /GET .*\/api\/sessions\/[^/?]+$/.test(u)).length
    await until(() => transcriptGets() >= 1)
    assert.equal(transcriptGets(), 1, 'only the opened conversation was hydrated')
    const other = c2.snap().sessions.find(s => s.id !== c2.snap().activeId).id
    c2.store.selectSession(other)
    await until(() => transcriptGets() === 2)
  })

  it('a dropped stream reconnects and never renders a message twice', async () => {
    const fx = await fixture()
    const s = await startServer({ persistence: createMemoryPersistence(), respond: scripted(() => reply(call('sh', 'shell', { command: 'sleep 0.4; echo done' })), () => reply(say('All finished.'))) })
    const c = await startClient(s)
    await c.store.openWorkspace({ root: fx.root })
    c.store.sendMessage('run it')
    await until(() => c.view().entries.some(e => e.kind === 'activity'))
    s.dropStreams() // the connection dies mid-run
    await until(() => c.runtime.getConnection().reconnects >= 1)
    await until(() => c.view().status === 'completed')
    await until(() => c.runtime.getConnection().state === 'online')
    const texts = c.view().entries.filter(e => e.kind === 'assistant').map(e => e.text)
    assert.deepEqual(texts, ['All finished.'])
    assert.equal(c.view().entries.filter(e => e.kind === 'user').length, 1)
    const session = c.runtime.getSession(c.snap().activeId)
    assert.equal(new Set(session.events.map(e => e.id)).size, session.events.length, 'event ids are unique after resync')
  })

  it('shows the cached session list when the server is unreachable, per user, and clears it on logout', async () => {
    const fx = await fixture()
    const persistence = createMemoryPersistence()
    const s1 = await startServer({ persistence, respond: scripted(() => reply(say('hello'))) })
    const cache = createIndexCache(createIndexedDbDocStore({ db: await openIndexedDb(fakeIndexedDB(), 'cache-test') }))
    const c1 = await startClient(s1, { cache })
    await c1.store.openWorkspace({ root: fx.root })
    await c1.store.sendMessage('hello there').done; await until(() => c1.view().status === 'completed')
    await s1.service.flush({ id: 'alice' })
    await c1.runtime.init() // refresh the cache while online
    c1.store.destroy(); c1.runtime.close(); await s1.kill()

    const offline = createRemoteRuntime({ baseUrl: s1.base, cache, userKey: 'alice', fetch: async () => { throw new TypeError('offline') } })
    await offline.init()
    assert.deepEqual(offline.listSessions().map(x => x.title), ['Hello there'])
    assert.equal(offline.getConnection().offlineIndex, true)
    const other = createRemoteRuntime({ baseUrl: s1.base, cache, userKey: 'bob', fetch: async () => { throw new TypeError('offline') } })
    await assert.rejects(() => other.init(), /Cannot reach/)

    await offline.logout()
    assert.equal(await cache.load('alice'), null)
    assert.deepEqual(offline.listSessions(), [])
  })
})

describe('choosing a model from the UI', () => {
  it('applies to the next run of the open conversation, keeps its history, and survives a restart', async () => {
    const fx = await fixture()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-e2e-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const seen = []
    const respond = (req) => { seen.push([req.providerId, req.model, req.messages.filter(m => m.role === 'user').length]); return scripted(() => reply(say(`answer from ${req.providerId}`)))(req) }
    const s1 = await startServer({ persistence: createFilePersistence({ dir }), respond, providerIds: ['deepseek', 'kimi'] })
    const c1 = await startClient(s1)
    await c1.store.openWorkspace({ root: fx.root })
    assert.deepEqual(c1.snap().models.map(m => m.provider).filter((p, i, a) => a.indexOf(p) === i), ['deepseek', 'kimi'])
    assert.equal(c1.snap().active.model.provider, 'deepseek')
    await c1.store.sendMessage('first question').done; await until(() => c1.view().status === 'completed')
    await c1.store.chooseModel({ provider: 'kimi', model: 'kimi-k2-thinking' })
    await until(() => c1.snap().active.model.provider === 'kimi')
    await c1.store.sendMessage('second question').done; await until(() => c1.view().entries.filter(e => e.kind === 'assistant').length === 2)
    assert.deepEqual(seen, [['deepseek', 'deepseek-chat', 1], ['kimi', 'kimi-k2-thinking', 2]], 'the second run used the new provider, with the earlier turn in its history')
    assert.deepEqual(c1.view().entries.filter(e => e.kind === 'assistant').map(e => e.text), ['answer from deepseek', 'answer from kimi'])
    await s1.service.flush({ id: 'alice' }); c1.store.destroy(); c1.runtime.close(); await s1.kill()

    const s2 = await startServer({ persistence: createFilePersistence({ dir }), respond, providerIds: ['deepseek', 'kimi'] })
    const c2 = await startClient(s2)
    await until(() => c2.snap().active && c2.view().entries.length > 0)
    assert.equal(c2.snap().active.model.provider, 'kimi', 'the conversation remembers its model')
    assert.equal(c2.snap().sessions[0].id, c2.snap().activeId)
  })
  it('refuses to change the model while a run is active and says so', async () => {
    const fx = await fixture()
    const s = await startServer({ persistence: createMemoryPersistence(), respond: scripted(() => reply(call('sh', 'shell', { command: 'sleep 30' }))), providerIds: ['deepseek', 'kimi'] })
    const c = await startClient(s)
    await c.store.openWorkspace({ root: fx.root })
    c.store.sendMessage('wait')
    await until(() => c.view().entries.some(e => e.kind === 'activity' && e.items.some(i => i.status === 'running')))
    await c.store.chooseModel({ provider: 'kimi', model: 'kimi-k2-thinking' })
    assert.equal(c.snap().active.model.provider, 'deepseek')
    c.store.cancel(); await until(() => c.view().status === 'stopped')
  })
})

describe('browser storage holds no credentials', () => {
  it('settings contain only preferences; legacy provider keys are scrubbed; unrelated storage is untouched', () => {
    const mk = (init) => { const m = new Map(Object.entries(init)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), dump: () => Object.fromEntries(m) } }
    const local = mk({
      'wrkflow:keysbak': 'ciphertext', 'bluswan.settings': JSON.stringify({ permissionMode: 'ask', apiKey: 'sk-old-key-123456789', baseUrl: 'x' }),
      'wrkflow:models': JSON.stringify([{ id: 'm', apiKey: 'sk-model-key-123456789', name: 'n' }]), 'bluswan:history': '["a"]',
    })
    const session = mk({ 'wrkflow:keys': 'x', 'wrkflow:sk': 'y', 'firebase:authUser': 'keep' })
    const removed = scrubLegacySecrets({ local, session })
    assert.equal(removed.length, 5)
    const after = JSON.stringify([local.dump(), session.dump()])
    assert.doesNotMatch(after, /sk-old-key|sk-model-key|ciphertext/)
    assert.equal(local.getItem('bluswan:history'), '["a"]'); assert.equal(session.getItem('firebase:authUser'), 'keep')
    assert.deepEqual(scrubLegacySecrets({ local, session }), [], 'idempotent')
    assert.doesNotThrow(() => scrubLegacySecrets({ local: null, session: { getItem() { throw new Error('blocked') } } }))
  })
})
