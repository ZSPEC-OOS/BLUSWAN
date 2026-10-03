// DeepSeek Flash / V4 Pro contract: capability metadata, reasoningEffort mapping, thinking-mode request shape,
// streaming with reasoning deltas and tool calls, usage, cancellation and error mapping. Mocked fetch, no network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekProvider, buildRequestBody, capabilitiesFor, MODELS } from './deepseek.js'
import { isCodingCapable } from './capabilities.js'

const config = { apiKey: 'test-credential-value', baseUrl: 'https://api.example.com', model: 'deepseek-flash' }
const enc = new TextEncoder()
const sse = (...chunks) => chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
const delta = (d, finish = null, extra = {}) => ({ choices: [{ delta: d, finish_reason: finish }], ...extra })
const ok = (text) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close() } }), text: async () => '' })

async function run(model, request = {}, text = sse(delta({ content: 'hi' }, 'stop'), '[DONE]')) {
  let sent
  const provider = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return ok(text) } })
  const events = []
  await provider.stream({ model, messages: [{ role: 'user', content: 'x' }], tools: [], ...request }, { onEvent: e => events.push(e) })
  return { sent, events }
}

for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  describe(`deepseek ${model}`, () => {
    it('is recognised, listed, coding-capable and declares reasoning effort', () => {
      const caps = capabilitiesFor(model)
      assert.ok(MODELS.some(m => m.id === model))
      assert.ok(isCodingCapable(caps))
      assert.deepEqual([caps.reasoning, caps.reasoningEffort, caps.parallelToolCalls], [true, true, true])
      assert.ok(caps.contextWindow >= 128000)
    })

    it('maps canonical reasoningEffort to thinking + reasoning_effort and never sends temperature', async () => {
      const { sent } = await run(model, { reasoningEffort: 'high', temperature: 0.2, maxOutputTokens: 1234 })
      assert.deepEqual(sent.thinking, { type: 'enabled' })
      assert.equal(sent.reasoning_effort, 'high')
      assert.ok(!('temperature' in sent))
      assert.equal(sent.max_tokens, 1234)
      assert.equal(sent.stream, true)
    })

    it('omits thinking fields when no effort is requested, and clamps unknown efforts', () => {
      const caps = capabilitiesFor(model)
      const base = { model, messages: [{ role: 'user', content: 'x' }] }
      const plain = buildRequestBody(base, caps)
      assert.ok(!('thinking' in plain) && !('reasoning_effort' in plain))
      assert.equal(buildRequestBody({ ...base, reasoningEffort: 'bogus' }, caps).reasoning_effort, 'high')
    })

    it('streams reasoning deltas separately from text, plus tool calls and usage', async () => {
      const stream = sse(
        delta({ reasoning_content: 'think ' }), delta({ reasoning_content: 'more' }),
        delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 }, prompt_cache_hit_tokens: 4 } }, '[DONE]')
      const { events } = await run(model, { reasoningEffort: 'high' }, stream)
      assert.equal(events.filter(e => e.type === 'reasoning_delta').map(e => e.text).join(''), 'think more')
      assert.equal(events.filter(e => e.type === 'text_delta').length, 0)
      assert.deepEqual(events.find(e => e.type === 'tool_call_complete').input, { path: 'a' })
      assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', input: 10, output: 5, reasoning: 3, total: 15, cachedInput: 4 })
    })

    it('echoes reasoning_content on tool continuation turns of the current exchange', () => {
      const body = buildRequestBody({
        model, reasoningEffort: 'high',
        messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', reasoning: 'plan', toolCalls: [{ id: 'c', name: 'grep', input: {} }] }, { role: 'tool', toolCallId: 'c', content: 'r' }],
      }, capabilitiesFor(model))
      assert.equal(body.messages[1].reasoning_content, 'plan')
    })

    it('honours cancellation and maps provider errors without leaking the key', async () => {
      const controller = new AbortController(); controller.abort()
      const provider = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async (u, init) => { if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return ok('') } })
      await assert.rejects(provider.stream({ model, messages: [{ role: 'user', content: 'x' }], signal: controller.signal }, { onEvent() {} }), e => e.code === 'cancelled' || /abort|cancel/i.test(e.message))
      const failing = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async () => ({ ok: false, status: 401, body: null, text: async () => 'unauthorized' }) })
      await assert.rejects(failing.stream({ model, messages: [{ role: 'user', content: 'x' }] }, { onEvent() {} }), e => !JSON.stringify(e).includes('test-credential-value') && !e.message.includes('test-credential-value'))
    })
  })
}

describe('deepseek legacy models', () => {
  it('keeps deepseek-chat and deepseek-reasoner behaviour: no thinking fields from the effort mapping', () => {
    for (const model of ['deepseek-chat', 'deepseek-reasoner']) {
      const body = buildRequestBody({ model, messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'high' }, capabilitiesFor(model))
      assert.ok(!('thinking' in body) && !('reasoning_effort' in body), model)
    }
    assert.equal(capabilitiesFor('deepseek-chat').reasoning, false)
    assert.equal(capabilitiesFor('deepseek-reasoner').reasoning, true)
  })
})

describe('deepseek utility calls', () => {
  it('reasoningEffort "off" disables thinking and keeps temperature usable', () => {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
      const body = buildRequestBody({ model, messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'off', temperature: 0 }, capabilitiesFor(model))
      assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.ok(!('reasoning_effort' in body))
    }
  })
})
