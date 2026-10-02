// How the browser classifies and explains connection problems. Pure functions, no React: the remote runtime, the
// auth boundary and the connection screens all share this vocabulary.
import { PROTOCOL_VERSION } from '../../protocol/version.js'

/** Why the app cannot (fully) work. `retryable` failures are retried automatically with backoff. */
export const FAILURE = Object.freeze({
  server_unreachable: { kind: 'server_unreachable', retryable: true },
  server_not_ready: { kind: 'server_not_ready', retryable: true },
  authentication_required: { kind: 'authentication_required', retryable: false },
  authentication_failed: { kind: 'authentication_failed', retryable: false },
  persistence_unavailable: { kind: 'persistence_unavailable', retryable: true },
  workspace_host_unavailable: { kind: 'workspace_host_unavailable', retryable: true },
  configuration_error: { kind: 'configuration_error', retryable: false },
  client_server_version_mismatch: { kind: 'client_server_version_mismatch', retryable: false },
  unknown_server_error: { kind: 'unknown_server_error', retryable: true },
})

export const BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 15000])
export const backoffDelay = (attempt, schedule = BACKOFF_MS) => schedule[Math.min(attempt, schedule.length - 1)]

export class ConnectionFailure extends Error {
  constructor(kind, message, { status = null, code = null, requestId = null, cause = null, stage = null } = {}) {
    super(message)
    this.name = 'ConnectionFailure'
    this.kind = kind; this.status = status; this.code = code; this.requestId = requestId; this.stage = stage
    this.retryable = FAILURE[kind]?.retryable ?? true
    if (cause) this.cause = cause
  }
}

/** Failure → ConnectionFailure from an HTTP result (status + parsed body, either may be absent) or a thrown network error. */
export function classifyFailure({ status = null, body = null, networkError = null, stage = null, requestId = null } = {}) {
  const err = body?.error ?? null
  const code = err?.code ?? null
  const rid = requestId ?? err?.requestId ?? null
  const make = (kind, message) => new ConnectionFailure(kind, message, { status, code, requestId: rid, stage, cause: networkError })
  if (networkError || status === null) return make('server_unreachable', 'BLUSWAN could not reach its runtime.')
  if (code === 'protocol_mismatch' || status === 426) return make('client_server_version_mismatch', 'This page and the runtime are different versions.')
  if (status === 401 || code === 'unauthenticated') return make('authentication_failed', err?.message || 'Your session has expired. Sign in again.')
  if (status === 403 || code === 'forbidden') return make('authentication_failed', 'This account is not allowed to use this runtime.')
  if (code === 'persistence_unavailable') return make('persistence_unavailable', 'The runtime cannot reach its storage.')
  if (code === 'workspace_host_unavailable') return make('workspace_host_unavailable', 'The runtime cannot reach its workspace location.')
  if (code === 'configuration_error') return make('configuration_error', err?.message || 'The runtime is misconfigured.')
  if (code === 'server_not_ready') return make('server_not_ready', 'BLUSWAN\'s runtime is starting.')
  // A gateway answering for a dead upstream is "unreachable", not an application error: no JSON from BLUSWAN, only a proxy page.
  if ([502, 503, 504].includes(status) && !err) return make('server_unreachable', 'BLUSWAN could not reach its runtime.')
  if (status === 404 && !err) return make('server_unreachable', 'Nothing that looks like BLUSWAN answered at this address.')
  if (status >= 500) return make('unknown_server_error', err?.message || 'The runtime reported an internal error.')
  return make('unknown_server_error', err?.message || `Unexpected response (${status}).`)
}

/** Validates the health payload a runtime returned. Throws a classified failure if it is not a compatible BLUSWAN. */
export function checkHealth(health, { clientProtocol = PROTOCOL_VERSION } = {}) {
  if (!health || health.service !== 'bluswan' || health.ok !== true) {
    throw new ConnectionFailure('server_unreachable', 'The address answered, but it is not a BLUSWAN runtime.', { stage: 'checking_server' })
  }
  if (health.protocolVersion !== clientProtocol) {
    throw new ConnectionFailure('client_server_version_mismatch', 'This page and the runtime are different versions.', { stage: 'checking_server', code: 'protocol_mismatch' })
  }
  return health
}

