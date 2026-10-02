// The agent runtime is provider-neutral: the SAME coding scenario runs through DeepSeek, Kimi, OpenAI and
// Anthropic — real adapters, each answering in its own native wire format (mocked fetch) — and produces the same
// canonical result. Also: switching providers between runs, capability gating, and no silent fallback.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry, createStandardProviders } from '../providers/registry.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { BUG_PROJECT } from '../validation/testing/fixtures.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { WIRE, mockFetch } from '../providers/testing/wire.js'
import { createFakeProvider } from './testing/fakeProvider.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

const MODELS = { deepseek: 'deepseek-chat', kimi: 'kimi-k2-thinking', openai: 'gpt-4.1', anthropic: 'claude-sonnet-5-5' }
const WIRE_OF = { deepseek: 'chat', kimi: 'chat', openai: 'responses', anthropic: 'anthropic' }
const patch = (from, to) => `--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a ${from} b\n+  return a ${to} b\n }\n`
const call = (id, name, input) => ({ id, name, args: JSON.stringify(input) })

/** read → wrong patch → validation fails → repair → validation passes → final answer. Neutral; rendered per provider. */
const scenario = () => [
  { text: ['Let me read the code. '], calls: [call('c1', 'read_file', { path: 'src/math.js' })], usage: { input: 100, output: 20 } },
  { calls: [call('c2', 'apply_patch', { patch: patch('-', '*') })], usage: { input: 150, output: 30 } },
  { text: ['I changed add().'], usage: { input: 160, output: 5 } }, // runtime validates → fails
  { text: ['The test shows add(2, 3) is 6.'], calls: [call('c3', 'apply_patch', { patch: patch('*', '+') })], usage: { input: 200, output: 25 } },
  { text: ['Corrected the operator.'], usage: { input: 210, output: 5 } }, // validates → passes
  { text: ['Fixed add(): it now adds.'], usage: { input: 230, output: 8 } },
]

async function boot({ providers = ['deepseek'], script, mode = 'full_auto' } = {}) {
  const fx = await createFixtureRepo({ files: BUG_PROJECT }); cleanups.push(() => fx.cleanup())
  const workspaces = createNodeWorkspaceManager()
  const fetches = {}
  for (const id of providers) fetches[id] = mockFetch((c, n) => WIRE[WIRE_OF[id]](script(id, n, c)))
  const adapters = providers.map(id => createStandardProviders({
    getConfig: (p) => ({ apiKey: 'sk-int-0123456789', baseUrl: `https://${p}.example.test${p === 'anthropic' ? '' : '/v1'}`, model: MODELS[p] }),
    fetchImpl: (url, init) => fetches[Object.keys(fetches).find(k => String(url).startsWith(`https://${k}.`))](url, init),
  }).find(a => a.id === id))
  const runtime = createAgentRuntime({
    providers: createProviderRegistry(adapters), workspaces, approvals: 'interactive', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), permissionMode: mode },
  })
  const ws = await workspaces.openWorkspace({ root: fx.root })
  return { fx, runtime, ws, fetches, session: (provider) => runtime.startSession({ workspaceId: ws.id, model: { provider, model: MODELS[provider] } }) }
}

const canonical = (s) => ({
  status: s.status,
  roles: s.messages.map(m => `${m.role}${m.toolCalls ? `[${m.toolCalls.map(c => c.name).join(',')}]` : ''}${m.role === 'tool' ? `:${m.name}` : ''}`),
  changed: s.changedFiles.map(f => f.path),
  validation: s.validation.currentStatus,
  usage: s.tokenUsage.total,
  eventTypes: [...new Set(s.events.map(e => e.type))].sort(),
})

