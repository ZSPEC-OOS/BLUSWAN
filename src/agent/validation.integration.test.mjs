// Acceptance: bug → wrong patch → automatic focused validation fails → classified evidence enters
// context → repair → revalidation → broader lint/build → git evidence → grounded final answer.
// Real runtime, sessions, context engine (under budget pressure), tools, validation engine, workspace, git.
// Only the model is scripted. Offline.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { BUG_PROJECT } from '../validation/testing/fixtures.js'
import { createTokenEstimator } from '../context/tokenEstimator.js'
import { validateHistory } from '../context/conversationContext.js'

const WINDOW = 5_000
const OUT = 500
const NOISY_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from '../src/math.js'

for (let i = 0; i < 600; i++) console.log(\`noise line \${i} \${'.'.repeat(60)}\`)

test('add', () => { assert.equal(add(2, 3), 5) })
test('multiply', () => { assert.equal(multiply(2, 3), 6) })
`
const patch = (from, to) => `--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a ${from} b\n+  return a ${to} b\n }\n`

describe('Acceptance: self-correcting run under context pressure', () => {
  let fx, wm, runtime, session, events, requests, estimator
  before(async () => {
    fx = await createFixtureRepo({ files: { ...BUG_PROJECT, 'tests/math.test.js': NOISY_TEST } })
    wm = createNodeWorkspaceManager()
    estimator = createTokenEstimator()
    requests = []
    const script = [
      () => reply(say('I will look at the implementation and its tests.'), call('c1', 'read_many_files', { paths: ['src/math.js', 'tests/math.test.js'] })),
      () => reply(call('c2', 'apply_patch', { patch: patch('-', '*') })), // first (wrong) attempt
      () => reply(say('I changed add() to fix the bug.')), // → runtime validates: fails
      (req) => {
        const evidence = req.messages.at(-1).content
        assert.match(evidence, /FAILED \[test_failure\]: 1 test failed, 1 passed/)
        assert.ok(evidence.length < 4_500, 'failure evidence is bounded despite 600 noisy lines')
        assert.match(req.messages[0].content, /VALIDATION STATE: FAILED/)
        return reply(say('The test shows add(2, 3) returned 6; it should add.'), call('c3', 'apply_patch', { patch: patch('*', '+') }))
      },
      () => reply(say('Corrected the operator.')), // → focused test, lint, build
      (req) => {
        const evidence = req.messages.at(-1).content
        assert.match(evidence, /Status: passed/)
        assert.match(evidence, /✓ node --test tests\/math\.test\.js \(focused test\)[\s\S]*✓ npm run lint[\s\S]*✓ npm run build/)
        assert.match(evidence, /Git:\n- 1 files changed \(\+1 −1\)/)
        // the earlier failing validation log is compacted, but the resolved state is explicit
        const old = req.messages.filter(m => m.role === 'tool' && m.name === 'validation')
        assert.equal(old.length, 2)
        assert.ok(old[0].content.length < 800, `old validation log should be compact (${old[0].content.length})`)
        assert.match(old[0].content, /node --test tests\/math\.test\.js failed \[test_failure\]/)
        assert.match(req.messages[0].content, /VALIDATION STATE: PASSED/)
        assert.ok(!/UNRESOLVED/.test(req.messages[0].content), 'resolved failure is downgraded')
        return reply(say('Fixed add() in src/math.js (it subtracted). Validation: the focused math test, lint and build all pass.'))
      },
    ]
    const provider = createFakeProvider({
      capabilities: { contextWindow: WINDOW, maxOutputTokens: OUT },
      respond: (req, n) => { requests.push(req); return script[n - 1](req) },
    })
    runtime = createAgentRuntime({
      providers: createProviderRegistry([provider]), workspaces: wm, sleep: async () => {},
      config: { ...loadRuntimeConfig({}), maxOutputTokens: OUT, contextSafetyMarginTokens: 200, maxToolContextTokens: 700, minRecentExchanges: 0 },
    })
    const ws = await wm.openWorkspace({ root: fx.root })
    session = runtime.startSession({ workspaceId: ws.id, model: { provider: 'fake', model: 'scripted' } })
    events = []
    runtime.subscribe(session.id, e => events.push(e))
  })
  after(() => fx.cleanup())

  it('edits, validates, repairs, revalidates, escalates, and ends with a grounded success', async () => {
    const done = await runtime.sendMessage(session.id, 'Fix the bug in add() in src/math.js.')
    assert.equal(done.status, 'completed', JSON.stringify(done.events.find(e => e.type === 'session.failed')))
    assert.equal(requests.length, 6)

    const run = done.runs.at(-1)
    assert.equal(run.outcome, 'success')
    assert.equal(run.validation.firstPassSuccess, false)
    assert.equal(run.validation.repairSuccess, true)
    assert.equal(run.validation.finalValidationStatus, 'passed')
    assert.deepEqual(run.warnings, [])

    const completed = events.filter(e => e.type === 'validation.completed').map(e => `${e.data.kind}:${e.data.status}`)
    assert.deepEqual(completed, ['test:failed', 'test:passed', 'lint:passed', 'build:passed'])
    assert.equal(events.at(-1).type, 'session.completed')
    assert.equal(done.messages.at(-1).role, 'assistant')
    assert.match(done.messages.at(-1).content, /lint and build all pass/)
  })

  it('kept every request within the context budget with valid tool structure', () => {
    for (const req of requests) {
      const budget = WINDOW - OUT - 200 - estimator.estimateToolSchemaTokens(req.tools)
      assert.ok(estimator.estimateContextTokens(req.messages) <= budget)
      validateHistory(req.messages.slice(1))
    }
    assert.ok(runtime.getSession(session.id).contextStats.compactionCount > 0, 'noisy validation output forced compaction')
  })

  it('ended with independently verifiable repository state', async () => {
    const ws = wm.getWorkspace(runtime.getSession(session.id).workspaceId)
    const diff = await ws.gitDiff()
    assert.deepEqual(diff.files.map(f => [f.path, f.additions, f.deletions]), [['src/math.js', 1, 1]])
    assert.ok(diff.diff.includes('-  return a - b\n+  return a + b'))
    assert.equal((await ws.runCommand('npm test')).exitCode, 0)
    assert.deepEqual((await ws.gitStatus()).modified, ['src/math.js'])
  })

  it('never mutated git or installed anything on its own', () => {
    const s = runtime.getSession(session.id)
    const shells = s.toolCalls.filter(c => c.name === 'shell')
    assert.equal(shells.length, 0) // every check was run by the validation engine, none through arbitrary shell
    assert.ok(!events.some(e => e.type === 'validation.started' && /install|push|commit|reset|checkout|--fix|--write/.test(e.data.command)))
  })
})
