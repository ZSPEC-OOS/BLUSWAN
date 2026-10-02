// End-to-end: a long scripted session through the real runtime, session manager, context
// engine, tool executor, workspace and event protocol. Only the model is scripted.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIXTURE_FILES, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { validateHistory } from '../context/conversationContext.js'
import { createTokenEstimator } from '../context/tokenEstimator.js'
import { fileBody } from '../context/testing/simulator.js'

const WINDOW = 7_200
const OUT = 500
const GOAL = 'Fix add() in src/math.js so the tests pass, and review the helper modules in src/lib. Do not change the public API of multiply().'
const FOLLOW_UP = 'Also add a regression test for add(). Do not touch src/index.js.'

function repoFiles() {
  const files = { ...FIXTURE_FILES, 'AGENTS.md': '# Engineering notes\nPrefer small patches. Run `npm test` before finishing.\n', '.env': 'SECRET_TOKEN=super-secret-value\n' }
  for (let i = 0; i < 14; i++) files[`src/lib/mod${i}.js`] = `${fileBody(`mod${i}`, 170)}\n`
  return files
}

describe('Acceptance: long session with compaction, scripted model only', () => {
  let fx, wm, runtime, provider, session, requests, events, estimator
  before(async () => {
    fx = await createFixtureRepo({ files: repoFiles() })
    wm = createNodeWorkspaceManager()
    estimator = createTokenEstimator()
    requests = []
    const first = []
    first.push(() => reply(say('I will start by locating the modules.'), call('c0', 'search_files', { query: 'mod' })))
    for (let i = 0; i < 14; i++) first.push(() => reply(call(`r${i}`, 'read_file', { path: `src/lib/mod${i}.js` })))
    first.push(() => reply(call('s1', 'shell', { command: 'ls src/lib' })))
    first.push(() => reply(call('r-math', 'read_file', { path: 'src/math.js' })))
    first.push(() => reply(call('p1', 'apply_patch', { patch: FIX_ADD_PATCH })))
    first.push(() => reply(call('w1', 'write_file', { path: 'src/lib/helper.js', content: 'export const helper = 1\n' })))
    first.push(() => reply(call('t1', 'shell', { command: 'npm test' })))
    first.push(() => reply(say('Fixed add() and ran npm test: passing.')))

    const second = [
      () => reply(call('g1', 'git_status', {})),
      () => reply(call('w2', 'write_file', { path: 'tests/add.test.js', content: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/math.js'\ntest('add regression', () => assert.equal(add(1, 2), 3))\n" })),
      () => reply(call('t2', 'shell', { command: 'node --test tests/add.test.js' })),
      () => reply(say('Added the regression test; it passes.')),
    ]
    const script = [...first, ...second]
    provider = createFakeProvider({
      capabilities: { contextWindow: WINDOW, maxOutputTokens: OUT },
      respond: (req, n) => { requests.push(req); return script[n - 1](req) },
    })
    const config = {
      ...loadRuntimeConfig({}), maxOutputTokens: OUT, contextSafetyMarginTokens: 200, maxTurns: 100,
      minRecentExchanges: 0, maxToolContextTokens: 1_500, maxRepositoryContextTokens: 500, maxSummaryTokens: 1_200,
    }
    runtime = createAgentRuntime({ providers: createProviderRegistry([provider]), workspaces: wm, config, sleep: async () => {} })
    const workspace = await wm.openWorkspace({ root: fx.root })
    session = runtime.startSession({ workspaceId: workspace.id, model: { provider: 'fake', model: 'scripted' } })
    events = []
    runtime.subscribe(session.id, e => events.push(e))
  })
  after(() => fx.cleanup())

  const firstRun = () => requests.slice(0, 21)
  const secondRun = () => requests.slice(21)
  const inputBudget = (req) => WINDOW - OUT - 200 - estimator.estimateToolSchemaTokens(req.tools)

  it('completes a long first run with every request bounded and structurally valid', async () => {
    const done = await runtime.sendMessage(session.id, GOAL)
    assert.equal(done.status, 'completed', JSON.stringify(done.events.find(e => e.type === 'session.failed')))
    assert.equal(requests.length, 21)
    for (const req of firstRun()) {
      assert.ok(estimator.estimateContextTokens(req.messages) <= inputBudget(req), 'request must fit the budget')
      validateHistory(req.messages.slice(1))
      assert.equal(req.messages.at(-1).role === 'user' || req.messages.at(-1).role === 'tool', true)
    }
    // raw history alone would not have fit
    const raw = estimator.estimateContextTokens(done.messages)
    assert.ok(raw > WINDOW, `raw history ${raw} should exceed the window ${WINDOW}`)
    assert.ok(done.contextStats.compactionCount > 0)
    assert.ok(events.some(e => e.type === 'context.compacted'))
    const compacted = events.find(e => e.type === 'context.compacted')
    assert.deepEqual(Object.keys(compacted.data).sort(), ['droppedItems', 'estimatedTokens', 'maxTokens', 'steps', 'summarizedItems', 'summaryRevision'])
    assert.ok(!JSON.stringify(compacted).includes('mod3Fn'), 'events carry metadata only')
  })

  it('kept the goal, repository guidance, and changed-file state in front of the model', () => {
    const last = firstRun().at(-1)
    const sys = last.messages[0].content
    assert.match(sys, /Goal:\nFix add\(\) in src\/math\.js/)
    assert.match(sys, /Do not change the public API of multiply\(\)/)
    assert.match(sys, /Files changed:\n- src\/math\.js \(modified, validated since\)\n- src\/lib\/helper\.js \(created, validated since\)/)
    assert.match(requests[0].messages[0].content, /Repository instructions \(AGENTS\.md\):[\s\S]*Prefer small patches/)
    // the most recent observation is verbatim
    assert.match(last.messages.at(-1).content, /Tool: shell[\s\S]*npm test|Exit code: 0/)
  })

  it('compacted old observations instead of resending them', () => {
    const late = firstRun()[16] // after the lib reads, around the patch
    const tools = late.messages.filter(m => m.role === 'tool')
    const verbatimReads = tools.filter(m => /^Tool: read_file/.test(m.content) && /mod\d+Fn1\(/.test(m.content))
    const compactReads = tools.filter(m => /^Read src\/lib\/mod\d+\.js lines/.test(m.content))
    assert.ok(compactReads.length >= 5, `expected compact observations, got ${compactReads.length}`)
    assert.ok(verbatimReads.length <= 3, `only a few recent reads stay verbatim, got ${verbatimReads.length}`)
  })

  it('never exposes secret files to the provider', () => {
    for (const req of requests.length ? requests : []) assert.ok(!JSON.stringify(req.messages).includes('super-secret-value'))
  })

  it('accepts a follow-up and rebuilds context with prior engineering state', async () => {
    const done = await runtime.sendMessage(session.id, FOLLOW_UP)
    assert.equal(done.status, 'completed', JSON.stringify(done.events.find(e => e.type === 'session.failed')))
    assert.equal(requests.length, 25)
    for (const req of secondRun()) {
      assert.ok(estimator.estimateContextTokens(req.messages) <= inputBudget(req))
      validateHistory(req.messages.slice(1))
      const lastUser = [...req.messages].reverse().find(m => m.role === 'user')
      assert.equal(lastUser.content, FOLLOW_UP) // current request verbatim
      const sys = req.messages[0].content
      assert.match(sys, /Do not touch src\/index\.js/)
      assert.match(sys, /Do not change the public API of multiply\(\)/) // earlier constraint still present
      assert.match(sys, /Goal:\nFix add\(\) in src\/math\.js/)
      assert.match(sys, /src\/math\.js \(modified/)
      assert.match(sys, /Validation:\n- `npm test`: passed/)
    }
    // the first run's exchange was folded out of the provider view but not out of the session
    assert.ok(done.contextSummary.revision >= 1)
    assert.ok(!secondRun()[0].messages.some(m => m.role === 'tool' && /mod5/.test(m.content)))
    assert.ok(done.messages.some(m => m.role === 'tool' && /mod5Fn1/.test(m.content)), 'canonical history keeps everything')
    assert.deepEqual(done.changedFiles.map(f => f.path).sort(), ['src/lib/helper.js', 'src/math.js', 'tests/add.test.js'])
    assert.equal(done.messages.filter(m => m.role === 'user').length, 2)
  })

  it('exposes inspectable diagnostics without leaking content', async () => {
    const dbg = await runtime.debugContext(session.id)
    assert.ok(dbg.estimatedTokens > 0 && dbg.budget.availableInputTokens > 0)
    assert.ok(dbg.sections.system > 0 && dbg.sections.summary > 0 && 'toolSchemas' in dbg.sections)
    assert.ok(dbg.selectedItems.every(i => i.section && i.type && i.source && i.priority && typeof i.estimatedTokens === 'number'))
    assert.ok(dbg.selectedItems.some(i => i.type === 'session_summary'))
    const text = JSON.stringify(dbg)
    assert.ok(!text.includes('super-secret') && !text.includes('mod3Fn') && !text.includes('Prefer small patches'))
    assert.ok(dbg.summaryRevision >= 1 && dbg.stats.builds >= 25)
    const turn = runtime.getSession(session.id).turns.at(-1)
    assert.ok(turn.context.estimatedInputTokens > 0 && 'compactionOccurred' in turn.context)
  })
})

describe('context failure handling', () => {
  it('fails before any provider request, with a concise error, when the window is far too small', async () => {
    const fx = await createFixtureRepo()
    try {
      const wm = createNodeWorkspaceManager()
      const provider = createFakeProvider({ capabilities: { contextWindow: 1_500, maxOutputTokens: 500 }, turns: [reply(say('never'))] })
      const runtime = createAgentRuntime({ providers: createProviderRegistry([provider]), workspaces: wm, config: { ...loadRuntimeConfig({}), maxOutputTokens: 500, contextSafetyMarginTokens: 100 } })
      const ws = await wm.openWorkspace({ root: fx.root })
      const s = runtime.startSession({ workspaceId: ws.id, model: { provider: 'fake', model: 'm' } })
      const done = await runtime.sendMessage(s.id, 'hello')
      const failed = done.events.find(e => e.type === 'session.failed').data.error
      assert.equal(done.status, 'error')
      assert.equal(failed.code, 'context_budget_exceeded')
      assert.ok(failed.message.length < 200 && !/at \S+ \(/.test(failed.message))
      assert.equal(provider.requests.length, 0)
      // the session remains usable (the user can start over or narrow the scope)
      assert.equal(runtime.getSession(s.id).messages[0].content, 'hello')
    } finally { await fx.cleanup() }
  })
})
