// Minimal HTTP surface over the application service (node:http, no framework).
// JSON request/response plus one Server-Sent-Events stream that carries canonical runtime events unchanged.
// Every route except /api/health authenticates the bearer token and acts only on that user's data.
import { bearerToken } from './auth.js'
import { isBluswanError, createError } from '../protocol/schemas.js'
import { redactSecrets } from '../utils/redact.js'
import { createLogger } from '../utils/logger.js'
import { randomUUID } from 'node:crypto'
import { APP_VERSION, PROTOCOL_VERSION, SERVICE_NAME } from '../protocol/version.js'

const log = createLogger('http')
const MAX_BODY = 1_000_000
const STATUS = { unauthenticated: 401, forbidden: 403, not_found: 404, workspace_not_found: 404, persistence_not_found: 404, invalid_request: 400, session_busy: 409, persistence_conflict: 409, nothing_to_revert: 409, revert_unsupported: 422, revert_failed: 500, configuration_error: 503, persistence_invalid_record: 422, persistence_schema_unsupported: 422, persistence_unavailable: 503, server_not_ready: 503, server_unavailable: 503, workspace_host_unavailable: 503, payload_too_large: 413, too_many_requests: 429, protocol_mismatch: 426, github_not_configured: 503, github_not_connected: 409, github_rate_limited: 429, github_auth_expired: 401, github_permission_denied: 403, github_repository_not_found: 404, github_api_error: 502, git_operation_failed: 500, git_dirty_working_tree: 409, git_conflicts: 409, git_detached_head: 409, git_branch_diverged: 409, git_push_rejected: 409, git_remote_mismatch: 409, git_timeout: 504, git_auth_rejected: 403, operation_in_progress: 409, operation_cancelled: 409, clone_conflict: 409, protected_branch: 409, branch_exists: 409, pull_request_not_merged: 409 }

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

async function readJson(req, maxBody = MAX_BODY) {
  let size = 0
  let tooLarge = false
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > maxBody) { // keep draining (without storing) so the client receives the 413 instead of a reset, up to a hard cap
      tooLarge = true
      if (size > maxBody * 8) { req.destroy(); break }
      continue
    }
    chunks.push(c)
  }
  if (tooLarge) throw createError({ code: 'payload_too_large', message: 'Request body is too large.' })
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw createError({ code: 'invalid_request', message: 'Request body must be JSON.' }) }
}

async function readRaw(req, max = 5_000_000) {
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > max) throw createError({ code: 'payload_too_large', message: 'Request body is too large.' }); chunks.push(c) }
  return Buffer.concat(chunks)
}

/** Normalizes any failure into { error: { code, message } } — never a stack trace, never a secret. */
export function errorBody(e) {
  if (isBluswanError(e)) return { status: STATUS[e.code] ?? 500, body: { error: { code: e.code, message: e.message, retryable: !!e.retryable } } }
  log.warn('unhandled request failure', { message: redactSecrets(String(e?.message ?? e)) })
  return { status: 500, body: { error: { code: 'runtime_error', message: 'Something went wrong on the server.', retryable: false } } }
}

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' }

/**
 * @param {{service:object, auth:{verify:(token:string|null)=>Promise<{id:string,email:string|null}>}, corsOrigin?:string|null,
 *          heartbeatMs?:number, maxBodyBytes?:number, sseMaxMs?:number, staticDir?:string|null, logRequests?:boolean, logger?:object}} deps
 * @returns {((req, res) => void) & {drain:()=>void, closeStreams:()=>void}} request listener
 */
