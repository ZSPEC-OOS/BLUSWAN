// Provider-neutral stream events. Adapters translate native payloads into these
// shapes; the runtime consumes only these.

export const PROVIDER_EVENT_TYPES = Object.freeze([
  'text_delta', 'reasoning_status', 'tool_call', 'usage', 'completed',
])

export const textDelta = (text) => ({ type: 'text_delta', text: String(text) })
export const reasoningStatus = (text = '') => ({ type: 'reasoning_status', text: String(text) })
export const toolCall = ({ id, name, arguments: args = {} }) => ({ type: 'tool_call', id, name, arguments: args })
export const completed = (finishReason = 'stop') => ({ type: 'completed', finishReason })

export function normalizeUsage({ input = 0, output = 0, total } = {}) {
  const i = Number(input) || 0
  const o = Number(output) || 0
  return { input: i, output: o, total: total === undefined ? i + o : Number(total) || 0 }
}

export const usage = (u) => ({ type: 'usage', ...normalizeUsage(u) })

export function isValidProviderEvent(e) {
  if (!e || !PROVIDER_EVENT_TYPES.includes(e.type)) return false
  switch (e.type) {
    case 'text_delta': return typeof e.text === 'string'
    case 'reasoning_status': return typeof e.text === 'string'
    case 'tool_call': return typeof e.id === 'string' && typeof e.name === 'string'
      && !!e.arguments && typeof e.arguments === 'object'
    case 'usage': return typeof e.input === 'number' && typeof e.output === 'number'
    case 'completed': return typeof e.finishReason === 'string'
    default: return false
  }
}
