// `npm run doctor`: checks a BLUSWAN deployment from the outside in and says what to fix. Read-only and offline by
// default (no provider is contacted, nothing billable). Secrets are never printed — only whether they are set.
import fs from 'node:fs/promises'
import { parseServerConfig } from './config.js'
import { createFilePersistence } from '../persistence/adapters/filePersistence.js'
import { APP_VERSION, PROTOCOL_VERSION } from '../protocol/version.js'

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i
const PROVIDER_VARS = { deepseek: 'DEEPSEEK_API_KEY', kimi: 'KIMI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }

const pass = (id, title, detail = '') => ({ id, status: 'pass', title, detail })
const warn = (id, title, detail = '', fix = '') => ({ id, status: 'warn', title, detail, fix })
const fail = (id, title, detail = '', fix = '') => ({ id, status: 'fail', title, detail, fix })
const skip = (id, title, detail = '') => ({ id, status: 'skip', title, detail })

async function timed(fetchImpl, url, init = {}, ms = 5000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { return await fetchImpl(url, { ...init, signal: ac.signal }) } finally { clearTimeout(t) }
}
const describeNetworkError = (e) => {
  const code = e?.cause?.code ?? e?.code
  if (code === 'ECONNREFUSED') return { detail: 'Connection refused: nothing is listening at that address.', fix: 'Start the runtime (npm run server) or correct BLUSWAN_PORT / the URL.' }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { detail: 'The host name does not resolve.', fix: 'Check the host name in the URL.' }
  if (e?.name === 'AbortError') return { detail: 'No answer within 5 seconds.', fix: 'Check the host/port, firewalls and the reverse proxy.' }
  if (/certificate|SSL|TLS/i.test(String(e?.cause?.message ?? e?.message))) return { detail: 'TLS handshake failed.', fix: 'Check the certificate on the reverse proxy.' }
  return { detail: 'The request failed before any response.', fix: 'Check that the runtime is running and the address is right.' }
}

/**
 * @param {{env?:object, url?:string, token?:string, live?:boolean, fetch?:typeof fetch, runLive?:(provider:string)=>Promise<{ok:boolean, detail?:string}>}} options
 * @returns {Promise<{ok:boolean, checks:object[], url:string}>}
 */
export async function runDoctor({ env = process.env, url, token = env.BLUSWAN_DOCTOR_TOKEN, live = false, fetch: fetchImpl = globalThis.fetch, runLive } = {}) {
  const checks = []
  const parsed = parseServerConfig(env)
  const { settings } = parsed

  // 1. environment
  if (parsed.ok) checks.push(pass('env', 'Server environment is valid', parsed.warnings.length ? `${parsed.warnings.length} warning(s) below` : ''))
  else checks.push(fail('env', 'Server environment is invalid', parsed.errors.join('\n'), 'Fix the variables named above (see .env.example and docs/DEPLOYMENT.md).'))
  for (const w of parsed.warnings) checks.push(warn('env-warning', 'Configuration warning', w))

  // 2. providers (names only)
  const configured = Object.entries(PROVIDER_VARS).filter(([, v]) => !!env[v]).map(([p]) => p)
  checks.push(configured.length
    ? pass('providers', `Model providers configured: ${configured.join(', ')}`)
    : warn('providers', 'No model provider is configured', 'BLUSWAN runs, but model calls will fail.', 'Set at least one of DEEPSEEK_API_KEY, KIMI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY on the runtime.'))

  // 3. workspace roots
  if (settings.roots.length) {
    const usable = []
    for (const r of settings.roots) { if (await fs.access(r).then(() => true, () => false)) usable.push(r) }
    checks.push(usable.length === settings.roots.length
      ? pass('workspace-roots', `Workspace roots accessible (${usable.length})`)
      : usable.length
        ? warn('workspace-roots', `${settings.roots.length - usable.length} of ${settings.roots.length} workspace roots are not accessible`, '', 'Fix BLUSWAN_WORKSPACE_ROOTS or the folder permissions.')
        : fail('workspace-roots', 'No configured workspace root is accessible on this machine', '', 'The runtime must run on the machine that owns the repositories. Fix BLUSWAN_WORKSPACE_ROOTS.'))
  } else checks.push(settings.authMode === 'none' && !settings.production ? pass('workspace-roots', 'No workspace roots set (local mode: repositories under your home directory)') : fail('workspace-roots', 'BLUSWAN_WORKSPACE_ROOTS is not set', '', 'Set it to the folders repositories may be opened from.'))

  // 4. persistence (local view of the configured store)
  if (settings.persistence === 'file') {
    try { await createFilePersistence({ dir: settings.dataDir }).probe(); checks.push(pass('persistence', 'Persistence directory is writable')) } catch { checks.push(fail('persistence', 'Persistence directory is not writable', '', 'Check BLUSWAN_DATA_DIR and its permissions.')) }
  } else if (settings.persistence === 'memory') checks.push(warn('persistence', 'Persistence is in memory', 'Conversations are lost when the runtime restarts.', 'Use BLUSWAN_PERSISTENCE=file or firebase for anything beyond experiments.'))
  else checks.push(skip('persistence', 'Firestore persistence is verified by the runtime readiness check below'))

  // 5. runtime reachable
  const base = (url || env.BLUSWAN_API_URL || env.VITE_BLUSWAN_API_URL || `http://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.port}`).replace(/\/+$/, '')
  let health = null
  try {
    const res = await timed(fetchImpl, `${base}/api/health`)
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.service !== 'bluswan') checks.push(fail('reachable', `${base} answered, but not as a BLUSWAN runtime`, `HTTP ${res.status}`, 'The address may point at the web app, a proxy page or another service. Check the reverse-proxy /api route.'))
    else {
      health = body
      checks.push(pass('reachable', `Runtime reachable at ${base}`, `version ${body.version}, protocol ${body.protocolVersion}, auth ${body.auth}`))
      checks.push(body.protocolVersion === PROTOCOL_VERSION
        ? pass('protocol', `Protocol version matches this checkout (${PROTOCOL_VERSION})`)
        : fail('protocol', `Protocol mismatch: runtime ${body.protocolVersion}, this checkout ${PROTOCOL_VERSION}`, `runtime ${body.version}, checkout ${APP_VERSION}`, 'Deploy the web app and the runtime from the same release.'))
      if (body.auth !== settings.authMode) checks.push(warn('auth-mode', `Runtime reports auth "${body.auth}" but this environment says "${settings.authMode}"`, '', 'Run the doctor with the same environment as the runtime.'))
    }
  } catch (e) {
    const d = describeNetworkError(e)
    checks.push(fail('reachable', `Cannot reach a runtime at ${base}`, d.detail, d.fix))
  }
  try {
    const u = new URL(base)
    if (!LOOPBACK.test(u.hostname) && LOOPBACK.test(settings.host)) checks.push(warn('bind', 'The runtime is bound to localhost only', `BLUSWAN_HOST=${settings.host}, but ${u.hostname} is not a loopback name.`, 'Other machines (and phones) cannot reach it. Use BLUSWAN_HOST=0.0.0.0 with BLUSWAN_AUTH=firebase behind HTTPS.'))
    if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname) && settings.authMode === 'firebase') checks.push(warn('https', 'Remote runtime over plain HTTP', 'Bearer tokens would cross the network unencrypted.', 'Terminate TLS in front of BLUSWAN.'))
  } catch { /* an invalid URL is already reported by the reachability check */ }

  // 6. readiness (+ auth/persistence as the runtime sees them)
  if (health) {
    try {
      const res = await timed(fetchImpl, `${base}/api/ready`); const body = await res.json().catch(() => null)
      if (res.ok) checks.push(pass('ready', 'Runtime is ready', Object.entries(body?.checks ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')))
      else checks.push(fail('ready', 'Runtime is up but not ready', body?.error?.message ?? `HTTP ${res.status}`, body?.error?.code === 'persistence_unavailable' ? 'Check the storage backend and BLUSWAN_DATA_DIR / Firestore credentials.' : body?.error?.code === 'workspace_host_unavailable' ? 'Check BLUSWAN_WORKSPACE_ROOTS on the runtime host.' : 'Check the runtime log.'))
      if (body?.providers && body.providers.configured === 0) checks.push(warn('runtime-providers', 'The running runtime has no model provider configured'))
    } catch (e) { checks.push(fail('ready', 'Readiness check failed', describeNetworkError(e).detail)) }

    // 7. event stream (detects proxies that buffer or time out SSE)
    if (health.auth === 'firebase' && !token) checks.push(skip('sse', 'Event stream not checked', 'The runtime requires sign-in; pass a Firebase ID token in BLUSWAN_DOCTOR_TOKEN to check it.'))
    else {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000)
      try {
        const res = await fetchImpl(`${base}/api/stream`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ac.signal })
        const type = res.headers.get('content-type') ?? ''
        if (!res.ok) checks.push(fail('sse', `Event stream refused (HTTP ${res.status})`, '', res.status === 401 ? 'The token was not accepted.' : 'Check the reverse-proxy /api/stream route.'))
        else if (!/text\/event-stream/.test(type)) checks.push(fail('sse', `Event stream returned ${type || 'no content type'}`, '', 'A proxy is rewriting the response. Route /api/ to the runtime unchanged.'))
        else {
          const reader = res.body.getReader(); const first = await reader.read(); clearTimeout(t)
          const text = new TextDecoder().decode(first.value ?? new Uint8Array())
          checks.push(/"kind":"hello"/.test(text) ? pass('sse', 'Event stream delivers data immediately', 'No proxy buffering detected') : fail('sse', 'The event stream did not deliver its first message', '', 'Disable proxy buffering for /api/stream (proxy_buffering off; X-Accel-Buffering is already sent).'))
          await reader.cancel().catch(() => {})
        }
      } catch (e) { checks.push(fail('sse', 'Event stream did not open in time', e?.name === 'AbortError' ? 'No data within 5 seconds — typical of a buffering proxy.' : describeNetworkError(e).detail, 'Disable proxy buffering and raise read timeouts for /api/stream.')) } finally { clearTimeout(t); ac.abort() }
    }

    // 8. CORS for split-origin deployments
    if (settings.corsOrigin) {
      try {
        const res = await timed(fetchImpl, `${base}/api/bootstrap`, { method: 'OPTIONS', headers: { Origin: settings.corsOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
        const allowed = res.headers.get('access-control-allow-origin')
        checks.push(allowed === settings.corsOrigin ? pass('cors', `CORS allows ${settings.corsOrigin}`) : fail('cors', 'CORS preflight is not allowing the configured web origin', `Access-Control-Allow-Origin: ${allowed ?? '(none)'}`, 'Make sure BLUSWAN_CORS_ORIGIN equals the web app origin exactly and the proxy forwards OPTIONS.'))
      } catch (e) { checks.push(fail('cors', 'CORS preflight failed', describeNetworkError(e).detail)) }
    }
  } else checks.push(skip('ready', 'Readiness not checked', 'The runtime is not reachable.'))

  // 9. optional live provider checks (billable; explicit opt-in)
  if (live) {
    if (!configured.length) checks.push(skip('live', 'No configured provider to test'))
    for (const p of configured) {
      if (!runLive) { checks.push(skip(`live-${p}`, `${p}: live check unavailable here`)); continue }
      const r = await runLive(p).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }))
      checks.push(r.ok ? pass(`live-${p}`, `${p}: live request succeeded`) : fail(`live-${p}`, `${p}: live request failed`, r.detail ?? '', 'Check the key, base URL and model name.'))
    }
  } else if (configured.length) checks.push(skip('live', 'Live provider checks not run', 'Add --live to make one small billable request per configured provider.'))

  return { ok: !checks.some(c => c.status === 'fail'), checks, url: base }
}

const MARK = { pass: '✓', warn: '!', fail: '✕', skip: '-' }
export function formatDoctor(result) {
  const lines = [`BLUSWAN doctor — ${result.url}`, '']
  for (const c of result.checks) {
    lines.push(`${MARK[c.status]} ${c.title}`)
    if (c.detail) for (const l of c.detail.split('\n')) lines.push(`    ${l}`)
    if (c.fix && c.status !== 'pass') lines.push(`    → ${c.fix}`)
  }
  const n = (s) => result.checks.filter(c => c.status === s).length
  lines.push('', `${n('pass')} passed, ${n('warn')} warnings, ${n('fail')} failed, ${n('skip')} skipped`)
  return lines.join('\n')
}
