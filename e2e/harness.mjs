// End-to-end harness: the REAL BLUSWAN server (src/server/main.js) behind a small front server that serves the built
// web app (dist/) and proxies /api to the backend. The front server also exposes /__e2e/* controls so tests can stop,
// start and restart the backend, drop the event stream, and expire credentials — while the browser keeps one page.
//
//  • provider: deterministic scripted fake (no network, no keys); the user's message text selects the script;
//  • repository: a temporary git fixture; persistence: a temporary directory;
//  • identity: the front server plays an identity-aware gateway, attaching "Authorization: Bearer tok-<user>" for the
//    user named in the `e2e_user` cookie. (Firebase sign-in itself needs the emulator, which is not available offline.)
import http from 'node:http'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../src/server/main.js'
import { createCredentialStore } from '../src/providers/credentials/credentialStore.js'
import { createFakeProvider, say, call, reply } from '../src/agent/testing/fakeProvider.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../src/workspace/testing/fixtureRepo.js'
import { createError } from '../src/protocol/schemas.js'
import { startFakeGithub, generateAppKey } from '../src/server/github/testing/fakeGithub.js'
import { createGithubApi } from '../src/server/github/api.js'
import { createAppAuth } from '../src/server/github/appAuth.js'
import { clonePath } from '../src/server/github/paths.js'
import { FIXTURE_FILES } from '../src/workspace/testing/fixtureRepo.js'

const PORT = Number(process.env.E2E_PORT || 4173)
const DIST = path.resolve(import.meta.dirname, '../dist')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const state = {
  backend: null, backendPort: 0, root: null, dataDir: null, repo: null,
  tokens: new Map(), // user → token the gateway attaches
  valid: new Set(), generation: 0,
  fake: null, providerMode: 'ok', readyFail: false, streamBlocked: false, proxied: new Set(), requests: 0,
}

const tokenFor = (user) => state.tokens.get(user) ?? `tok-${user}-${state.generation}`
const auth = {
  mode: 'test', // reported to the browser as "none": no sign-in screen, the gateway supplies the identity
  async verify(token) {
    const m = /^tok-([a-z]+)-(\d+)$/.exec(token ?? '')
    if (!m || Number(m[2]) !== state.generation) throw createError({ code: 'unauthenticated', message: 'Your session has expired. Sign in again.' })
    return { id: m[1], email: `${m[1]}@example.test` }
  },
}

const lastUser = (req) => req.messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
const assistantsSinceUser = (req) => { let n = 0; for (let i = req.messages.length - 1; i >= 0 && req.messages[i].role !== 'user'; i--) if (req.messages[i].role === 'assistant') n++; return n }
const typed = async (onEvent, text, delay = 15) => { for (const part of text.match(/.{1,12}/gs) ?? []) { onEvent(say(part)); await sleep(delay) } }

/** The scripted "model": behaviour is chosen by the user's message. Deterministic, offline, free. */
function respond(req, _n, onEvent) {
  const text = lastUser(req).toLowerCase()
  const k = assistantsSinceUser(req)
  if (state.providerMode === 'outage') throw createError({ code: 'provider_error', message: 'The provider is unavailable.', retryable: false, provider: 'deepseek' })
  return (async () => {
    if (text.startsWith('slow')) { // streams for a long time; Stop aborts it
      for (let i = 0; i < 200 && !req.signal?.aborted; i++) { onEvent(say(`tick ${i} `)); await sleep(100) }
      return []
    }
    if (text.startsWith('fix add')) {
      if (k === 0) return reply(call('p1', 'apply_patch', { patch: FIX_ADD_PATCH }))
      await typed(onEvent, k === 1 ? 'Fixed the add function.' : 'Verified: the tests pass.'); return reply()
    }
    if (text.startsWith('create approval')) { // a command that needs the user's approval in Ask / Auto Edit
      if (k === 0) return reply(call('s1', 'shell', { command: 'touch approved.txt' }))
      await typed(onEvent, 'Created approved.txt.'); return reply()
    }
    if (text.startsWith('dangerous')) {
      if (k === 0) return reply(call('s2', 'shell', { command: 'rm -rf /' }))
      await typed(onEvent, 'That command is not allowed.'); return reply()
    }
    await typed(onEvent, 'Hello from the scripted model.'); return reply()
  })()
}

function backendEnv() {
  return {
    BLUSWAN_PORT: '0', BLUSWAN_HOST: '127.0.0.1', BLUSWAN_PERSISTENCE: 'file', BLUSWAN_DATA_DIR: state.dataDir, BLUSWAN_WORKSPACE_ROOTS: state.root,
    BLUSWAN_AUTH: 'none', BLUSWAN_PERMISSION_MODE: 'auto_edit',
  }
}

