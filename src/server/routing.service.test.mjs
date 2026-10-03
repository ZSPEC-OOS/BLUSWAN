// Service-level routing: bootstrap exposure, default preference for new sessions, mode changes, settings,
// persistence across restart, legacy sessions, credential availability. Fake providers; no network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBluswanService } from './service.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createFakeProvider, say, reply } from '../agent/testing/fakeProvider.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const KEY = ['fast', 'key', 'value', '0123456789'].join('-')
const user = { id: 'alice' }
const ENV = { BLUSWAN_MODEL_MODE: 'auto', BLUSWAN_FAST_PROVIDER: 'deepseek', BLUSWAN_FAST_MODEL: 'flash-x', BLUSWAN_ADVANCED_PROVIDER: 'kimi', BLUSWAN_ADVANCED_MODEL: 'pro-x' }

function boot({ env = ENV, creds = { deepseek: { apiKey: KEY, model: 'flash-x' }, kimi: { apiKey: KEY, model: 'pro-x' } }, persistence = createMemoryPersistence(), seen = [] } = {}) {
  const credentials = createCredentialStore(creds)
  const service = createBluswanService({
    persistence, credentials, hostId: 'h', allowedRoots: [], config: { ...loadRuntimeConfig(env) },
    providerFactory: () => ['deepseek', 'kimi'].map(id => createFakeProvider({ id, respond: () => { seen.push(id); return reply(say(`${id} answered`)) } })),
    autosave: { debounceMs: 5, retry: { attempts: 1, baseMs: 1 }, sleep: async () => {} },
  })
  return { service, persistence, seen }
}
const settle = async (service, id) => { for (let i = 0; i < 400; i++) { const s = (await service.getSession(user, id)).session; if (!['running', 'waiting_permission'].includes(s.status)) return s; await new Promise(r => setTimeout(r, 5)) } throw new Error('timeout') }

describe('routing in the service', () => {
  it('bootstrap exposes only safe routing metadata', async () => {
    const { service } = boot()
    const b = await service.bootstrap(user)
    assert.equal(b.routing.available, true)
    assert.equal(b.routing.preferredMode, 'auto')
    assert.deepEqual(b.routing.modes.map(m => [m.id, m.label, m.available]), [['auto', 'Auto', true], ['fast', 'Flash', true], ['advanced', 'Pro', true]])
    assert.deepEqual(b.routing.profiles.map(p => [p.id, p.provider, p.model]), [['fast', 'deepseek', 'flash-x'], ['advanced', 'kimi', 'pro-x']])
    const text = JSON.stringify(b.routing)
    assert.ok(!text.includes(KEY) && !/prompt|weight|threshold|apiKey/i.test(text))
  })

  it('without routing configuration nothing changes: manual sessions only', async () => {
    const { service } = boot({ env: {} })
    const b = await service.bootstrap(user)
    assert.deepEqual([b.routing.available, b.routing.configured, b.routing.preferredMode], [false, false, null])
    const { session } = await service.createSession(user, {})
    assert.equal(session.modelPreference, null)
  })

  it('new sessions default to Auto when both profiles are usable; an explicit model stays manual', async () => {
    const { service } = boot()
    assert.equal((await service.createSession(user, {})).session.modelPreference, 'auto')
    const manual = (await service.createSession(user, { model: { provider: 'kimi', model: 'pro-x' } })).session
    assert.deepEqual([manual.modelPreference, manual.model.model], [null, 'pro-x'])
  })

  it('Auto is unavailable when a profile lacks credentials: reported, never half-working', async () => {
    const { service } = boot({ creds: { deepseek: { apiKey: KEY, model: 'flash-x' } } })
    const b = await service.bootstrap(user)
    assert.deepEqual([b.routing.available, b.routing.preferredMode], [false, null])
    assert.deepEqual(b.routing.modes.map(m => [m.id, m.available]), [['auto', false], ['fast', true], ['advanced', false]])
    assert.equal((await service.createSession(user, {})).session.modelPreference, null)
    const { session } = await service.createSession(user, {})
    await assert.rejects(service.setModel(user, session.id, { mode: 'pro' }), e => e.code === 'configuration_error')
    await assert.rejects(service.setModel(user, session.id, { mode: 'auto' }), e => e.code === 'configuration_error')
    assert.equal((await service.setModel(user, session.id, { mode: 'flash' })).modelPreference, 'fast')
  })

  it('setModel accepts a mode, remembers it for new conversations, and a manual model clears it', async () => {
    const { service, seen } = boot()
    const { session } = await service.createSession(user, {})
    const r = await service.setModel(user, session.id, { mode: 'pro' })
    assert.deepEqual([r.modelPreference, r.model.provider], ['advanced', 'kimi'])
    assert.equal((await service.getSettings(user)).modelMode, 'advanced')
    assert.equal((await service.createSession(user, {})).session.modelPreference, 'advanced')
    await service.sendMessage(user, session.id, 'Fix the typo in README.md.')
    await settle(service, session.id)
    assert.deepEqual(seen, ['kimi']) // Pro was forced even for a trivial request
    await assert.rejects(service.setModel(user, session.id, { mode: 'turbo' }), e => e.code === 'invalid_request')
    const m = await service.setModel(user, session.id, { provider: 'deepseek', model: 'flash-x' })
    assert.equal(m.modelPreference, null)
    assert.equal((await service.getSession(user, session.id)).session.modelPreference, null)
  })

  it('Auto routes each request on the server and the preference survives a restart', async () => {
    const persistence = createMemoryPersistence()
    const first = boot({ persistence })
    const { session } = await first.service.createSession(user, {})
    await first.service.sendMessage(user, session.id, 'Fix the typo in README.md.')
    await settle(first.service, session.id)
    await first.service.sendMessage(user, session.id, 'Refactor the entire codebase across all modules to use the new data model.')
    await settle(first.service, session.id)
    assert.deepEqual(first.seen, ['deepseek', 'kimi'])
    await new Promise(r => setTimeout(r, 80))
    const second = boot({ persistence })
    const restored = (await second.service.getSession(user, session.id)).session
    assert.equal(restored.modelPreference, 'auto')
    const routes = restored.events.filter(e => e.type === 'model.route.selected').map(e => e.data.tier)
    assert.deepEqual(routes, ['fast', 'advanced'])
  })

  it('a pre-routing stored session restores as a manual selection and keeps its model', async () => {
    const persistence = createMemoryPersistence()
    const first = boot({ persistence, env: {} })
    const { session } = await first.service.createSession(user, { model: { provider: 'kimi', model: 'pro-x' } })
    await first.service.sendMessage(user, session.id, 'hello')
    await settle(first.service, session.id)
    await new Promise(r => setTimeout(r, 80))
    const rec = await persistence.loadSession(user.id, session.id)
    delete rec.modelPreference // as written by a build that predates routing
    await persistence.saveSession(user.id, rec)
    const second = boot({ persistence })
    const restored = (await second.service.getSession(user, session.id)).session
    assert.deepEqual([restored.modelPreference, restored.model.provider, restored.model.model], [null, 'kimi', 'pro-x'])
  })
})

