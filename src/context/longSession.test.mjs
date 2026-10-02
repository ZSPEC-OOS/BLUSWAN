import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSimulator, readResult, shellResult, grepResult, patchResult, fileBody } from './testing/simulator.js'
import { validateHistory } from './conversationContext.js'
import { createProviderSummarizer } from './compaction.js'
import { createFakeProvider } from '../agent/testing/fakeProvider.js'
import { textDelta, completed } from '../providers/normalize.js'

const GOAL = 'Refactor the auth module so token refresh is serialized, and add regression coverage.'

async function runLongSession({ exchanges = 60, window = 14_000, hooks = {} } = {}) {
  const sim = createSimulator({ contextWindow: window })
  const builds = []
  for (let i = 0; i < exchanges; i++) {
    sim.user(i === 0 ? GOAL : hooks.userText?.(i) ?? `Step ${i}: look into module ${i} and report what it exports.`)
    builds.push(await sim.build())
    sim.tool('read_file', { path: `src/mod${i}.js` }, readResult(`src/mod${i}.js`, fileBody(`mod${i}`, 60)), `Reading module ${i}`)
    sim.tool('grep', { pattern: `symbol${i}` }, grepResult(Array.from({ length: 15 }, (_, k) => ({ path: `src/hit${i}_${k}.js`, line: k + 1, column: 1, text: 'matching line '.repeat(8) }))))
    hooks.after?.(sim, i)
    sim.tool('shell', { command: 'ls -la' }, shellResult('ls -la', { stdout: `file listing ${i}\n`.repeat(150) }))
    builds.push(await sim.build())
    sim.final(`Done with step ${i}.`)
  }
  return { sim, builds }
}

