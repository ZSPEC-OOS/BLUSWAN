import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider } from './testing/fakeProvider.js'
import { createError } from '../protocol/schemas.js'
import { composeStopConditions, maxTurns, userCancelled, unrecoverableError } from './stopConditions.js'
import { buildSystemPrompt } from './systemPrompt.js'

const model = { provider: 'fake', model: 'm1' }
const config = { maxTurns: 5, temperature: 0, maxOutputTokens: 100 }

function setup(opts) {
  const provider = createFakeProvider(opts)
  const runtime = createAgentRuntime({ providers: createProviderRegistry([provider]), config })
  const events = []
  runtime.subscribe(e => events.push(e.type))
  return { provider, runtime, events }
}

describe('agent runtime', () => {
  it('starts a session and emits session.started', () => {
    const { runtime, events } = setup()
    const s = runtime.startSession({ model })
    assert.equal(s.status, 'idle')
    assert.deepEqual(events, ['session.started'])
  })

  it('runs a turn through the provider and emits normalized events', async () => {
    const { runtime, events, provider } = setup({
      script: [{ type: 'text_delta', text: 'Inspecting ' }, { type: 'text_delta', text: 'repository...' },
        { type: 'usage', input: 3, output: 4, total: 7 }, { type: 'completed', finishReason: 'stop' }],
    })
    const s = runtime.startSession({ model })
    const done = await runtime.sendMessage(s.id, 'Fix the auth race.')
    assert.deepEqual(events, [
      'session.started', 'user.message', 'session.updated',
      'assistant.text.delta', 'assistant.text.delta', 'assistant.text.completed', 'session.updated',
    ])
    assert.equal(done.status, 'idle')
    assert.deepEqual(done.messages.map(m => [m.role, m.content]),
      [['user', 'Fix the auth race.'], ['assistant', 'Inspecting repository...']])
    assert.deepEqual(done.tokenUsage, { input: 3, output: 4, total: 7 })
    assert.equal(provider.requests[0].messages[0].role, 'system')
    assert.equal(provider.requests[0].model, 'm1')
  })

  it('transitions through running and continues the same session', async () => {
    const { runtime, provider } = setup({ script: [{ type: 'text_delta', text: 'ok' }, { type: 'completed', finishReason: 'stop' }] })
    const statuses = []
    runtime.subscribe((e, s) => { if (e.type === 'session.updated') statuses.push(s.status) })
    const s = runtime.startSession({ model })
    await runtime.sendMessage(s.id, 'one')
    await runtime.sendMessage(s.id, 'two')
    assert.deepEqual(statuses, ['running', 'idle', 'running', 'idle'])
    assert.equal(provider.requests[1].messages.filter(m => m.role === 'user').length, 2)
  })

  it('rejects overlapping and empty messages', async () => {
    const { runtime } = setup({ hang: true })
    const s = runtime.startSession({ model })
    const p = runtime.sendMessage(s.id, 'a')
    await assert.rejects(runtime.sendMessage(s.id, 'b'), /cannot accept/)
    runtime.cancelSession(s.id)
    await p
    await assert.rejects(runtime.sendMessage(s.id, '  '), /cannot accept|required/)
  })

  it('reports provider failures as session.failed with a normalized error', async () => {
    const err = createError({ code: 'rate_limit', message: 'slow down', provider: 'fake', retryable: true })
    const { runtime, events } = setup({ failWith: err })
    const s = runtime.startSession({ model })
    const done = await runtime.sendMessage(s.id, 'go')
    assert.equal(done.status, 'error')
    assert.ok(events.includes('session.failed'))
    const failed = done.events.find(e => e.type === 'session.failed')
    assert.equal(failed.data.error.code, 'rate_limit')
    assert.equal(failed.data.error.retryable, true)
    // the session remains usable after a failure
    const again = await runtime.sendMessage(s.id, 'retry').catch(e => e)
    assert.ok(again.status === 'error')
  })

  it('wraps unknown exceptions as runtime_error', async () => {
    const { runtime } = setup({ failWith: new Error('kaboom') })
    const s = runtime.startSession({ model })
    const done = await runtime.sendMessage(s.id, 'go')
    assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'runtime_error')
  })

  it('fails with configuration_error for an unknown provider', async () => {
    const { runtime } = setup()
    const s = runtime.startSession({ model: { provider: 'nope', model: 'x' } })
    const done = await runtime.sendMessage(s.id, 'go')
    assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'configuration_error')
  })

  it('treats a tool call as invalid_response while no tools are offered', async () => {
    const { runtime } = setup({ script: [{ type: 'tool_call', id: '1', name: 'read_file', arguments: {} }, { type: 'completed', finishReason: 'tool_calls' }] })
    const s = runtime.startSession({ model })
    const done = await runtime.sendMessage(s.id, 'go')
    assert.equal(done.events.find(e => e.type === 'session.failed').data.error.code, 'invalid_response')
  })

  it('cancels an in-flight request', async () => {
    const { runtime, events, provider } = setup({ hang: true })
    const s = runtime.startSession({ model })
    const p = runtime.sendMessage(s.id, 'long task')
    await new Promise(r => setImmediate(r))
    assert.equal(provider.requests[0].signal.aborted, false)
    runtime.cancelSession(s.id)
    const done = await p
    assert.equal(provider.requests[0].signal.aborted, true)
    assert.equal(done.status, 'cancelled')
    assert.equal(events.filter(e => e === 'session.cancelled').length, 1)
    assert.ok(!events.includes('session.failed'))
  })

  it('cancels an idle session', () => {
    const { runtime, events } = setup()
    const s = runtime.startSession({ model })
    assert.equal(runtime.cancelSession(s.id).status, 'cancelled')
    assert.ok(events.includes('session.cancelled'))
  })

  it('completeSession emits session.completed', () => {
    const { runtime, events } = setup()
    const s = runtime.startSession({ model })
    assert.equal(runtime.completeSession(s.id).status, 'completed')
    assert.ok(events.includes('session.completed'))
  })
})

describe('stop conditions and prompt', () => {
  it('composes conditions in order', () => {
    const stop = composeStopConditions(userCancelled(), maxTurns(2), unrecoverableError())
    assert.equal(stop({ turnCount: 0 }), null)
    assert.equal(stop({ turnCount: 2 }).reason, 'max_turns')
    const ac = new AbortController(); ac.abort()
    assert.equal(stop({ turnCount: 5, signal: ac.signal }).reason, 'cancelled')
    assert.equal(stop({ turnCount: 0, error: { retryable: false } }).reason, 'provider_failure')
    assert.equal(stop({ turnCount: 0, error: { retryable: true } }), null)
  })
  it('has a single canonical prompt', () => {
    assert.match(buildSystemPrompt(), /^You are BLUSWAN/)
  })
})
