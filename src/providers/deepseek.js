// DeepSeek adapter (OpenAI-compatible chat completions API). Everything DeepSeek-specific is here: its model table,
// reasoning echo rule, and the cache-hit usage field (handled in the shared chat-completions protocol).
import { createAdapter, validateProviderConfig } from './adapter.js'
import { capabilitiesFromTable } from './capabilities.js'
import { createChatCompletionsProtocol } from './chatCompletions.js'
import { createProviderErrors } from './errors.js'
import { readSse } from './transport.js'
import { getProviderConfig } from '../config/runtimeConfig.js'

export const DEEPSEEK_ID = 'deepseek'
const LABEL = 'DeepSeek'

// Model metadata is data, not code paths. Longest matching prefix wins.
const MODEL_CAPABILITIES = [
  { prefix: 'deepseek-reasoner', caps: { toolCalling: true, reasoning: true, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 32768 } },
  { prefix: 'deepseek-', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 8192 } },
]
const FALLBACK = { toolCalling: true, contextWindow: 128000, maxOutputTokens: 8192 }
export const MODELS = [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' }]

const errors = createProviderErrors({ id: DEEPSEEK_ID, label: LABEL })
const protocol = createChatCompletionsProtocol({ errors, label: LABEL })

export const capabilitiesFor = (model = '') => capabilitiesFromTable(MODEL_CAPABILITIES, model, FALLBACK)
export const normalizeMessages = protocol.normalizeMessages
export const normalizeTools = protocol.normalizeTools
export const buildRequestBody = protocol.buildRequestBody
export const createChunkParser = protocol.createChunkParser
export const errorFromResponse = errors.fromResponse
export const errorFromException = errors.fromException
export { readSse }

const ctx = { errors, label: LABEL, envPrefix: 'DEEPSEEK' }
/** Throws configuration_error when required settings are absent. */
export const validateConfig = (config, model) => validateProviderConfig(ctx, config, model)
export const validateProvider = (model, config = getProviderConfig(DEEPSEEK_ID)) => validateConfig(config, model || config.model)

export const buildHeaders = (config) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` })
export const buildUrl = (config) => `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

/** @param {{getConfig?:()=>object, fetchImpl?:typeof fetch, requestTimeoutMs?:number, streamTimeoutMs?:number}} [deps] */
export function createDeepSeekProvider(deps = {}) {
  return createAdapter({
    id: DEEPSEEK_ID, label: LABEL, envPrefix: 'DEEPSEEK', errors, capabilitiesFor, models: MODELS,
    protocol: {
      normalizeMessages, normalizeTools, createParser: createChunkParser,
      build: (config, request, caps) => ({ url: buildUrl(config), headers: buildHeaders(config), body: buildRequestBody(request, caps) }),
    },
    ...deps,
  })
}
