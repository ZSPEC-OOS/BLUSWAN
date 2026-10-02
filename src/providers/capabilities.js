// Provider/model capabilities. The runtime decides what to do from these flags — never from a provider's name.
import { createError } from '../protocol/schemas.js'

export const DEFAULT_CAPABILITIES = Object.freeze({
  streaming: true,
  toolCalling: false,
  reasoning: false,
  parallelToolCalls: false,
  contextWindow: 8192,
  maxOutputTokens: 2048,
})

export function defineCapabilities(overrides = {}) {
  return Object.freeze({ ...DEFAULT_CAPABILITIES, ...overrides })
}

/**
 * The autonomous coding agent needs streaming and tool calling. A model without them can chat but cannot act
 * as the agent, so it is rejected up front rather than failing mid-run.
 */
export function assertCodingCapable(caps, { provider = null, model = '' } = {}) {
  const missing = []
  if (!caps?.toolCalling) missing.push('tool calling')
  if (!caps?.streaming) missing.push('streaming')
  if (missing.length) {
    throw createError({ code: 'unsupported_feature', provider, message: `${model || 'This model'} does not support ${missing.join(' and ')}, which the coding agent needs. Choose another model.` })
  }
  return caps
}

export const isCodingCapable = (caps) => !!caps?.toolCalling && !!caps?.streaming

/** Longest-prefix lookup in a table of { prefix, caps }; falls back to `fallback`. Data, not code paths. */
export function capabilitiesFromTable(table, model = '', fallback = {}) {
  const hit = table.filter(e => model.startsWith(e.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0]
  return defineCapabilities(hit ? hit.caps : fallback)
}
