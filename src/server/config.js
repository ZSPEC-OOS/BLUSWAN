// Server environment validation. `parseServerConfig(env)` is pure: it never exits, logs or touches the filesystem.
// It returns the effective settings plus every problem found, so `npm run server`, `npm run doctor` and the tests
// all report the same, complete list. Values of secrets are never copied into messages.
import path from 'node:path'

const LOOPBACK = ['127.0.0.1', '::1', 'localhost']
export const AUTH_MODES = ['none', 'firebase']
export const PERSISTENCE_KINDS = ['file', 'memory', 'firebase']

/** A single allowed browser origin: scheme://host[:port], no path, no wildcard. */
export function validateCorsOrigin(value, { production = false } = {}) {
  if (!value) return null
  if (value === '*') return production ? 'BLUSWAN_CORS_ORIGIN must be one explicit origin in production, not "*".' : 'BLUSWAN_CORS_ORIGIN must be one explicit origin (a wildcard would let any site call the runtime).'
  let u
  try { u = new URL(value) } catch { return 'BLUSWAN_CORS_ORIGIN must be an origin such as https://app.example.com.' }
  if (!['http:', 'https:'].includes(u.protocol) || u.origin !== value.replace(/\/$/, '') || u.pathname !== '/' || u.search || u.hash || u.username) {
    return 'BLUSWAN_CORS_ORIGIN must be an origin only (scheme, host and optional port; no path).'
  }
  return null
}

const PROVIDER_KEYS = { deepseek: 'DEEPSEEK_API_KEY', kimi: 'KIMI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }

/**
 * @returns {{ok:boolean, errors:string[], warnings:string[], settings:object}}
 */
export function parseServerConfig(env = process.env) {
  const errors = []; const warnings = []
  const production = env.NODE_ENV === 'production'

  const portRaw = env.BLUSWAN_PORT
  let port = 8787
  if (portRaw !== undefined && portRaw !== '') {
    port = Number(portRaw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) { errors.push('BLUSWAN_PORT must be an integer between 0 and 65535.'); port = 8787 }
  }

  const authMode = env.BLUSWAN_AUTH || 'none'
  if (!AUTH_MODES.includes(authMode)) errors.push(`BLUSWAN_AUTH must be one of: ${AUTH_MODES.join(', ')}.`)
  const host = env.BLUSWAN_HOST || '127.0.0.1'
  const loopback = LOOPBACK.includes(host)
  if (authMode === 'none' && !loopback) errors.push('BLUSWAN_AUTH=none may only listen on a loopback address (anyone who could reach it could run commands). Use BLUSWAN_AUTH=firebase.')
  if (production && authMode === 'none' && env.BLUSWAN_ALLOW_NO_AUTH !== '1') errors.push('Refusing production without authentication. Set BLUSWAN_AUTH=firebase (or BLUSWAN_ALLOW_NO_AUTH=1 to accept the risk on a private host).')
  if (authMode === 'firebase' && !env.FIREBASE_PROJECT_ID) errors.push('FIREBASE_PROJECT_ID is required when BLUSWAN_AUTH=firebase.')

  const persistence = env.BLUSWAN_PERSISTENCE || 'file'
  if (!PERSISTENCE_KINDS.includes(persistence)) errors.push(`BLUSWAN_PERSISTENCE must be one of: ${PERSISTENCE_KINDS.join(', ')}.`)
  if (persistence === 'firebase' && !env.FIREBASE_PROJECT_ID) errors.push('FIREBASE_PROJECT_ID is required when BLUSWAN_PERSISTENCE=firebase.')
  if (persistence === 'firebase' && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.FIRESTORE_EMULATOR_HOST && !env.K_SERVICE && !env.GCE_METADATA_HOST) {
    warnings.push('BLUSWAN_PERSISTENCE=firebase needs Google application-default credentials (GOOGLE_APPLICATION_CREDENTIALS or a managed identity).')
  }
  if (persistence === 'memory' && (production || authMode !== 'none')) warnings.push('BLUSWAN_PERSISTENCE=memory loses every conversation when the server restarts.')

  const roots = (env.BLUSWAN_WORKSPACE_ROOTS || '').split(path.delimiter).map(s => s.trim()).filter(Boolean)
  if ((authMode !== 'none' || production) && !roots.length) errors.push('BLUSWAN_WORKSPACE_ROOTS is required when authentication is enabled or NODE_ENV=production.')
  for (const r of roots) if (!path.isAbsolute(r)) errors.push('BLUSWAN_WORKSPACE_ROOTS entries must be absolute paths.')

  const corsProblem = validateCorsOrigin(env.BLUSWAN_CORS_ORIGIN, { production })
  if (corsProblem) errors.push(corsProblem)
  if (env.BLUSWAN_CORS_ORIGIN?.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(env.BLUSWAN_CORS_ORIGIN) && authMode === 'firebase') {
    warnings.push('BLUSWAN_CORS_ORIGIN is plain http: bearer tokens would cross the network unencrypted. Serve the web app over HTTPS.')
  }
  if (!loopback && authMode === 'firebase') warnings.push('Listening beyond loopback: terminate TLS in front of BLUSWAN (reverse proxy) — never expose bearer tokens over plain http.')

  const providers = Object.entries(PROVIDER_KEYS).filter(([, k]) => !!env[k]).map(([p]) => p)

  return {
    ok: errors.length === 0, errors, warnings,
    settings: { port, host, authMode, persistence, dataDir: env.BLUSWAN_DATA_DIR || '.bluswan/data', roots, production, corsOrigin: env.BLUSWAN_CORS_ORIGIN || null, providers, hostId: env.BLUSWAN_HOST_ID || null, projectId: env.FIREBASE_PROJECT_ID || null, staticDir: env.BLUSWAN_STATIC_DIR || null },
  }
}
