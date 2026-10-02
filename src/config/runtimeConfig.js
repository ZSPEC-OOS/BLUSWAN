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

/**
 * Context-engine settings. Override per key with VITE_BLUSWAN_<SNAKE_CASE_NAME>
 * (ratios as decimals, summarizeWithModel as "true").
 */
export const DEFAULT_CONTEXT = Object.freeze({
  contextSafetyMarginTokens: 2000,
  reservedOutputTokens: 0, // 0 = use maxOutputTokens (capped by the model's own limit)
  compactionThresholdRatio: 0.78, // compact when projected input exceeds this share of the usable budget
  compactionTargetRatio: 0.6, // ...and compact down to this share, so it doesn't re-run every turn
  maxRepositoryContextTokens: 1500,
  maxToolContextTokens: 24_000, // verbatim tool results kept once compaction is active
  maxRecentConversationTokens: 16_000,
  maxSummaryTokens: 2500,
  maxFileSummaryTokens: 200,
  maxInstructionTokens: 800,
  maxRelevantFiles: 8,
  minRecentExchanges: 2, // complete earlier exchanges kept verbatim before history is folded into the summary
  summarizeWithModel: false, // optional model-assisted summary of folded history (never required)
})

/** Validation/recovery settings. Override per key with VITE_BLUSWAN_<SNAKE_CASE_NAME> (booleans as "true"/"false"). */
export const DEFAULT_VALIDATION = Object.freeze({
  enableAutomaticValidation: true, // behavior setting: run project checks before accepting completion
  enableBroadValidation: true, // allow broad tests / build in addition to focused checks
  maxAutomaticValidationRounds: 3, // automatic validation runs per user request
  maxRecoveryRounds: 3, // failed rounds the agent may repair per user request
  defaultTestTimeoutMs: 60_000,
  broadTestTimeoutMs: 180_000,
  defaultLintTimeoutMs: 60_000,
  defaultTypecheckTimeoutMs: 90_000,
  defaultBuildTimeoutMs: 180_000,
  maxValidationOutputBytes: 60_000,
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
  const context = {}
  for (const [key, fallback] of Object.entries(DEFAULT_CONTEXT)) {
    const raw = env[`VITE_BLUSWAN_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]
    if (typeof fallback === 'boolean') context[key] = raw === undefined ? fallback : raw === 'true'
    else if (Number.isInteger(fallback)) context[key] = nonNegInt(raw, fallback)
    else { const f = Number.parseFloat(raw); context[key] = Number.isFinite(f) && f > 0 && f <= 1 ? f : fallback }
  }
  const validation = {}
  for (const [key, fallback] of Object.entries(DEFAULT_VALIDATION)) {
    const raw = env[`VITE_BLUSWAN_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]
    validation[key] = typeof fallback === 'boolean' ? (raw === undefined ? fallback : raw !== 'false') : nonNegInt(raw, fallback)
  }
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
    permissionMode: ['ask', 'auto_edit', 'full_auto'].includes(env.VITE_BLUSWAN_PERMISSION_MODE) ? env.VITE_BLUSWAN_PERMISSION_MODE : 'auto_edit',
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
    ...context,
    ...validation,
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

/** Context settings with defaults filled in (callers may pass partial configs). */
export function resolveContextConfig(config = getRuntimeConfig()) {
  const out = { ...DEFAULT_CONTEXT }
  for (const key of Object.keys(DEFAULT_CONTEXT)) if (config[key] !== undefined) out[key] = config[key]
  out.maxOutputTokens = config.maxOutputTokens ?? DEFAULTS.maxOutputTokens
  return out
}

/** Validation settings with defaults filled in (callers may pass partial configs). */
export function resolveValidationConfig(config = getRuntimeConfig()) {
  const out = { ...DEFAULT_VALIDATION }
  for (const key of Object.keys(DEFAULT_VALIDATION)) if (config[key] !== undefined) out[key] = config[key]
  return out
}
