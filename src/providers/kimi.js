// Kimi (Moonshot AI) adapter. Moonshot's API is OpenAI-compatible chat completions, so it shares that protocol;
// what is Kimi-specific lives here: authentication/base URL, model table and capabilities.
import { createAdapter } from './adapter.js'
import { capabilitiesFromTable } from './capabilities.js'
import { createChatCompletionsProtocol } from './chatCompletions.js'
import { createProviderErrors } from './errors.js'

export const KIMI_ID = 'kimi'
const LABEL = 'Kimi'

const MODEL_CAPABILITIES = [
  { prefix: 'kimi-k2-thinking', caps: { toolCalling: true, reasoning: true, parallelToolCalls: true, contextWindow: 256000, maxOutputTokens: 16384 } },
  { prefix: 'kimi-k2', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 8192 } },
  { prefix: 'kimi-latest', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 8192 } },
  { prefix: 'moonshot-v1-128k', caps: { toolCalling: true, contextWindow: 128000, maxOutputTokens: 8192 } },
  { prefix: 'moonshot-v1-32k', caps: { toolCalling: true, contextWindow: 32000, maxOutputTokens: 4096 } },
  { prefix: 'moonshot-v1-8k', caps: { toolCalling: true, contextWindow: 8000, maxOutputTokens: 2048 } },
]
const FALLBACK = { toolCalling: true, contextWindow: 128000, maxOutputTokens: 8192 }
export const MODELS = [{ id: 'kimi-k2-thinking', displayName: 'Kimi K2 Thinking' }, { id: 'kimi-latest', displayName: 'Kimi Latest' }]

const errors = createProviderErrors({ id: KIMI_ID, label: LABEL })
const protocol = createChatCompletionsProtocol({ errors, label: LABEL }) // Kimi thinking models also need reasoning echoed on tool turns

export const capabilitiesFor = (model = '') => capabilitiesFromTable(MODEL_CAPABILITIES, model, FALLBACK)
export const buildHeaders = (config) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` })
export const buildUrl = (config) => `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
export const { normalizeMessages, normalizeTools, buildRequestBody, createChunkParser } = protocol
export const errorFromResponse = errors.fromResponse

export function createKimiProvider(deps = {}) {
  return createAdapter({
    id: KIMI_ID, label: LABEL, envPrefix: 'KIMI', errors, capabilitiesFor, models: MODELS,
    protocol: { normalizeMessages, normalizeTools, createParser: createChunkParser, build: (config, request, caps) => ({ url: buildUrl(config), headers: buildHeaders(config), body: buildRequestBody(request, caps) }) },
    ...deps,
  })
}
