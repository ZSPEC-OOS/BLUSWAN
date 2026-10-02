// One behavioural contract, run against every adapter through its own native wire format (no network).
// A provider that passes is interchangeable to the runtime: same events, same errors, same cancellation.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekProvider } from './deepseek.js'
import { createKimiProvider } from './kimi.js'
import { createOpenAIProvider } from './openai.js'
import { createAnthropicProvider } from './anthropic.js'
import { assertProviderAdapter } from './provider.js'
import { isValidProviderEvent } from './normalize.js'
import { assertCodingCapable, isCodingCapable } from './capabilities.js'
import { WIRE, streamError, mockFetch, fragments } from './testing/wire.js'

const KEY = 'sk-contract-test-key-0123456789'
const ADAPTERS = [
  { name: 'deepseek', make: createDeepSeekProvider, wire: 'chat', model: 'deepseek-chat', url: '/chat/completions', authHeader: (h) => h.Authorization === `Bearer ${KEY}`, maxField: (b) => b.max_tokens, toolNames: (b) => b.tools.map(t => t.function.name) },
  { name: 'kimi', make: createKimiProvider, wire: 'chat', model: 'kimi-k2-thinking', url: '/chat/completions', authHeader: (h) => h.Authorization === `Bearer ${KEY}`, maxField: (b) => b.max_tokens, toolNames: (b) => b.tools.map(t => t.function.name) },
  { name: 'openai', make: createOpenAIProvider, wire: 'responses', model: 'gpt-4.1', url: '/responses', authHeader: (h) => h.Authorization === `Bearer ${KEY}`, maxField: (b) => b.max_output_tokens, toolNames: (b) => b.tools.map(t => t.name) },
  { name: 'anthropic', make: createAnthropicProvider, wire: 'anthropic', model: 'claude-sonnet-5-5', url: '/v1/messages', authHeader: (h) => h['x-api-key'] === KEY && !!h['anthropic-version'], maxField: (b) => b.max_tokens, toolNames: (b) => b.tools.map(t => t.name) },
]

const TOOLS = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
const HISTORY = [
  { role: 'system', content: 'You are BLUSWAN.' },
  { role: 'user', content: 'Fix the bug in math.js' },
  { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'src/math.js' } }] },
  { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'export const add = (a, b) => a - b', meta: { ok: true } },
  { role: 'user', content: 'ok go on' },
]

const config = (a, extra = {}) => ({ apiKey: KEY, baseUrl: 'https://api.example.test', model: a.model, ...extra })
const make = (a, fetchImpl, cfg = {}, deps = {}) => a.make({ getConfig: () => config(a, cfg), fetchImpl, ...deps })

async function collect(provider, request) {
  const events = []
  await provider.stream({ model: request.model, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, ...request }, { onEvent: (e) => events.push(e) })
  const out = { events, text: '', reasoning: '', calls: [], usage: null, finish: null }
  for (const e of events) {
    if (e.type === 'text_delta') out.text += e.text
    else if (e.type === 'reasoning_delta') out.reasoning += e.text
    else if (e.type === 'tool_call_complete') out.calls.push(e)
    else if (e.type === 'usage') out.usage = e
    else if (e.type === 'completed') out.finish = e.finishReason
  }
  return out
}
/** The stream cut right after the frame carrying `needle` (so it never reaches its terminal event). */
const upToFirstText = (stream, needle) => { const frames = stream.split('\n\n').filter(Boolean); return `${frames.slice(0, frames.findIndex(f => f.includes(needle)) + 1).join('\n\n')}\n\n` }
const rejects = async (p) => { try { await p } catch (e) { return e } throw new Error('expected rejection') }

/** A fetch whose body never ends until the caller aborts. */
const hangingFetch = (firstChunk = '') => async (url, init) => {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({
    start(c) {
      if (firstChunk) c.enqueue(enc.encode(firstChunk))
      init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    },
  }), { status: 200 })
}