async function startBackend() {
  if (state.backend) return
  const persistenceMod = await import('../src/persistence/adapters/filePersistence.js')
  const persistence = persistenceMod.createFilePersistence({ dir: state.dataDir })
  const probe = persistence.probe
  persistence.probe = async () => { if (state.readyFail) throw new Error('forced'); return probe() }
  const credentials = createCredentialStore({ deepseek: { apiKey: 'e2e-not-a-real-key', baseUrl: 'http://invalid.test', model: 'scripted-model' } })
  const api = createGithubApi({ apiUrl: state.fake.url })
  const github = {
    settings: { configured: true, webhook: false, apiUrl: state.fake.url, webUrl: state.fake.url, slug: 'bluswan-e2e' }, api, webApi: api,
    appAuth: createAppAuth({ appId: '1', privateKey: state.appKey, api }),
    secrets: { clientId: 'cid', clientSecret: 'e2e-client-secret', webhookSecret: 'e2e-hook', stateSecret: 'e2e-client-secret' }, cloneUrlOk: () => true,
  }
  state.backend = await startServer({
    env: backendEnv(), heartbeatMs: 1000, shutdownDeadlineMs: 1500,
    injected: { auth, persistence, credentials, github, providerFactory: () => createFakeProvider({ id: 'deepseek', respond }) },
  })
  state.backendPort = state.backend.port
}
async function stopBackend() {
  const b = state.backend; state.backend = null
  for (const r of [...state.proxied]) r.destroy()
  if (b) await b.close('e2e')
}
async function reset() {
  await stopBackend()
  await state.fake?.close().catch(() => {})
  state.appKey ??= generateAppKey()
  state.fake = await startFakeGithub({ repos: [{ owner: 'acme', name: 'widgets', private: true, files: FIXTURE_FILES }], redirectTo: `http://127.0.0.1:${PORT}` })
  if (state.root) await fs.rm(state.root, { recursive: true, force: true })
  state.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-e2e-')))
  state.dataDir = path.join(state.root, '.data')
  state.repo = await createFixtureRepo({ git: true })
  // the repository must sit below the allowed root
  const target = path.join(state.root, 'repo')
  await fs.rename(state.repo.root, target).catch(async () => { await fs.cp(state.repo.root, target, { recursive: true }) })
  state.repoPath = target
  state.tokens.clear(); state.protocolOverride = null; state.generation = 0; state.providerMode = 'ok'; state.readyFail = false; state.streamBlocked = false
  await startBackend()
}

// ─── front server ────────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
const cookieUser = (req) => /(?:^|;\s*)e2e_user=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'alice'

