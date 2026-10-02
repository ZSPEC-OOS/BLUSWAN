// Builds and starts the BLUSWAN server from an environment. Used by `npm run server`, `npm run doctor` and the
// end-to-end tests, so the code that ships is the code that is tested. Nothing here calls process.exit.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createBluswanService } from './service.js'
import { createHttpHandler } from './http.js'
import { createNoAuth, createFirebaseVerifier } from './auth.js'
import { parseServerConfig } from './config.js'
import { createEnvCredentialStore } from '../providers/credentials/serverCredentialStore.js'
import { createFilePersistence } from '../persistence/adapters/filePersistence.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { APP_VERSION, PROTOCOL_VERSION } from '../protocol/version.js'

export class ConfigError extends Error {
  constructor(problems) { super(`Invalid BLUSWAN configuration:\n - ${problems.join('\n - ')}`); this.name = 'ConfigError'; this.problems = problems }
}

/** The startup summary: what is running, never a secret and no filesystem paths beyond a count. */
export function startupSummary({ settings, address }) {
  return {
    version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, listen: address, auth: settings.authMode, persistence: settings.persistence,
    workspaceRoots: settings.roots.length, providersConfigured: settings.providers, staticApp: !!settings.staticDir, cors: settings.corsOrigin ? 'single-origin' : 'off',
  }
}

/**
 * @param {{env?:object, injected?:{persistence?:object, auth?:object, credentials?:object, providerFactory?:Function}, print?:(line:string)=>void,
 *          heartbeatMs?:number, logRequests?:boolean, shutdownDeadlineMs?:number}} options
 * @returns {Promise<{server, service, settings, port:number, host:string, address:string, close:(reason?:string)=>Promise<void>, warnings:string[]}>}
 */
export async function startServer({ env = process.env, injected = {}, print = () => {}, heartbeatMs, logRequests = false, shutdownDeadlineMs = 8000 } = {}) {
  const parsed = parseServerConfig(env)
  if (!parsed.ok) throw new ConfigError(parsed.errors)
  const { settings, warnings } = parsed

  const auth = injected.auth ?? (settings.authMode === 'firebase' ? createFirebaseVerifier({ projectId: settings.projectId }) : createNoAuth())
  let persistence = injected.persistence
  if (!persistence) {
    if (settings.persistence === 'memory') persistence = createMemoryPersistence()
    else if (settings.persistence === 'firebase') {
      const { createFirebasePersistence } = await import('../persistence/adapters/firebasePersistence.js')
      const { initializeApp, applicationDefault } = await import('firebase-admin/app').catch(() => { throw new ConfigError(['BLUSWAN_PERSISTENCE=firebase needs the firebase-admin package (npm install firebase-admin).']) })
      const { getFirestore } = await import('firebase-admin/firestore')
      persistence = createFirebasePersistence({ db: getFirestore(initializeApp({ credential: applicationDefault(), projectId: settings.projectId })) })
    } else persistence = createFilePersistence({ dir: path.resolve(settings.dataDir) })
  }

  const service = createBluswanService({
    persistence, credentials: injected.credentials ?? createEnvCredentialStore(env), hostId: settings.hostId || os.hostname(),
    allowedRoots: settings.roots.length ? settings.roots : [os.homedir()], config: loadRuntimeConfig(env),
    ...(injected.providerFactory ? { providerFactory: injected.providerFactory } : {}),
  })
  // one JSON object per line: easy to grep, ship and parse; bodies, headers, tokens and query strings never appear
  const requestLogger = { info: (msg, meta) => print(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...meta })), warn() {}, error() {}, debug() {} }
  const handler = createHttpHandler({ service, auth, corsOrigin: settings.corsOrigin, staticDir: settings.staticDir, logRequests, logger: requestLogger, ...(heartbeatMs ? { heartbeatMs } : {}) })
  const server = http.createServer(handler)
  // JSON request lifetime is bounded; SSE is a long *response* and is governed by the handler's own lifetime/heartbeat.
  server.headersTimeout = 30_000; server.requestTimeout = 60_000; server.keepAliveTimeout = 65_000

  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new ConfigError([`Port ${settings.port} is already in use (BLUSWAN_PORT).`]) : e))
    server.listen(settings.port, settings.host, resolve)
  })
  const port = server.address().port
  const address = `${settings.host}:${port}`
  const summary = startupSummary({ settings, address })
  print(`BLUSWAN ${summary.version} (protocol ${summary.protocolVersion}) listening on http://${address}`)
  print(`  auth: ${summary.auth} · persistence: ${summary.persistence} · workspace roots: ${summary.workspaceRoots} · providers configured: ${summary.providersConfigured.join(', ') || 'none'}`)
  for (const w of warnings) print(`  warning: ${w}`)

  let closing = null
  const close = (reason = 'close') => closing ??= (async () => {
    print(`shutting down (${reason})`)
    handler.drain() // new requests get 503 server_not_ready and /api/ready flips
    const closed = new Promise(r => server.close(r)) // stop accepting; resolves when connections end
    handler.closeStreams(); server.closeIdleConnections?.()
    await service.shutdown({ deadlineMs: shutdownDeadlineMs }) // cancel runs, flush saves, release workspaces and shells (bounded)
    server.closeAllConnections?.()
    await closed
  })()
  return { server, service, settings, port, host: settings.host, address, warnings, close, handler }
}
