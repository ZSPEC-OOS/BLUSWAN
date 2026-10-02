// Environment-backed credentials for the BLUSWAN server. Refuses to run in a browser: this module must never be
// bundled into client code (and a key read here would not be hidden there).
import { createCredentialStore } from './credentialStore.js'

export function createEnvCredentialStore(env = globalThis.process?.env ?? {}) {
  if (typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined') {
    throw new Error('The server credential store cannot be used in a browser.')
  }
  return createCredentialStore({
    deepseek: { apiKey: env.DEEPSEEK_API_KEY || '', baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model: env.DEEPSEEK_MODEL || '' },
  })
}
