import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { runDoctor, formatDoctor } from './doctor.js'
import { startServer } from './main.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'blu-doc-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const byId = (r, id) => r.checks.find(c => c.id === id)
async function boot(env = {}, injected = {}) {
  const s = await startServer({ env: { BLUSWAN_PORT: '0', BLUSWAN_PERSISTENCE: 'memory', ...env }, injected, heartbeatMs: 30 })
  cleanups.push(() => s.close())
  return s
}

describe('npm run doctor', () => {
  it('a healthy local runtime passes every runtime check', async () => {
    const root = tmp(); const s = await boot({ BLUSWAN_WORKSPACE_ROOTS: root, DEEPSEEK_API_KEY: 'sk-doctor-secret-0123456789' })
    const r = await runDoctor({ env: { BLUSWAN_PORT: String(s.port), BLUSWAN_PERSISTENCE: 'memory', BLUSWAN_WORKSPACE_ROOTS: root, DEEPSEEK_API_KEY: 'sk-doctor-secret-0123456789' } })
    assert.equal(r.ok, true)
    for (const id of ['env', 'providers', 'workspace-roots', 'reachable', 'protocol', 'ready', 'sse']) assert.equal(byId(r, id)?.status, 'pass', id)
    assert.match(byId(r, 'providers').title, /deepseek/)
  })
  it('never prints secret values', async () => {
    const root = tmp(); const s = await boot({ BLUSWAN_WORKSPACE_ROOTS: root, OPENAI_API_KEY: 'sk-never-print-0123456789abcdef' })
    const r = await runDoctor({ env: { BLUSWAN_PORT: String(s.port), BLUSWAN_PERSISTENCE: 'memory', BLUSWAN_WORKSPACE_ROOTS: root, OPENAI_API_KEY: 'sk-never-print-0123456789abcdef' }, token: 'tok-never-print' })
    assert.doesNotMatch(JSON.stringify(r) + formatDoctor(r), /sk-never-print|tok-never-print/)
  })
  it('a runtime that is not running is reported with a fix (wrong port / not started)', async () => {
    const srv = http.createServer(); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; await new Promise(r => srv.close(r))
    const r = await runDoctor({ env: { BLUSWAN_PORT: String(port), BLUSWAN_PERSISTENCE: 'memory' } })
    assert.equal(r.ok, false)
    const c = byId(r, 'reachable'); assert.equal(c.status, 'fail'); assert.match(c.detail, /refused/); assert.match(c.fix, /npm run server/)
    assert.equal(byId(r, 'ready').status, 'skip')
  })
  it('an address that is not BLUSWAN is detected', async () => {
    const other = http.createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>') }); await new Promise(r => other.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise(r => { other.closeAllConnections(); other.close(r) }))
    const r = await runDoctor({ env: {}, url: `http://127.0.0.1:${other.address().port}` })
    assert.match(byId(r, 'reachable').title, /not as a BLUSWAN runtime/)
  })
  it('invalid environment, missing roots and missing providers are all reported', async () => {
    const r = await runDoctor({ env: { BLUSWAN_AUTH: 'firebase', BLUSWAN_PORT: '1' , BLUSWAN_HOST: '0.0.0.0', BLUSWAN_WORKSPACE_ROOTS: path.join(tmp(), 'nope') } , url: 'http://127.0.0.1:1' })
    assert.equal(byId(r, 'env').status, 'fail'); assert.match(byId(r, 'env').detail, /FIREBASE_PROJECT_ID/)
    assert.equal(byId(r, 'workspace-roots').status, 'fail')
    assert.equal(byId(r, 'providers').status, 'warn')
  })
  it('flags a runtime that is up but not ready, with the storage fix', async () => {
    const persistence = createMemoryPersistence(); persistence.probe = async () => { throw new Error('down') }
    const s = await boot({}, { persistence })
    const r = await runDoctor({ env: { BLUSWAN_PORT: String(s.port) } })
    assert.equal(byId(r, 'ready').status, 'fail'); assert.match(byId(r, 'ready').fix, /storage/i)
  })
  it('warns when the runtime is bound to localhost but addressed by a public name', async () => {
    const r = await runDoctor({ env: { BLUSWAN_HOST: '127.0.0.1' }, url: 'http://bluswan.example.com:9' , fetch: async () => { throw Object.assign(new TypeError('x'), { cause: { code: 'ECONNREFUSED' } }) } })
    assert.equal(byId(r, 'bind').status, 'warn')
  })
  it('detects a proxy that serves the stream as something else, and a CORS misconfiguration', async () => {
    const s = await boot({ BLUSWAN_CORS_ORIGIN: 'https://app.example.com' })
    const real = globalThis.fetch
    const broken = async (u, init) => (String(u).endsWith('/api/stream') ? new Response('<html>proxy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) : real(u, init))
    const r = await runDoctor({ env: { BLUSWAN_PORT: String(s.port), BLUSWAN_PERSISTENCE: 'memory', BLUSWAN_CORS_ORIGIN: 'https://app.example.com' }, fetch: broken })
    assert.equal(byId(r, 'sse').status, 'fail'); assert.equal(byId(r, 'cors').status, 'pass')
    const wrong = await runDoctor({ env: { BLUSWAN_PORT: String(s.port), BLUSWAN_PERSISTENCE: 'memory', BLUSWAN_CORS_ORIGIN: 'https://other.example.com' } })
    assert.equal(byId(wrong, 'cors').status, 'fail')
  })
  it('live provider checks are opt-in and use the supplied runner', async () => {
    const root = tmp(); const env = { BLUSWAN_PORT: '1', BLUSWAN_WORKSPACE_ROOTS: root, KIMI_API_KEY: 'k' }
    assert.equal(byId(await runDoctor({ env, url: 'http://127.0.0.1:1' }), 'live').status, 'skip')
    const calls = []
    const r = await runDoctor({ env, url: 'http://127.0.0.1:1', live: true, runLive: async (p) => { calls.push(p); return { ok: false, detail: 'HTTP 401' } } })
    assert.deepEqual(calls, ['kimi']); assert.equal(byId(r, 'live-kimi').status, 'fail')
  })
  it('formats a readable report with a summary line', async () => {
    const out = formatDoctor(await runDoctor({ env: { BLUSWAN_PORT: '1' }, url: 'http://127.0.0.1:1' }))
    assert.match(out, /BLUSWAN doctor/); assert.match(out, /✕ Cannot reach a runtime/); assert.match(out, /→ /); assert.match(out, /\d+ passed, \d+ warnings, \d+ failed/)
  })
})
