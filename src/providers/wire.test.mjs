// Provider-specific wire details that the shared contract deliberately does not pin down, plus the model registry.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessages as anthropicMessages, buildRequestBody as anthropicBody, buildHeaders as anthropicHeaders, ANTHROPIC_VERSION } from './anthropic.js'
import { normalizeMessages as openaiMessages, buildRequestBody as openaiBody, capabilitiesFor as openaiCaps } from './openai.js'
import { buildRequestBody as kimiBody, capabilitiesFor as kimiCaps, normalizeMessages as kimiMessages } from './kimi.js'
import { capabilitiesFor as deepseekCaps } from './deepseek.js'
import { capabilitiesFor as anthropicCaps } from './anthropic.js'
import { createProviderRegistry, createStandardProviders, defaultRegistry } from './registry.js'
import { createFakeProvider } from '../agent/testing/fakeProvider.js'
import { isCodingCapable } from './capabilities.js'
import { loadRuntimeConfig, redactConfig } from '../config/runtimeConfig.js'
import { createEnvCredentialStore } from './credentials/serverCredentialStore.js'
import { providerLabel } from './labels.js'

const TOOL = { name: 'shell', description: 'Run a command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }
const HISTORY = [
  { role: 'system', content: 'sys A' }, { role: 'system', content: 'sys B' },
  { role: 'user', content: 'run the tests' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'shell', input: { command: 'npm test' } }, { id: 't2', name: 'shell', input: null }] },
  { role: 'tool', toolCallId: 't1', name: 'shell', content: 'failed', meta: { ok: false } },
  { role: 'tool', toolCallId: 't2', name: 'shell', content: 'skipped', meta: { ok: true } },
  { role: 'user', content: 'try again' },
]

describe('anthropic wire format', () => {
  it('moves system messages into `system` and folds consecutive tool results into one user turn', () => {
    const { system, messages } = anthropicMessages(HISTORY)
    assert.equal(system, 'sys A\n\nsys B')
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user'])
    assert.deepEqual(messages[1].content.map(b => [b.type, b.id]), [['tool_use', 't1'], ['tool_use', 't2']])
    assert.deepEqual(messages[1].content[1].input, {}, 'malformed inputs are never re-sent')
    assert.deepEqual(messages[2].content.map(b => b.type), ['tool_result', 'tool_result', 'text'])
    assert.equal(messages[2].content[0].is_error, true); assert.equal('is_error' in messages[2].content[1], false)
    assert.ok(messages.every(m => m.content.length))
  })
  it('sends the version header, key header, bounded max_tokens and native tool schema', () => {
    assert.deepEqual(anthropicHeaders({ apiKey: 'k' }), { 'Content-Type': 'application/json', 'x-api-key': 'k', 'anthropic-version': ANTHROPIC_VERSION })
    const b = anthropicBody({ model: 'claude-sonnet-5-5', messages: HISTORY, tools: [TOOL], maxOutputTokens: 99999, temperature: 0 }, anthropicCaps('claude-sonnet-5-5'))
    assert.equal(b.max_tokens, 8192); assert.deepEqual(b.tools[0], { name: 'shell', description: 'Run a command', input_schema: TOOL.inputSchema })
    assert.equal(b.system, 'sys A\n\nsys B'); assert.equal(b.stream, true)
  })
})

describe('openai wire format', () => {
  it('uses instructions + input items, call_id pairing, and omits provider-side item ids', () => {
    const { instructions, input } = openaiMessages(HISTORY)
    assert.equal(instructions, 'sys A\n\nsys B')
    assert.deepEqual(input.map(i => i.type ?? i.role), ['user', 'function_call', 'function_call', 'function_call_output', 'function_call_output', 'user'])
    assert.ok(input.filter(i => i.type === 'function_call').every(i => 'call_id' in i && !('id' in i)))
    assert.equal(input[2].arguments, '{}')
  })
  it('is stateless, bounded, and drops temperature for reasoning models', () => {
    const plain = openaiBody({ model: 'gpt-4.1', messages: HISTORY, tools: [TOOL], temperature: 0, maxOutputTokens: 500 }, openaiCaps('gpt-4.1'))
    assert.deepEqual([plain.store, plain.stream, plain.max_output_tokens, plain.temperature, plain.tools[0].type, plain.tools[0].name], [false, true, 500, 0, 'function', 'shell'])
    const reasoning = openaiBody({ model: 'gpt-5', messages: HISTORY, tools: [TOOL], temperature: 0, maxOutputTokens: 500 }, openaiCaps('gpt-5'))
    assert.equal('temperature' in reasoning, false); assert.equal(reasoning.max_output_tokens, 32768)
  })
})

