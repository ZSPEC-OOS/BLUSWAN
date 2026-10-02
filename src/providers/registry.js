// The one provider registry. Adding a provider is `registerProvider(adapter)`; nothing in the agent loop changes.
import { assertProviderAdapter } from './provider.js'
import { createError } from '../protocol/schemas.js'
import { createDeepSeekProvider } from './deepseek.js'
import { createKimiProvider } from './kimi.js'
import { createOpenAIProvider } from './openai.js'
import { createAnthropicProvider } from './anthropic.js'

/** Registry instances are independent so tests and hosts can inject their own. */
export function createProviderRegistry(initial = []) {
  const adapters = new Map()

  const registry = {
    registerProvider(adapter) {
      assertProviderAdapter(adapter)
      if (adapters.has(adapter.id)) throw new Error(`Provider already registered: ${adapter.id}`)
      adapters.set(adapter.id, adapter)
      return registry
    },
    getProvider(id) {
      const adapter = adapters.get(id)
      if (!adapter) throw createError({ code: 'configuration_error', message: `Unknown provider: ${id}`, provider: typeof id === 'string' ? id : null })
      return adapter
    },
    hasProvider: (id) => adapters.has(id),
    listProviders: () => [...adapters.keys()],
    /** [{ provider, id, displayName, capabilities, known }] — empty for adapters that do not enumerate models. */
    listModels: (providerId) => registry.getProvider(providerId).listModels?.() ?? [],
    /** One model's metadata; unknown ids get the adapter's fallback capabilities and `known: false`. */
    resolveModel(providerId, modelId) {
      const p = registry.getProvider(providerId)
      const listed = p.listModels?.().find(m => m.id === modelId)
      return listed ?? { provider: providerId, id: modelId, displayName: modelId, capabilities: p.capabilities(modelId), known: false }
    },
  }
  initial.forEach(a => registry.registerProvider(a))
  return registry
}

/** Every supported provider, configured from `getConfig(providerId)` (server credentials). */
export function createStandardProviders({ getConfig, fetchImpl } = {}) {
  const deps = (id) => ({ ...(getConfig ? { getConfig: () => getConfig(id) } : {}), ...(fetchImpl ? { fetchImpl } : {}) })
  return [createDeepSeekProvider(deps('deepseek')), createKimiProvider(deps('kimi')), createOpenAIProvider(deps('openai')), createAnthropicProvider(deps('anthropic'))]
}

/** Application registry with all providers, reading the server environment. */
export const defaultRegistry = createProviderRegistry(createStandardProviders())
