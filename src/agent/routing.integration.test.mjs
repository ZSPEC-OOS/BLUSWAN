// Adaptive routing through the real runtime: per-request routing, run stickiness, manual overrides, one-way
// escalation at a turn boundary, cancellation, persistence of the preference, and legacy compatibility.
// Only the models are scripted (two fake providers stand in for the Flash and Pro profiles).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from './testing/fakeProvider.js'
import { createRouting } from './routingBridge.js'
import { parseRoutingEnv } from '../config/routingConfig.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { serializeSession, toRuntimeSession, validateRecord } from '../persistence/serializer.js'

const ROUTING_ENV = { BLUSWAN_FAST_PROVIDER: 'fake-fast', BLUSWAN_FAST_MODEL: 'flash-1', BLUSWAN_ADVANCED_PROVIDER: 'fake-pro', BLUSWAN_ADVANCED_MODEL: 'pro-1' }
const SIMPLE = 'Fix the typo in README.md.'
const HARD = 'Refactor the entire codebase across all modules to use the new data model.'

function setup({ fast = {}, pro = {}, configured = () => true, env = ROUTING_ENV, classifier = null } = {}) {
  const fastP = createFakeProvider({ id: 'fake-fast', respond: () => reply(say('fast answer')), ...fast })
  const proP = createFakeProvider({ id: 'fake-pro', respond: () => reply(say('pro answer')), ...pro })
  const providers = createProviderRegistry([fastP, proP])
  if (classifier) fastP.classifierText = classifier
  const parsed = parseRoutingEnv(env, { knownProviders: ['fake-fast', 'fake-pro'] })
  const routing = createRouting({ routing: parsed, providers, isConfigured: configured })
  const runtime = createAgentRuntime({ providers, routing, config: loadRuntimeConfig({}) })
  const events = []
  runtime.subscribe((e) => events.push(e))
  return { runtime, fastP, proP, events, routing }
}
const start = (runtime, modelPreference) => runtime.startSession({ model: { provider: 'fake-fast', model: 'flash-1' }, modelPreference })
const types = (events, t) => events.filter(e => e.type === t)

