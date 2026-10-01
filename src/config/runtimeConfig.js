// Centralized runtime configuration. Credentials come from the environment
// (VITE_* when executing browser-side) and are never logged.

const DEFAULTS = Object.freeze({
  defaultProvider: 'deepseek',
  maxTurns: 25,
  requestTimeoutMs: 60_000,
  streamTimeoutMs: 60_000,
  maxOutputTokens: 8192,
  maxTransportRetries: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 8000,
  maxIdenticalToolCalls: 3,
  maxFailedTurns: 6,
  temperature: 0,
  devLogging: false,
})

/** Workspace/tool limits. Override per key with VITE_BLUSWAN_LIMIT_<SNAKE_CASE_NAME>. */
export const DEFAULT_LIMITS = Object.freeze({
  maxReadBytes: 64_000,
  maxFileBytes: 10_000_000,
  maxReadManyFiles: 20,
  maxReadManyBytes: 200_000,
  maxWriteBytes: 2_000_000,
  maxPatchBytes: 1_000_000,
  maxGrepResults: 200,
  maxGrepFileBytes: 1_000_000,
  maxGrepLineLength: 500,
  maxSearchResults: 100,
  maxShellOutputBytes: 100_000,
  maxDiffBytes: 200_000,
  maxDirectoryDepth: 5,
  maxDirectoryEntries: 1000,
  maxIndexedFiles: 50_000,
  maxToolResultChars: 60_000,
  defaultShellTimeoutMs: 120_000,
  maxShellTimeoutMs: 600_000,
})

function readEnv() {
  try { if (import.meta.env) return import.meta.env } catch {}
  return typeof process !== 'undefined' ? process.env : {}
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function nonNegInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Pure: builds a frozen config from an env-like object.
 * Per-provider settings live under `providers[providerId]`.
 */
export function loadRuntimeConfig(env = readEnv()) {
  const limits = {}
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const envKey = `VITE_BLUSWAN_LIMIT_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`
    limits[key] = int(env[envKey], fallback)
  }
  const deepseekModel = env.VITE_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || ''
  return Object.freeze({
    defaultProvider: env.VITE_BLUSWAN_PROVIDER || DEFAULTS.defaultProvider,
    defaultModel: env.VITE_BLUSWAN_MODEL || deepseekModel,
    maxTurns: int(env.VITE_BLUSWAN_MAX_TURNS, DEFAULTS.maxTurns),
    requestTimeoutMs: int(env.VITE_BLUSWAN_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    streamTimeoutMs: int(env.VITE_BLUSWAN_STREAM_TIMEOUT_MS, DEFAULTS.streamTimeoutMs),
    maxOutputTokens: int(env.VITE_BLUSWAN_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens),
    maxTransportRetries: nonNegInt(env.VITE_BLUSWAN_MAX_TRANSPORT_RETRIES, DEFAULTS.maxTransportRetries),
    retryBaseDelayMs: nonNegInt(env.VITE_BLUSWAN_RETRY_BASE_DELAY_MS, DEFAULTS.retryBaseDelayMs),
    retryMaxDelayMs: int(env.VITE_BLUSWAN_RETRY_MAX_DELAY_MS, DEFAULTS.retryMaxDelayMs),
    maxIdenticalToolCalls: int(env.VITE_BLUSWAN_MAX_IDENTICAL_TOOL_CALLS, DEFAULTS.maxIdenticalToolCalls),
    maxFailedTurns: int(env.VITE_BLUSWAN_MAX_FAILED_TURNS, DEFAULTS.maxFailedTurns),
    temperature: DEFAULTS.temperature,
    limits: Object.freeze(limits),
    devLogging: env.VITE_BLUSWAN_DEV_LOGGING === 'true' || !!env.DEV,
    providers: Object.freeze({
      deepseek: Object.freeze({
        apiKey: env.VITE_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '',
        baseUrl: env.VITE_DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        model: deepseekModel,
      }),
    }),
  })
}

let cached = null
export function getRuntimeConfig() {
  if (!cached) cached = loadRuntimeConfig()
  return cached
}

export function getProviderConfig(providerId, config = getRuntimeConfig()) {
  return config.providers[providerId] ?? {}
}

/** Canonical model reference derived from configuration. */
export function getDefaultModelRef(config = getRuntimeConfig()) {
  const model = config.defaultModel || getProviderConfig(config.defaultProvider, config).model || ''
  return { provider: config.defaultProvider, model }
}

/** Returns a copy safe for logging: secrets masked. */
export function redactConfig(config = getRuntimeConfig()) {
  const providers = {}
  for (const [id, p] of Object.entries(config.providers)) {
    providers[id] = { ...p, apiKey: p.apiKey ? '[redacted]' : '' }
  }
  return { ...config, providers }
}

/** Merges explicit overrides over the configured (or default) limits. */
export function resolveLimits(overrides = {}, config = getRuntimeConfig()) {
  return Object.freeze({ ...DEFAULT_LIMITS, ...(config.limits ?? {}), ...overrides })
}
