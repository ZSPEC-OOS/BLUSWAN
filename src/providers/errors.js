// Canonical provider error model. Every adapter maps HTTP failures, stream errors, timeouts and cancellation to
// the same BluswanError codes so the runtime never sees a provider-native error.
//   configuration_error · authentication_error · rate_limit · network_error · provider_timeout · invalid_response
//   context_limit · unsupported_feature · cancelled · provider_error
import { createError } from '../protocol/schemas.js'
import { redactSecrets } from '../utils/redact.js'

const CONTEXT_LIMIT = /context[ _-]?(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (maximum|model'?s)|reduce the length|token limit/i

/** @param {{id:string, label:string}} provider */
export function createProviderErrors({ id, label }) {
  const err = (code, message, extra = {}) => createError({ code, message, provider: id, ...extra })
  return {
    err,
    configuration: (message) => err('configuration_error', message),
    invalid: (message) => err('invalid_response', message),
    fromResponse(status, detail = '') {
      const clean = redactSecrets(String(detail))
      const message = `${label} request failed (${status})${clean ? `: ${clean}` : ''}`
      if (status === 401 || status === 403) return err('authentication_error', message)
      if (status === 429) return err('rate_limit', message, { retryable: true })
      if (status === 413 || (status === 400 && CONTEXT_LIMIT.test(clean))) return err('context_limit', message)
      if (status >= 500) return err('provider_error', message, { retryable: true })
      return err('provider_error', message)
    },
    /** In-stream error payloads: `kind` is the provider's own error type/code, used only to pick the canonical class. */
    fromStream(message, kind = '') {
      const clean = redactSecrets(String(message ?? 'unknown'))
      const text = `${label} stream error: ${clean}`
      if (/rate[_ ]?limit/i.test(kind)) return err('rate_limit', text, { retryable: true })
      if (/auth|permission|invalid_api_key/i.test(kind)) return err('authentication_error', text)
      if (/overloaded|server_error|unavailable|timeout/i.test(kind)) return err('provider_error', text, { retryable: true })
      if (CONTEXT_LIMIT.test(clean) || /context_length/i.test(kind)) return err('context_limit', text)
      return err('provider_error', text)
    },
    fromException(e, { signal, timedOut } = {}) {
      if (timedOut === 'request') return err('provider_timeout', `${label} did not respond in time (request timeout).`, { retryable: true, cause: e })
      if (timedOut === 'stream') return err('provider_timeout', `${label} stream stalled (no data within the inactivity timeout).`, { retryable: true, cause: e })
      if (signal?.aborted || e?.name === 'AbortError') return err('cancelled', 'Request cancelled.', { cause: e })
      return err('network_error', `${label} network failure: ${e?.message ?? 'unknown'}`, { retryable: true, cause: e })
    },
  }
}

export const isNormalized = (e) => !!e && typeof e === 'object' && 'retryable' in e && typeof e.code === 'string'