describe('routing at request start', () => {
  it('Auto sends a simple request to Flash and a hard one to Pro, independently per request', async () => {
    const { runtime, fastP, proP, events } = setup()
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, SIMPLE)
    assert.deepEqual([fastP.requests.length, proP.requests.length], [1, 0])
    await runtime.sendMessage(s.id, HARD)
    assert.deepEqual([fastP.requests.length, proP.requests.length], [1, 1])
    await runtime.sendMessage(s.id, SIMPLE)
    assert.deepEqual([fastP.requests.length, proP.requests.length], [2, 1])
    const sel = types(events, 'model.route.selected').map(e => e.data)
    assert.deepEqual(sel.map(d => [d.mode, d.tier, d.provider, d.model, d.source]), [
      ['auto', 'fast', 'fake-fast', 'flash-1', 'deterministic'], ['auto', 'advanced', 'fake-pro', 'pro-1', 'deterministic'], ['auto', 'fast', 'fake-fast', 'flash-1', 'deterministic'],
    ])
    assert.ok(sel.every(d => Array.isArray(d.reasonCodes) && d.reasonCodes.length && d.reasoningEffort === 'high'))
    assert.equal(proP.requests[0].reasoningEffort, 'high')
    assert.equal(runtime.getSession(s.id).modelPreference, 'auto')
  })

  it('records a safe per-run route summary with usage per segment', async () => {
    const { runtime } = setup()
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, HARD)
    const run = runtime.getSession(s.id).runs[0]
    assert.deepEqual([run.route.requestedMode, run.route.initialTier, run.route.finalTier, run.route.escalated], ['auto', 'advanced', 'advanced', false])
    assert.equal(run.route.segments.length, 1)
    assert.deepEqual([run.route.segments[0].model, run.route.segments[0].turns, run.route.segments[0].input, run.route.segments[0].output], ['pro-1', 1, 10, 5])
    assert.equal(run.route.classifier.used, false)
    assert.ok(!JSON.stringify(run.route).includes('README'))
  })

  it('manual Flash and Pro are absolute: no scoring, no escalation, no events beyond the selection', async () => {
    const { runtime, fastP, proP, events } = setup()
    const a = start(runtime, 'fast'); const b = start(runtime, 'advanced')
    await runtime.sendMessage(a.id, HARD)
    await runtime.sendMessage(b.id, SIMPLE)
    assert.deepEqual([fastP.requests.length, proP.requests.length], [1, 1])
    assert.deepEqual(types(events, 'model.route.selected').map(e => [e.data.mode, e.data.source]), [['fast', 'manual'], ['advanced', 'manual']])
    assert.equal(types(events, 'model.route.escalated').length, 0)
  })

  it('a legacy manual session (no preference) runs its chosen model and emits no route events', async () => {
    const { runtime, fastP, proP, events } = setup()
    const s = runtime.startSession({ model: { provider: 'fake-pro', model: 'pro-1' } })
    assert.equal(s.modelPreference, null)
    await runtime.sendMessage(s.id, SIMPLE)
    assert.deepEqual([fastP.requests.length, proP.requests.length], [0, 1])
    assert.equal(types(events, 'model.route.selected').length, 0)
    assert.equal(proP.requests[0].reasoningEffort, undefined)
    assert.equal(runtime.getSession(s.id).runs[0].route, undefined)
  })

  it('setModelPreference switches modes between runs; an explicit model makes the session manual', async () => {
    const { runtime } = setup()
    const s = start(runtime, null)
    runtime.setModelPreference(s.id, 'advanced')
    assert.deepEqual([runtime.getSession(s.id).modelPreference, runtime.getSession(s.id).model.model], ['advanced', 'pro-1'])
    runtime.setModelPreference(s.id, 'auto')
    assert.equal(runtime.getSession(s.id).modelPreference, 'auto')
    runtime.setSessionModel(s.id, { provider: 'fake-fast', model: 'flash-1' })
    assert.equal(runtime.getSession(s.id).modelPreference, null)
    assert.throws(() => runtime.setModelPreference(s.id, 'turbo'), e => e.code === 'invalid_request')
  })

  it('classifies gray requests on the Fast profile with no tools, and records classifier usage separately', async () => {
    const verdict = '{"route":"advanced","confidence":0.9,"scope":"broad","risk":"medium"}'
    const { runtime, fastP, proP } = setup({
      fast: { respond: (req) => (req.metadata?.purpose === 'routing' ? [say(verdict), { type: 'usage', input: 40, output: 9 }, { type: 'completed', finishReason: 'stop' }] : reply(say('fast'))) },
    })
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, 'Improve the error handling in the sync module and clean up anything weird.')
    const cls = fastP.requests[0]
    assert.deepEqual([cls.metadata.purpose, cls.tools, cls.reasoningEffort, cls.maxOutputTokens], ['routing', [], 'off', 120])
    assert.equal(proP.requests.length, 1)
    const run = runtime.getSession(s.id).runs[0]
    assert.deepEqual([run.route.source, run.route.classifier.outcome, run.route.classifier.usage.input, run.route.segments[0].input], ['classifier', 'ok', 40, 10])
  })

  it('falls back to Pro when the classifier fails, without failing the request', async () => {
    const { runtime, proP } = setup({ fast: { respond: () => { throw new Error('classifier down') } } })
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, 'Improve the error handling in the sync module and clean up anything weird.')
    assert.equal(proP.requests.length, 1)
    assert.equal(runtime.getSession(s.id).runs[0].route.reasonCodes[0], 'classifier_unavailable')
  })
})

