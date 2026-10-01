// DeepSeek adapter protocol tests: mocked fetch and SSE streams, no network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekProvider, buildRequestBody, capabilitiesFor } from './deepseek.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { withRetry, backoffDelay } from './retry.js'
import { createError } from '../protocol/schemas.js'

const config = { apiKey: 'sk-secret-123456789', baseUrl: 'https://api.example.com', model: 'deepseek-chat' }
const enc = new TextEncoder()

const sse = (...chunks) => chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
const delta = (d, finish = null, extra = {}) => ({ choices: [{ delta: d, finish_reason: finish }], ...extra })

/** Response whose body delivers `text` in pieces of `size` bytes (to exercise SSE framing). */
function response(text, { size = Infinity, status = 200, hang = false, signal } = {}) {
  const bytes = enc.encode(text)
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += Math.min(size, bytes.length)) c.enqueue(bytes.subarray(i, i + Math.min(size, bytes.length)))
      if (!hang) c.close()
      else signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    },
  })
  return { ok: status < 400, status, body, text: async () => 'detail' }
}

async function run(text, { size, opts = {}, request = {} } = {}) {
  const provider = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async () => response(text, { size }), ...opts })
  const events = []
  await provider.stream({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], tools: [], ...request }, { onEvent: e => events.push(e) })
  return events
}

describe('deepseek streaming', () => {
  it('streams plain text, including text split across chunks and SSE frames', async () => {
    const text = sse(delta({ content: 'Hel' }), delta({ content: 'lo, ' }), delta({ content: 'world' }, 'stop'), '[DONE]')
    for (const size of [Infinity, 7, 1]) {
      const events = await run(text, { size })
      assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'Hello, world', `size ${size}`)
      assert.equal(events.at(-1).type, 'completed')
      assert.equal(events.at(-1).finishReason, 'stop')
    }
  })

  it('assembles a single tool call', async () => {
    const events = await run(sse(
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/App.jsx"}' } }] }),
      delta({}, 'tool_calls'), '[DONE]'))
    const done = events.filter(e => e.type === 'tool_call_complete')
    assert.deepEqual(done.map(e => [e.id, e.name, e.input]), [['call_1', 'read_file', { path: 'src/App.jsx' }]])
    assert.equal(events.at(-1).finishReason, 'tool_calls')
  })

  it('assembles multiple tool calls in index order, even when interleaved', async () => {
    const events = await run(sse(
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path"' } }, { index: 1, id: 'b', function: { name: 'git_status', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '{}' } }, { index: 0, function: { arguments: ':"x.js"}' } }] }, 'tool_calls'), '[DONE]'))
    assert.deepEqual(events.filter(e => e.type === 'tool_call_complete').map(e => [e.id, e.name, e.input]),
      [['a', 'read_file', { path: 'x.js' }], ['b', 'git_status', {}]])
  })

  it('reconstructs fragmented arguments, including fragments split inside strings and multi-byte characters', async () => {
    const frags = ['{"pa', 'th":"src/', 'App.jsx","note":"caf', 'é ☃"}']
    const events = await run(sse(
      delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: frags[0] } }] }),
      ...frags.slice(1).map(f => delta({ tool_calls: [{ index: 0, function: { arguments: f } }] })),
      delta({}, 'tool_calls'), '[DONE]'), { size: 3 })
    assert.deepEqual(events.find(e => e.type === 'tool_call_complete').input, { path: 'src/App.jsx', note: 'café ☃' })
    assert.equal(events.filter(e => e.type === 'tool_call_delta').length, 4)
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
  })

  it('preserves text that precedes tool calls', async () => {
    const events = await run(sse(delta({ content: 'Let me look.' }), delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] }, 'tool_calls'), '[DONE]'))
    assert.deepEqual(events.map(e => e.type), ['text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_complete', 'completed'])
  })

  it('flags malformed tool arguments without throwing so the model can correct them', async () => {
    const events = await run(sse(delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{"path": ' } }] }, 'tool_calls'), '[DONE]'))
    const done = events.find(e => e.type === 'tool_call_complete')
    assert.equal(done.input, null)
    assert.match(done.inputError, /not valid JSON/)
  })

  it('generates an id when the provider omits one', async () => {
    const events = await run(sse(delta({ tool_calls: [{ index: 0, function: { name: 'git_status', arguments: '{}' } }] }, 'tool_calls'), '[DONE]'))
    assert.match(events.find(e => e.type === 'tool_call_complete').id, /^call_0_/)
  })

  it('extracts usage, including reasoning tokens', async () => {
    const events = await run(sse(
      delta({ content: 'ok' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 12 } } }, '[DONE]'))
    assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', input: 120, output: 30, reasoning: 12, total: 150 })
  })

  it('emits reasoning_delta for reasoning_content and keeps it separate from text', async () => {
    const events = await run(sse(delta({ reasoning_content: 'hmm ' }), delta({ reasoning_content: 'ok' }), delta({ content: 'Answer' }, 'stop'), '[DONE]'))
    assert.equal(events.filter(e => e.type === 'reasoning_delta').map(e => e.text).join(''), 'hmm ok')
    assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'Answer')
  })

  it('treats a stream that ends before completion as an invalid response', async () => {
    await assert.rejects(run(sse(delta({ content: 'partial' }))), e => e.code === 'invalid_response')
  })

  it('handles malformed stream data with a normalized error', async () => {
    await assert.rejects(run(`data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {not json\n\n`), e => e.code === 'invalid_response' && !/not json/.test(e.message))
  })

  it('surfaces in-stream error payloads', async () => {
    await assert.rejects(run(sse({ error: { message: 'overloaded' } })), e => e.code === 'provider_error' && /overloaded/.test(e.message))
  })

  it('maps insufficient_system_resource to a retryable provider error', async () => {
    await assert.rejects(run(sse(delta({ content: 'x' }, 'insufficient_system_resource'), '[DONE]')), e => e.code === 'provider_error' && e.retryable)
  })
})