async function control(req, res, url) {
  const op = url.pathname.replace('/__e2e/', '')
  const q = url.searchParams
  if (op === 'ready') return json(res, 200, { ok: true })
  if (op === 'reset') { await reset(); return json(res, 200, { repo: state.repoPath }) }
  if (op === 'info') return json(res, 200, { repo: state.repoPath, backendUp: !!state.backend, backendPort: state.backendPort, root: state.root })
  if (op === 'backend/stop') { await stopBackend(); return json(res, 200, { ok: true }) }
  if (op === 'backend/start') { await startBackend(); return json(res, 200, { ok: true }) }
  if (op === 'backend/restart') { await stopBackend(); await startBackend(); return json(res, 200, { ok: true }) }
  if (op === 'stream/drop') { for (const r of [...state.proxied]) r.destroy(); return json(res, 200, { dropped: true }) }
  if (op === 'stream/block') { state.streamBlocked = q.get('on') === '1'; if (state.streamBlocked) for (const r of [...state.proxied]) r.destroy(); return json(res, 200, { blocked: state.streamBlocked }) }
  if (op === 'token/expire') { state.generation += 1; state.tokens.set(q.get('user') ?? 'alice', `tok-${q.get('user') ?? 'alice'}-0`); return json(res, 200, { ok: true }) } // the gateway keeps sending the old token
  if (op === 'token/refresh') { state.tokens.delete(q.get('user') ?? 'alice'); return json(res, 200, { ok: true, generation: state.generation }) }
  if (op === 'provider') { state.providerMode = q.get('mode') ?? 'ok'; return json(res, 200, { mode: state.providerMode }) }
  if (op === 'ready-fail') { state.readyFail = q.get('on') === '1'; return json(res, 200, { readyFail: state.readyFail }) }
  if (op === 'file') {
    const abs = path.resolve(state.repoPath, q.get('path') ?? '')
    if (!abs.startsWith(state.repoPath + path.sep)) return json(res, 400, { error: 'outside' })
    if (req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); await fs.writeFile(abs, Buffer.concat(chunks)); return json(res, 200, { ok: true }) }
    return json(res, 200, { content: await fs.readFile(abs, 'utf8').catch(() => null) })
  }
  if (op === 'git') return json(res, 200, { status: state.repo.git('status', '--porcelain'), head: state.repo.git('rev-parse', 'HEAD').trim() })
  if (op === 'repo/move') { // the repository disappears from (or returns to) the runtime host
    const away = `${state.repoPath}.moved`
    if (q.get('on') === '1') await fs.rename(state.repoPath, away); else await fs.rename(away, state.repoPath)
    return json(res, 200, { ok: true })
  }
  if (op === 'health-protocol') { state.protocolOverride = q.get('v') ? Number(q.get('v')) : null; return json(res, 200, { ok: true }) }
  if (op === 'gh/merge') { const sha = state.fake.merge(Number(q.get('n') ?? 1), { method: q.get('method') ?? 'merge', deleteBranch: q.get('deleteBranch') === '1' }); return json(res, 200, { sha }) }
  if (op === 'gh/remote') return json(res, 200, { branches: ['main', ...(q.get('branch') ? [q.get('branch')] : [])].filter(b => state.fake.hasRemoteBranch('acme', 'widgets', b)), prs: state.fake.state.prs.map(p => ({ number: p.number, state: p.state, merged: !!p.merged_at, head: p.head })), tokenRequests: state.fake.state.tokens })
  if (op === 'gh/break-remote') { const r = state.fake.state.repos.get('acme/widgets'); if (q.get('on') === '1') { r.goodBare = r.bare; r.bare = `${r.bare}.missing` } else if (r.goodBare) { r.bare = r.goodBare }; return json(res, 200, { ok: true }) }
  if (op === 'gh/reject-pushes') { state.fake.rejectPushes('acme', 'widgets'); return json(res, 200, { ok: true }) }
  if (op === 'gh/local') {
    const dir = clonePath({ root: state.root, userId: q.get('user') ?? 'alice', owner: 'acme', repo: 'widgets' })
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim()
    try { return json(res, 200, { exists: true, branch: git('rev-parse', '--abbrev-ref', 'HEAD'), status: git('status', '--porcelain'), branches: git('branch', '--format=%(refname:short)').split('\n').filter(Boolean), math: fsSync.readFileSync(path.join(dir, 'src/math.js'), 'utf8') }) } catch { return json(res, 200, { exists: false }) }
  }
  if (op === 'stats') return json(res, 200, { ...(await state.backend?.service.stats()), requests: state.requests, proxiedStreams: state.proxied.size })
  return json(res, 404, { error: 'unknown control' })
}

function proxy(req, res, url) {
  state.requests += 1
  const isStream = url.pathname === '/api/stream'
  if (!state.backend || (isStream && state.streamBlocked)) { // what an nginx in front of a dead runtime answers
    res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html><body><h1>502 Bad Gateway</h1></body></html>')
  }
  if (url.pathname === '/api/health' && state.protocolOverride) { // a runtime from a different release
    return json(res, 200, { ok: true, service: 'bluswan', version: '9.9.9', protocolVersion: state.protocolOverride, auth: 'none' })
  }
  const user = cookieUser(req)
  const headers = { ...req.headers, host: `127.0.0.1:${state.backendPort}` }
  delete headers.cookie
  if (!headers.authorization) headers.authorization = `Bearer ${tokenFor(user)}`
  const up = http.request({ host: '127.0.0.1', port: state.backendPort, method: req.method, path: req.url, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers)
    ur.pipe(res)
  })
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html><body><h1>502 Bad Gateway</h1></body></html>') } else res.destroy() })
  if (isStream) {
    state.proxied.add(res)
    res.on('close', () => { state.proxied.delete(res); up.destroy() })
  } else res.on('close', () => up.destroy())
  req.pipe(up)
}

async function serveDist(req, res, url) {
  let rel = decodeURIComponent(url.pathname)
  let abs = path.join(DIST, path.normalize(rel))
  if (!abs.startsWith(DIST)) { res.writeHead(404); return res.end() }
  if (!fsSync.existsSync(abs) || fsSync.statSync(abs).isDirectory()) abs = path.join(DIST, 'index.html')
  const body = await fs.readFile(abs)
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
  res.end(body)
}

const front = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (url.pathname.startsWith('/__e2e/')) return await control(req, res, url)
    if (url.pathname.startsWith('/api/')) return proxy(req, res, url)
    return await serveDist(req, res, url)
  } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) }); else res.end() }
})
await reset()
front.listen(PORT, '127.0.0.1', () => console.log(`e2e harness on http://127.0.0.1:${PORT}`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stopBackend().catch(() => {}); await state.fake?.close().catch(() => {}); await fs.rm(state.root, { recursive: true, force: true }).catch(() => {}); process.exit(0) })
