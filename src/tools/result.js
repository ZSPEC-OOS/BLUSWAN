// Normalized tool result construction and input summarization for telemetry.
import { WorkspaceError, TOOL_ERROR_CODES } from '../workspace/errors.js'
import { redactSecrets } from '../utils/redact.js'

export { TOOL_ERROR_CODES, redactSecrets }
/** Tool implementations throw this to report a structured failure. */
export { WorkspaceError as ToolError }

export function createToolResult({ toolCallId = null, tool, ok, output = null, error = null, metadata = {}, durationMs = 0 }) {
  return { ok, tool, toolCallId, output, error, metadata, durationMs }
}

export function toolSuccess(tool, output, extra = {}) {
  return createToolResult({ tool, ok: true, output, ...extra })
}

export function toolFailure(tool, code, message, { details = null, output = null, ...extra } = {}) {
  return createToolResult({
    tool, ok: false, output, error: { code, message: String(message).slice(0, 2000), ...(details ? { details } : {}) }, ...extra,
  })
}

/**
 * Compact, secret-free description of tool input for events and logs.
 * Large bodies (file content, patches) are reduced to their size.
 */
export function summarizeInput(input) {
  if (!input || typeof input !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'env' && value && typeof value === 'object') out.env = Object.keys(value)
    else if (typeof value === 'string' && (key === 'content' || key === 'patch')) out[key] = `[${value.length} chars]`
    else if (typeof value === 'string') out[key] = redactSecrets(value.length > 200 ? `${value.slice(0, 200)}…` : value)
    else if (Array.isArray(value)) out[key] = value.length > 10 ? [...value.slice(0, 10), `…(+${value.length - 10})`] : value
    else out[key] = value
  }
  return out
}
