// Performance budgets for the paths a user waits on. Budgets are deliberately generous (several times the measured
// values) so they catch order-of-magnitude regressions without flaking on a slow CI machine. Measured values are
// printed as test diagnostics.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startServer } from './main.js'
import { createBluswanService } from './service.js'
import { createHttpHandler } from './http.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createCredentialStore } from '../providers/credentials/credentialStore.js'
import { createRemoteRuntime } from '../client/runtime/createRemoteRuntime.js'
import { createContextEngine } from '../context/contextEngine.js'
import { createMessage, createSession } from '../protocol/schemas.js'
import { serializeSession } from '../persistence/serializer.js'
import { defineCapabilities } from '../providers/provider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 2)) } }
const timeIt = async (fn) => { const t0 = performance.now(); const v = await fn(); return { ms: performance.now() - t0, v } }
const credentials = createCredentialStore({})
const auth = { mode: 'test', verify: async () => ({ id: 'perf', email: null }) }

async function boot(persistence = createMemoryPersistence()) {
  const service = createBluswanService({ persistence, credentials, allowedRoots: [os.tmpdir()] })
  const server = http.createServer(createHttpHandler({ service, auth, heartbeatMs: 1000 }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise(r => { server.closeAllConnections(); server.close(r) }))
  return { service, persistence, base: `http://127.0.0.1:${server.address().port}` }
}
const record = (id, n, events = 0) => {
  const session = createSession({ model: { provider: 'deepseek', model: 'm' }, id })
  session.messages = Array.from({ length: n }, (_, i) => createMessage({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(20) }))
  session.events = Array.from({ length: events }, (_, i) => ({ id: `e${id}-${i}`, type: 'assistant.text.completed', sessionId: id, timestamp: i + 1, data: { text: 'x'.repeat(60) } }))
  session.status = 'completed'
  return serializeSession(session, { userId: 'perf' })
}

describe('performance budgets', () => {
  it('runtime start → ready and first /api/health', async (t) => {
    const { ms, v: s } = await timeIt(() => startServer({ env: { BLUSWAN_PORT: '0', BLUSWAN_PERSISTENCE: 'memory' } }))
    cleanups.push(() => s.close())
    const ready = await timeIt(() => fetch(`http://127.0.0.1:${s.port}/api/ready`))
    t.diagnostic(`start ${ms.toFixed(0)} ms, first /api/ready ${ready.ms.toFixed(0)} ms`)
    assert.ok(ms < 1500 && ready.ms < 500)
  })

  it('bootstrap with 300 stored conversations and the session list page', async (t) => {
    const s = await boot()
    for (let i = 0; i < 300; i++) await s.persistence.saveSession('perf', record(`s${String(i).padStart(4, '0')}`, 4))
    const boot1 = await timeIt(async () => (await fetch(`${s.base}/api/bootstrap`)).json())
    assert.equal(boot1.v.sessions.items.length, 50)
    const list = await timeIt(async () => (await fetch(`${s.base}/api/sessions?limit=300`)).json())
    t.diagnostic(`first bootstrap (cold, 300 stored) ${boot1.ms.toFixed(0)} ms; list of 300 ${list.ms.toFixed(0)} ms`)
    assert.ok(boot1.ms < 2000 && list.ms < 2000)
  })

  it('hydrating a long conversation (4,000 messages, 4,000 events) and shipping it to the client', async (t) => {
    const s = await boot()
    await s.persistence.saveSession('perf', record('long-session', 4000, 4000))
    const first = await timeIt(async () => { const r = await fetch(`${s.base}/api/sessions/long-session`); const text = await r.text(); return { status: r.status, bytes: text.length } })
    const second = await timeIt(async () => (await fetch(`${s.base}/api/sessions/long-session`)).text())
    t.diagnostic(`cold hydrate+serve ${first.ms.toFixed(0)} ms (${(first.v.bytes / 1e6).toFixed(1)} MB), warm ${second.ms.toFixed(0)} ms`)
    assert.equal(first.v.status, 200); assert.ok(first.ms < 5000 && second.ms < 3000)
  })

  it('context build for a 600-message conversation', async (t) => {
    const messages = Array.from({ length: 600 }, (_, i) => createMessage({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}: ${'lorem ipsum '.repeat(40)}` }))
    const engine = createContextEngine({ config: {} })
    const caps = defineCapabilities({ toolCalling: true, contextWindow: 128_000, maxOutputTokens: 8192 })
    const { ms, v } = await timeIt(() => engine.build({ session: { messages, contextSummary: null, validation: null }, workspace: null, capabilities: caps, tools: [], system: 'system prompt' }))
    t.diagnostic(`context build ${ms.toFixed(0)} ms (compacted: ${!!v.compacted})`)
    assert.ok(ms < 3000)
  })

  it('the client is back online within a few hundred milliseconds of a dropped stream', async (t) => {
    const handler = { current: null }
    const service = createBluswanService({ persistence: createMemoryPersistence(), credentials, allowedRoots: [os.tmpdir()] })
    handler.current = createHttpHandler({ service, auth, heartbeatMs: 1000 })
    const server = http.createServer(handler.current)
    await new Promise(r => server.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise(r => { server.closeAllConnections(); server.close(r) }))
    const rt = createRemoteRuntime({ baseUrl: `http://127.0.0.1:${server.address().port}`, reconnect: { baseMs: 20, maxMs: 100 } }); cleanups.push(() => rt.close())
    await rt.init(); await until(() => rt.getConnection().state === 'online')
    const times = []
    for (let i = 1; i <= 3; i++) {
      const t0 = performance.now()
      handler.current.closeStreams()
      await until(() => rt.getConnection().reconnects >= i && rt.getConnection().state === 'online')
      times.push(performance.now() - t0)
    }
    t.diagnostic(`stream drop → online: ${times.map(x => `${x.toFixed(0)} ms`).join(', ')} (backoff base 20 ms)`)
    assert.ok(Math.max(...times) < 1000)
  })

  it('workspace change listing on a 300-file repository and a large diff stay bounded', async (t) => {
    const files = {}; for (let i = 0; i < 300; i++) files[`src/f${i}.js`] = `export const v${i} = ${i}\n`
    files['package.json'] = '{"name":"p","version":"1.0.0","type":"module"}\n'
    const fx = await createFixtureRepo({ files }); cleanups.push(fx.cleanup)
    const ws = await createNodeWorkspaceManager().openWorkspace({ root: fx.root })
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(fx.root, `src/f${i}.js`), `export const v${i} = ${i + 1000}\n`)
    fs.writeFileSync(path.join(fx.root, 'src/big.js'), Array.from({ length: 120_000 }, (_, i) => `export const x${i} = ${i}`).join('\n'))
    const list = await timeIt(() => ws.gitChanges())
    const diff = await timeIt(() => ws.gitDiff({ path: 'src/big.js' }))
    t.diagnostic(`gitChanges (61 modified) ${list.ms.toFixed(0)} ms; 120k-line diff ${diff.ms.toFixed(0)} ms`)
    assert.ok(list.v.files.length >= 60); assert.ok(diff.v && list.ms < 3000 && diff.ms < 5000)
  })
})
