import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSimulator, readResult, shellResult, grepResult, patchResult, fileBody } from './testing/simulator.js'
import { validateHistory } from './conversationContext.js'

const toolMessages = (ctx) => ctx.messages.filter(m => m.role === 'tool')

describe('conversation compaction', () => {
  it('compacts older tool results but keeps the most recent one verbatim', async () => {
    const sim = createSimulator({ contextWindow: 5_000 })
    sim.user('Investigate and fix.')
    for (let i = 0; i < 12; i++) sim.tool('read_file', { path: `src/f${i}.js` }, readResult(`src/f${i}.js`, fileBody(`f${i}`, 50)))
    const ctx = await sim.build()
    assert.ok(ctx.compacted)
    const tools = toolMessages(ctx)
    assert.match(tools.at(-1).content, /^Tool: read_file\nStatus: ok/) // latest result in full
    assert.match(tools.at(-1).content, /f11Fn1/)
    assert.match(tools[0].content, /^Read src\/f0\.js lines 1–50 of 50\./) // older ones compacted to observations
    assert.ok(!/f0Fn1\(/.test(tools[0].content.replace(/Defines:.*/, '')))
  })

  it('keeps tool call/result pairs valid under every compaction level', async () => {
    for (const contextWindow of [9_000, 5_000, 3_600]) {
      const sim = createSimulator({ contextWindow, maxOutputTokens: 300 })
      sim.user('Task one: read modules.')
      for (let i = 0; i < 6; i++) sim.tool('read_file', { path: `src/f${i}.js` }, readResult(`src/f${i}.js`, fileBody(`f${i}`, 40)), `Reading ${i}`)
      sim.final('Done one.')
      sim.user('Task two: patch and test.')
      sim.tool('apply_patch', { patch: 'x'.repeat(2000) }, patchResult('src/f1.js'))
      sim.tool('shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 0, stdout: 'ok\n'.repeat(200) }))
      const ctx = await sim.build()
      validateHistory(ctx.messages.slice(1))
      const last = ctx.messages.slice(-2)
      assert.deepEqual(last.map(m => m.role), ['assistant', 'tool']) // active cycle intact
      assert.equal(last[0].toolCalls[0].id, last[1].toolCallId)
      assert.match(last[1].content, /Exit code: 0/)
    }
  })

  it('shrinks large file bodies and patches inside old tool calls, keeping them valid JSON-shaped', async () => {
    const sim = createSimulator({ contextWindow: 5_000, maxOutputTokens: 300 })
    sim.user('Do it.')
    sim.tool('write_file', { path: 'big.js', content: 'z'.repeat(16000) }, { ok: true, tool: 'write_file', output: { path: 'big.js', created: true, overwritten: false, bytesWritten: 16000 } })
    sim.tool('read_file', { path: 'a.js' }, readResult('a.js', fileBody('a', 60)))
    sim.tool('read_file', { path: 'b.js' }, readResult('b.js', fileBody('b', 60)))
    const ctx = await sim.build()
    const old = ctx.messages.find(m => m.toolCalls?.[0]?.name === 'write_file')
    assert.ok(old)
    assert.match(old.toolCalls[0].input.content, /chars omitted/)
    assert.ok(old.toolCalls[0].input.content.length < 400)
    assert.equal(old.toolCalls[0].input.path, 'big.js')
  })

  it('never resends a huge old tool output in full', async () => {
    const sim = createSimulator({ contextWindow: 10_000 })
    sim.user('Run the whole suite.')
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i}: noisy log output`).join('\n')
    sim.tool('shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 1, stdout: huge, stderr: 'AssertionError: expected 1 received 2' }))
    sim.final('It failed.')
    sim.user('Look at src/a.js.')
    sim.tool('read_file', { path: 'src/a.js' }, readResult('src/a.js', fileBody('a', 20)))
    const ctx = await sim.build()
    const shell = toolMessages(ctx).find(m => m.name === 'shell')
    assert.ok(shell.content.length < 1_000, `old shell output should be compact, got ${shell.content.length}`)
    assert.match(shell.content, /FAILED/)
    assert.match(shell.content, /expected 1 received 2/)
    assert.ok(ctx.estimatedTokens < 10_000)
  })

  it('supersedes a read once the file is modified, without trusting the old content', async () => {
    const sim = createSimulator({ contextWindow: 50_000 })
    sim.user('Fix src/a.js')
    sim.tool('read_file', { path: 'src/a.js' }, readResult('src/a.js', 'export function oldVersion() {}\n'))
    sim.tool('apply_patch', { patch: '...' }, patchResult('src/a.js'))
    const ctx = await sim.build()
    const read = toolMessages(ctx).find(m => m.name === 'read_file')
    assert.match(read.content, /Superseded: src\/a\.js modified afterwards/)
    assert.ok(!/export function oldVersion\(\) \{\}/.test(read.content))
  })

  it('folds old exchanges into the summary while the goal and constraints survive', async () => {
    const sim = createSimulator({ contextWindow: 6_000 })
    sim.user('Refactor the auth module and add tests. Do not change the AuthProvider public API.')
    sim.tool('read_file', { path: 'src/auth.js' }, readResult('src/auth.js', fileBody('auth', 40)))
    sim.final('Read it.')
    for (let i = 0; i < 12; i++) {
      sim.user(`Follow-up ${i}: examine module ${i}.`)
      sim.tool('grep', { pattern: `term${i}` }, grepResult(Array.from({ length: 20 }, (_, k) => ({ path: `src/g${i}_${k}.js`, line: k, column: 1, text: 'match '.repeat(30) }))))
      sim.tool('read_file', { path: `src/m${i}.js` }, readResult(`src/m${i}.js`, fileBody(`m${i}`, 45)))
      sim.final(`Looked at ${i}.`)
    }
    sim.user('Continue with the retry logic.')
    const ctx = await sim.build()
    assert.ok(ctx.steps.includes('fold_history'))
    assert.ok(sim.session.contextSummary.revision >= 1)
    const sys = ctx.messages[0].content
    assert.match(sys, /Goal:\nRefactor the auth module/)
    assert.match(sys, /Do not change the AuthProvider public API/)
    assert.equal(ctx.messages.at(-1).content, 'Continue with the retry logic.')
    assert.ok(ctx.estimatedTokens <= ctx.budget.availableInputTokens)
    // canonical history is untouched
    assert.equal(sim.session.messages.length, 4 + 12 * 6 + 1)
  })
})
