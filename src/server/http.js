// Minimal HTTP surface over the application service (node:http, no framework).
// JSON request/response plus one Server-Sent-Events stream that carries canonical runtime events unchanged.
// Every route except /api/health authenticates the bearer token and acts only on that user's data.
import { bearerToken } from './auth.js'
import { isBluswanError, createError } from '../protocol/schemas.js'
import { redactSecrets } from '../utils/redact.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('http')
const MAX_BODY = 1_000_000
const STATUS = { unauthenticated: 401, forbidden: 403, not_found: 404, workspace_not_found: 404, persistence_not_found: 404, invalid_request: 400, session_busy: 409, persistence_conflict: 409, nothing_to_revert: 409, revert_unsupported: 422, revert_failed: 500, configuration_error: 503, persistence_invalid_record: 422, persistence_schema_unsupported: 422, persistence_unavailable: 503 }

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw createError({ code: 'invalid_request', message: 'Request body is too large.' })
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw createError({ code: 'invalid_request', message: 'Request body must be JSON.' }) }
}

/** Normalizes any failure into { error: { code, message } } — never a stack trace, never a secret. */
export function errorBody(e) {
  if (isBluswanError(e)) return { status: STATUS[e.code] ?? 500, body: { error: { code: e.code, message: e.message, retryable: !!e.retryable } } }
  log.warn('unhandled request failure', { message: redactSecrets(String(e?.message ?? e)) })
  return { status: 500, body: { error: { code: 'runtime_error', message: 'Something went wrong on the server.', retryable: false } } }
}

/**
 * @param {{service:object, auth:{verify:(token:string|null)=>Promise<{id:string,email:string|null}>}, corsOrigin?:string|null,
 *          heartbeatMs?:number}} deps
 * @returns {(req, res) => void} request listener
 */
export function createHttpHandler({ service, auth, corsOrigin = null, heartbeatMs = 15_000 }) {
  const cors = corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', Vary: 'Origin' } : {}

  async function route(req, res, url, user) {
    const m = req.method
    const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const q = url.searchParams
    const body = m === 'GET' || m === 'DELETE' ? {} : await readJson(req)
    const ok = (data, status = 200) => send(res, status, data, cors)

    if (seg[0] === 'me' && m === 'GET') return ok({ user })
    if (seg[0] === 'bootstrap' && m === 'GET') return ok(await service.bootstrap(user))
    if (seg[0] === 'providers' && m === 'GET') return ok({ providers: service.providers(user) })
    if (seg[0] === 'settings') return ok(m === 'PUT' ? await service.saveSettings(user, body) : await service.getSettings(user))
    if (seg[0] === 'model-check' && m === 'POST') return ok(await service.checkModel(user, body.model))
    if (seg[0] === 'workspaces') {
      if (!seg[1] && m === 'GET') return ok({ workspaces: await service.listWorkspaces(user) })
      if (!seg[1] && m === 'POST') return ok(await service.openWorkspace(user, body), 201)
      if (seg[2] === 'reconnect' && m === 'POST') return ok(await service.reconnectWorkspace(user, seg[1], body))
    }
    if (seg[0] === 'sessions') {
      if (!seg[1]) {
        if (m === 'GET') return ok(await service.listSessions(user, { cursor: q.get('cursor'), limit: Number(q.get('limit')) || 50 }))
        if (m === 'POST') return ok(await service.createSession(user, body), 201)
      }
      const id = seg[1]
      if (!seg[2]) {
        if (m === 'GET') return ok(await service.getSession(user, id))
        if (m === 'DELETE') return ok(await service.deleteSession(user, id))
      }
      if (seg[2] === 'messages' && m === 'POST') return ok(await service.sendMessage(user, id, body.content), 202)
      if (seg[2] === 'cancel' && m === 'POST') return ok(await service.cancel(user, id))
      if (seg[2] === 'permissions' && seg[3] && m === 'POST') {
        if (body.decision === 'approve') return ok(await service.approve(user, id, seg[3]))
        if (body.decision === 'deny') return ok(await service.deny(user, id, seg[3]))
        throw createError({ code: 'invalid_request', message: 'decision must be "approve" or "deny".' })
      }
      if (seg[2] === 'workspace-state' && m === 'GET') return ok(await service.workspaceState(user, id))
      if (seg[2] === 'diff' && m === 'GET') return ok(await service.fileDiff(user, id, q.get('path') ?? '', q.get('from') || undefined))
      if (seg[2] === 'revert' && m === 'POST') return ok(await service.revertFile(user, id, body.path))
      if (seg[2] === 'commands' && !seg[3] && m === 'GET') return ok({ commands: await service.commands(user, id) })
      if (seg[2] === 'commands' && seg[3] && m === 'GET') return ok(await service.command(user, id, seg[3]))
    }
    if (seg[0] === 'logout' && m === 'POST') { await service.dispose(user); return ok({ ok: true }) }
    throw createError({ code: 'not_found', message: 'Unknown endpoint.' })
  }

  async function stream(req, res, user) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors })
    const write = (msg) => res.write(`id: ${msg.event?.id ?? ''}\ndata: ${JSON.stringify(msg)}\n\n`)
    write({ kind: 'hello', at: Date.now() })
    const unsubscribe = await service.subscribe(user, write)
    const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs)
    const close = () => { clearInterval(beat); unsubscribe() }
    req.on('close', close); res.on('error', close)
  }

  return async function handler(req, res) {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
      const url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } }, cors)
      if (url.pathname === '/api/health') return send(res, 200, { ok: true }, cors)
      const user = await auth.verify(bearerToken(req))
      if (url.pathname === '/api/stream' && req.method === 'GET') return await stream(req, res, user)
      return await route(req, res, url, user)
    } catch (e) {
      if (res.headersSent) { res.end(); return }
      const { status, body } = errorBody(e)
      send(res, status, body, cors)
    }
  }
}
