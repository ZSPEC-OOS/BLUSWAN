// Environment-backed credentials for the BLUSWAN server. Refuses to run in a browser: this module must never be
// bundled into client code (and a key read here would not be hidden there).
import { createCredentialStore } from './credentialStore.js'

export function createEnvCredentialStore(env = globalThis.process?.env ?? {}) {
  if (typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined') {
    throw new Error('The server credential store cannot be used in a browser.')
  }
  // Only unprefixed server variables: a VITE_ value would be compiled into the browser bundle, so it is never read.
  return createCredentialStore({
    deepseek: { apiKey: env.DEEPSEEK_API_KEY || '', baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model: env.DEEPSEEK_MODEL || '' },
    kimi: { apiKey: env.KIMI_API_KEY || '', baseUrl: env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', model: env.KIMI_MODEL || '' },
    openai: { apiKey: env.OPENAI_API_KEY || '', baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model: env.OPENAI_MODEL || '' },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY || '', baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', model: env.ANTHROPIC_MODEL || '' },
  })
}