describe('deepseek errors', () => {
  const failing = (status, body = 'detail') => createDeepSeekProvider({
    getConfig: () => config,
    fetchImpl: async () => ({ ok: false, status, text: async () => body }),
  })
  const attempt = (p) => p.stream({ model: 'm', messages: [] }, { onEvent() {} })

  it('rate limit → retryable rate_limit', async () => {
    await assert.rejects(attempt(failing(429)), e => e.code === 'rate_limit' && e.retryable === true)
  })
  it('server errors → retryable provider_error', async () => {
    for (const status of [500, 502, 503]) await assert.rejects(attempt(failing(status)), e => e.code === 'provider_error' && e.retryable === true)
  })
  it('authentication → non-retryable authentication_error', async () => {
    for (const status of [401, 403]) await assert.rejects(attempt(failing(status)), e => e.code === 'authentication_error' && e.retryable === false)
  })
  it('bad request → non-retryable provider_error', async () => {
    await assert.rejects(attempt(failing(400)), e => e.code === 'provider_error' && !e.retryable)
  })
  it('network failure → retryable network_error', async () => {
    const p = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async () => { throw new TypeError('fetch failed') } })
    await assert.rejects(attempt(p), e => e.code === 'network_error' && e.retryable)
  })
  it('never leaks the API key or auth header in errors', async () => {
    const echo = failing(401, `Incorrect API key provided: ${config.apiKey}. Authorization: Bearer ${config.apiKey}`)
    await assert.rejects(attempt(echo), e => {
      const text = JSON.stringify(e)
      assert.ok(!text.includes('123456789'), text)
      return true
    })
  })
  it('validates credentials and model before any request', async () => {
    let fetched = false
    const p = createDeepSeekProvider({ getConfig: () => ({ ...config, apiKey: '' }), fetchImpl: async () => { fetched = true } })
    assert.throws(() => p.validate('deepseek-chat'), e => e.code === 'configuration_error')
    await assert.rejects(attempt(p), e => e.code === 'configuration_error')
    assert.equal(fetched, false)
    assert.doesNotThrow(() => createDeepSeekProvider({ getConfig: () => config }).validate('deepseek-chat'))
  })
})

describe('deepseek cancellation and timeouts', () => {
  it('cancels before the request is sent', async () => {
    const ac = new AbortController(); ac.abort()
    const p = createDeepSeekProvider({ getConfig: () => config, fetchImpl: async () => { throw new Error('should not fetch') } })
    await assert.rejects(p.stream({ model: 'm', messages: [], signal: ac.signal }, { onEvent() {} }), e => e.code === 'cancelled')
  })
  it('cancels while headers are pending', async () => {
    const fetchImpl = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))
    const ac = new AbortController()
    const p = createDeepSeekProvider({ getConfig: () => config, fetchImpl })
    const pending = p.stream({ model: 'm', messages: [], signal: ac.signal }, { onEvent() {} })
    setTimeout(() => ac.abort(), 10)
    await assert.rejects(pending, e => e.code === 'cancelled')
  })
  it('cancels in the middle of a stream and stops emitting', async () => {
    const ac = new AbortController()
    const events = []
    const fetchImpl = async (_u, init) => response(sse(delta({ content: 'a' })), { hang: true, signal: init.signal })
    const p = createDeepSeekProvider({ getConfig: () => config, fetchImpl })
    const pending = p.stream({ model: 'm', messages: [], signal: ac.signal }, { onEvent: e => { events.push(e); ac.abort() } })
    await assert.rejects(pending, e => e.code === 'cancelled')
    assert.equal(events.length, 1)
  })
  it('request timeout → retryable provider_timeout', async () => {
    const fetchImpl = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))
    const p = createDeepSeekProvider({ getConfig: () => config, fetchImpl, requestTimeoutMs: 20, streamTimeoutMs: 1000 })
    await assert.rejects(p.stream({ model: 'm', messages: [] }, { onEvent() {} }), e => e.code === 'provider_timeout' && e.retryable && /request timeout/.test(e.message))
  })
  it('stream inactivity timeout is distinct from the request timeout', async () => {
    const fetchImpl = async (_u, init) => response(sse(delta({ content: 'a' })), { hang: true, signal: init.signal })
    const p = createDeepSeekProvider({ getConfig: () => config, fetchImpl, requestTimeoutMs: 1000, streamTimeoutMs: 30 })
    const events = []
    await assert.rejects(p.stream({ model: 'm', messages: [] }, { onEvent: e => events.push(e) }), e => e.code === 'provider_timeout' && /stalled/.test(e.message))
    assert.equal(events[0].text, 'a')
  })
})

