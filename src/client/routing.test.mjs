// Phase 13 client: Auto / Flash / Pro selection (desktop select, Settings radios, mobile Settings), the per-run
// indicator, manual provider/model access, and the full browser-store → server path with scripted models.
import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { importComponent, render, h } from './testing/renderJsx.mjs'
import { projectEvents } from './activity/projectEvents.js'
import { routeLabel, modeOptions } from './models/modelSelection.js'
import { createRemoteRuntime } from './runtime/createRemoteRuntime.js'
import { createClientStore } from './state/clientStore.js'
import { createSettingsStore } from './settings/settingsStore.js'
import { createBluswanService } from '../server/service.js'
import { createHttpHandler } from '../server/http.js'
import { createNoAuth } from '../server/auth.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createFakeProvider, say, reply } from '../agent/testing/fakeProvider.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const noop = () => {}
const ROUTING = {
  available: true, configured: true, defaultMode: 'auto', preferredMode: 'auto',
  modes: [{ id: 'auto', label: 'Auto', available: true }, { id: 'fast', label: 'Flash', available: true }, { id: 'advanced', label: 'Pro', available: true }],
  profiles: [{ id: 'fast', label: 'Flash', provider: 'deepseek', model: 'deepseek-flash' }, { id: 'advanced', label: 'Pro', provider: 'kimi', model: 'kimi-pro' }],
}
const MODELS = [
  { provider: 'deepseek', id: 'deepseek-flash', displayName: 'DeepSeek Flash', configured: true, codingCapable: true, capabilities: { reasoning: true } },
  { provider: 'kimi', id: 'kimi-pro', displayName: 'Kimi Pro', configured: true, codingCapable: true, capabilities: {} },
]
let C
before(async () => { C = {
  selector: (await importComponent('status/ModelSelector.jsx')).default,
  picker: (await importComponent('status/ModelModePicker.jsx')).default,
  routeLine: (await importComponent('shared/RouteLine.jsx')).default,
  mobile: (await importComponent('mobile/MobileSettings.jsx')).default,
} })

describe('mode choices', () => {
  it('labels runs the way the product speaks', () => {
    assert.deepEqual([routeLabel('auto', 'fast'), routeLabel('auto', 'advanced'), routeLabel('fast', 'fast'), routeLabel('advanced', 'advanced')], ['Auto · Flash', 'Auto · Pro', 'Flash', 'Pro'])
  })
  it('lists Auto first and recommended; an unavailable mode explains itself', () => {
    const o = modeOptions({ ...ROUTING, modes: ROUTING.modes.map(m => (m.id === 'advanced' ? { ...m, available: false } : m)) })
    assert.deepEqual(o.map(x => [x.id, x.recommended, x.available]), [['auto', true, true], ['fast', false, true], ['advanced', false, false]])
    assert.match(o[2].hint, /Not available/)
    assert.deepEqual(modeOptions(null), [])
  })
})

describe('desktop selector', () => {
  const props = (o = {}) => ({ models: MODELS, current: { provider: 'deepseek', model: 'deepseek-flash' }, onChange: noop, routing: ROUTING, mode: 'auto', onModeChange: noop, ...o })
  it('offers Auto (recommended), Flash and Pro above the manual provider models, with the current mode selected', async () => {
    const html = await render(await h(C.selector, props()))
    assert.match(html, /aria-label="Model"/)
    assert.match(html, /<optgroup label="Automatic">/)
    assert.match(html, /<option value="mode:auto" selected="">Auto \(recommended\)<\/option>/)
    assert.match(html, /value="mode:fast"[^>]*>Flash</); assert.match(html, /value="mode:advanced"[^>]*>Pro</)
    assert.match(html, /<optgroup label="DeepSeek">/); assert.match(html, /<optgroup label="Kimi">/) // manual access preserved
  })
  it('shows the manual model as selected when no mode applies', async () => {
    const html = await render(await h(C.selector, props({ mode: null })))
    assert.match(html, /value="deepseek:deepseek-flash" selected/)
  })
  it('is unchanged without routing', async () => {
    const html = await render(await h(C.selector, { models: MODELS, current: { provider: 'kimi', model: 'kimi-pro' }, onChange: noop }))
    assert.doesNotMatch(html, /Automatic/); assert.match(html, /value="kimi:kimi-pro" selected/)
  })
  it('disables an unavailable tier', async () => {
    const r = { ...ROUTING, modes: ROUTING.modes.map(m => (m.id === 'auto' ? { ...m, available: false } : m)) }
    assert.match(await render(await h(C.selector, props({ routing: r, mode: null }))), /value="mode:auto" disabled="">Auto \(recommended\) — unavailable/)
  })
})