/** Text and actions per failure kind: the connection screens render exactly this. `saved` is only claimed when known. */
export function describeFailure(kind, { savedKnown = false } = {}) {
  const base = {
    server_unreachable: { title: 'BLUSWAN could not reach its runtime', detail: 'The runtime may not be running, or this address may be wrong.', actions: ['retry', 'details'] },
    server_not_ready: { title: 'BLUSWAN\'s runtime is starting…', detail: 'It is up but not ready yet. This page will continue on its own.', actions: ['retry', 'details'] },
    authentication_required: { title: 'Sign in to continue', detail: 'This runtime requires an account.', actions: ['signin'] },
    authentication_failed: { title: 'Your session has expired', detail: 'Sign in again to continue where you left off.', actions: ['signin', 'details'] },
    persistence_unavailable: { title: 'Storage is unavailable', detail: 'The runtime cannot save conversations right now, so coding is paused to avoid losing work.', actions: ['retry', 'details'] },
    workspace_host_unavailable: { title: 'The workspace location is unavailable', detail: 'The runtime cannot reach the folders it may open. Other parts of BLUSWAN keep working.', actions: ['retry', 'details'] },
    configuration_error: { title: 'The runtime is misconfigured', detail: 'An administrator needs to fix the server configuration. Connection details list what to check.', actions: ['details', 'retry'] },
    client_server_version_mismatch: { title: 'This page and the runtime do not match', detail: 'Reload to get the matching version of the app.', actions: ['reload', 'details'] },
    unknown_server_error: { title: 'The runtime reported a problem', detail: 'Try again. If it keeps happening, copy the connection details for whoever runs the server.', actions: ['retry', 'details'] },
  }[kind] ?? { title: 'Something went wrong', detail: 'Try again.', actions: ['retry', 'details'] }
  return { ...base, ...(savedKnown ? { note: 'Conversations already saved by the runtime will be there when it is back.' } : {}) }
}

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i

/**
 * Checks the configured API base URL. '' means same origin (valid). Returns { ok, url, warnings:[{code,message}], error? }.
 * `page` is { hostname, protocol } of the current location, `mobile` tells whether the client is a phone/tablet.
 */
export function validateApiUrl(value, { page = null, mobile = false } = {}) {
  const raw = (value ?? '').trim()
  const warnings = []
  if (!raw) return { ok: true, url: '', warnings }
  let u
  try { u = new URL(raw) } catch { return { ok: false, url: raw, warnings, error: 'VITE_BLUSWAN_API_URL must be an absolute http(s) URL such as https://bluswan.example.com.' } }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, url: raw, warnings, error: 'VITE_BLUSWAN_API_URL must start with http:// or https://.' }
  if (u.username || u.password) return { ok: false, url: raw, warnings, error: 'VITE_BLUSWAN_API_URL must not contain credentials.' }
  const url = `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  const pageHost = page?.hostname ?? ''
  if (LOCAL_HOST.test(u.hostname) && pageHost && !LOCAL_HOST.test(pageHost)) {
    warnings.push({ code: 'localhost_api_from_remote_page', message: mobile
      ? 'This device is trying to reach a runtime at "localhost", which means the device itself. Use the runtime\'s public address instead.'
      : 'The runtime address points at "localhost", but this page is not served from localhost, so it will not find the runtime.' })
  }
  if (u.protocol === 'http:' && !LOCAL_HOST.test(u.hostname) && page?.protocol === 'https:') {
    warnings.push({ code: 'mixed_content', message: 'This page is served over HTTPS but the runtime address is plain http, which browsers block. Serve the runtime over HTTPS.' })
  }
  return { ok: true, url, warnings }
}

/** True for phones and tablets (best effort; used only to tailor guidance). */
export function isMobileClient(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? ''
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (nav?.maxTouchPoints > 1 && /Macintosh/.test(ua))
}

/** Performs GET /api/health (no auth) and validates it. */
export async function probeHealth({ fetch: f = globalThis.fetch?.bind(globalThis), baseUrl = '', signal } = {}) {
  let res
  try { res = await f(`${baseUrl}/api/health`, { signal, headers: { Accept: 'application/json' } }) } catch (e) { throw classifyFailure({ networkError: e, stage: 'checking_server' }) }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw classifyFailure({ status: res.status, body, stage: 'checking_server', requestId: res.headers?.get?.('x-request-id') })
  return checkHealth(body)
}

/** Performs GET /api/ready (no auth). Resolves to the readiness body, or throws a classified failure (e.g. persistence). */
export async function probeReady({ fetch: f = globalThis.fetch?.bind(globalThis), baseUrl = '', signal } = {}) {
  let res
  try { res = await f(`${baseUrl}/api/ready`, { signal, headers: { Accept: 'application/json' } }) } catch (e) { throw classifyFailure({ networkError: e, stage: 'checking_server' }) }
  const body = await res.json().catch(() => null)
  if (res.ok) return body
  if (res.status === 404) return { ready: true, legacy: true } // an older runtime without /api/ready: health already passed
  throw classifyFailure({ status: res.status, body, stage: 'checking_server', requestId: res.headers?.get?.('x-request-id') })
}
