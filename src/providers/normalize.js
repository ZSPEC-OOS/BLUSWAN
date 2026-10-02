// Provider-neutral stream events. Adapters translate native payloads into these
// shapes; the runtime consumes only these.
//
//   text_delta          { text }
//   reasoning_delta     { text }                 (never rendered raw by the UI)
//   tool_call_start     { index, id, name }
//   tool_call_delta     { index, id, argumentsDelta }
//   tool_call_complete  { id, name, input, inputError?, rawArguments }
//   usage               { input, output, reasoning, total, cachedInput? }   (cachedInput only when the provider reports it)
//   completed           { finishReason }
//   error               { error }                (normalized BluswanError)

export const PROVIDER_EVENT_TYPES = Object.freeze([
  'text_delta', 'reasoning_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_complete',
  'usage', 'completed', 'error',
])

export const textDelta = (text) => ({ type: 'text_delta', text: String(text) })
export const reasoningDelta = (text) => ({ type: 'reasoning_delta', text: String(text) })
export const toolCallStart = ({ index = 0, id = '', name = '' }) => ({ type: 'tool_call_start', index, id, name })
export const toolCallDelta = ({ index = 0, id = '', argumentsDelta = '' }) => ({ type: 'tool_call_delta', index, id, argumentsDelta })
/** `input` is null with `inputError` set when the model produced unparseable arguments. */
export const toolCallComplete = ({ id, name, input = {}, inputError, rawArguments = '' }) => ({
  type: 'tool_call_complete', id, name, input, rawArguments, ...(inputError ? { inputError } : {}),
})
export const completed = (finishReason = 'stop') => ({ type: 'completed', finishReason })
export const errorEvent = (error) => ({ type: 'error', error })

export function normalizeUsage({ input = 0, output = 0, reasoning = 0, cachedInput, total } = {}) {
  const i = Number(input) || 0
  const o = Number(output) || 0
  return {
    input: i, output: o, reasoning: Number(reasoning) || 0, total: total === undefined ? i + o : Number(total) || 0,
    ...(cachedInput != null && Number.isFinite(Number(cachedInput)) ? { cachedInput: Number(cachedInput) } : {}),
  }
}

export const usage = (u) => ({ type: 'usage', ...normalizeUsage(u) })

export function isValidProviderEvent(e) {
  if (!e || !PROVIDER_EVENT_TYPES.includes(e.type)) return false
  switch (e.type) {
    case 'text_delta':
    case 'reasoning_delta': return typeof e.text === 'string'
    case 'tool_call_start': return typeof e.id === 'string' && typeof e.name === 'string'
    case 'tool_call_delta': return typeof e.argumentsDelta === 'string'
    case 'tool_call_complete': return typeof e.id === 'string' && typeof e.name === 'string'
      && (e.inputError ? e.input === null : !!e.input && typeof e.input === 'object')
    case 'usage': return typeof e.input === 'number' && typeof e.output === 'number'
    case 'completed': return typeof e.finishReason === 'string'
    case 'error': return !!e.error && typeof e.error.code === 'string'
    default: return false
  }
}
