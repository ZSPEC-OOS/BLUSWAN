// Structured error type shared by the workspace and tool layers. Codes are the
// only supported way to branch on failure kinds; messages are for humans/models.

export const TOOL_ERROR_CODES = Object.freeze([
  'invalid_input',
  'tool_not_found',
  'workspace_not_found',
  'path_outside_workspace',
  'file_not_found',
  'not_a_file',
  'not_a_directory',
  'binary_file',
  'already_exists',
  'permission_denied',
  'patch_parse_error',
  'patch_apply_failed',
  'command_failed',
  'command_timeout',
  'command_cancelled',
  'git_not_repository',
  'git_error',
  'output_limit_exceeded',
  'internal_error',
])

export class WorkspaceError extends Error {
  /**
   * @param {string} code one of TOOL_ERROR_CODES
   * @param {string} message
   * @param {{details?:object|null, output?:*, cause?:*}} [extra] `output` carries partial results (e.g. a failed command's streams)
   */
  constructor(code, message, { details = null, output = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    if (!TOOL_ERROR_CODES.includes(code)) throw new Error(`Unknown tool error code: ${code}`)
    this.name = 'WorkspaceError'
    this.code = code
    this.details = details
    this.output = output
  }
}

export function isWorkspaceError(e) {
  return e instanceof WorkspaceError
}
