// Provider credentials are obtained through this boundary, on the server, and never leave it.
//
//   credentialStore {
//     getCredential(provider, userContext) → { apiKey, baseUrl, model }   throws configuration_error when missing
//     hasCredential(provider, userContext) → boolean
//     describe(userContext)                → [{ provider, configured, model }]   (safe to send to a client)
//   }
// Implementations are synchronous because provider adapters read their configuration per request; a secrets
// service must be loaded at startup and cached.
import { createError } from '../../protocol/schemas.js'

const LABEL = { deepseek: 'DeepSeek' }
const ENV_NAME = { deepseek: 'DEEPSEEK_API_KEY' }

export const missingCredential = (provider) => createError({
  code: 'configuration_error', provider,
  message: `${LABEL[provider] ?? provider} is not configured on the server (set ${ENV_NAME[provider] ?? `the ${provider} API key`}).`,
})

/** Builds a store from a plain table: provider → { apiKey, baseUrl, model }. */
export function createCredentialStore(table = {}) {
  const entry = (provider) => table[provider]
  return {
    getCredential(provider) {
      const c = entry(provider)
      if (!c?.apiKey) throw missingCredential(provider)
      return { apiKey: c.apiKey, baseUrl: c.baseUrl ?? '', model: c.model ?? '' }
    },
    hasCredential: (provider) => !!entry(provider)?.apiKey,
    describe: () => Object.keys(table).map(provider => ({ provider, label: LABEL[provider] ?? provider, configured: !!table[provider]?.apiKey, model: table[provider]?.model ?? '' })),
  }
}
