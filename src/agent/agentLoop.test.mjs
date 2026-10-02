// Agent loop tests: real runtime, session manager, event protocol, tool executor and workspace;
// only the model provider is scripted.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, think, call, badCall, reply } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { createError } from '../protocol/schemas.js'

const model = { provider: 'fake', model: 'm1' }
const baseConfig = { ...loadRuntimeConfig({}), enableAutomaticValidation: false, maxTurns: 25, maxTransportRetries: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2 }
const noSleep = async () => {}

describe('agent loop', () => {
  let fx, wm, workspace
  beforeEach(async () => {
    fx = await createFixtureRepo()
    wm = createNodeWorkspaceManager()
    workspace = await wm.openWorkspace({ root: fx.root })
  })
  afterEach(() => fx.cleanup())

  function harness(providerOpts, { config = {}, withWorkspace = true } = {}) {
    const provider = createFakeProvider(providerOpts)
    const runtime = createAgentRuntime({
      providers: createProviderRegistry([provider]), workspaces: wm, config: { ...baseConfig, ...config }, sleep: noSleep,
    })
    const session = runtime.startSession({ workspaceId: withWorkspace ? workspace.id : null, model })
    const events = []
    runtime.subscribe(session.id, e => events.push(e))
    const types = () => events.map(e => e.type)
    return { provider, runtime, session, events, types, send: text => runtime.sendMessage(session.id, text) }
  }
  const toolMessages = s => s.messages.filter(m => m.role === 'tool')

  describe('canonical tool loop', () => {
    it('reads, patches, tests, and finishes with a grounded answer', async () => {
      const h = harness({
        turns: [
          reply(say('I will inspect the code.'), call('c1', 'read_file', { path: 'src/math.js' })),
          reply(call('c2', 'apply_patch', { patch: FIX_ADD_PATCH })),
          reply(call('c3', 'shell', { command: 'npm test' })),
          reply(say('Fixed add(); npm test passes.')),
        ],
      })
      const done = await h.send('Fix add()')

      assert.equal(done.status, 'completed')
      assert.equal(h.provider.requests.length, 4)
      assert.deepEqual(done.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
      assert.equal(done.messages[1].content, 'I will inspect the code.') // text before a tool call is preserved
      assert.deepEqual(done.messages[1].toolCalls, [{ id: 'c1', name: 'read_file', input: { path: 'src/math.js' } }])
      assert.deepEqual(toolMessages(done).map(m => [m.toolCallId, m.name]), [['c1', 'read_file'], ['c2', 'apply_patch'], ['c3', 'shell']])
      assert.match(toolMessages(done)[0].content, /return a - b/)
      assert.match(toolMessages(done)[2].content, /Exit code: 0/)
      assert.equal(done.messages.at(-1).content, 'Fixed add(); npm test passes.')

      // events: deterministic ordering
      assert.deepEqual(h.types().filter(t => t !== 'assistant.text.delta'), [
        'user.message', 'session.updated', 'assistant.text.completed', 'tool.started', 'tool.completed',
        'tool.started', 'file.changed', 'tool.completed', 'tool.started', 'tool.completed', 'command.completed',
        'assistant.text.completed', 'session.completed'])

      // session state
      assert.deepEqual(done.changedFiles, [{ path: 'src/math.js', action: 'modified' }])
      assert.deepEqual(done.toolCalls.map(c => [c.name, c.status]), [['read_file', 'completed'], ['apply_patch', 'completed'], ['shell', 'completed']])
      assert.deepEqual(done.turns.map(t => [t.turn, t.finishReason, t.toolCalls.length]), [[1, 'tool_calls', 1], [2, 'tool_calls', 1], [3, 'tool_calls', 1], [4, 'stop', 0]])
      assert.deepEqual(done.tokenUsage, { input: 40, output: 20, reasoning: 0, total: 60 })
      assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /a \+ b/)
    })

    it('offers registry tools and workspace context in the first request', async () => {
      const h = harness({ turns: [reply(say('hi'))] })
      await h.send('hello')
      const [req] = h.provider.requests
      assert.deepEqual(req.tools.map(t => t.name).sort(), ['apply_patch', 'delete_file', 'git_diff', 'git_status', 'grep', 'list_directory', 'read_file', 'read_many_files', 'search_files', 'shell', 'write_file'])
      assert.ok(req.tools.every(t => t.inputSchema?.type === 'object'))
      const system = req.messages[0].content
      assert.match(system, /^You are BLUSWAN/)
      assert.match(system, /WORKSPACE/)
      assert.match(system, /Branch: main/)
      assert.match(system, /Git status: clean/)
      assert.match(system, /Top-level:.*src\/.*package\.json/)
      assert.match(system, /package\.json \(package manager: npm\)/)
      assert.ok(!system.includes(fx.root), 'absolute paths are not leaked')
      assert.equal(req.metadata.turn, 1)
    })

    it('offers no tools to sessions without a workspace', async () => {
      const h = harness({ turns: [reply(say('chat only'))] }, { withWorkspace: false })
      await h.send('hi')
      assert.deepEqual(h.provider.requests[0].tools, [])
      assert.ok(!h.provider.requests[0].messages[0].content.includes('WORKSPACE'))
    })

    it('streams text deltas before completion and reports reasoning only as status', async () => {
      const h = harness({ turns: [reply(think('secret chain of thought'), say('Hel'), say('lo'))] })
      const done = await h.send('hi')
      assert.deepEqual(h.types(), ['user.message', 'session.updated', 'assistant.reasoning.status', 'assistant.text.delta', 'assistant.text.delta', 'assistant.text.completed', 'session.completed'])
      assert.ok(!JSON.stringify(h.events).includes('secret chain'))
      assert.equal(done.messages[1].reasoning, 'secret chain of thought') // kept for provider continuation only
    })

    it('feeds tool failures back to the model, which recovers', async () => {
      const h = harness({
        turns: [
          reply(call('c1', 'read_file', { path: 'src/mathh.js' })),
          reply(call('c2', 'search_files', { query: 'math' })),
          reply(call('c3', 'read_file', { path: 'src/math.js' })),
          reply(call('c4', 'apply_patch', { patch: FIX_ADD_PATCH })),
          reply(say('done')),
        ],
      })
      const done = await h.send('fix it')
      assert.equal(done.status, 'completed')
      assert.match(toolMessages(done)[0].content, /Status: error\nError \[file_not_found\]/)
      assert.match(toolMessages(done)[1].content, /src\/math\.js/)
      assert.deepEqual(done.toolCalls.map(c => c.status), ['failed', 'completed', 'completed', 'completed'])
      assert.deepEqual(h.types().filter(t => t === 'tool.failed').length, 1)
    })

    it('handles unknown tools, malformed arguments and invalid input without crashing', async () => {
      const h = harness({
        turns: [
          reply(call('c1', 'foo_magic_tool', {}), badCall('c2', 'read_file', '{"pa'), call('c3', 'read_file', { path: 42 })),
          reply(say('ok, giving up on those')),
        ],
      })
      const done = await h.send('go')
      assert.equal(done.status, 'completed')
      const [a, b, c] = toolMessages(done).map(m => m.content)
      assert.match(a, /Error \[unknown_tool\].*foo_magic_tool/)
      assert.match(b, /Error \[invalid_input\]/)
      assert.match(c, /Error \[invalid_input\].*input\.path/)
      assert.deepEqual(h.events.filter(e => e.type === 'tool.failed').map(e => e.data.error.code), ['unknown_tool', 'invalid_input', 'invalid_input'])
      // malformed arguments are never replayed to the provider as invalid JSON
      assert.equal(done.messages[1].toolCalls[1].input, null)
    })

    it('treats a non-zero exit as an observation the model can read', async () => {
      const h = harness({ turns: [reply(call('c1', 'shell', { command: 'echo boom >&2; exit 1' })), reply(say('it failed'))] })
      const done = await h.send('run')
      assert.match(toolMessages(done)[0].content, /Status: ok\nCommand: echo boom >&2; exit 1\nExit code: 1/)
      assert.match(toolMessages(done)[0].content, /STDERR:\nboom/)
      assert.equal(done.status, 'completed')
      assert.equal(h.events.filter(e => e.type === 'tool.failed').length, 0)
    })

    it('refuses commands that need approval and never runs them', async () => {
      const h = harness({
        turns: [reply(call('c1', 'shell', { command: 'git push origin main' }), call('c2', 'shell', { command: 'rm -rf src' }), call('c3', 'shell', { command: 'sudo ls' })), reply(say('cannot'))],
      })
      const done = await h.send('push it')
      const [push, rm, sudo] = toolMessages(done).map(m => m.content)
      assert.match(push, /Error \[permission_required\]/)
      assert.match(rm, /Error \[permission_required\]/)
      assert.match(sudo, /Error \[permission_denied\]/)
      assert.equal(await workspace.exists('src/math.js'), true)
    })

    it('can create and delete files via tools (Full Auto allows deletions)', async () => {
      const h = harness({
        turns: [reply(call('c1', 'write_file', { path: 'tests/new.test.js', content: 'x' }), call('c2', 'delete_file', { path: 'src/index.js' })), reply(say('ok'))],
      }, { config: { permissionMode: 'full_auto' } })
      const done = await h.send('go')
      assert.deepEqual(done.changedFiles, [{ path: 'tests/new.test.js', action: 'created' }, { path: 'src/index.js', action: 'deleted' }])
      assert.deepEqual(h.events.filter(e => e.type === 'file.changed').map(e => [e.data.path, e.data.action, e.data.toolCallId]),
        [['tests/new.test.js', 'created', 'c1'], ['src/index.js', 'deleted', 'c2']])
    })

    it('keeps only the latest action per changed file', async () => {
      const h = harness({
        turns: [reply(call('c1', 'write_file', { path: 'a.txt', content: '1' })), reply(call('c2', 'write_file', { path: 'a.txt', content: '2' })), reply(say('ok'))],
      })
      const done = await h.send('go')
      assert.deepEqual(done.changedFiles, [{ path: 'a.txt', action: 'modified' }])
    })

    it('bounds oversized tool results sent to the model', async () => {
      const h = harness({ turns: [reply(call('c1', 'read_file', { path: 'src/math.js' })), reply(say('ok'))] }, { config: { limits: { maxToolResultChars: 80 } } })
      // limits come from the runtime config; ensure the serializer clips with an explicit marker
      const done = await h.send('go')
      assert.ok(toolMessages(done)[0].content.length <= 80 + 60)
      assert.match(toolMessages(done)[0].content, /characters omitted/)
    })
  })

  describe('parallel and ordered execution', () => {
    it('runs read-only calls concurrently and returns results in emitted order', async () => {
      const h = harness({ turns: [reply(call('r1', 'read_file', { path: 'package.json' }), call('r2', 'read_file', { path: 'src/math.js' }), call('r3', 'git_status', {})), reply(say('ok'))] })
      const done = await h.send('inspect')
      assert.deepEqual(toolMessages(done).map(m => m.toolCallId), ['r1', 'r2', 'r3'])
      const order = h.events.filter(e => e.type.startsWith('tool.')).map(e => e.type)
      assert.deepEqual(order.slice(0, 3), ['tool.started', 'tool.started', 'tool.started']) // batch started together
      assert.match(toolMessages(done)[2].content, /"clean":true/)
      // next turn sees all three results
      assert.equal(h.provider.requests[1].messages.filter(m => m.role === 'tool').length, 3)
    })

    it('executes modifying calls sequentially in emitted order', async () => {
      const h = harness({
        turns: [reply(
          call('w1', 'write_file', { path: 'o.txt', content: 'one' }),
          call('w2', 'write_file', { path: 'o.txt', content: 'two' }),
          call('w3', 'apply_patch', { patch: '--- a/o.txt\n+++ b/o.txt\n@@ -1 +1 @@\n-two\n+three\n' }),
          call('w4', 'shell', { command: 'cat o.txt' }),
        ), reply(say('ok'))],
      })
      const done = await h.send('go')
      assert.equal(await fs.readFile(path.join(fx.root, 'o.txt'), 'utf8'), 'three\n')
      const seq = h.events.filter(e => e.type === 'tool.started' || e.type === 'tool.completed').map(e => `${e.type}:${e.data.toolCallId}`)
      assert.deepEqual(seq, ['w1', 'w2', 'w3', 'w4'].flatMap(id => [`tool.started:${id}`, `tool.completed:${id}`]))
      assert.match(toolMessages(done)[3].content, /three/)
    })

    it('does not run a read after a write in the same response until the write finishes', async () => {
      const h = harness({
        turns: [reply(call('a', 'read_file', { path: 'src/math.js' }), call('b', 'write_file', { path: 'src/math.js', content: 'NEW\n' }), call('c', 'read_file', { path: 'src/math.js' })), reply(say('ok'))],
      })
      const done = await h.send('go')
      const [first, , last] = toolMessages(done).map(m => m.content)
      assert.match(first, /return a - b/)
      assert.match(last, /NEW/)
    })
  })

  describe('limits and guards', () => {
    it('stops at the turn limit without further provider calls', async () => {
      const h = harness({ turns: (() => { const t = []; for (let i = 0; i < 10; i++) t.push(reply(call(`c${i}`, 'grep', { pattern: `x${i}` }))); return t })() }, { config: { maxTurns: 3 } })
      const done = await h.send('loop')
      assert.equal(h.provider.requests.length, 3)
      assert.equal(done.status, 'error')
      const failed = done.events.find(e => e.type === 'session.failed')
      assert.equal(failed.data.error.code, 'max_turns')
      assert.match(done.messages.at(-1).content, /limit of 3 agent turns.*preserved/)
      assert.equal(done.messages.at(-1).role, 'assistant')
      // history stays valid: every tool call has a result
      assert.equal(toolMessages(done).length, 3)
    })

    it('warns on the third identical call, then stops if the model persists', async () => {
      const same = () => reply(call(`c${Math.random()}`, 'read_file', { path: 'src/math.js' }))
      const h = harness({ turns: Array.from({ length: 10 }, same) })
      const done = await h.send('loop')
      assert.equal(h.provider.requests.length, 4)
      const msgs = toolMessages(done).map(m => m.content)
      assert.match(msgs[0], /Status: ok/)
      assert.match(msgs[2], /Error \[loop_detected\].*Choose a different approach/)
      assert.match(msgs[3], /Error \[loop_detected\]/)
      assert.equal(done.status, 'error')
      assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'loop_detected')
    })

    it('lets the model recover after the warning', async () => {
      const h = harness({
        turns: [
          reply(call('1', 'read_file', { path: 'src/math.js' })), reply(call('2', 'read_file', { path: 'src/math.js' })),
          reply(call('3', 'read_file', { path: 'src/math.js' })), reply(call('4', 'grep', { pattern: 'add' })), reply(say('found it')),
        ],
      })
      const done = await h.send('go')
      assert.equal(done.status, 'completed')
    })

    it('does not flag reads of different ranges or reordered argument keys as identical', async () => {
      const h = harness({
        turns: [
          reply(call('1', 'read_file', { path: 'src/math.js', startLine: 1, endLine: 2 })), reply(call('2', 'read_file', { path: 'src/math.js', startLine: 3, endLine: 4 })),
          reply(call('3', 'read_file', { path: 'src/math.js', startLine: 5, endLine: 6 })), reply(call('4', 'read_file', { endLine: 6, startLine: 5, path: 'src/math.js' })), reply(say('ok')),
        ],
      })
      const done = await h.send('go')
      assert.equal(done.status, 'completed')
      assert.ok(!toolMessages(done).some(m => /loop_detected/.test(m.content)))
    })

    it('stops after consecutive turns in which every tool call failed', async () => {
      const h = harness({ turns: Array.from({ length: 10 }, (_, i) => reply(call(`c${i}`, 'read_file', { path: `nope${i}.js` }))) }, { config: { maxFailedTurns: 3 } })
      const done = await h.send('go')
      assert.equal(h.provider.requests.length, 3)
      assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'no_progress')
    })
  })

  describe('sessions', () => {
    it('rejects a second message while a run is active, without corrupting history', async () => {
      let release
      const gate = new Promise(r => { release = r })
      const h = harness({ turns: [async () => { await gate; return reply(say('done')) }] })
      const first = h.send('one')
      await assert.rejects(h.send('two'), e => e.code === 'session_busy')
      release()
      const done = await first
      assert.deepEqual(done.messages.map(m => [m.role, m.content]), [['user', 'one'], ['assistant', 'done']])
    })

    it('continues the same conversation, workspace and changes across user messages', async () => {
      const h = harness({
        turns: [
          reply(call('c1', 'apply_patch', { patch: FIX_ADD_PATCH })), reply(say('Fixed add.')),
          reply(call('c2', 'write_file', { path: 'tests/extra.test.js', content: '// extra\n' })), reply(say('Added a test.')),
        ],
      })
      await h.send('Fix add')
      const second = await h.send('Also add a regression test')
      assert.equal(second.status, 'completed')
      assert.equal(second.id, h.session.id)
      assert.deepEqual(second.changedFiles.map(f => f.path), ['src/math.js', 'tests/extra.test.js'])
      const req3 = h.provider.requests[2]
      assert.deepEqual(req3.messages.slice(1).map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user'])
      assert.equal(req3.messages.at(-1).content, 'Also add a regression test')
      assert.match(req3.messages[0].content, /Git status: 1 modified/) // context reflects work from the first run
      assert.equal(second.turns.length, 4)
      assert.equal(second.workspaceId, workspace.id)
    })

    it('a new session starts with fresh history, trace and the same workspace', async () => {
      const h = harness({ turns: [reply(say('one')), reply(say('two'))] })
      await h.send('first')
      const fresh = h.runtime.startSession({ workspaceId: workspace.id, model })
      assert.deepEqual([fresh.messages, fresh.turns, fresh.toolCalls, fresh.changedFiles], [[], [], [], []])
      assert.equal(fresh.workspaceId, workspace.id)
      assert.deepEqual(fresh.model, model)
    })
  })

  describe('validation before any request', () => {
    const failedWith = async (h) => (await h.send('go')).events.find(e => e.type === 'session.failed')?.data.error
    it('rejects an unknown provider, missing model, missing credentials and missing workspace', async () => {
      const unknown = harness({ turns: [] })
      unknown.runtime.getSession(unknown.session.id)
      const bad = unknown.runtime.startSession({ model: { provider: 'nope', model: 'x' } })
      assert.equal((await unknown.runtime.sendMessage(bad.id, 'go')).events.find(e => e.type === 'session.failed').data.error.code, 'configuration_error')

      const noModel = createAgentRuntime({ providers: createProviderRegistry([createFakeProvider({ turns: [] })]), config: baseConfig })
      const s = noModel.startSession({ model: { provider: 'fake', model: '' } })
      assert.equal((await noModel.sendMessage(s.id, 'go')).events.find(e => e.type === 'session.failed').data.error.code, 'configuration_error')

      const provider = createFakeProvider({ turns: [], validate() { throw createError({ code: 'configuration_error', message: 'API key is not configured', provider: 'fake' }) } })
      const rt = createAgentRuntime({ providers: createProviderRegistry([provider]), config: baseConfig })
      const s2 = rt.startSession({ model })
      assert.equal((await rt.sendMessage(s2.id, 'go')).events.find(e => e.type === 'session.failed').data.error.message, 'API key is not configured')
      assert.equal(provider.requests.length, 0)

      const h = harness({ turns: [] })
      await wm.closeWorkspace(workspace.id)
      assert.match((await failedWith(h)).message, /Workspace not found/)
      assert.equal(h.provider.requests.length, 0)
    })
  })

  describe('transport retry', () => {
    const rateLimit = () => createError({ code: 'rate_limit', message: 'slow down', provider: 'fake', retryable: true })

    it('retries a retryable failure once and announces it without touching the transcript', async () => {
      const h = harness({ failures: [rateLimit()], turns: [reply(say('ok'))] })
      const done = await h.send('go')
      assert.equal(done.status, 'completed')
      assert.equal(h.provider.requests.length, 2)
      const retry = h.events.find(e => e.type === 'provider.retry')
      assert.deepEqual([retry.data.attempt, retry.data.reason, typeof retry.data.delayMs], [1, 'rate_limit', 'number'])
      assert.deepEqual(done.messages.map(m => m.role), ['user', 'assistant'])
    })

    it('gives up after the configured retries and reports the normalized error', async () => {
      const h = harness({ failures: [rateLimit(), rateLimit(), rateLimit(), rateLimit()], turns: [reply(say('x'))] })
      const done = await h.send('go')
      assert.equal(h.provider.requests.length, 3) // 1 attempt + 2 retries
      assert.equal(done.status, 'error')
      assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'rate_limit')
      assert.equal(h.events.filter(e => e.type === 'provider.retry').length, 2)
    })

    it('does not retry authentication errors or invalid requests', async () => {
      const h = harness({ failures: [createError({ code: 'authentication_error', message: 'bad key', provider: 'fake' })], turns: [reply(say('x'))] })
      const done = await h.send('go')
      assert.equal(h.provider.requests.length, 1)
      assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'authentication_error')
    })

    it('does not retry once content has been streamed, but keeps the partial text', async () => {
      const h = harness({ turns: [async (_req, _n, emit) => { emit(say('partial ')); throw rateLimit() }, reply(say('x'))] })
      const done = await h.send('go')
      assert.equal(h.provider.requests.length, 1)
      assert.equal(done.status, 'error')
      assert.equal(done.messages.at(-1).content, 'partial ')
    })

    it('retries only the failed request, not the session: earlier tool work is untouched', async () => {
      const h = harness({
        turns: [reply(call('c1', 'write_file', { path: 'k.txt', content: 'k' })), async () => { throw rateLimit() }, reply(say('done'))],
      })
      const done = await h.send('go')
      assert.equal(done.status, 'completed')
      assert.equal(h.provider.requests.length, 3)
      assert.equal(toolMessages(done).length, 1) // the write ran exactly once
    })

    it('scrubs secrets from provider errors', async () => {
      const h = harness({ failWith: createError({ code: 'provider_error', message: 'bad Authorization: Bearer sk-abcdef1234567890 for key sk-zzzzzzzzzzzz', provider: 'fake' }) })
      const done = await h.send('go')
      assert.ok(!JSON.stringify(done.events).includes('sk-abcdef'))
      assert.ok(!JSON.stringify(done.events).includes('sk-zzzz'))
    })
  })

  describe('cancellation', () => {
    it('stops provider streaming, keeps partial text, runs no tools, and stays reopenable', async () => {
      let started
      const ready = new Promise(r => { started = r })
      const h = harness({
        turns: [async (req, _n, emit) => {
          emit(say('Looking'))
          started()
          await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
        }, reply(say('back again'))],
      })
      const run = h.send('long task')
      await ready
      h.runtime.cancelSession(h.session.id)
      const done = await run
      assert.equal(done.status, 'cancelled')
      assert.equal(h.provider.requests[0].signal.aborted, true)
      assert.equal(done.toolCalls.length, 0)
      assert.equal(h.types().filter(t => t === 'session.cancelled').length, 1)
      assert.ok(!h.types().includes('session.failed'))
      assert.equal(done.messages.at(-1).content, 'Looking')
      const again = await h.send('continue')
      assert.equal(again.status, 'completed')
    })

    it('aborts a running shell command, keeps prior edits, and skips the remaining calls', async () => {
      const h = harness({
        turns: [reply(call('w', 'write_file', { path: 'kept.txt', content: 'k' }), call('s', 'shell', { command: 'sleep 60' }), call('late', 'write_file', { path: 'late.txt', content: 'x' })), reply(say('unreachable'))],
      })
      const unsub = h.runtime.subscribe(h.session.id, e => { if (e.type === 'tool.started' && e.data.toolCallId === 's') setTimeout(() => h.runtime.cancelSession(h.session.id), 150) })
      const t0 = Date.now()
      const done = await h.send('go')
      unsub()
      assert.ok(Date.now() - t0 < 5000)
      assert.equal(done.status, 'cancelled')
      assert.equal(h.provider.requests.length, 1)
      assert.equal(await workspace.exists('kept.txt'), true)
      assert.equal(await workspace.exists('late.txt'), false)
      assert.deepEqual(done.toolCalls.map(c => [c.id, c.status]), [['w', 'completed'], ['s', 'cancelled'], ['late', 'cancelled']])
      // every tool call has a result so the next provider request is well-formed
      assert.deepEqual(toolMessages(done).map(m => m.toolCallId), ['w', 's', 'late'])
      assert.deepEqual(done.changedFiles, [{ path: 'kept.txt', action: 'created' }])
      assert.ok(h.types().includes('session.cancelled'))
      // the user can inspect the diff and continue
      assert.equal((await workspace.gitDiff()).files.length, 1)
      const next = await h.send('carry on')
      assert.equal(next.status, 'completed')
    })
  })
})