describe('one agent runtime, four providers', () => {
  const results = {}
  for (const id of Object.keys(MODELS)) {
    it(`${id}: reads, patches, fails validation, repairs, passes, answers`, async () => {
      const h = await boot({ providers: [id], script: (_p, n) => scenario()[n - 1] })
      const s = h.session(id)
      await h.runtime.sendMessage(s.id, 'Fix the failing add test')
      const done = h.runtime.getSession(s.id)
      assert.equal(done.status, 'completed')
      assert.match(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8'), /return a \+ b/)
      assert.equal(done.messages.at(-1).content, 'Fixed add(): it now adds.')
      assert.equal(done.validation.currentStatus, 'passed')
      assert.equal(h.fetches[id].calls.length, 6, 'one request per model turn')
      // every request used this provider's native format and headers…
      const first = h.fetches[id].calls[0]
      assert.ok(String(first.url).includes(id))
      assert.ok(JSON.stringify(first.body).includes('read_file'), 'tools were offered in native form')
      // …and later requests carry the earlier tool exchange in the provider's native continuation format
      const last = JSON.stringify(h.fetches[id].calls.at(-1).body)
      assert.ok(last.includes('c1') && last.includes('c2') && last.includes('c3'), 'tool call ids survive in the native continuation')
      // session state is canonical: no provider-native structures
      const stored = JSON.stringify(done.messages)
      assert.doesNotMatch(stored, /tool_calls|tool_use|tool_result|function_call_output|"input_schema"/)
      results[id] = canonical(done)
    })
  }
  it('produces the same canonical result for every provider', () => {
    const [first, ...rest] = Object.values(results)
    assert.equal(rest.length, 3)
    for (const r of rest) assert.deepEqual(r, first)
    assert.deepEqual(first.changed, ['src/math.js'])
    assert.equal(first.usage, 100 + 20 + 150 + 30 + 160 + 5 + 200 + 25 + 210 + 5 + 230 + 8 + 0 * 1, 'usage is summed from each provider\'s own accounting')
  })
})

describe('switching providers between runs', () => {
  it('a later run on another provider continues from the same canonical history, in that provider\'s native format', async () => {
    const turns = {
      deepseek: [{ calls: [call('d1', 'read_file', { path: 'src/math.js' })] }, { text: ['add subtracts; I have not changed anything yet.'] }],
      anthropic: [{ text: ['Continuing: I will fix add().'] }],
      openai: [{ text: ['Thanks, all good.'] }],
    }
    const seen = { deepseek: 0, anthropic: 0, openai: 0 }
    const h = await boot({ providers: ['deepseek', 'anthropic', 'openai'], script: (id) => turns[id][seen[id]++] })
    const s = h.session('deepseek')
    await h.runtime.sendMessage(s.id, 'What is wrong in math.js?')
    const before = structuredClone(h.runtime.getSession(s.id).messages)

    h.runtime.setSessionModel(s.id, { provider: 'anthropic', model: MODELS.anthropic })
    assert.equal(h.runtime.getSession(s.id).model.provider, 'anthropic')
    assert.deepEqual(h.runtime.getSession(s.id).messages, before, 'switching rewrites nothing')
    await h.runtime.sendMessage(s.id, 'Go ahead and continue')
    const a = h.fetches.anthropic.calls[0].body
    assert.match(a.system, /BLUSWAN/i, 'the canonical system prompt moved into Anthropic\'s system field')
    const blocks = a.messages.flatMap(m => m.content)
    assert.ok(blocks.some(b => b.type === 'tool_use' && b.id === 'd1' && b.name === 'read_file'), 'DeepSeek-era tool call re-expressed as tool_use')
    assert.ok(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'd1' && /add/.test(b.content)), 'and its result as tool_result')
    assert.ok(blocks.some(b => b.type === 'text' && /What is wrong/.test(b.text)))

    h.runtime.setSessionModel(s.id, { provider: 'openai', model: MODELS.openai })
    await h.runtime.sendMessage(s.id, 'thanks')
    const o = h.fetches.openai.calls[0].body
    assert.ok(o.input.some(i => i.type === 'function_call' && i.call_id === 'd1'))
    assert.ok(o.input.some(i => i.type === 'function_call_output' && i.call_id === 'd1'))
    assert.equal(h.runtime.getSession(s.id).status, 'completed')
    assert.deepEqual(h.runtime.getSession(s.id).messages.slice(0, before.length), before, 'earlier history is byte-identical after two switches')
  })

  it('refuses to switch during a run, to an unknown provider, or to a model that cannot call tools', async () => {
    const h = await boot({ providers: ['deepseek'], script: () => ({ text: ['ok'] }) })
    const s = h.session('deepseek')
    const running = h.runtime.sendMessage(s.id, 'hi')
    assert.throws(() => h.runtime.setSessionModel(s.id, { provider: 'deepseek', model: 'deepseek-reasoner' }), (e) => e.code === 'session_busy')
    await running
    assert.throws(() => h.runtime.setSessionModel(s.id, { provider: 'mystery', model: 'x' }), (e) => e.code === 'configuration_error')
    assert.throws(() => h.runtime.setSessionModel(s.id, { provider: 'deepseek', model: '' }), (e) => e.code === 'invalid_request')
    const chatOnly = createFakeProvider({ id: 'chatonly', capabilities: { toolCalling: false } })
    const runtime = createAgentRuntime({ providers: createProviderRegistry([chatOnly]), workspaces: createNodeWorkspaceManager(), config: loadRuntimeConfig({}) })
    const ws = await runtime.openWorkspace({ root: h.fx.root })
    const cs = runtime.startSession({ workspaceId: ws.id, model: { provider: 'chatonly', model: 'm' } })
    await runtime.sendMessage(cs.id, 'edit files')
    assert.equal(runtime.getSession(cs.id).events.find(e => e.type === 'session.failed').data.error.code, 'unsupported_feature')
    assert.throws(() => runtime.setSessionModel(cs.id, { provider: 'chatonly', model: 'm2' }), (e) => e.code === 'unsupported_feature')
    assert.equal(chatOnly.requests.length, 0, 'failed early, before any request')
  })

  it('a failing provider is reported as such — there is no silent fallback to another provider', async () => {
    const h = await boot({ providers: ['deepseek', 'openai'], script: () => ({ text: ['never'] }) })
    h.fetches.deepseek.calls.length = 0
    const failing = createStandardProviders({ getConfig: () => ({ apiKey: 'k', baseUrl: 'https://deepseek.example.test/v1', model: 'deepseek-chat' }), fetchImpl: async () => new Response('down', { status: 500 }) })[0]
    const runtime = createAgentRuntime({
      providers: createProviderRegistry([failing, ...createStandardProviders({ getConfig: () => ({ apiKey: 'k', baseUrl: 'https://openai.example.test/v1', model: 'gpt-4.1' }), fetchImpl: h.fetches.openai }).filter(a => a.id === 'openai')]),
      workspaces: createNodeWorkspaceManager(), sleep: async () => {}, config: { ...loadRuntimeConfig({}), maxTransportRetries: 1 },
    })
    const ws = await runtime.openWorkspace({ root: h.fx.root })
    const s = runtime.startSession({ workspaceId: ws.id, model: { provider: 'deepseek', model: 'deepseek-chat' } })
    await runtime.sendMessage(s.id, 'hello')
    assert.equal(runtime.getSession(s.id).status, 'error')
    assert.equal(runtime.getSession(s.id).events.find(e => e.type === 'session.failed').data.error.code, 'provider_error')
    assert.equal(h.fetches.openai.calls.length, 0, 'the other provider was never contacted')
  })
})