describe('no silent substitution', () => {
  it('Pro unavailable: Auto and Pro fail clearly and never run Flash instead', async () => {
    const { runtime, fastP, events } = setup({ configured: (p) => p !== 'fake-pro' })
    assert.throws(() => runtime.setModelPreference(start(runtime, null).id, 'auto'), e => e.code === 'configuration_error')
    const s = start(runtime, 'advanced')
    await runtime.sendMessage(s.id, SIMPLE)
    assert.equal(fastP.requests.length, 0)
    assert.equal(runtime.getSession(s.id).status, 'error')
    assert.equal(types(events, 'session.failed').at(-1).data.error.code, 'configuration_error')
  })
  it('Flash unavailable: Flash fails clearly and never spends Pro', async () => {
    const { runtime, proP } = setup({ configured: (p) => p !== 'fake-fast' })
    const s = start(runtime, 'fast')
    await runtime.sendMessage(s.id, SIMPLE)
    assert.equal(proP.requests.length, 0)
    assert.equal(runtime.getSession(s.id).status, 'error')
  })
  it('a session preferring Auto on a server without routing fails clearly', async () => {
    const fastP = createFakeProvider({ id: 'fake-fast', respond: () => reply(say('x')) })
    const runtime = createAgentRuntime({ providers: createProviderRegistry([fastP]), config: loadRuntimeConfig({}) })
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, SIMPLE)
    assert.equal(fastP.requests.length, 0)
    assert.equal(runtime.getSession(s.id).status, 'error')
  })
})