describe('deepseek request construction', () => {
  it('derives tool schemas from the canonical registry rather than duplicating them', () => {
    const tools = createDefaultToolRegistry().describeTools()
    const body = buildRequestBody({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], tools, temperature: 0, maxOutputTokens: 100 }, capabilitiesFor('deepseek-chat'))
    assert.equal(body.tools.length, 11)
    const read = body.tools.find(t => t.function.name === 'read_file')
    assert.deepEqual(read.function.parameters, tools.find(t => t.name === 'read_file').inputSchema)
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.equal(body.max_tokens, 100)
  })

  it('converts tool-call history and tool results into the native continuation format', () => {
    const body = buildRequestBody({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 's' }, { role: 'user', content: 'u', id: 'x', timestamp: 1 },
        { role: 'assistant', content: 'Reading', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }, { id: 'c2', name: 'grep', input: null }] },
        { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'Tool: read_file\n...' },
        { role: 'tool', toolCallId: 'c2', name: 'grep', content: 'Error' },
      ],
    }, capabilitiesFor('deepseek-chat'))
    assert.deepEqual(body.messages[2], {
      role: 'assistant', content: 'Reading',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }, { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } }],
    })
    assert.deepEqual(body.messages[3], { role: 'tool', content: 'Tool: read_file\n...', tool_call_id: 'c1' })
    assert.ok(!('name' in body.messages[3]) && !('id' in body.messages[1]))
  })

  it('echoes reasoning only on tool turns of the current exchange', () => {
    const call = [{ id: 'c', name: 'grep', input: {} }]
    const body = buildRequestBody({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: '', toolCalls: call, reasoning: 'old thoughts' },
        { role: 'tool', toolCallId: 'c', content: 'r' }, { role: 'assistant', content: 'done', reasoning: 'final thoughts' },
        { role: 'user', content: 'second' }, { role: 'assistant', content: '', toolCalls: call, reasoning: 'new thoughts' },
        { role: 'tool', toolCallId: 'c', content: 'r' },
      ],
      temperature: 0,
    }, capabilitiesFor('deepseek-reasoner'))
    assert.equal(body.messages[1].reasoning_content, undefined)
    assert.equal(body.messages[3].reasoning_content, undefined)
    assert.equal(body.messages[5].reasoning_content, 'new thoughts')
    assert.ok(!('temperature' in body))
  })
})

describe('retry helper', () => {
  const opts = { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, sleep: async () => {}, random: () => 1 }
  it('backs off exponentially with a cap and jitter', () => {
    const o = { baseDelayMs: 100, maxDelayMs: 300, random: () => 1 }
    assert.deepEqual([1, 2, 3, 4].map(a => backoffDelay(a, o)), [100, 200, 300, 300])
    assert.equal(backoffDelay(1, { ...o, random: () => 0 }), 50)
  })
  it('retries until success and reports each retry', async () => {
    const seen = []
    let n = 0
    const out = await withRetry(async () => { if (++n < 3) throw createError({ code: 'rate_limit', message: 'x', retryable: true }); return 'ok' },
      { ...opts, shouldRetry: e => e.retryable, onRetry: i => seen.push([i.attempt, i.delayMs]) })
    assert.deepEqual([out, n, seen], ['ok', 3, [[1, 100], [2, 200]]])
  })
  it('stops after maxRetries and on non-retryable errors', async () => {
    let n = 0
    await assert.rejects(withRetry(async () => { n++; throw new Error('x') }, { ...opts, shouldRetry: () => true }))
    assert.equal(n, 3)
    n = 0
    await assert.rejects(withRetry(async () => { n++; throw new Error('x') }, { ...opts, shouldRetry: () => false }))
    assert.equal(n, 1)
  })
  it('never retries after cancellation', async () => {
    const ac = new AbortController()
    let n = 0
    await assert.rejects(withRetry(async () => { n++; ac.abort(); throw new Error('x') }, { ...opts, shouldRetry: () => true, signal: ac.signal }))
    assert.equal(n, 1)
  })
})
