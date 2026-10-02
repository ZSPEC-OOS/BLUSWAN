// GitHub App authentication: a short-lived JWT (RS256) identifies the app; installation tokens (about 1 hour) act for
// one installation. Tokens live only in memory inside this process and are refreshed before they expire.
import crypto from 'node:crypto'
import { createError } from '../../protocol/schemas.js'

const b64 = (b) => Buffer.from(b).toString('base64url')

export function normalizePem(raw) {
  const text = String(raw ?? '')
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text
}

export function createAppAuth({ appId, privateKey, api, now = () => Date.now() }) {
  const pem = normalizePem(privateKey)
  const cache = new Map() // installationId → { token, expiresAt }
  const jwt = () => {
    const t = Math.floor(now() / 1000)
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const body = b64(JSON.stringify({ iat: t - 60, exp: t + 9 * 60, iss: String(appId) }))
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem).toString('base64url')
    return `${head}.${body}.${sig}`
  }
  return {
    jwt,
    /** @returns {Promise<string>} an installation token valid for at least two more minutes */
    async installationToken(installationId) {
      const hit = cache.get(installationId)
      if (hit && hit.expiresAt - now() > 120_000) return hit.token
      let r
      try { r = await api.request('POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { token: jwt(), body: {} }) } catch (e) {
        if (e.code === 'github_repository_not_found') throw createError({ code: 'github_permission_denied', message: 'GitHub access to this installation was removed. Reconnect GitHub.' })
        throw e
      }
      cache.set(installationId, { token: r.json.token, expiresAt: Date.parse(r.json.expires_at) || now() + 55 * 60_000 })
      return r.json.token
    },
    forget(installationId) { cache.delete(installationId) },
  }
}