describe('escalation', () => {
  // Flash keeps issuing a tool call that fails each turn (no workspace) → no progress → escalate once.
  const failing = (n) => reply(say(`trying ${n}`), call(`c${n}`, 'read_file', { path: `missing-${n}.txt` }))
  it('moves a Flash run to Pro once, at a turn boundary, preserving history', async () => {
    const { runtime, fastP, proP, events } = setup({
      fast: { respond: (req, n) => failing(n) },
      pro: { respond: () => reply(say('pro finished')) },
    })
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, SIMPLE)
    const esc = types(events, 'model.route.escalated')
    assert.equal(esc.length, 1)
    assert.deepEqual([esc[0].data.from, esc[0].data.to, esc[0].data.model, esc[0].data.reasonCode, esc[0].data.reasoningEffort], ['fast', 'advanced', 'pro-1', 'repeated_tool_failures', 'high'])
    assert.equal(fastP.requests.length, 3) // no Flash turn after escalation
    assert.equal(proP.requests.length, 1)
    // the Pro request sees the full conversation, including the earlier tool calls and results (nothing is replayed)
    const seen = proP.requests[0].messages
    assert.equal(seen.filter(m => m.role === 'tool').length, 3)
    assert.equal(seen.filter(m => m.toolCalls?.length).length, 3)
    const session = runtime.getSession(s.id)
    assert.equal(session.status, 'completed')
    assert.equal(session.model.model, 'pro-1')
    const run = session.runs[0]
    assert.deepEqual([run.route.initialTier, run.route.finalTier, run.route.escalated, run.route.escalationReason], ['fast', 'advanced', true, 'repeated_tool_failures'])
    assert.deepEqual(run.route.segments.map(x => [x.tier, x.turns]), [['fast', 3], ['advanced', 1]])
    // ordering: selected → ... → escalated → last turn
    const order = events.map(e => e.type).filter(t => ['model.route.selected', 'model.route.escalated', 'session.completed'].includes(t))
    assert.deepEqual(order, ['model.route.selected', 'model.route.escalated', 'session.completed'])
  })

  it('the next request is routed afresh (no sticky Pro across requests)', async () => {
    const { runtime, fastP } = setup({ fast: { respond: (req, n) => (n <= 3 ? failing(n) : reply(say('fast again'))) } })
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, SIMPLE)
    await runtime.sendMessage(s.id, 'Update the copyright year in README.md.')
    assert.equal(fastP.requests.length, 4)
    assert.equal(runtime.getSession(s.id).runs[1].route.initialTier, 'fast')
  })

  it('never escalates manual Flash or Pro runs', async () => {
    const { runtime, proP, events } = setup({ fast: { respond: (req, n) => (n <= 4 ? failing(n) : reply(say('done'))) } })
    const s = start(runtime, 'fast')
    await runtime.sendMessage(s.id, SIMPLE)
    assert.equal(types(events, 'model.route.escalated').length, 0)
    assert.equal(proP.requests.length, 0)
  })

  it('if Pro becomes unavailable when escalation is required, the run fails clearly and preserves completed work', async () => {
    const { runtime, fastP, proP, events } = setup({
      configured: () => true,
      fast: { respond: (req, n) => failing(n) },
      pro: { validate() { throw new Error('no pro key') } },
    })
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, SIMPLE)
    const session = runtime.getSession(s.id)
    const failed = types(events, 'session.failed').at(-1)
    assert.equal(types(events, 'model.route.escalated').length, 0)
    assert.equal(proP.requests.length, 0)
    assert.equal(fastP.requests.length, 3) // no fourth Flash turn after BLUSWAN decides Pro is required
    assert.equal(session.status, 'error')
    assert.equal(failed.data.error.code, 'configuration_error')
    assert.match(failed.data.error.message, /needs Pro.*unavailable/i)
    assert.equal(session.toolCalls.length, 3) // completed work/evidence is preserved; nothing is replayed
    assert.deepEqual(
      [
        session.runs[0].route.initialTier,
        session.runs[0].route.finalTier,
        session.runs[0].route.escalated,
        session.runs[0].route.escalationReason,
        session.runs[0].route.escalationRequired,
        session.runs[0].route.escalationFailureReason,
      ],
      ['fast', 'fast', false, 'repeated_tool_failures', true, 'advanced_unavailable'],
    )
  })

  it('cancelling stops the run with no further provider calls, including after a would-be escalation', async () => {
    let runtimeRef; let sid
    const { runtime, fastP, proP } = setup({
      fast: { respond: (req, n) => { if (n === 3) runtimeRef.cancelSession(sid); return failing(n) } },
    })
    runtimeRef = runtime
    const s = start(runtime, 'auto'); sid = s.id
    await runtime.sendMessage(s.id, SIMPLE)
    assert.equal(runtime.getSession(s.id).status, 'cancelled')
    assert.equal(proP.requests.length, 0)
    assert.equal(fastP.requests.length, 3)
  })

  it('cancelling during classification makes no provider call afterwards', async () => {
    let calls = 0
    const { runtime, proP } = setup({ fast: { respond: ({ signal }) => { calls += 1; return new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) } } })
    const s = start(runtime, 'auto')
    const p = runtime.sendMessage(s.id, 'Improve the error handling in the sync module and clean up anything weird.')
    await new Promise(r => setTimeout(r, 20))
    runtime.cancelSession(s.id)
    await p
    assert.equal(runtime.getSession(s.id).status, 'cancelled')
    assert.deepEqual([calls, proP.requests.length], [1, 0])
  })
})

describe('persistence of the preference', () => {
  it('round-trips modelPreference; records without it restore as manual', async () => {
    const { runtime } = setup()
    const s = start(runtime, 'auto')
    await runtime.sendMessage(s.id, SIMPLE)
    const rec = validateRecord(JSON.parse(JSON.stringify(serializeSession(runtime.getSession(s.id), { userId: 'u1' }))))
    assert.equal(rec.modelPreference, 'auto')
    assert.equal(toRuntimeSession(rec).modelPreference, 'auto')
    assert.ok(rec.runs[0].route.segments.length)
    const legacy = { ...rec }; delete legacy.modelPreference
    assert.equal(toRuntimeSession(validateRecord(legacy)).modelPreference, null)
    assert.throws(() => validateRecord({ ...rec, modelPreference: 'turbo' }))
  })
})