export function createHttpHandler({ service, auth, corsOrigin = null, heartbeatMs = 15_000, maxBodyBytes = MAX_BODY, sseMaxMs = 6 * 3600_000, staticDir = null, logRequests = false, logger = log }) {
  const maxBody = maxBodyBytes
  const authName = auth.mode === 'firebase' ? 'firebase' : 'none'
  const streams = new Set()
  let draining = false
  // CORS is granted to exactly one configured origin, and only when the request really comes from it.
  const corsFor = (req) => (corsOrigin && req.headers.origin === corsOrigin
    ? { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-ID', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'X-Request-ID', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
    : (corsOrigin ? { Vary: 'Origin' } : {}))
  const requestId = (req) => {
    const given = req.headers['x-request-id']
    return typeof given === 'string' && /^[A-Za-z0-9_.-]{8,64}$/.test(given) ? given : randomUUID()
  }

  async function route(req, res, url, user, hdr) {
    const m = req.method
    const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const q = url.searchParams
    const body = m === 'GET' || m === 'DELETE' ? {} : await readJson(req, maxBody)
    const ok = (data, status = 200) => send(res, status, data, hdr)

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
    if (seg[0] === 'github') {
      const gh = service.github
      if (seg[1] === 'status' && m === 'GET') return ok(await gh.status(user))
      if (seg[1] === 'connect' && !seg[2] && m === 'POST') return ok(await gh.connectUrl(user))
      if (seg[1] === 'connect' && seg[2] === 'complete' && m === 'POST') return ok(await gh.completeConnection(user, { code: body.code, installationId: body.installationId, state: body.state }))
      if (seg[1] === 'disconnect' && m === 'POST') return ok(await gh.disconnect(user))
      if (seg[1] === 'recent' && m === 'GET') return ok(await gh.recent(user))
      if (seg[1] === 'tasks' && m === 'GET') return ok(await gh.allTasks(user))
      if (seg[1] === 'repositories' && !seg[2] && m === 'GET') return ok(await gh.listRepositories(user, { page: Number(q.get('page')) || 1, perPage: Number(q.get('perPage')) || 30, q: q.get('q') ?? '', owner: q.get('owner') ?? '', visibility: q.get('visibility') ?? '', refresh: q.get('refresh') === '1' }))
      if (seg[1] === 'repositories' && seg[2] && seg[3] && !seg[4] && m === 'GET') return ok(await gh.repository(user, seg[2], seg[3]))
      if (seg[1] === 'repositories' && seg[4] === 'clone' && m === 'POST') return ok(await gh.clone(user, seg[2], seg[3]), 201)
      if (seg[1] === 'repositories' && seg[4] === 'open' && m === 'POST') return ok(await gh.open(user, seg[2], seg[3]))
    }
    if (seg[0] === 'operations' && seg[2] === 'cancel' && m === 'POST') return ok(service.github.cancel(user, seg[1]))
    if (seg[0] === 'workspaces' && seg[1] && seg[2]) {
      const gh = service.github; const id = seg[1]
      if (seg[2] === 'git' && m === 'GET') return ok(await gh.git(user, id))
      if (seg[2] === 'branches' && m === 'GET') return ok(await gh.branches(user, id))
      if (seg[2] === 'branches' && m === 'POST') return ok(await gh.createBranch(user, id, body), 201)
      if (seg[2] === 'suggest-branch' && m === 'GET') return ok(gh.suggestBranch(q.get('task') ?? '', []))
      if (seg[2] === 'checkout' && m === 'POST') return ok(await gh.checkout(user, id, body))
      if (seg[2] === 'sync' && m === 'POST') return ok(await gh.sync(user, id))
      if (seg[2] === 'commits' && m === 'GET') return ok(await gh.commits(user, id, { limit: Number(q.get('limit')) || 15 }))
      if (seg[2] === 'suggest-commit' && m === 'GET') return ok(await gh.suggestCommit(user, id, { task: q.get('task') ?? '' }))
      if (seg[2] === 'commit' && m === 'POST') return ok(await gh.commit(user, id, body), 201)
      if (seg[2] === 'push' && m === 'POST') return ok(await gh.push(user, id))
      if (seg[2] === 'pr-draft' && m === 'POST') return ok(await gh.prDraft(user, id, body))
      if (seg[2] === 'pull-requests' && !seg[3] && m === 'POST') return ok(await gh.createPullRequest(user, id, body), 201)
      if (seg[2] === 'pull-requests' && seg[3] === 'current' && m === 'GET') return ok(await gh.pullRequestStatus(user, id, { branch: q.get('branch') || undefined }))
      if (seg[2] === 'cleanup' && m === 'POST') return ok(await gh.cleanup(user, id, body))
      if (seg[2] === 'abandon' && m === 'POST') return ok(await gh.abandon(user, id, body))
      if (seg[2] === 'remove-local' && m === 'POST') return ok(await gh.removeLocalCopy(user, id, body))
      if (seg[2] === 'tasks' && m === 'GET') return ok(await gh.tasks(user, id))
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
      if (seg[2] === 'model' && m === 'PUT') return ok(await service.setModel(user, id, body))
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

  async function stream(req, res, user, hdr) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...hdr })
    const write = (msg) => { if (!res.writableEnded && !res.destroyed) res.write(`id: ${msg.event?.id ?? ''}\ndata: ${JSON.stringify(msg)}\n\n`) }
    write({ kind: 'hello', at: Date.now(), protocolVersion: PROTOCOL_VERSION })
    const unsubscribe = await service.subscribe(user, write)
    const beat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n') }, heartbeatMs)
    const lifetime = sseMaxMs > 0 ? setTimeout(() => close(true), sseMaxMs) : null // the client reconnects and resyncs
    let closed = false
    const handle = { end: () => close(true) }
    function close(end = false) {
      if (closed) return
      closed = true; clearInterval(beat); clearTimeout(lifetime); unsubscribe(); streams.delete(handle)
      if (end && !res.writableEnded) res.end()
    }
    streams.add(handle)
    req.on('close', () => close()); res.on('error', () => close()); res.on('close', () => close())
  }

  async function serveStatic(req, res, url, hdr) {
    const fsp = await import('node:fs/promises'); const pathMod = await import('node:path')
    const root = pathMod.resolve(staticDir)
    let rel = decodeURIComponent(url.pathname)
    let abs = pathMod.resolve(root, '.' + pathMod.posix.normalize('/' + rel))
    if (abs !== root && !abs.startsWith(root + pathMod.sep)) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } }, hdr)
    let st = await fsp.stat(abs).catch(() => null)
    if (st?.isDirectory()) { abs = pathMod.join(abs, 'index.html'); st = await fsp.stat(abs).catch(() => null) }
    const asset = !!st?.isFile()
    if (!asset) { // single-page app: unknown non-file paths load the app, which does its own routing
      if (pathMod.extname(rel)) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } }, hdr)
      abs = pathMod.join(root, 'index.html')
    }
    const body = await fsp.readFile(abs).catch(() => null)
    if (!body) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } }, hdr)
    const type = CONTENT_TYPES[pathMod.extname(abs)] ?? 'application/octet-stream'
    const immutable = /[\\/]assets[\\/].+-[A-Za-z0-9_-]{6,}\./.test(abs)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Request-ID': hdr['X-Request-ID'] })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function handler(req, res) {
    const started = Date.now()
    const id = requestId(req)
    const hdr = { 'X-Request-ID': id, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...corsFor(req) }
    let url = null
    let userId = null
    res.on('finish', () => {
      if (!logRequests) return
      // one line per request: no query string, no body, no headers, no tokens
      logger.info('request', { method: req.method, path: url?.pathname?.startsWith('/api/') ? url.pathname.replace(/\/sessions\/[^/]+/, '/sessions/:id') : '(static)', status: res.statusCode, ms: Date.now() - started, requestId: id, ...(userId ? { user: userId.slice(0, 8) } : {}) })
    })
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, hdr); return res.end() }
      url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith('/api/')) {
        if (staticDir && (req.method === 'GET' || req.method === 'HEAD')) return await serveStatic(req, res, url, hdr)
        return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } }, hdr)
      }
      // liveness: fast, unauthenticated, reveals nothing but the service identity and versions
      if (url.pathname === '/api/health') return send(res, 200, { ok: true, service: SERVICE_NAME, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, auth: authName }, hdr)
      // readiness: can the runtime do work? 503 when storage or workspaces are unusable. Categories only.
      if (url.pathname === '/api/ready') {
        const r = draining ? { ready: false, code: 'server_not_ready', message: 'BLUSWAN is shutting down.', checks: {} } : await service.ready()
        return send(res, r.ready ? 200 : 503, r.ready
          ? { ok: true, ready: true, service: SERVICE_NAME, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, auth: authName, checks: r.checks, providers: r.providers }
          : { ok: false, ready: false, service: SERVICE_NAME, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, auth: authName, checks: r.checks, providers: r.providers, error: { code: r.code, message: r.message, retryable: true } }, hdr)
      }
      if (url.pathname === '/api/github/webhook' && req.method === 'POST') { // authenticated by signature, not by bearer token
        const raw = await readRaw(req)
        const gh = service.github
        if (!gh?.configured || !gh.webhookEnabled) throw createError({ code: 'not_found', message: 'Unknown endpoint.' })
        if (!gh.verifyWebhook(raw, req.headers['x-hub-signature-256'])) throw createError({ code: 'unauthenticated', message: 'Invalid webhook signature.' })
        let payload; try { payload = JSON.parse(raw.toString('utf8')) } catch { throw createError({ code: 'invalid_request', message: 'Webhook body must be JSON.' }) }
        const result = await gh.handleWebhook(String(req.headers['x-github-event'] ?? ''), payload)
        return send(res, 202, { accepted: true, ...result }, hdr)
      }
      if (draining) throw createError({ code: 'server_not_ready', message: 'BLUSWAN is shutting down.', retryable: true })
      const user = await auth.verify(bearerToken(req))
      userId = user.id
      if (url.pathname === '/api/stream' && req.method === 'GET') return await stream(req, res, user, hdr)
      return await route(req, res, url, user, hdr)
    } catch (e) {
      if (res.headersSent) { res.end(); return }
      const { status, body } = errorBody(e)
      send(res, status, { error: { ...body.error, requestId: id } }, hdr)
    }
  }
  handler.drain = () => { draining = true }
  handler.closeStreams = () => { for (const s of [...streams]) s.end() }
  handler.streamCount = () => streams.size
  return handler
}
