// Authentication for the BLUSWAN server. Tokens are verified here, never in the browser:
//   none     — a single local user; refuses to listen on a non-loopback interface (see scripts/server.mjs)
//   firebase — verifies Firebase ID tokens (RS256) against Google's published certificates, using node:crypto
import crypto from 'node:crypto'
import { createError } from '../protocol/schemas.js'

const unauthenticated = (message = 'Sign in to continue.') => createError({ code: 'unauthenticated', message })

export function createNoAuth({ userId = 'local', email = null } = {}) {
  return { mode: 'none', async verify() { return { id: userId, email } } }
}

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
const b64 = (s) => Buffer.from(s, 'base64url')

/**
 * @param {{projectId:string, fetchCerts?:()=>Promise<Record<string,string>>, now?:()=>number}} options
 *   `fetchCerts` returns { kid: PEM certificate } (injectable; the default downloads and caches Google's certificates).
 */
export function createFirebaseVerifier({ projectId, fetchCerts, now = () => Date.now() }) {
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required for Firebase authentication')
  let cache = { certs: null, expires: 0 }
  const certs = async () => {
    if (cache.certs && cache.expires > now()) return cache.certs
    const loaded = fetchCerts ? await fetchCerts() : await (await fetch(CERTS_URL)).json()
    cache = { certs: loaded, expires: now() + 3_600_000 }
    return loaded
  }
  return {
    mode: 'firebase',
    async verify(token) {
      if (typeof token !== 'string' || token.split('.').length !== 3) throw unauthenticated()
      try {
        const [h, p, sig] = token.split('.')
        const header = JSON.parse(b64(h).toString())
        const claims = JSON.parse(b64(p).toString())
        if (header.alg !== 'RS256') throw new Error('alg')
        const pem = (await certs())[header.kid]
        if (!pem) throw new Error('kid')
        const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pem, b64(sig))
        const t = Math.floor(now() / 1000)
        if (!ok || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`
          || typeof claims.sub !== 'string' || !claims.sub || claims.exp <= t || claims.iat > t + 60) throw new Error('claims')
        return { id: claims.sub, email: claims.email ?? null }
      } catch {
        throw unauthenticated('Your session has expired. Sign in again.')
      }
    },
  }
}

export function bearerToken(req) {
  const h = req.headers.authorization
  const m = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h) : null
  return m ? m[1].trim() : null
}