describe('server configuration and doctor for routing', () => {
  it('parseServerConfig: absent routing is inert; bad values are errors; missing credentials are warnings', async () => {
    const { parseServerConfig } = await import('./config.js')
    assert.equal(parseServerConfig({}).settings.routing.configured, false)
    const ok = parseServerConfig({ BLUSWAN_MODEL_MODE: 'auto', DEEPSEEK_API_KEY: 'x' })
    assert.deepEqual([ok.ok, ok.settings.routing.profiles.fast.model, ok.settings.routing.profiles.advanced.model], [true, 'deepseek-flash', 'deepseek-v4-pro'])
    assert.ok(!ok.warnings.some(w => /Routing/.test(w)))
    assert.match(parseServerConfig({ BLUSWAN_MODEL_MODE: 'turbo' }).errors.join(), /BLUSWAN_MODEL_MODE/)
    assert.match(parseServerConfig({ BLUSWAN_FAST_PROVIDER: 'nope' }).errors.join(), /BLUSWAN_FAST_PROVIDER/)
    const noKey = parseServerConfig({ BLUSWAN_MODEL_MODE: 'auto' })
    assert.equal(noKey.warnings.filter(w => /Auto will be unavailable/.test(w)).length, 2)
    assert.ok(!JSON.stringify(noKey).includes('sk-'))
  })

  it('doctor reports routing without any secret', async () => {
    const { runDoctor } = await import('./doctor.js')
    const secret = ['doctor', 'secret', '0123456789'].join('-')
    const base = { BLUSWAN_PERSISTENCE: 'memory', DEEPSEEK_API_KEY: secret }
    const off = await runDoctor({ env: base, fetch: async () => { throw new Error('offline') } })
    assert.equal(off.checks.find(c => c.id === 'routing').status, 'skip')
    const on = await runDoctor({ env: { ...base, BLUSWAN_MODEL_MODE: 'auto' }, fetch: async () => { throw new Error('offline') } })
    const r = on.checks.find(c => c.id === 'routing')
    assert.equal(r.status, 'pass'); assert.match(r.detail, /deepseek-flash/); assert.match(r.detail, /deepseek-v4-pro/)
    assert.ok(!JSON.stringify(on).includes(secret))
    const missing = await runDoctor({ env: { BLUSWAN_PERSISTENCE: 'memory', BLUSWAN_MODEL_MODE: 'auto' }, fetch: async () => { throw new Error('offline') } })
    assert.equal(missing.checks.find(c => c.id === 'routing').status, 'warn')
  })
})
