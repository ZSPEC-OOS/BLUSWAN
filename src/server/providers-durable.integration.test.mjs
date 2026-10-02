// Final architecture scenario, provider-neutral and offline: workspace → session on one provider → reads/searches →
// edit → validation fails → repair → passes → diff → persist → restart → restore → switch provider → continue from
// the canonical context. Real server service, runtime, tools, git, validation, persistence and provider ADAPTERS;
// only the network is mocked (each provider answers in its own wire format).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBluswanService } from './service.js'
import { createStandardProviders } from '../providers/registry.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createFilePersistence } from '../persistence/adapters/filePersistence.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { BUG_PROJECT } from '../validation/testing/fixtures.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { WIRE, mockFetch } from '../providers/testing/wire.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 15000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)) } }
const USER = { id: 'dev-1', email: 'dev@example.com' }
const patch = (from, to) => `--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a ${from} b\n+  return a ${to} b\n }\n`
const call = (id, name, input) => ({ id, name, args: JSON.stringify(input) })
const WIRE_OF = { deepseek: 'chat', kimi: 'chat', openai: 'responses', anthropic: 'anthropic' }
const MODEL = { deepseek: 'deepseek-chat', kimi: 'kimi-k2-thinking', openai: 'gpt-4.1', anthropic: 'claude-sonnet-5-5' }

const FIRST_RUN = [
  { text: ['Let me look around. '], calls: [call('s1', 'search_files', { query: 'math' }), call('r1', 'read_file', { path: 'src/math.js' })], usage: { input: 100, output: 20 } },
  { calls: [call('p1', 'apply_patch', { patch: patch('-', '*') })], usage: { input: 140, output: 25 } },
  { text: ['I changed add().'], usage: { input: 150, output: 5 } },
  { text: ['The test shows add(2, 3) is 6, not 5.'], calls: [call('p2', 'apply_patch', { patch: patch('*', '+') })], usage: { input: 190, output: 22 } },
  { text: ['Corrected the operator.'], usage: { input: 200, output: 5 } },
  { text: ['add() was subtracting; it now adds and the tests pass.'], usage: { input: 220, output: 12 } },
]

function boot(persistence, scripts) {
  const fetches = {}
  for (const [id, script] of Object.entries(scripts)) fetches[id] = mockFetch((c, n) => WIRE[WIRE_OF[id]](script[n - 1] ?? { text: ['(no more script)'] }))
  const credentials = createCredentialStore(Object.fromEntries(Object.keys(MODEL).map(id => [id, { apiKey: `sk-${id}-phase9-0123456789`, baseUrl: `https://${id}.example.test`, model: MODEL[id] }])))
  const service = createBluswanService({
    persistence, credentials, hostId: 'host-1', allowedRoots: [os.tmpdir()], config: { ...loadRuntimeConfig({}), permissionMode: 'full_auto' },
    providerFactory: (user, creds) => createStandardProviders({
      getConfig: (id) => creds.getCredential(id, user),
      fetchImpl: (url, init) => fetches[Object.keys(fetches).find(k => String(url).startsWith(`https://${k}.`))](url, init),
    }),
    autosave: { debounceMs: 10, sleep: async () => {} },
  })
  cleanups.push(async () => { await service.dispose(USER).catch(() => {}) })
  return { service, fetches }
}

