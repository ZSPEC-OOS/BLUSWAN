// Plain-language wording for normalized runtime errors. Raw codes/messages stay available as `details`
// (shown only in an expandable area); stack traces never reach the conversation.

const PROVIDER_NAME = { deepseek: 'DeepSeek' }
const provider = (e) => PROVIDER_NAME[e?.provider] ?? (e?.provider ? String(e.provider) : 'The model provider')

export function friendlyError(error) {
  const e = error ?? {}
  switch (e.code) {
    case 'rate_limit': return `${provider(e)} is temporarily rate-limited. The request could not continue.`
    case 'authentication_error': return `${provider(e)} rejected the API key. Check it in Settings.`
    case 'network_error': return `Couldn't reach ${provider(e)}. Check your connection and try again.`
    case 'provider_timeout': return `${provider(e)} took too long to respond. Try again in a moment.`
    case 'provider_error': return `${provider(e)} returned an error. Try again in a moment.`
    case 'invalid_response': return `${provider(e)} sent a response BLUSWAN couldn't read. Try again.`
    case 'max_turns': return 'BLUSWAN reached its step limit for this request. Work done so far is kept — send a message to continue.'
    case 'loop_detected':
    case 'no_progress': return "BLUSWAN stopped because it wasn't making progress. Work done so far is kept."
    case 'context_budget_exceeded':
    case 'context_invalid_history':
    case 'context_compaction_failed': return "This conversation has grown beyond the model's capacity. Start a new chat or narrow the request."
    case 'configuration_error': return e.message || 'BLUSWAN is not fully configured. Open Settings to finish setup.'
    case 'session_busy': return 'BLUSWAN is still working on the previous request.'
    case 'cancelled': return 'Stopped.'
    default: return 'Something went wrong while running this request.'
  }
}

const TOOL_ERRORS = {
  file_not_found: 'file not found',
  not_a_file: 'not a file',
  not_a_directory: 'not a directory',
  binary_file: 'binary file',
  path_outside_workspace: 'outside the repository',
  already_exists: 'already exists',
  patch_parse_error: 'the patch was malformed',
  patch_apply_failed: 'the patch did not apply',
  invalid_input: 'invalid input',
  unknown_tool: 'unknown tool',
  command_timeout: 'timed out',
  command_cancelled: 'stopped',
  tool_cancelled: 'stopped',
  permission_denied: 'not allowed',
  permission_required: 'needs approval',
  loop_detected: 'repeated action skipped',
  git_not_repository: 'not a git repository',
  output_limit_exceeded: 'too large',
}

/** Short reason for a failed tool action, e.g. "file not found". */
export const friendlyToolError = (error) => TOOL_ERRORS[error?.code] ?? 'failed'

/** Conversation-level wording for the technical details disclosure. */
export const technicalDetails = (error) => [error?.code, error?.message].filter(Boolean).join(': ')