describe('Settings radios', () => {
  it('renders a radio group with Auto recommended and the current mode checked', async () => {
    const html = await render(await h(C.picker, { routing: ROUTING, mode: 'fast', onChange: noop }))
    assert.match(html, /role="radiogroup" aria-label="Model mode"/)
    assert.match(html, /Auto<span class="mode-picker__badge"> · Recommended/)
    assert.match(html, /checked="" value="fast"/); assert.doesNotMatch(html, /checked="" value="auto"/)
    assert.match(html, /Fast and economical/); assert.match(html, /Deeper reasoning/)
  })
  it('renders nothing when the server has no routing', async () => {
    assert.equal(await render(await h(C.picker, { routing: null, mode: null, onChange: noop })), '')
  })
  it('mobile Settings keeps the model controls inside ⚙ Settings: radios, plus manual access in a disclosure', async () => {
    const html = await render(await h(C.mobile, { models: MODELS, model: ROUTING.profiles[0], onChooseModel: noop, routing: ROUTING, mode: 'auto', onChooseMode: noop, permissionMode: 'auto_edit', onPermissionMode: noop, connection: { state: 'online' }, diagnose: async () => ({}), onClose: noop }))
    assert.match(html, /role="radiogroup" aria-label="Model mode"/)
    assert.match(html, /<details class="mmanual">/); assert.match(html, /Choose a specific model/); assert.match(html, /aria-label="Model"/)
  })
  it('mobile Settings without routing shows only the existing selector', async () => {
    const html = await render(await h(C.mobile, { models: MODELS, model: ROUTING.profiles[0], onChooseModel: noop, permissionMode: 'auto_edit', onPermissionMode: noop, connection: { state: 'online' }, diagnose: async () => ({}), onClose: noop }))
    assert.doesNotMatch(html, /radiogroup/); assert.match(html, /aria-label="Model"/)
  })
})

