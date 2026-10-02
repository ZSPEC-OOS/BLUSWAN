import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTokenEstimator, defaultEstimator, estimateTokens, estimateMessageTokens, estimateContextTokens } from './tokenEstimator.js'
import { createTokenBudget } from './tokenBudget.js'
import { loadRuntimeConfig, DEFAULT_CONTEXT } from '../config/runtimeConfig.js'
import { createSimulator, readResult, fileBody } from './testing/simulator.js'
import { validateHistory } from './conversationContext.js'
import { buildSystemPrompt } from '../agent/systemPrompt.js'

describe('token estimator', () => {
  it('is monotonic, non-zero for text and zero for empty', () => {
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens(undefined), 0)
    assert.ok(estimateTokens('a'.repeat(1000)) > estimateTokens('a'.repeat(100)))
    assert.ok(estimateTokens('hello world') >= 1)
  })
  it('is conservative relative to 4 chars per token', () => {
    assert.ok(estimateTokens('x'.repeat(4000)) > 1000)
  })
  it('counts tool calls, reasoning and per-message overhead', () => {
    const plain = estimateMessageTokens({ role: 'assistant', content: 'hi' })
    const withCalls = estimateMessageTokens({ role: 'assistant', content: 'hi', toolCalls: [{ id: 'c', name: 'read_file', input: { path: 'src/a.js' } }] })
    assert.ok(withCalls > plain && plain > estimateTokens('hi'))
    assert.equal(estimateContextTokens([{ content: 'a' }, { content: 'b' }]), 2 * estimateMessageTokens({ content: 'a' }))
  })
  it('budgets tool schemas conservatively and is replaceable', () => {
    const tools = [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }]
    assert.ok(defaultEstimator.estimateToolSchemaTokens(tools) > estimateTokens(JSON.stringify(tools)))
    assert.equal(defaultEstimator.estimateToolSchemaTokens([]), 0)
    const coarse = createTokenEstimator({ charsPerToken: 1 })
    assert.equal(coarse.estimateTokens('abcd'), 4)
  })
})

describe('token budget', () => {
  const caps = { contextWindow: 128_000, maxOutputTokens: 8192 }
  const config = { ...loadRuntimeConfig({}), maxOutputTokens: 8192 }

  it('derives the usable input budget from the model, output reserve, safety margin and tools', () => {
    const b = createTokenBudget({ capabilities: caps, config, toolTokens: 3000 })
    assert.equal(b.availableInputTokens, 128_000 - 8192 - DEFAULT_CONTEXT.contextSafetyMarginTokens - 3000)
    assert.equal(b.compactionThreshold, Math.floor(b.availableInputTokens * DEFAULT_CONTEXT.compactionThresholdRatio))
    assert.ok(b.compactionTarget < b.compactionThreshold && b.compactionThreshold < b.availableInputTokens)
  })
  it('is model-aware: different windows and output limits give different budgets', () => {
    const small = createTokenBudget({ capabilities: { contextWindow: 32_000, maxOutputTokens: 4096 }, config })
    const big = createTokenBudget({ capabilities: { contextWindow: 200_000, maxOutputTokens: 8192 }, config })
    assert.ok(big.availableInputTokens > small.availableInputTokens)
    assert.equal(small.reservedOutputTokens, 4096) // capped at the model's own maximum
  })
  it('never plans to fill the whole window', () => {
    const b = createTokenBudget({ capabilities: caps, config })
    assert.ok(b.availableInputTokens + b.reservedOutputTokens + b.reservedSafetyTokens <= caps.contextWindow)
    assert.ok(b.reservedSafetyTokens > 0)
  })
  it('honours configuration overrides', () => {
    const b = createTokenBudget({ capabilities: caps, config: { ...config, contextSafetyMarginTokens: 5000, compactionThresholdRatio: 0.5 } })
    assert.equal(b.reservedSafetyTokens, 5000)
    assert.equal(b.compactionThreshold, Math.floor(b.availableInputTokens * 0.5))
  })
})

