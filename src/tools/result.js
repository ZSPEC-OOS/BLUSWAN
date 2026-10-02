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

/**
 * Small, bounded, secret-free description of a successful result for runtime events (the UI's activity
 * details). Full outputs stay on the tool message; nothing here carries file bodies.
 */
export function summarizeOutput(tool, o) {
  if (!o || typeof o !== 'object') return {}
  switch (tool) {
    case 'read_file': return { path: o.path, lines: o.endLine - o.startLine + 1, totalLines: o.totalLines, truncated: o.truncated }
    case 'read_many_files': return { count: o.files.filter(f => f.ok).length, failed: o.files.filter(f => !f.ok).length, paths: o.files.filter(f => f.ok).map(f => f.path).slice(0, 20) }
    case 'list_directory': return { count: o.entries.length }
    case 'search_files': return { matches: o.matches.length, paths: o.matches.map(m => m.path).slice(0, 10) }
    case 'grep': return { matches: o.matches.length, files: new Set(o.matches.map(m => m.path)).size }
    case 'shell': {
      const tail = redactSecrets(`${o.stderr ?? ''}\n${o.stdout ?? ''}`.trim()).slice(-600)
      return { exitCode: o.exitCode, timedOut: o.timedOut, truncated: o.truncated, excerpt: tail }
    }
    case 'git_status': return { branch: o.branch, clean: o.clean, changed: o.modified.length + o.staged.length + o.deleted.length + o.untracked.length }
    case 'git_diff': return { files: o.files.length, additions: o.additions, deletions: o.deletions }
    case 'apply_patch': return { files: o.changedFiles.length, hunks: o.appliedHunks }
    case 'write_file': return { path: o.path, created: o.created }
    case 'delete_file': return { path: o.path }
    default: return {}
  }
}