describe('Acceptance: provider-neutral, durable, switchable', () => {
  it('works end to end across a restart and a provider switch', async () => {
    const fx = await createFixtureRepo({ files: BUG_PROJECT }); cleanups.push(() => fx.cleanup())
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-p9-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))

    // ── session 1 on OpenAI ──
    const a = boot(createFilePersistence({ dir }), { openai: FIRST_RUN })
    const boot1 = await a.service.bootstrap(USER)
    assert.deepEqual(boot1.providers.map(p => p.provider), ['deepseek', 'kimi', 'openai', 'anthropic'])
    assert.ok(boot1.models.every(m => m.configured && m.codingCapable), 'every listed model can act as the coding agent')
    const ws = await a.service.openWorkspace(USER, { root: fx.root })
    const { session } = await a.service.createSession(USER, { workspaceId: ws.id, model: { provider: 'openai', model: 'gpt-4.1' } })
    await a.service.sendMessage(USER, session.id, 'Fix the failing add test')
    await until(async () => (await a.service.getSession(USER, session.id)).session.status === 'completed')

    const done = (await a.service.getSession(USER, session.id)).session
    const types = done.events.map(e => e.type)
    for (const t of ['tool.completed', 'file.changed', 'validation.started', 'validation.completed', 'assistant.text.completed', 'session.completed']) assert.ok(types.includes(t), t)
    const validations = done.events.filter(e => e.type === 'validation.completed').map(e => e.data.status)
    assert.equal(validations[0], 'failed', 'the first attempt failed validation'); assert.equal(validations.at(-1), 'passed', 'the repair passed')
    assert.equal(done.model.provider, 'openai')
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /return a \+ b/)

    // changes + diff are available from authoritative state
    const state = await a.service.workspaceState(USER, session.id)
    assert.deepEqual(state.files.map(f => f.path), ['src/math.js'])
    assert.match((await a.service.fileDiff(USER, session.id, 'src/math.js')).diff, /\+ {2}return a \+ b/)
    await a.service.flush(USER)
    await a.service.dispose(USER) // "the server stops"

    // ── restart: a new service over the same storage, other providers now reachable ──
    const b = boot(createFilePersistence({ dir }), { anthropic: [{ text: ['Continuing from the earlier fix: nothing else to change.'], usage: { input: 300, output: 10 } }], openai: [] })
    const list = await b.service.listSessions(USER)
    assert.deepEqual(list.items.map(i => [i.id, i.title, i.status, i.model.provider]), [[session.id, 'Fix the failing add test', 'completed', 'openai']])
    const restored = await b.service.getSession(USER, session.id)
    assert.equal(restored.workspace, 'ok'); assert.equal(restored.session.validation.currentStatus, 'passed', 'repository unchanged → evidence still current')
    assert.equal(restored.session.events.filter(e => e.type === 'assistant.text.completed').at(-1).data.text, 'add() was subtracting; it now adds and the tests pass.')

    // ── switch provider for the follow-up; canonical history continues ──
    assert.equal((await b.service.setModel(USER, session.id, { provider: 'anthropic', model: 'claude-sonnet-5-5' })).model.provider, 'anthropic')
    await b.service.sendMessage(USER, session.id, 'Continue from where we left off')
    await until(async () => (await b.service.getSession(USER, session.id)).session.events.filter(e => e.type === 'session.completed').length === 2)
    const req = b.fetches.anthropic.calls[0].body
    const blocks = req.messages.flatMap(m => m.content)
    assert.match(req.system, /BLUSWAN/i)
    for (const id of ['s1', 'r1', 'p1', 'p2']) assert.ok(blocks.some(x => x.type === 'tool_use' && x.id === id), `OpenAI-era call ${id} replayed as Anthropic tool_use`)
    assert.ok(blocks.some(x => x.type === 'tool_result' && x.tool_use_id === 'r1' && x.content.length > 0), 'with its (context-managed) result')
    assert.ok(blocks.some(x => x.type === 'text' && /Fix the failing add test/.test(x.text)))
    assert.deepEqual(b.fetches.openai.calls, [], 'the previous provider was not contacted')

    // ── what is stored stays canonical and secret-free ──
    await b.service.flush(USER)
    const stored = JSON.stringify(await createFilePersistence({ dir }).loadSession(USER.id, session.id))
    assert.deepEqual(stored.match(/tool_use|tool_result|function_call_output|"tool_calls":|input_schema|sk-[a-z]+-phase9/g) ?? [], [], 'no provider-native structures or credentials in the stored record')
    assert.match(stored, /"provider":"anthropic"/); assert.match(stored, /"toolCalls"/)
    const final = (await b.service.getSession(USER, session.id)).session
    assert.equal(final.events.filter(e => e.type === 'assistant.text.completed').at(-1).data.text, 'Continuing from the earlier fix: nothing else to change.')
    assert.equal(final.status, 'completed')
  })

  it('a session never switches provider on its own after a failure', async () => {
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const failing = mockFetch(() => new Response('upstream down', { status: 500 }))
    const other = mockFetch(() => WIRE.chat({ text: ['never'] }))
    const service = createBluswanService({
      persistence: (await import('../persistence/adapters/memoryPersistence.js')).createMemoryPersistence(), allowedRoots: [os.tmpdir()],
      credentials: createCredentialStore({ deepseek: { apiKey: 'k', baseUrl: 'https://deepseek.example.test', model: 'deepseek-chat' }, kimi: { apiKey: 'k', baseUrl: 'https://kimi.example.test', model: 'kimi-k2-thinking' } }),
      config: { ...loadRuntimeConfig({}), maxTransportRetries: 0 },
      providerFactory: (u, c) => createStandardProviders({ getConfig: (id) => c.getCredential(id, u), fetchImpl: (url, init) => (String(url).includes('deepseek') ? failing : other)(url, init) }),
      autosave: { debounceMs: 10, sleep: async () => {} },
    })
    cleanups.push(() => service.dispose(USER))
    const ws = await service.openWorkspace(USER, { root: fx.root })
    const { session } = await service.createSession(USER, { workspaceId: ws.id, model: { provider: 'deepseek', model: 'deepseek-chat' } })
    await service.sendMessage(USER, session.id, 'hello')
    await until(async () => (await service.getSession(USER, session.id)).session.status === 'error')
    const failed = (await service.getSession(USER, session.id)).session.events.find(e => e.type === 'session.failed').data.error
    assert.equal(failed.code, 'provider_error'); assert.equal(failed.provider, 'deepseek')
    assert.equal(other.calls.length, 0)
  })
})
