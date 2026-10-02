import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProviderRegistry, defaultRegistry } from './registry.js'
import { createFakeProvider } from '../agent/testing/fakeProvider.js'
import { textDelta, reasoningDelta, toolCallComplete, usage, completed, normalizeUsage, isValidProviderEvent } from './normalize.js'
import {
  createDeepSeekProvider, createChunkParser, errorFromResponse, errorFromException,
  validateConfig, capabilitiesFor, normalizeTools, normalizeMessages, buildHeaders, buildUrl, readSse,
} from './deepseek.js'
import { loadRuntimeConfig, redactConfig } from '../config/runtimeConfig.js'

describe('provider registry', () => {
  it('registers DeepSeek by default', () => {
    assert.ok(defaultRegistry.hasProvider('deepseek'))
    assert.deepEqual(defaultRegistry.listProviders(), ['deepseek'])
    assert.equal(defaultRegistry.getProvider('deepseek').id, 'deepseek')
  })
  it('throws a normalized error for unknown providers', () => {
    assert.throws(() => defaultRegistry.getProvider('kimi'), e => e.code === 'configuration_error')
  })
  it('rejects duplicate registration and invalid adapters', () => {
    const r = createProviderRegistry([createFakeProvider()])
    assert.throws(() => r.registerProvider(createFakeProvider()), /already registered/)
    assert.throws(() => r.registerProvider({ id: 'x' }), /missing/)
  })
})

describe('provider normalization', () => {
  it('builds valid neutral events', () => {
    assert.ok(isValidProviderEvent(textDelta('a')))
    assert.ok(isValidProviderEvent(toolCallComplete({ id: '1', name: 'read_file', input: { path: 'a' } })))
    assert.ok(isValidProviderEvent(reasoningDelta('r')))
    assert.ok(isValidProviderEvent(usage({ input: 2, output: 3 })))
    assert.ok(isValidProviderEvent(completed()))
    assert.equal(isValidProviderEvent({ type: 'native_chunk' }), false)
  })
  it('normalizes usage totals', () => {
    assert.deepEqual(normalizeUsage({ input: 2, output: 3 }), { input: 2, output: 3, reasoning: 0, total: 5 })
    assert.deepEqual(normalizeUsage({}), { input: 0, output: 0, reasoning: 0, total: 0 })
  })
})