describe('long sessions', () => {
  it('keeps every request within budget and bounded after compaction stabilizes', async () => {
    const { sim, builds } = await runLongSession({ exchanges: 60 })
    for (const b of builds) {
      assert.ok(b.estimatedTokens <= b.budget.availableInputTokens, `over budget: ${b.estimatedTokens} > ${b.budget.availableInputTokens}`)
      validateHistory(b.messages.slice(1))
    }
    const mid = Math.max(...builds.slice(40, 80).map(b => b.estimatedTokens))
    const late = Math.max(...builds.slice(-40).map(b => b.estimatedTokens))
    assert.ok(late <= mid * 1.15, `request size should plateau: mid ${mid}, late ${late}`)
    assert.ok(sim.session.messages.length > 300) // the canonical history keeps growing
    assert.ok(sim.session.contextSummary.revision > 5)
    const rawTokens = sim.engine.estimator.estimateContextTokens(sim.session.messages)
    assert.ok(rawTokens > 3 * late, `raw history (${rawTokens}) should dwarf the provider context (${late})`)
  })

  it('preserves the original goal, the latest instruction exactly, and recent turns', async () => {
    const latest = 'Now also handle the timeout path. Do not change the AuthProvider public API.'
    const { sim, builds } = await runLongSession({ exchanges: 40, hooks: { userText: i => (i === 39 ? latest : undefined) } })
    const last = builds[builds.length - 1]
    assert.match(last.messages[0].content, new RegExp(`Goal:\\n${GOAL.slice(0, 40)}`))
    const lastUser = [...last.messages].reverse().find(m => m.role === 'user')
    assert.equal(lastUser.content, latest)
    assert.match(last.messages[0].content, /Do not change the AuthProvider public API/)
    assert.ok(last.messages.some(m => m.role === 'tool' && /mod39\.js/.test(m.content))) // recent observation retained
    assert.ok(sim.session.contextSummary.currentObjective.startsWith('Now also handle the timeout path'))
    assert.ok(sim.session.contextSummary.revision > 0) // history was folded earlier; later builds can be below threshold again
  })

  it('later instructions take precedence while earlier constraints remain visible in order', async () => {
    const { builds } = await runLongSession({
      exchanges: 30,
      hooks: { userText: i => (i === 5 ? 'Keep the existing retry delays.' : i === 25 ? 'Actually use exponential backoff for retries instead.' : undefined) },
    })
    const sys = builds[builds.length - 1].messages[0].content
    const a = sys.indexOf('Keep the existing retry delays.')
    const b = sys.indexOf('Actually use exponential backoff')
    assert.ok(a >= 0 && b > a, 'both present, later instruction after earlier')
    assert.match(sys, /later entries override earlier ones/)
  })

  it('keeps changed-file state after the original patch results are gone', async () => {
    const { sim, builds } = await runLongSession({
      exchanges: 40,
      hooks: { after: (s, i) => { if (i === 2) { s.tool('apply_patch', { patch: 'p'.repeat(3000) }, patchResult('src/authService.js', 'tests/auth.test.js')) } } },
    })
    const last = builds[builds.length - 1]
    assert.ok(!last.messages.some(m => m.role === 'tool' && m.name === 'apply_patch'), 'old patch result should no longer be present')
    assert.match(last.messages[0].content, /Files changed:\n- src\/authService\.js \(modified/)
    assert.match(last.messages[0].content, /tests\/auth\.test\.js/)
    assert.deepEqual(sim.session.contextSummary.filesChanged.map(f => f.path), ['src/authService.js', 'tests/auth.test.js'])
  })

  it('keeps an unresolved failure in context through many later turns', async () => {
    const { builds } = await runLongSession({
      exchanges: 45,
      hooks: { after: (s, i) => { if (i === 3) s.tool('shell', { command: 'npm test -- auth' }, shellResult('npm test -- auth', { exitCode: 1, stdout: 'x\n'.repeat(500), stderr: 'AssertionError: expected refresh call count 1, received 2' })) } },
    })
    for (const b of [builds[10], builds[40], builds[builds.length - 1]]) {
      assert.match(b.messages[0].content, /Unresolved issues:\n- `npm test -- auth` failing: .*expected refresh call count 1, received 2/)
    }
  })

  it('downgrades a failure once it is fixed and the command passes', async () => {
    const sim = createSimulator({ contextWindow: 9_000 })
    sim.user('Fix the auth tests.')
    sim.tool('shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 1, stderr: 'AssertionError: expected 1 received 2' }))
    let ctx = await sim.build()
    assert.match(ctx.messages[0].content, /Unresolved issues/)
    sim.tool('apply_patch', {}, patchResult('src/auth.js'))
    sim.tool('shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 0, stdout: 'all good' }))
    for (let i = 0; i < 6; i++) sim.tool('read_file', { path: `src/x${i}.js` }, readResult(`src/x${i}.js`, fileBody('x', 50)))
    ctx = await sim.build()
    const sys = ctx.messages[0].content
    assert.ok(!/Unresolved issues/.test(sys))
    assert.match(sys, /Validation:\n- `npm test`: passed/)
    assert.match(sys, /src\/auth\.js \(modified, validated since\)/)
    const oldFailure = ctx.messages.find(m => m.role === 'tool' && /FAILED/.test(m.content))
    assert.ok(!oldFailure || oldFailure.content.length < 400, 'resolved failure is only a compact observation')
  })
})

describe('model-assisted summarization (optional)', () => {
  async function overflowing(summarizer) {
    const sim = createSimulator({ contextWindow: 4_500, summarizer })
    for (let i = 0; i < 8; i++) { sim.user(`Request ${i}: inspect part ${i}.`); sim.tool('read_file', { path: `a${i}.js` }, readResult(`a${i}.js`, fileBody('a', 50))); sim.final('ok') }
    sim.user('Continue.')
    return sim
  }

  it('adds decisions and facts returned by the summarizer when history is folded', async () => {
    const calls = []
    const sim = await overflowing(async (input) => { calls.push(input.folded.length); return { decisions: ['Keep the API stable'], importantFacts: ['Tests run with node --test'] } })
    const ctx = await sim.build()
    assert.ok(ctx.foldedMessageCount > 0 && calls.length === 1)
    assert.match(ctx.messages[0].content, /Keep the API stable/)
    assert.match(ctx.messages[0].content, /Tests run with node --test/)
  })

  it('falls back to deterministic compaction when the summarizer fails, without corrupting the summary', async () => {
    const sim = await overflowing(async () => { throw new Error('model unavailable') })
    const before = JSON.stringify(sim.session.contextSummary)
    const ctx = await sim.build()
    assert.ok(ctx.foldedMessageCount > 0)
    assert.equal(ctx.messages.at(-1).content, 'Continue.')
    assert.ok(ctx.estimatedTokens <= ctx.budget.availableInputTokens)
    const after = sim.session.contextSummary
    assert.equal(after.goal, JSON.parse(before).goal)
    assert.ok(after.revision > 0)
  })

  it('never calls the summarizer on a dry run', async () => {
    let called = false
    const sim = await overflowing(async () => { called = true; return {} })
    const ctx = await sim.build({ dryRun: true })
    assert.equal(called, false)
    assert.ok(ctx.foldedMessageCount > 0)
  })

  it('the provider-backed summarizer uses a small separate prompt, no tools, and parses JSON', async () => {
    const provider = createFakeProvider({
      respond: (req) => {
        assert.equal(req.metadata.purpose, 'summarization')
        assert.deepEqual(req.tools, [])
        assert.equal(req.messages.length, 2)
        assert.ok(req.messages[1].content.length < 6_000)
        return [textDelta('Here you go: {"decisions": ["Use backoff"], "importantFacts": ["lint is eslint"], "extra": 1}'), completed('stop')]
      },
    })
    const summarize = createProviderSummarizer({ provider, model: 'm' })
    const sim = await overflowing(summarize)
    const ctx = await sim.build()
    assert.equal(provider.requests.length, 1)
    assert.match(ctx.messages[0].content, /Use backoff/)
  })

  it('rejects unparseable summarizer output and falls back', async () => {
    const provider = createFakeProvider({ respond: () => [textDelta('no json here'), completed('stop')] })
    const sim = await overflowing(createProviderSummarizer({ provider, model: 'm' }))
    const ctx = await sim.build()
    assert.ok(ctx.foldedMessageCount > 0)
    assert.ok(!/Use backoff/.test(ctx.messages[0].content))
  })
})
