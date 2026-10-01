import { assertProviderAdapter } from './provider.js'
import { createError } from '../protocol/schemas.js'
import { createDeepSeekProvider } from './deepseek.js'

/** Registry instances are independent so tests and future hosts can inject their own. */
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
      if (!adapter) {
        throw createError({
          code: 'configuration_error',
          message: `Unknown provider: ${id}`,
          provider: typeof id === 'string' ? id : null,
        })
      }
      return adapter
    },
    hasProvider: (id) => adapters.has(id),
    listProviders: () => [...adapters.keys()],
  }

  initial.forEach(a => registry.registerProvider(a))
  return registry
}

/** Application registry; DeepSeek is the initial provider. */
export const defaultRegistry = createProviderRegistry([createDeepSeekProvider()])
