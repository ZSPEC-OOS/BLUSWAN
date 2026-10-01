// Canonical provider adapter contract.
//
// ProviderAdapter {
//   id: string
//   capabilities(model): Capabilities
//   normalizeMessages(messages): native messages
//   normalizeTools(tools): native tool schemas
//   stream(request, handlers): Promise<void>
// }
//
// request:  { model, messages, tools, signal, temperature, maxOutputTokens }
// handlers: { onEvent(providerEvent) }   // events from ./normalize.js
// stream() resolves after a `completed` event and rejects with a BluswanError
// (see protocol/schemas.js) on any failure; adapters never leak native errors.

export const DEFAULT_CAPABILITIES = Object.freeze({
  streaming: true,
  toolCalling: false,
  reasoning: false,
  parallelToolCalls: false,
  contextWindow: 8192,
  maxOutputTokens: 2048,
})

export function defineCapabilities(overrides = {}) {
  return Object.freeze({ ...DEFAULT_CAPABILITIES, ...overrides })
}

const REQUIRED_METHODS = ['capabilities', 'normalizeMessages', 'normalizeTools', 'stream']

export function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || adapter.id === '') {
    throw new Error('Provider adapter requires a non-empty string id')
  }
  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== 'function') throw new Error(`Provider adapter "${adapter.id}" is missing ${m}()`)
  }
  return adapter
}
