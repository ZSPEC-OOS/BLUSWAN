#!/usr/bin/env node
// BLUSWAN server: runtime, provider credentials, persistence and the HTTP/SSE API. The browser talks only to this.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createBluswanService } from '../src/server/service.js'
import { createHttpHandler } from '../src/server/http.js'
import { createNoAuth, createFirebaseVerifier } from '../src/server/auth.js'
import { createEnvCredentialStore } from '../src/providers/credentials/serverCredentialStore.js'
import { createFilePersistence } from '../src/persistence/adapters/filePersistence.js'
import { createMemoryPersistence } from '../src/persistence/adapters/memoryPersistence.js'
import { loadRuntimeConfig } from '../src/config/runtimeConfig.js'

const env = process.env
const port = Number(env.BLUSWAN_PORT) || 8787
const authMode = env.BLUSWAN_AUTH || 'none'
const host = env.BLUSWAN_HOST || '127.0.0.1'
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host)

if (authMode === 'none' && !loopback) {
  console.error('Refusing to listen on a non-loopback address with BLUSWAN_AUTH=none (anyone who can reach it could run commands). Use BLUSWAN_AUTH=firebase.')
  process.exit(1)
}
const auth = authMode === 'firebase' ? createFirebaseVerifier({ projectId: env.FIREBASE_PROJECT_ID }) : createNoAuth()

const persistenceKind = env.BLUSWAN_PERSISTENCE || 'file'
let persistence
if (persistenceKind === 'memory') persistence = createMemoryPersistence()
else if (persistenceKind === 'firebase') {
  const { createFirebasePersistence } = await import('../src/persistence/adapters/firebasePersistence.js')
  const { initializeApp, applicationDefault } = await import('firebase-admin/app').catch(() => { throw new Error('BLUSWAN_PERSISTENCE=firebase needs the firebase-admin package (npm install firebase-admin).') })
  const { getFirestore } = await import('firebase-admin/firestore')
  persistence = createFirebasePersistence({ db: getFirestore(initializeApp({ credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID })) })
} else persistence = createFilePersistence({ dir: path.resolve(env.BLUSWAN_DATA_DIR || '.bluswan/data') })

const roots = (env.BLUSWAN_WORKSPACE_ROOTS || '').split(path.delimiter).filter(Boolean)
if (authMode !== 'none' && !roots.length) { console.error('BLUSWAN_WORKSPACE_ROOTS is required when authentication is enabled.'); process.exit(1) }

const service = createBluswanService({
  persistence, credentials: createEnvCredentialStore(env), hostId: env.BLUSWAN_HOST_ID || os.hostname(),
  allowedRoots: roots.length ? roots : [os.homedir()], config: loadRuntimeConfig(env),
})
const server = http.createServer(createHttpHandler({ service, auth, corsOrigin: env.BLUSWAN_CORS_ORIGIN || null }))
server.listen(port, host, () => console.log(`BLUSWAN server on http://${host}:${port} (auth: ${authMode}, persistence: ${persistenceKind})`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { server.close(); process.exit(0) })