describe('context engine: budget enforcement and priorities', () => {
  it('passes a small context through unchanged (no compaction)', async () => {
    const sim = createSimulator()
    sim.user('Fix the bug in src/math.js')
    sim.tool('read_file', { path: 'src/math.js' }, readResult('src/math.js', fileBody('math', 10)), 'Looking.')
    const ctx = await sim.build()
    assert.equal(ctx.compacted, false)
    assert.deepEqual(ctx.steps, [])
    assert.deepEqual(ctx.messages.slice(1).map(m => m.role), ['user', 'assistant', 'tool'])
    assert.equal(ctx.messages[3].content, sim.session.messages[2].content) // tool result verbatim
    assert.ok(ctx.estimatedTokens <= ctx.budget.compactionThreshold)
  })

  it('keeps the system prompt and current request, with explicit priorities and sources', async () => {
    const sim = createSimulator()
    sim.user('Fix the bug in src/math.js')
    const ctx = await sim.build()
    assert.ok(ctx.messages[0].content.startsWith(buildSystemPrompt()))
    const critical = ctx.items.filter(i => i.priority === 'critical')
    assert.deepEqual(critical.map(i => i.type), ['system_instructions', 'user_message'])
    for (const i of ctx.items) assert.ok(i.section && i.type && i.source && i.priority && typeof i.estimatedTokens === 'number')
    assert.deepEqual(Object.keys(ctx.diagnostics), ['totalEstimatedTokens', 'maxInputTokens', 'compacted', 'sections'])
  })

  it('compacts before overflow once the projected input crosses the threshold', async () => {
    const sim = createSimulator({ contextWindow: 6_500 })
    sim.user('Investigate the modules and fix the math bug.')
    for (let i = 0; i < 10; i++) sim.tool('read_file', { path: `src/m${i}.js` }, readResult(`src/m${i}.js`, fileBody(`m${i}`, 60)))
    const ctx = await sim.build()
    assert.equal(ctx.compacted, true)
    assert.ok(ctx.steps.includes('compact_tool_outputs'))
    assert.ok(ctx.estimatedTokens <= ctx.budget.availableInputTokens)
    assert.ok(ctx.estimatedTokens <= ctx.budget.compactionTarget || ctx.steps.length > 3)
    assert.ok(ctx.metrics.summarizedItems > 0)
    validateHistory(ctx.messages.slice(1))
  })

  it('reduces low-priority content first and keeps critical content intact', async () => {
    const sim = createSimulator({ contextWindow: 6_000 })
    const request = 'Please update the retry logic to use exponential backoff but keep the public API unchanged.'
    for (let i = 0; i < 12; i++) { sim.user(`Earlier request number ${i}: look at module ${i}`); sim.tool('read_file', { path: `src/e${i}.js` }, readResult(`src/e${i}.js`, fileBody(`e${i}`, 50))); sim.final(`Done with ${i}`) }
    sim.user(request)
    const ctx = await sim.build()
    assert.equal(ctx.compacted, true)
    assert.equal(ctx.messages.at(-1).content, request) // current request verbatim and last
    assert.ok(ctx.messages[0].content.startsWith(buildSystemPrompt()))
    assert.ok(ctx.omitted.some(o => o.type === 'exchange')) // old exchanges were folded, not the critical ones
    assert.ok(ctx.estimatedTokens <= ctx.budget.availableInputTokens)
  })

  it('fails with a normalized error when critical context cannot fit, never dropping the request', async () => {
    const sim = createSimulator({ contextWindow: 3_000, maxOutputTokens: 500 })
    sim.user('x'.repeat(40_000))
    await assert.rejects(sim.build(), e => e.code === 'context_budget_exceeded' && /usable context capacity/.test(e.message))
  })
  it('fails clearly when the window cannot even hold the tool definitions and reserves', async () => {
    const sim = createSimulator({ contextWindow: 800, maxOutputTokens: 500 })
    sim.user('hi')
    await assert.rejects(sim.build(), e => e.code === 'context_budget_exceeded')
  })
  it('rejects malformed history instead of sending it', async () => {
    const sim = createSimulator()
    sim.user('hi')
    sim.session.messages.push({ id: 'x', role: 'tool', toolCallId: 'nope', name: 'grep', content: 'orphan', timestamp: 1 })
    await assert.rejects(sim.build(), e => e.code === 'context_invalid_history')
  })
  it('accounts for tool schema overhead in the budget', async () => {
    const sim = createSimulator()
    sim.user('hi')
    const tools = Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, description: 'x'.repeat(200), inputSchema: { type: 'object', properties: {} } }))
    const free = await sim.build()
    const withTools = await sim.build({ tools })
    assert.ok(withTools.budget.availableInputTokens < free.budget.availableInputTokens)
    assert.equal(withTools.sections.toolSchemas, withTools.budget.toolTokens)
  })
})
