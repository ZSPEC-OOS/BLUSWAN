// The evaluation harness itself, offline: scripted reference answers must satisfy every task's objective check,
// metrics are raw measurements, and a model that does nothing must FAIL (the check is not "the model said so").
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runEvalTask, runEval, countDuplicateCalls, formatResults } from './harness.js'
import { TASKS } from './tasks.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../agent/testing/fakeProvider.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const scriptedProvider = (turns) => {
  let n = 0
  return createFakeProvider({ id: 'fake', respond: () => {
    const t = turns[n++] ?? { text: 'done' }
    return reply(...(t.text ? [say(t.text)] : []), ...(t.calls ?? []).map(c => call(c.id, c.name, c.input)))
  } })
}
const config = { ...loadRuntimeConfig({}) }

describe('evaluation harness', () => {
  for (const task of TASKS) {
    it(`reference answer for "${task.id}" passes its objective check`, async () => {
      const r = await runEvalTask({ task, model: { provider: 'fake', model: 'm' }, providers: createProviderRegistry([scriptedProvider(task.reference())]), config })
      assert.equal(r.success, true, JSON.stringify(r))
      assert.equal(r.sessionStatus, 'completed')
      assert.deepEqual(r.changedFiles.sort(), [...task.expectedFiles].sort())
      assert.equal(r.unnecessaryFilesChanged, 0)
      assert.ok(r.turns >= 3 && r.toolCalls >= 2 && r.tokens.total > 0 && r.durationMs >= 0)
    })
  }
  it('a model that changes nothing fails, regardless of what it claims', async () => {
    const r = await runEvalTask({ task: TASKS[0], model: { provider: 'fake', model: 'm' }, providers: createProviderRegistry([scriptedProvider([{ text: 'All fixed, trust me.' }])]), config })
    assert.equal(r.success, false); assert.equal(r.filesChanged, 0)
  })
  it('counts unnecessary file changes and duplicate tool calls', async () => {
    const turns = [{ calls: [{ id: 'a', name: 'read_file', input: { path: 'src/math.js' } }] }, { calls: [{ id: 'b', name: 'read_file', input: { path: 'src/math.js' } }, { id: 'c', name: 'write_file', input: { path: 'NOTES.md', content: 'x' } }] }, { text: 'done' }]
    const r = await runEvalTask({ task: TASKS[0], model: { provider: 'fake', model: 'm' }, providers: createProviderRegistry([scriptedProvider(turns)]), config })
    assert.equal(r.unnecessaryFilesChanged, 1); assert.ok(r.duplicateToolCalls >= 1)
    assert.equal(countDuplicateCalls([{ name: 'x', input: { a: 1 } }, { name: 'x', input: { a: 1 } }, { name: 'x', input: { a: 2 } }]), 1)
  })
  it('reports raw rows without ranking', async () => {
    const results = await runEval({ tasks: TASKS.slice(0, 2), model: { provider: 'fake', model: 'm' }, providers: createProviderRegistry([scriptedProvider([])]), config })
    const text = formatResults(results)
    assert.match(text, /task\s+model\s+result/); assert.doesNotMatch(text, /winner|rank|score/i)
    assert.equal(results.length, 2)
  })
})

describe('routing comparison', () => {
  it('runs the same tasks forced Flash, forced Pro and Auto, recording the route taken and raw outcomes', async () => {
    const { runRoutingComparison, formatRoutingComparison } = await import('./routingEval.js')
    const { createRouting } = await import('../agent/routingBridge.js')
    const { parseRoutingEnv } = await import('../config/routingConfig.js')
    const mk = (id) => { const t = TASKS[0].reference(); let n = 0; return createFakeProvider({ id, respond: () => { const x = t[n++] ?? { text: 'done' }; return reply(...(x.text ? [say(x.text)] : []), ...(x.calls ?? []).map(c => call(c.id, c.name, c.input))) } }) }
    // a fresh provider pair per row so every row starts its script from the beginning
    const results = []
    for (const mode of ['fast', 'advanced', 'auto']) {
      const providers = createProviderRegistry([mk('fake-fast'), mk('fake-pro')])
      const routing = createRouting({ routing: parseRoutingEnv({ BLUSWAN_FAST_PROVIDER: 'fake-fast', BLUSWAN_FAST_MODEL: 'f', BLUSWAN_ADVANCED_PROVIDER: 'fake-pro', BLUSWAN_ADVANCED_MODEL: 'p' }, { knownProviders: ['fake-fast', 'fake-pro'] }), providers, isConfigured: () => true })
      results.push(...await runRoutingComparison({ tasks: [TASKS[0]], routing, providers, modes: [mode], config }))
    }
    assert.deepEqual(results.map(r => r.mode), ['fast', 'advanced', 'auto'])
    assert.ok(results.every(r => r.success), JSON.stringify(results.map(r => [r.mode, r.success])))
    assert.deepEqual(results.slice(0, 2).map(r => r.route.finalTier), ['fast', 'advanced'])
    assert.ok(['fast', 'advanced'].includes(results[2].route.finalTier))
    assert.deepEqual(results.map(r => r.route.requestedMode), ['fast', 'advanced', 'auto'])
    const text = formatRoutingComparison(results)
    assert.match(text, /task\s+mode\s+result\s+route/); assert.doesNotMatch(text, /winner|rank|score/i)
  })
})
