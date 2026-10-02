// Anthropic adapter on the Messages API. System prompt, content blocks, tool_use / tool_result and stream events are
// Anthropic-specific and stay in this file; the runtime only sees canonical messages and neutral events.
import { createAdapter } from './adapter.js'
import { capabilitiesFromTable } from './capabilities.js'
import { createProviderErrors } from './errors.js'
import { textDelta, reasoningDelta, toolCallStart, toolCallDelta, toolCallComplete, usage, completed } from './normalize.js'

export const ANTHROPIC_ID = 'anthropic'
const LABEL = 'Anthropic'
export const ANTHROPIC_VERSION = '2023-06-01'

const MODEL_CAPABILITIES = [
  { prefix: 'claude-', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 200000, maxOutputTokens: 8192 } },
]
const FALLBACK = { toolCalling: true, contextWindow: 200000, maxOutputTokens: 8192 }
export const MODELS = [
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
]

const errors = createProviderErrors({ id: ANTHROPIC_ID, label: LABEL })
export const capabilitiesFor = (model = '') => capabilitiesFromTable(MODEL_CAPABILITIES, model, FALLBACK)

/** Canonical messages → { system, messages } with tool results folded into user turns. */
export function normalizeMessages(messages = []) {
  const system = []
  const out = []
  const push = (role, blocks) => {
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks) // the API wants alternating turns; adjacent same-role turns merge
    else out.push({ role, content: [...blocks] })
  }
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content)
    else if (m.role === 'user') push('user', [{ type: 'text', text: m.content }])
    else if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} })
      if (blocks.length) push('assistant', blocks)
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.meta?.ok === false ? { is_error: true } : {}) }])
    }
  }
  return { system: system.join('\n\n'), messages: out }
}

export const normalizeTools = (tools = []) => tools.map(t => ({
  name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} },
}))

export function buildRequestBody(request, caps) {
  const { system, messages } = normalizeMessages(request.messages)
  const body = { model: request.model, max_tokens: Math.min(request.maxOutputTokens ?? caps.maxOutputTokens, caps.maxOutputTokens), messages, stream: true }
  if (system) body.system = system
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.tools?.length && caps.toolCalling) body.tools = normalizeTools(request.tools)
  return body
}

export const buildHeaders = (config) => ({ 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION })
export const buildUrl = (config) => `${config.baseUrl.replace(/\/+$/, '')}/v1/messages`

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' }

/** Messages API stream events → neutral events. */
export function createStreamParser() {
  const blocks = new Map() // index → { type, id, name, args }
  let inputTokens = 0
  let cached
  let outputTokens = 0
  let finishReason = null
  let stopped = false
  let done = false
  const completes = []

  function closeBlock(index) {
    const b = blocks.get(index)
    if (!b || b.type !== 'tool_use' || b.closed) return
    b.closed = true
    const id = b.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`
    try {
      const input = b.args.trim() === '' ? {} : JSON.parse(b.args)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments must be a JSON object')
      completes.push(toolCallComplete({ id, name: b.name, input, rawArguments: b.args }))
    } catch (e) {
      completes.push(toolCallComplete({ id, name: b.name, input: null, rawArguments: b.args, inputError: `Tool arguments for "${b.name}" were not valid JSON (${e.message}). Resend the call with a complete JSON object.` }))
    }
  }

  return {
    stopOnFinish: true,
    push(ev) {
      const out = []
      switch (ev?.type) {
        case 'message_start': {
          const u = ev.message?.usage ?? {}
          inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
          if (u.cache_read_input_tokens != null) cached = u.cache_read_input_tokens
          outputTokens = u.output_tokens ?? 0
          break
        }
        case 'content_block_start': {
          const b = ev.content_block ?? {}
          blocks.set(ev.index, { type: b.type, id: b.id ?? '', name: b.name ?? '', args: '' })
          if (b.type === 'tool_use') out.push(toolCallStart({ index: ev.index, id: b.id ?? '', name: b.name ?? '' }))
          break
        }
        case 'content_block_delta': {
          const d = ev.delta ?? {}
          const b = blocks.get(ev.index)
          if (d.type === 'text_delta' && d.text) out.push(textDelta(d.text))
          else if (d.type === 'thinking_delta' && d.thinking) out.push(reasoningDelta(d.thinking))
          else if (d.type === 'input_json_delta' && b) { b.args += d.partial_json ?? ''; if (d.partial_json) out.push(toolCallDelta({ index: ev.index, id: b.id, argumentsDelta: d.partial_json })) }
          break
        }
        case 'content_block_stop': closeBlock(ev.index); break
        case 'message_delta':
          if (ev.delta?.stop_reason) finishReason = FINISH[ev.delta.stop_reason] ?? ev.delta.stop_reason
          if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens
          break
        case 'message_stop': stopped = true; break
        case 'error': throw errors.fromStream(ev.error?.message ?? 'unknown', ev.error?.type ?? '')
        default: break // ping and unknown events
      }
      return out
    },
    get finished() { return stopped },
    flush() {
      if (done) return []
      done = true
      for (const index of blocks.keys()) closeBlock(index)
      return [usage({ input: inputTokens, output: outputTokens, ...(cached != null ? { cachedInput: cached } : {}) }), ...completes, completed(finishReason ?? 'stop')]
    },
  }
}

export const errorFromResponse = errors.fromResponse

export function createAnthropicProvider(deps = {}) {
  return createAdapter({
    id: ANTHROPIC_ID, label: LABEL, envPrefix: 'ANTHROPIC', errors, capabilitiesFor, models: MODELS,
    protocol: { normalizeMessages, normalizeTools, createParser: createStreamParser, build: (config, request, caps) => ({ url: buildUrl(config), headers: buildHeaders(config), body: buildRequestBody(request, caps) }) },
    ...deps,
  })
}
