// The single token-estimation interface for the context engine. Exact provider tokenization is not
// available offline, so this is a deliberately conservative approximation (code and JSON tokenize
// worse than prose). Replace it by passing a different estimator to the context engine.

export const DEFAULT_CHARS_PER_TOKEN = 3.6
const MESSAGE_OVERHEAD = 4 // role markers and framing per message
const TOOL_SCHEMA_SAFETY = 1.15 // provider-side serialization of tool schemas costs more than raw JSON

export function createTokenEstimator({ charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  const estimateTokens = (text) => (text ? Math.ceil(String(text).length / charsPerToken) : 0)

  const estimateMessageTokens = (m) => MESSAGE_OVERHEAD
    + estimateTokens(m.content)
    + (m.toolCalls?.length ? estimateTokens(JSON.stringify(m.toolCalls)) : 0)
    + (m.reasoning ? estimateTokens(m.reasoning) : 0)
    + (m.toolCallId ? 3 : 0) + (m.name ? 2 : 0)

  return {
    estimateTokens,
    estimateMessageTokens,
    estimateContextTokens: (messages) => messages.reduce((n, m) => n + estimateMessageTokens(m), 0),
    /** Tool definitions consume context too; estimate them conservatively. */
    estimateToolSchemaTokens: (tools) => (tools?.length ? Math.ceil(estimateTokens(JSON.stringify(tools)) * TOOL_SCHEMA_SAFETY) : 0),
  }
}

export const defaultEstimator = createTokenEstimator()
export const { estimateTokens, estimateMessageTokens, estimateContextTokens, estimateToolSchemaTokens } = defaultEstimator
