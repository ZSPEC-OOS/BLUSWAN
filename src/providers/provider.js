// Canonical provider adapter contract.
//
// ProviderAdapter {
//   id: string
//   listModels(): [{ provider, id, displayName, capabilities, known }]
//   capabilities(model): Capabilities               (src/providers/capabilities.js)
//   normalizeMessages(messages): native messages    (canonical → provider wire format)
//   normalizeTools(tools): native tool schemas
//   validate?(model): void                          (credential / model checks before any request)
//   stream(request, handlers): Promise<void>
// }
//
// request:  { model, messages, tools, signal, temperature, maxOutputTokens, reasoningEffort?, metadata? }
//   reasoningEffort is a canonical hint ("high" | "max", or "off" for short utility calls); only adapters whose model declares the reasoningEffort capability map it.
// handlers: { onEvent(providerEvent) }   // events from ./normalize.js
// stream() resolves after a `completed` event and rejects with a BluswanError (protocol/schemas.js, mapped by
// ./errors.js) on any failure; adapters never leak native errors, native tool formats or native messages.

export { DEFAULT_CAPABILITIES, defineCapabilities } from './capabilities.js'

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
