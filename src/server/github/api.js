// GitHub REST access with normalized errors. The token is a parameter of each call: nothing is cached here.
import { createError } from '../../protocol/schemas.js'
import { redactGithub } from './redact.js'

export function normalizeApiError(status, body, headers = {}) {
  const message = redactGithub(body?.message ?? '').slice(0, 200)
  const remaining = headers['x-ratelimit-remaining']; const retryAfter = Number(headers['retry-after']) || null
  const reset = Number(headers['x-ratelimit-reset']) || null
  if (status === 429 || (status === 403 && (remaining === '0' || /rate limit|abuse/i.test(message)))) {
    const wait = retryAfter ?? (reset ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : null)
    return createError({ code: 'github_rate_limited', message: `GitHub is rate limiting requests${wait ? `; try again in about ${Math.ceil(wait / 60) || 1} minute(s)` : ''}.`, retryable: true })
  }
  if (status === 401) return createError({ code: 'github_auth_expired', message: 'GitHub access expired or was revoked. Reconnect GitHub.' })
  if (status === 403) return createError({ code: 'github_permission_denied', message: 'GitHub denied access. Check that the BLUSWAN app is installed on this repository with the required permissions.' })
  if (status === 404) return createError({ code: 'github_repository_not_found', message: 'GitHub could not find that repository, branch or pull request (or the app cannot see it).' })
  if (status === 422) return createError({ code: 'invalid_request', message: `GitHub rejected the request${message ? `: ${message}` : ''}.` })
  return createError({ code: 'github_api_error', message: `GitHub responded with an error (${status}).`, retryable: status >= 500 })
}

export function createGithubApi({ apiUrl = 'https://api.github.com', fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  async function request(method, path, { token, body, query, basic, accept = 'application/vnd.github+json' } = {}) {
    const url = new URL(`${apiUrl}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    let res
    try {
      res = await fetchImpl(url, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bluswan', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(basic ? { Authorization: `Basic ${basic}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      throw createError({ code: 'github_api_error', message: e?.name === 'TimeoutError' ? 'GitHub did not respond in time.' : 'GitHub could not be reached.', retryable: true })
    }
    const text = await res.text()
    let json = null; try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
    const headers = Object.fromEntries(res.headers.entries())
    if (!res.ok) throw normalizeApiError(res.status, json, headers)
    return { json, headers, status: res.status }
  }
  return { request }
}