describe('kimi wire format', () => {
  it('is chat-completions shaped and echoes reasoning on tool turns of the current exchange', () => {
    const history = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', reasoning: 'plan', toolCalls: [{ id: 'a', name: 'shell', input: {} }] }, { role: 'tool', toolCallId: 'a', name: 'shell', content: 'ok' }]
    const m = kimiMessages(history)
    assert.equal(m[1].reasoning_content, 'plan'); assert.equal(m[2].tool_call_id, 'a')
    const body = kimiBody({ model: 'kimi-k2-thinking', messages: history, tools: [TOOL], temperature: 0 }, kimiCaps('kimi-k2-thinking'))
    assert.equal(body.tools[0].function.name, 'shell'); assert.equal('temperature' in body, false)
  })
})

describe('capabilities and the model registry', () => {
  it('capabilities come from model metadata, with documented fallbacks', () => {
    assert.deepEqual([deepseekCaps('deepseek-reasoner').reasoning, deepseekCaps('deepseek-chat').reasoning], [true, false])
    assert.equal(kimiCaps('kimi-k2-thinking').contextWindow, 256000); assert.equal(kimiCaps('moonshot-v1-8k').maxOutputTokens, 2048)
    assert.equal(openaiCaps('gpt-4.1').contextWindow, 1000000); assert.equal(openaiCaps('o3-mini').reasoning, true)
    assert.equal(anthropicCaps('claude-opus-5-5').contextWindow, 200000)
    for (const f of [deepseekCaps, kimiCaps, openaiCaps, anthropicCaps]) assert.equal(isCodingCapable(f('some-unknown-model')), true, 'unknown models get the provider fallback')
  })
  it('lists models per provider, includes the server-configured one, and flags unknown ids', () => {
    const [ds, , oa, an] = createStandardProviders({ getConfig: (id) => ({ apiKey: 'k', baseUrl: 'https://x', model: { deepseek: 'deepseek-chat', kimi: 'kimi-x', openai: 'gpt-custom-1', anthropic: 'claude-sonnet-5-5' }[id] }) })
    assert.ok(ds.listModels().some(m => m.id === 'deepseek-reasoner'))
    const custom = oa.listModels().find(m => m.id === 'gpt-custom-1'); assert.deepEqual([custom.known, custom.provider], [false, 'openai'])
    assert.equal(an.listModels().filter(m => m.id === 'claude-sonnet-5-5').length, 1, 'no duplicates when the configured model is already known')
    const reg = createProviderRegistry([ds, oa])
    assert.deepEqual(reg.listProviders(), ['deepseek', 'openai'])
    assert.equal(reg.resolveModel('openai', 'gpt-4.1').known, true)
    assert.deepEqual([reg.resolveModel('openai', 'brand-new').known, reg.resolveModel('openai', 'brand-new').capabilities.toolCalling], [false, true])
    assert.throws(() => reg.listModels('nope'), (e) => e.code === 'configuration_error')
  })
  it('adapters without model lists still register (the fake provider)', () => {
    const reg = createProviderRegistry([createFakeProvider({ id: 'f' })])
    assert.deepEqual(reg.listModels('f'), []); assert.equal(reg.resolveModel('f', 'm').provider, 'f')
  })
  it('the default registry has all four providers and a label for each', () => {
    assert.deepEqual(defaultRegistry.listProviders().map(providerLabel), ['DeepSeek', 'Kimi', 'OpenAI', 'Anthropic'])
  })
})

describe('provider configuration', () => {
  it('reads each provider\'s server variables, ignores VITE_ secrets, and redacts keys', () => {
    const cfg = loadRuntimeConfig({
      DEEPSEEK_API_KEY: 'sk-d-1', KIMI_API_KEY: 'sk-k-1', KIMI_MODEL: 'kimi-k2-thinking', OPENAI_API_KEY: 'sk-o-1', OPENAI_BASE_URL: 'https://proxy.example/v1',
      ANTHROPIC_API_KEY: 'sk-a-1', ANTHROPIC_MODEL: 'claude-sonnet-5-5', VITE_OPENAI_API_KEY: 'browser-visible',
    })
    assert.deepEqual(Object.keys(cfg.providers).sort(), ['anthropic', 'deepseek', 'kimi', 'openai'])
    assert.equal(cfg.providers.openai.baseUrl, 'https://proxy.example/v1'); assert.equal(cfg.providers.kimi.baseUrl, 'https://api.moonshot.ai/v1'); assert.equal(cfg.providers.anthropic.baseUrl, 'https://api.anthropic.com')
    assert.equal(cfg.providers.openai.apiKey, 'sk-o-1', 'only the unprefixed key is read')
    assert.doesNotMatch(JSON.stringify(redactConfig(cfg)), /sk-[dkoa]-1|browser-visible/)
  })
  it('the server credential store reports configuration per provider without exposing keys', () => {
    const store = createEnvCredentialStore({ KIMI_API_KEY: 'sk-k-2', KIMI_MODEL: 'kimi-k2-thinking' })
    assert.deepEqual(store.describe().map(p => [p.provider, p.configured]), [['deepseek', false], ['kimi', true], ['openai', false], ['anthropic', false]])
    assert.doesNotMatch(JSON.stringify(store.describe()), /sk-k-2/)
    assert.throws(() => store.getCredential('openai'), (e) => e.code === 'configuration_error' && /OPENAI_API_KEY/.test(e.message))
  })
})
