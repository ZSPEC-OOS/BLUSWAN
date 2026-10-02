// OpenAI adapter on the Responses API (stateless: `store:false`; the canonical session history is re-sent each
// turn, nothing provider-side is relied on). OpenAI-specific wire formats stay in this file.
import { createAdapter } from './adapter.js'
import { capabilitiesFromTable } from './capabilities.js'
import { createProviderErrors } from './errors.js'
import { textDelta, reasoningDelta, toolCallStart, toolCallDelta, toolCallComplete, usage, completed } from './normalize.js'

export const OPENAI_ID = 'openai'
const LABEL = 'OpenAI'

const MODEL_CAPABILITIES = [
  { prefix: 'gpt-5', caps: { toolCalling: true, reasoning: true, parallelToolCalls: true, contextWindow: 400000, maxOutputTokens: 32768 } },
  { prefix: 'o4', caps: { toolCalling: true, reasoning: true, parallelToolCalls: true, contextWindow: 200000, maxOutputTokens: 32768 } },
  { prefix: 'o3', caps: { toolCalling: true, reasoning: true, parallelToolCalls: true, contextWindow: 200000, maxOutputTokens: 32768 } },
  { prefix: 'gpt-4.1', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 1000000, maxOutputTokens: 16384 } },
  { prefix: 'gpt-4o', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 16384 } },
]
const FALLBACK = { toolCalling: true, contextWindow: 128000, maxOutputTokens: 8192 }
export const MODELS = [{ id: 'gpt-4.1', displayName: 'GPT-4.1' }, { id: 'gpt-5', displayName: 'GPT-5' }]

const errors = createProviderErrors({ id: OPENAI_ID, label: LABEL })
export const capabilitiesFor = (model = '') => capabilitiesFromTable(MODEL_CAPABILITIES, model, FALLBACK)

const argumentsJson = (call) => (call.input && typeof call.input === 'object' ? JSON.stringify(call.input) : '{}')

/** Canonical messages → { instructions, input[] } for the Responses API. */
export function normalizeMessages(messages = []) {
  const instructions = []
  const input = []
  for (const m of messages) {
    if (m.role === 'system') { instructions.push(m.content); continue }
    if (m.role === 'user') { input.push({ role: 'user', content: m.content }); continue }
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const c of m.toolCalls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: argumentsJson(c) })
      continue
    }
    if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
  }
  return { instructions: instructions.join('\n\n'), input }
}

export const normalizeTools = (tools = []) => tools.map(t => ({
  type: 'function', name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} }, strict: false,
}))

export function buildRequestBody(request, caps) {
  const { instructions, input } = normalizeMessages(request.messages)
  const body = { model: request.model, input, stream: true, store: false }
  if (instructions) body.instructions = instructions
  // reasoning models spend output budget on thinking: give them their full allowance
  body.max_output_tokens = caps.reasoning ? caps.maxOutputTokens : Math.min(request.maxOutputTokens ?? caps.maxOutputTokens, caps.maxOutputTokens)
  if (request.temperature !== undefined && !caps.reasoning) body.temperature = request.temperature
  if (request.tools?.length && caps.toolCalling) { body.tools = normalizeTools(request.tools); body.parallel_tool_calls = !!caps.parallelToolCalls }
  return body
}

export const buildHeaders = (config) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` })
export const buildUrl = (config) => `${config.baseUrl.replace(/\/+$/, '')}/responses`

/** Responses API stream events → neutral events. */
export function createStreamParser() {
  const calls = new Map() // output_index → { id, name, args, started }
  let finishReason = null
  let done = false
  let sawCall = false

  const slot = (index, item = {}) => {
    let s = calls.get(index)
    if (!s) { s = { id: item.call_id ?? item.id ?? '', name: item.name ?? '', args: item.arguments ?? '', started: false }; calls.set(index, s) }
    return s
  }
  const finishFromResponse = (r) => {
    if (r?.status === 'incomplete') return r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : (r.incomplete_details?.reason ?? 'length')
    return sawCall ? 'tool_calls' : 'stop'
  }

  return {
    push(ev) {
      const out = []
      switch (ev?.type) {
        case 'response.output_text.delta': if (ev.delta) out.push(textDelta(ev.delta)); break
        case 'response.reasoning_summary_text.delta': case 'response.reasoning_text.delta': if (ev.delta) out.push(reasoningDelta(ev.delta)); break
        case 'response.output_item.added':
          if (ev.item?.type === 'function_call') {
            const s = slot(ev.output_index ?? 0, ev.item); s.started = true; sawCall = true
            out.push(toolCallStart({ index: ev.output_index ?? 0, id: s.id, name: s.name }))
          }
          break
        case 'response.function_call_arguments.delta': {
          const s = slot(ev.output_index ?? 0)
          s.args += ev.delta ?? ''
          if (ev.delta) out.push(toolCallDelta({ index: ev.output_index ?? 0, id: s.id, argumentsDelta: ev.delta }))
          break
        }
        case 'response.function_call_arguments.done': { const s = slot(ev.output_index ?? 0); if (typeof ev.arguments === 'string') s.args = ev.arguments; break }
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') {
            const s = slot(ev.output_index ?? 0, ev.item)
            s.id = ev.item.call_id || s.id; s.name = ev.item.name || s.name
            if (typeof ev.item.arguments === 'string') s.args = ev.item.arguments
          }
          break
        case 'response.completed': case 'response.incomplete': {
          const r = ev.response
          finishReason = finishFromResponse(r)
          const u = r?.usage
          if (u) out.push(usage({ input: u.input_tokens, output: u.output_tokens, total: u.total_tokens, reasoning: u.output_tokens_details?.reasoning_tokens, cachedInput: u.input_tokens_details?.cached_tokens }))
          break
        }
        case 'response.failed': throw errors.fromStream(ev.response?.error?.message ?? 'response failed', ev.response?.error?.code ?? '')
        case 'error': throw errors.fromStream(ev.message ?? ev.error?.message ?? 'unknown', ev.code ?? ev.error?.code ?? ev.error?.type ?? '')
        default: break
      }
      return out
    },
    get finished() { return finishReason !== null },
    flush() {
      if (done) return []
      done = true
      const completes = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([index, c]) => {
        const id = c.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`
        try {
          const input = c.args.trim() === '' ? {} : JSON.parse(c.args)
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments must be a JSON object')
          return toolCallComplete({ id, name: c.name, input, rawArguments: c.args })
        } catch (e) {
          return toolCallComplete({ id, name: c.name, input: null, rawArguments: c.args, inputError: `Tool arguments for "${c.name}" were not valid JSON (${e.message}). Resend the call with a complete JSON object.` })
        }
      })
      calls.clear()
      return [...completes, completed(finishReason ?? 'stop')]
    },
  }
}

export const errorFromResponse = errors.fromResponse

export function createOpenAIProvider(deps = {}) {
  return createAdapter({
    id: OPENAI_ID, label: LABEL, envPrefix: 'OPENAI', errors, capabilitiesFor, models: MODELS,
    protocol: { normalizeMessages, normalizeTools, createParser: createStreamParser, build: (config, request, caps) => ({ url: buildUrl(config), headers: buildHeaders(config), body: buildRequestBody(request, caps) }) },
    ...deps,
  })
}