for (const a of ADAPTERS) {
  const sse = (sc) => WIRE[a.wire](sc)
  describe(`provider contract: ${a.name}`, () => {
    it('is a valid adapter whose model is coding-capable and listed', () => {
      const p = make(a, mockFetch(() => ''))
      assertProviderAdapter(p)
      const caps = p.capabilities(a.model)
      assert.equal(isCodingCapable(caps), true)
      for (const k of ['streaming', 'toolCalling', 'reasoning', 'parallelToolCalls']) assert.equal(typeof caps[k], 'boolean')
      for (const k of ['contextWindow', 'maxOutputTokens']) assert.ok(caps[k] > 0)
      assert.ok(p.listModels().some(m => m.id === a.model), 'the configured model is offered')
      assert.ok(p.listModels().every(m => m.provider === a.name && m.capabilities && typeof m.displayName === 'string'))
    })

    it('streams text and completes', async () => {
      const r = await collect(make(a, mockFetch(() => sse({ text: ['Hel', 'lo ', 'world'], usage: { input: 10, output: 3 } }))), { model: a.model })
      assert.equal(r.text, 'Hello world'); assert.equal(r.finish, 'stop'); assert.equal(r.calls.length, 0)
      assert.ok(r.events.every(isValidProviderEvent), 'every event is canonical')
      assert.equal(r.events.at(-1).type, 'completed')
    })

    it('emits a tool call whose fragmented arguments are reassembled as {id, name, input}', async () => {
      const r = await collect(make(a, mockFetch(() => sse({ calls: [{ id: 'call_a', name: 'read_file', args: '{"path":"src/ünï/math.js"}', parts: 5 }] }))), { model: a.model })
      assert.deepEqual(r.calls.map(c => [c.id, c.name, c.input]), [['call_a', 'read_file', { path: 'src/ünï/math.js' }]])
      assert.equal(r.finish, 'tool_calls')
      assert.ok(r.events.some(e => e.type === 'tool_call_start') && r.events.some(e => e.type === 'tool_call_delta'))
      assert.ok(r.events.indexOf(r.events.find(e => e.type === 'tool_call_complete')) < r.events.findIndex(e => e.type === 'completed'))
    })

    it('keeps text that precedes a tool call, and returns several calls in order', async () => {
      const r = await collect(make(a, mockFetch(() => sse({ text: ['Checking '], calls: [{ id: 'c1', name: 'read_file', args: '{"path":"a"}' }, { id: 'c2', name: 'read_file', args: '{"path":"b"}' }] }))), { model: a.model })
      assert.equal(r.text, 'Checking '); assert.deepEqual(r.calls.map(c => [c.id, c.input.path]), [['c1', 'a'], ['c2', 'b']])
    })

    it('flags malformed tool arguments as a recoverable inputError instead of throwing', async () => {
      const r = await collect(make(a, mockFetch(() => sse({ calls: [{ id: 'c1', name: 'read_file', args: '{"path": "unterminated' }] }))), { model: a.model })
      assert.equal(r.calls[0].input, null); assert.match(r.calls[0].inputError, /not valid JSON/); assert.ok(r.events.every(isValidProviderEvent))
    })

    it('keeps reasoning separate from text', async () => {
      const r = await collect(make(a, mockFetch(() => sse({ reasoning: ['thinking…'], text: ['answer'] }))), { model: a.model })
      assert.equal(r.text, 'answer'); assert.doesNotMatch(r.text, /thinking/)
    })

    it('normalizes usage, including reasoning and cached input when reported', async () => {
      const r = await collect(make(a, mockFetch(() => sse({ text: ['x'], usage: { input: 120, output: 30, cached: 100 } }))), { model: a.model })
      assert.equal(r.usage.input, 120); assert.equal(r.usage.output, 30); assert.equal(r.usage.total, 150); assert.equal(r.usage.cachedInput, 100)
      const none = await collect(make(a, mockFetch(() => sse({ text: ['x'], usage: { input: 5, output: 2 } }))), { model: a.model })
      assert.equal('cachedInput' in none.usage, false, 'absent when the provider does not report it')
    })

    it('serializes canonical history, tools and tool results into its native request', async () => {
      const f = mockFetch(() => sse({ text: ['ok'] }))
      await collect(make(a, f), { model: a.model, messages: HISTORY, tools: TOOLS, temperature: 0, maxOutputTokens: 1000 })
      const { url, body, headers } = f.calls[0]
      assert.equal(url, `https://api.example.test${a.url}`)
      assert.ok(a.authHeader(headers), 'authenticates with the provider\'s own header')
      assert.equal(body.model, a.model); assert.equal(body.stream, true)
      assert.deepEqual(a.toolNames(body), ['read_file'])
      const text = JSON.stringify(body)
      for (const needle of ['You are BLUSWAN.', 'Fix the bug in math.js', 'call_1', 'src/math.js', 'a - b', 'ok go on']) assert.ok(text.includes(needle), `request carries ${needle}`)
      assert.ok(a.maxField(body) <= 1000 || a.name === 'openai', 'output limit respected')
      assert.doesNotMatch(text, new RegExp(KEY), 'the key is only ever a header')
    })

    it('never sends the tools of a model that cannot call them', async () => {
      const f = mockFetch(() => sse({ text: ['ok'] }))
      const p = make(a, f)
      p.capabilities = () => ({ streaming: true, toolCalling: false, reasoning: false, parallelToolCalls: false, contextWindow: 8000, maxOutputTokens: 1000 })
      // direct use of the adapter's own body builder through a request with tools: adapters consult capabilities(model)
      const body = (await import(`./${a.name}.js`)).buildRequestBody({ model: a.model, messages: HISTORY, tools: TOOLS }, p.capabilities())
      assert.equal(body.tools, undefined)
    })

    it('maps HTTP failures to canonical errors without leaking the key', async () => {
      const status = (code, text = '') => rejects(make(a, async () => new Response(`${text} ${KEY}`, { status: code })).stream({ model: a.model, messages: [{ role: 'user', content: 'x' }] }, { onEvent() {} }))
      const e401 = await status(401); assert.deepEqual([e401.code, e401.retryable], ['authentication_error', false])
      const e429 = await status(429); assert.deepEqual([e429.code, e429.retryable], ['rate_limit', true])
      const e500 = await status(500); assert.deepEqual([e500.code, e500.retryable], ['provider_error', true])
      const e400 = await status(400, 'bad'); assert.deepEqual([e400.code, e400.retryable], ['provider_error', false])
      const ctx = await status(400, 'This model\'s maximum context length is 8192 tokens; your prompt is too long'); assert.equal(ctx.code, 'context_limit')
      const big = await status(413); assert.equal(big.code, 'context_limit')
      for (const e of [e401, e429, e500, e400, ctx]) { assert.doesNotMatch(JSON.stringify(e), new RegExp(KEY)); assert.equal(e.provider, a.name) }
      const net = await rejects(make(a, async () => { throw new TypeError('fetch failed') }).stream({ model: a.model, messages: [] }, { onEvent() {} }))
      assert.deepEqual([net.code, net.retryable], ['network_error', true])
    })

    it('maps in-stream errors to canonical errors', async () => {
      const go = (payload) => rejects(make(a, mockFetch(() => payload)).stream({ model: a.model, messages: [{ role: 'user', content: 'x' }] }, { onEvent() {} }))
      const generic = await go(streamError[a.wire]('upstream exploded')); assert.ok(['provider_error', 'rate_limit'].includes(generic.code))
      const limited = await go(a.wire === 'anthropic' ? streamError.anthropic('slow down', 'rate_limit_error') : a.wire === 'responses' ? streamError.responses('slow down', 'rate_limit_exceeded') : streamError.chat('slow down', 'rate_limit_reached'))
      assert.deepEqual([limited.code, limited.retryable], ['rate_limit', true])
    })

    it('fails with configuration_error before any request when credentials or model are missing', async () => {
      const f = mockFetch(() => '')
      assert.equal((await rejects(make(a, f, { apiKey: '' }).stream({ model: a.model, messages: [] }, { onEvent() {} }))).code, 'configuration_error')
      assert.equal((await rejects(make(a, f, { model: '' }).stream({ model: '', messages: [] }, { onEvent() {} }))).code, 'configuration_error')
      assert.throws(() => make(a, f, { apiKey: '' }).validate(a.model), (e) => e.code === 'configuration_error' && /server/.test(e.message) && !/VITE_/.test(e.message))
      assert.equal(f.calls.length, 0)
    })

    it('rejects malformed chunks and truncated streams as invalid_response', async () => {
      const bad = await rejects(make(a, mockFetch(() => 'data: {not json\n\n')).stream({ model: a.model, messages: [] }, { onEvent() {} }))
      assert.equal(bad.code, 'invalid_response')
      const cut = await rejects(make(a, mockFetch(() => upToFirstText(sse({ text: ['partial'] }), 'partial'))).stream({ model: a.model, messages: [] }, { onEvent() {} }))
      assert.equal(cut.code, 'invalid_response')
    })

    it('supports cancellation: before the request, while waiting for headers, and mid-stream', async () => {
      const early = new AbortController(); early.abort()
      assert.equal((await rejects(make(a, mockFetch(() => '')).stream({ model: a.model, messages: [], signal: early.signal }, { onEvent() {} }))).code, 'cancelled')

      const waiting = new AbortController()
      const p1 = rejects(make(a, (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))).stream({ model: a.model, messages: [], signal: waiting.signal }, { onEvent() {} }))
      setTimeout(() => waiting.abort(), 10)
      assert.equal((await p1).code, 'cancelled')

      const mid = new AbortController(); const seen = []
      const first = upToFirstText(sse({ text: ['one '] }), 'one ')
      const p2 = rejects(make(a, hangingFetch(first)).stream({ model: a.model, messages: [], signal: mid.signal }, { onEvent: (e) => { seen.push(e); if (e.type === 'text_delta') setTimeout(() => mid.abort(), 5) } }))
      const e2 = await p2
      assert.equal(e2.code, 'cancelled'); assert.ok(seen.some(e => e.type === 'text_delta'))
    })

    it('distinguishes request timeout from stream inactivity', async () => {
      const slow = (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
      const req = await rejects(make(a, (u, init) => slow(init), {}, { requestTimeoutMs: 20, streamTimeoutMs: 1000 }).stream({ model: a.model, messages: [] }, { onEvent() {} }))
      assert.deepEqual([req.code, req.retryable, /request timeout/.test(req.message)], ['provider_timeout', true, true])
      const idle = await rejects(make(a, hangingFetch(': keep\n\n'), {}, { requestTimeoutMs: 1000, streamTimeoutMs: 20 }).stream({ model: a.model, messages: [] }, { onEvent() {} }))
      assert.deepEqual([idle.code, /inactivity/.test(idle.message)], ['provider_timeout', true])
    })
  })
}

describe('capability gate', () => {
  it('rejects models without tool calling or streaming as unsupported_feature', () => {
    assert.throws(() => assertCodingCapable({ streaming: true, toolCalling: false }, { provider: 'x', model: 'chat-only' }), (e) => e.code === 'unsupported_feature' && /chat-only/.test(e.message))
    assert.throws(() => assertCodingCapable({ streaming: false, toolCalling: true }), (e) => e.code === 'unsupported_feature')
    assert.doesNotThrow(() => assertCodingCapable({ streaming: true, toolCalling: true }))
  })
  it('fragments helper splits arguments', () => assert.equal(fragments('abcdef', 3).join(''), 'abcdef'))
})