describe('deepseek adapter', () => {
  const config = { apiKey: 'sk-secret', baseUrl: 'https://api.example.com/', model: 'deepseek-chat' }

  it('validates configuration early', () => {
    assert.throws(() => validateConfig({ ...config, apiKey: '' }, 'm'), e => e.code === 'configuration_error')
    assert.throws(() => validateConfig(config, ''), e => e.code === 'configuration_error')
    assert.doesNotThrow(() => validateConfig(config, 'm'))
  })
  it('builds url and auth header', () => {
    assert.equal(buildUrl(config), 'https://api.example.com/chat/completions')
    assert.equal(buildHeaders(config).Authorization, 'Bearer sk-secret')
  })
  it('reports capabilities from model metadata', () => {
    assert.equal(capabilitiesFor('deepseek-reasoner').reasoning, true)
    assert.equal(capabilitiesFor('deepseek-chat').reasoning, false)
    assert.equal(capabilitiesFor('unknown').streaming, true)
  })
  it('converts tools and messages', () => {
    assert.deepEqual(normalizeTools([{ name: 't', description: 'd', inputSchema: { type: 'object' } }]),
      [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }])
    const [m] = normalizeMessages([{ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', input: { a: 1 } }] }])
    assert.equal(m.tool_calls[0].function.arguments, '{"a":1}')
  })
  it('maps HTTP and network failures', () => {
    assert.equal(errorFromResponse(401).code, 'authentication_error')
    const rl = errorFromResponse(429)
    assert.equal(rl.code, 'rate_limit'); assert.equal(rl.retryable, true)
    assert.equal(errorFromResponse(503).retryable, true)
    assert.equal(errorFromResponse(400).retryable, false)
    assert.equal(errorFromException(new TypeError('fetch failed')).code, 'network_error')
    assert.equal(errorFromException(Object.assign(new Error('x'), { name: 'AbortError' })).code, 'cancelled')
  })
  it('parses stream chunks into neutral events', () => {
    const p = createChunkParser()
    const out = [
      ...p.push({ choices: [{ delta: { content: 'Hel' } }] }),
      ...p.push({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
      ...p.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
      ...p.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }] }),
      ...p.push({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } }),
      ...p.flush(),
    ]
    assert.deepEqual(out.map(e => e.type), ['text_delta', 'reasoning_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'usage', 'tool_call_complete', 'completed'])
    assert.deepEqual(out.find(e => e.type === 'tool_call_complete').input, { path: 'a' })
    assert.equal(out.at(-1).finishReason, 'tool_calls')
  })
  it('turns malformed tool arguments into a recoverable inputError', () => {
    const p = createChunkParser()
    p.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{bad' } }] } }] })
    const done = p.flush().find(e => e.type === 'tool_call_complete')
    assert.equal(done.input, null)
    assert.match(done.inputError, /not valid JSON/)
    assert.equal(done.rawArguments, '{bad')
  })

  function sseResponse(lines, status = 200) {
    const body = new ReadableStream({
      start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close() },
    })
    return { ok: status < 400, status, body, text: async () => 'detail' }
  }

  it('reads SSE payloads', async () => {
    const res = sseResponse(['data: {"a":1}\n\n', 'data: [DONE]\n\n'])
    const out = []
    for await (const d of readSse(res.body)) out.push(d)
    assert.deepEqual(out, ['{"a":1}', '[DONE]'])
  })
  it('streams end-to-end with a mocked fetch', async () => {
    let captured
    const fetchImpl = async (url, init) => {
      captured = { url, init }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    }
    const provider = createDeepSeekProvider({ getConfig: () => config, fetchImpl })
    const events = []
    await provider.stream({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], tools: [] }, { onEvent: e => events.push(e) })
    assert.deepEqual(events.map(e => e.type), ['text_delta', 'completed'])
    assert.equal(JSON.parse(captured.init.body).stream, true)
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-secret')
  })
  it('surfaces config errors before any fetch', async () => {
    let called = false
    const provider = createDeepSeekProvider({ getConfig: () => ({ ...config, apiKey: '' }), fetchImpl: async () => { called = true } })
    await assert.rejects(provider.stream({ model: 'm', messages: [] }, { onEvent() {} }), e => e.code === 'configuration_error')
    assert.equal(called, false)
  })
  it('maps HTTP failures from the transport', async () => {
    const provider = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async () => sseResponse([], 429) })
    await assert.rejects(provider.stream({ model: 'm', messages: [] }, { onEvent() {} }), e => e.code === 'rate_limit' && e.retryable)
  })
  it('supports cancellation via AbortSignal', async () => {
    const fetchImpl = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    const provider = createDeepSeekProvider({ getConfig: () => config, fetchImpl })
    const ac = new AbortController()
    const p = provider.stream({ model: 'm', messages: [], signal: ac.signal }, { onEvent() {} })
    ac.abort()
    await assert.rejects(p, e => e.code === 'cancelled')
  })
})

describe('runtime config', () => {
  it('reads env and redacts secrets', () => {
    const c = loadRuntimeConfig({ DEEPSEEK_API_KEY: 'sk-secret', DEEPSEEK_MODEL: 'deepseek-chat' })
    assert.equal(c.providers.deepseek.apiKey, 'sk-secret')
    assert.equal(c.defaultModel, 'deepseek-chat')
    assert.equal(c.defaultProvider, 'deepseek')
    assert.ok(!JSON.stringify(redactConfig(c)).includes('sk-secret'))
  })
})