describe('per-run indicator', () => {
  const ev = (type, data, i) => ({ id: `e${i}`, type, sessionId: 's', timestamp: i, data })
  it('projects the selection and a later escalation into one quiet line', () => {
    const v = projectEvents([
      ev('user.message', { messageId: 'm', content: 'hi' }, 1),
      ev('model.route.selected', { mode: 'auto', tier: 'fast', provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high', source: 'deterministic', reasonCodes: ['small_change'] }, 2),
      ev('model.route.escalated', { from: 'fast', to: 'advanced', provider: 'kimi', model: 'kimi-pro', reasoningEffort: 'high', reasonCode: 'repeated_validation_failure' }, 3),
    ])
    const routes = v.entries.filter(e => e.kind === 'route')
    assert.equal(routes.length, 1)
    assert.deepEqual([routes[0].label, routes[0].escalated, routes[0].tier], ['Auto · Pro', true, 'advanced'])
  })
  it('renders the label and the escalation note, and never reasoning or reason prose', async () => {
    const plain = await render(await h(C.routeLine, { entry: { label: 'Auto · Flash', tier: 'fast', escalated: false } }))
    assert.match(plain, /data-testid="route-indicator"/); assert.match(plain, />Auto · Flash</); assert.doesNotMatch(plain, /Escalated/)
    const esc = await render(await h(C.routeLine, { entry: { label: 'Auto · Pro', tier: 'advanced', escalated: true } }))
    assert.match(esc, /Escalated for deeper reasoning/)
  })
  it('a manual Flash run reads just "Flash"', () => {
    const v = projectEvents([ev('model.route.selected', { mode: 'fast', tier: 'fast', provider: 'deepseek', model: 'deepseek-flash', source: 'manual', reasonCodes: ['manual_fast'] }, 1)])
    assert.equal(v.entries[0].label, 'Flash')
  })
})

// ─── full path: browser store → remote runtime → server → routing → scripted models ───
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const KEY = ['server', 'only', 'secret', '0123456789'].join('-')
const ENV = { BLUSWAN_MODEL_MODE: 'auto', BLUSWAN_FAST_PROVIDER: 'deepseek', BLUSWAN_FAST_MODEL: 'deepseek-flash', BLUSWAN_ADVANCED_PROVIDER: 'kimi', BLUSWAN_ADVANCED_MODEL: 'kimi-pro' }

async function boot({ persistence = createMemoryPersistence(), seen = [] } = {}) {
  const service = createBluswanService({
    persistence, hostId: 'h', allowedRoots: [os.tmpdir()], config: loadRuntimeConfig(ENV),
    credentials: createCredentialStore({ deepseek: { apiKey: KEY, model: 'deepseek-flash' }, kimi: { apiKey: KEY, model: 'kimi-pro' } }),
    providerFactory: () => ['deepseek', 'kimi'].map(id => {
      const p = createFakeProvider({ id, respond: () => { seen.push(id); return reply(say(`${id} here`)) } })
      const model = id === 'deepseek' ? 'deepseek-flash' : 'kimi-pro'
      return { ...p, listModels: () => [{ provider: id, id: model, displayName: model, capabilities: p.capabilities(model), known: true }] }
    }),
    autosave: { debounceMs: 5, retry: { attempts: 2, baseMs: 1 }, sleep: async () => {} },
  })
  const server = http.createServer(createHttpHandler({ service, auth: createNoAuth({ userId: 'alice' }), heartbeatMs: 50 }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  cleanups.push(async () => { await service.dispose({ id: 'alice' }).catch(() => {}); await new Promise(r => { server.closeAllConnections(); server.close(r) }) })
  return { base, seen, service, persistence }
}
async function client(base) {
  const responses = []
  const runtime = createRemoteRuntime({ baseUrl: base, fetch: async (u, i) => { const r = await fetch(u, i); if (!String(u).endsWith('/api/stream')) responses.push(await r.clone().text()); return r }, userKey: 'alice', reconnect: { baseMs: 5, maxMs: 20 } })
  await runtime.init()
  const store = createClientStore({ runtime, settings: createSettingsStore({ storage: null }), selectModel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }), workspaceStorage: null, debounceMs: 5 })
  cleanups.push(async () => { store.destroy(); runtime.close() })
  return { runtime, store, responses, snap: () => store.getSnapshot() }
}
const routes = (c) => c.snap().active.view.entries.filter(e => e.kind === 'route').map(e => e.label)
const send = async (c, text) => { const before = routes(c).length; const r = c.store.sendMessage(text); await r.done; await until(() => routes(c).length > before && c.snap().active.view.status === 'completed') }

describe('browser store with server routing', () => {
  it('defaults to Auto, routes each request, and shows the indicator for each run', async () => {
    const s = await boot(); const c = await client(s.base)
    assert.equal(c.snap().routing.available, true)
    c.store.newSession()
    assert.equal(c.snap().mode, 'auto')
    await send(c, 'Fix the typo in README.md.')
    await send(c, 'Refactor the entire codebase across all modules to use the new data model.')
    assert.deepEqual(s.seen, ['deepseek', 'kimi'])
    assert.deepEqual(routes(c), ['Auto · Flash', 'Auto · Pro'])
    assert.doesNotMatch(c.responses.join('\n'), new RegExp(KEY))
  })

  it('Pro and Flash are absolute; the choice persists across a browser reload; a manual model clears it', async () => {
    const s = await boot(); const c = await client(s.base)
    c.store.newSession()
    await c.store.chooseMode('advanced')
    assert.equal(c.snap().mode, 'advanced')
    await send(c, 'Fix the typo in README.md.')
    assert.deepEqual([s.seen, routes(c)], [['kimi'], ['Pro']])
    await c.store.chooseMode('fast')
    await send(c, 'Refactor the entire codebase across all modules to use the new data model.')
    assert.deepEqual([s.seen, routes(c)], [['kimi', 'deepseek'], ['Pro', 'Flash']])
    await until(async () => (await s.service.getSettings({ id: 'alice' })).modelMode === 'fast')

    const reloaded = await client(s.base) // fresh browser, same server
    reloaded.store.newSession()
    assert.equal(reloaded.snap().mode, 'fast')

    await reloaded.store.chooseModel({ provider: 'kimi', model: 'kimi-pro' })
    await until(async () => (await s.service.getSettings({ id: 'alice' })).modelMode === 'manual')
    const manual = await client(s.base)
    manual.store.newSession()
    assert.equal(manual.snap().mode, null)
  })
})
