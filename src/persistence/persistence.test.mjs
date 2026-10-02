// The same contract is run against every backend (memory, file, IndexedDB, Firestore), plus serializer,
// migration and validation behaviour.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryPersistence } from './adapters/memoryPersistence.js'
import { createFilePersistence } from './adapters/filePersistence.js'
import { createPersistence } from './docStore.js'
import { createIndexedDbDocStore, openIndexedDb } from './adapters/localPersistence.js'
import { createFirestoreDocStore } from './adapters/firebasePersistence.js'
import { createSessionRepository } from './sessionRepository.js'
import { createWorkspaceRepository, toWorkspaceRecord } from './workspaceRepository.js'
import { createSettingsRepository } from './settingsRepository.js'
import { migrateSession } from './migration.js'
import { serializeSession, validateRecord, toIndex, toRuntimeSession, scrub, compactEvents, LIMITS } from './serializer.js'
import { CURRENT_SCHEMA_VERSION } from './persistence.js'
import { createSession } from '../protocol/schemas.js'
import { createEvent } from '../protocol/events.js'
import { fakeIndexedDB } from './testing/fakeIndexedDb.js'
import { fakeFirestore } from './testing/fakeFirestore.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

function sessionOf(id, { text = 'Fix the parser', at = 1000 } = {}) {
  const s = createSession({ model: { provider: 'deepseek', model: 'm' }, id, now: at })
  s.messages = [{ id: `${id}-m1`, role: 'user', content: text, timestamp: at }]
  s.events = [createEvent('user.message', id, { content: text }, { timestamp: at })]
  return { ...s, updatedAt: at }
}
const record = (id, userId = 'alice', opts) => serializeSession(sessionOf(id, opts), { userId })

const backends = {
  memory: async () => createMemoryPersistence(),
  file: async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-p-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); return createFilePersistence({ dir }) },
  indexeddb: async () => createPersistence(createIndexedDbDocStore({ db: await openIndexedDb(fakeIndexedDB(), 'test') })),
  firestore: async () => createPersistence(createFirestoreDocStore({ db: fakeFirestore() })),
}

for (const [name, make] of Object.entries(backends)) {
  describe(`persistence contract: ${name}`, () => {
    it('saves, loads and deletes a session; revision increments', async () => {
      const p = await make()
      const saved = await p.saveSession('alice', record('s1'))
      assert.equal(saved.revision, 1)
      const loaded = await p.loadSession('alice', 's1')
      assert.deepEqual([loaded.id, loaded.revision, loaded.messages.length, loaded.schemaVersion], ['s1', 1, 1, CURRENT_SCHEMA_VERSION])
      assert.equal((await p.saveSession('alice', { ...loaded })).revision, 2)
      assert.equal(await p.deleteSession('alice', 's1'), true)
      assert.equal(await p.loadSession('alice', 's1'), null)
      assert.equal((await p.listSessions('alice')).items.length, 0, 'index is removed with the record')
    })
    it('lists newest first from the lightweight index, with pagination', async () => {
      const p = await make()
      for (let i = 1; i <= 5; i++) await p.saveSession('alice', record(`s${i}`, 'alice', { at: i * 1000, text: `Task ${i}` }))
      const page1 = await p.listSessions('alice', { limit: 2 })
      assert.deepEqual(page1.items.map(i => i.id), ['s5', 's4'])
      assert.ok(page1.nextCursor)
      assert.equal('messages' in page1.items[0], false, 'no transcript in the index')
      const page2 = await p.listSessions('alice', { limit: 2, cursor: page1.nextCursor })
      assert.deepEqual(page2.items.map(i => i.id), ['s3', 's2'])
      const page3 = await p.listSessions('alice', { limit: 2, cursor: page2.nextCursor })
      assert.deepEqual([page3.items.map(i => i.id), page3.nextCursor], [['s1'], null])
    })
    it('detects revision conflicts instead of overwriting newer data', async () => {
      const p = await make()
      const first = await p.saveSession('alice', record('s1'), { expectedRevision: 0 })
      await p.saveSession('alice', first, { expectedRevision: 1 })
      await assert.rejects(() => p.saveSession('alice', first, { expectedRevision: 1 }), (e) => e.code === 'persistence_conflict')
      await assert.rejects(() => p.saveSession('alice', record('s1'), { expectedRevision: 0 }), (e) => e.code === 'persistence_conflict')
    })
    it('isolates users: another user cannot load, list, overwrite or delete', async () => {
      const p = await make()
      await p.saveSession('alice', record('s1'))
      assert.equal(await p.loadSession('bob', 's1'), null)
      assert.deepEqual((await p.listSessions('bob')).items, [])
      assert.equal(await p.deleteSession('bob', 's1'), false)
      await assert.rejects(() => p.saveSession('bob', record('s1', 'alice')), (e) => e.code === 'persistence_invalid_record')
      assert.equal((await p.loadSession('alice', 's1')).id, 's1')
    })
    it('rejects ids that could escape the collection path', async () => {
      const p = await make()
      await assert.rejects(() => p.loadSession('alice', '../bob/sessions/x'), (e) => e.code === 'persistence_invalid_record')
      await assert.rejects(() => p.loadSession('../bob', 's1'), (e) => e.code === 'persistence_invalid_record')
    })
    it('stores large records (chunked where the backend needs it)', async () => {
      const p = await make()
      const s = sessionOf('big')
      s.messages = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x'.repeat(30_000), timestamp: i }))
      const rec = serializeSession(s, { userId: 'alice' })
      await p.saveSession('alice', rec)
      assert.equal((await p.loadSession('alice', 'big')).messages.length, 40)
    })
    it('workspaces, settings and clearUser', async () => {
      const p = await make()
      await p.saveWorkspace('alice', { id: 'w1', userId: 'alice', name: 'r', updatedAt: 5 })
      assert.equal((await p.loadWorkspace('alice', 'w1')).name, 'r')
      assert.equal(await p.loadWorkspace('bob', 'w1'), null)
      assert.deepEqual((await p.listWorkspaces('alice')).map(w => w.id), ['w1'])
      await p.saveSettings('alice', { permissionMode: 'ask' })
      assert.deepEqual(await p.loadSettings('alice'), { permissionMode: 'ask' })
      await p.saveSession('alice', record('s1')); await p.saveSession('bob', record('b1', 'bob'))
      await p.clearUser('alice')
      assert.deepEqual([await p.loadSession('alice', 's1'), await p.loadWorkspace('alice', 'w1'), await p.loadSettings('alice')], [null, null, null])
      assert.equal((await p.loadSession('bob', 'b1')).id, 'b1', 'other users are untouched')
    })
  })
}

describe('repositories', () => {
  it('session repository: create is create-only, update checks revision', async () => {
    const repo = createSessionRepository(createMemoryPersistence(), { userId: 'alice' })
    const created = await repo.createSessionRecord(record('s1'))
    await assert.rejects(() => repo.createSessionRecord(record('s1')), (e) => e.code === 'persistence_conflict')
    const updated = await repo.updateSessionRecord({ ...created, title: 'Renamed' }, created.revision)
    assert.equal(updated.revision, 2)
    await assert.rejects(() => repo.updateSessionRecord(created, created.revision), (e) => e.code === 'persistence_conflict')
    assert.equal((await repo.listSessionRecords()).items[0].title, 'Renamed')
    assert.equal(await repo.deleteSessionRecord('s1'), true)
  })
  it('workspace repository stores a host-bound reference, not a bare path', async () => {
    const adapter = createMemoryPersistence()
    const repo = createWorkspaceRepository(adapter, { userId: 'alice' })
    const rec = toWorkspaceRecord({ userId: 'alice', hostId: 'host-1', workspace: { id: 'w1', root: '/work/r', metadata: { kind: 'local', repository: { name: 'r', branch: 'main', headSha: 'abc', isGitRepository: true } } } })
    await repo.save(rec)
    const back = await repo.get('w1')
    assert.deepEqual(back.rootReference, { type: 'host-path', hostId: 'host-1', path: '/work/r' })
    assert.deepEqual([back.baselineCommit, back.lastKnownHead, back.repository.branch], ['abc', 'abc', 'main'])
  })
  it('settings repository keeps only safe preferences and never a credential', async () => {
    const repo = createSettingsRepository(createMemoryPersistence(), { userId: 'alice' })
    await repo.save({ permissionMode: 'full_auto', model: 'deepseek-chat', apiKey: 'sk-secret-123456789', baseUrl: 'x' })
    const s = await repo.load()
    assert.deepEqual(s, { permissionMode: 'full_auto', provider: 'deepseek', model: 'deepseek-chat' })
    assert.doesNotMatch(JSON.stringify(s), /sk-secret/)
  })
})

describe('serializer', () => {
  it('collapses streaming, drops deltas, moves command output out of events and bounds tool output', () => {
    const s = sessionOf('s1')
    s.events.push(createEvent('assistant.text.delta', 's1', { text: 'He' }), createEvent('assistant.text.delta', 's1', { text: 'llo' }),
      createEvent('assistant.text.completed', 's1', { messageId: 'a', text: 'Hello' }),
      createEvent('command.completed', 's1', { id: 'c', stdout: 'big output', exitCode: 0 }))
    s.messages.push({ id: 'a', role: 'assistant', content: 'Hello', timestamp: 2 }, { id: 't', role: 'tool', content: `${'y'.repeat(30_000)} API_KEY=abcdef123456`, toolCallId: 'x', timestamp: 3 })
    const rec = serializeSession(s, { userId: 'alice', commands: [{ id: 'c', command: 'echo $TOKEN=sk-live-abcdefgh1234', stdout: 'big output', stderr: '', exitCode: 0 }] })
    assert.deepEqual(rec.events.map(e => e.type), ['user.message', 'assistant.text.completed', 'command.completed'])
    assert.equal('stdout' in rec.events.at(-1).data, false)
    assert.equal(rec.messages.filter(m => m.content === 'Hello').length, 1, 'final text appears once')
    assert.ok(rec.messages[2].content.length < 21_000); assert.match(rec.messages[2].content, /truncated for storage/)
    assert.doesNotMatch(JSON.stringify(rec), /abcdef123456|sk-live-abcdefgh1234/)
    assert.equal(rec.commands[0].stdout, 'big output')
  })
  it('caps event history and tool-call history', () => {
    const events = Array.from({ length: LIMITS.maxEvents + 50 }, (_, i) => createEvent('tool.started', 's', { i }))
    assert.equal(compactEvents(events).length, LIMITS.maxEvents)
    assert.equal(compactEvents(events)[0].data.i, 50)
  })
  it('scrubs secret-named fields and secret-looking strings', () => {
    const out = scrub({ apiKey: 'sk-aaaaaaaaaaaa', Authorization: 'Bearer abc', nested: { password: 'p', note: 'token=sk-bbbbbbbbbbbb' }, tokenUsage: { total: 5 } })
    assert.deepEqual(out.tokenUsage, { total: 5 })
    assert.doesNotMatch(JSON.stringify(out), /sk-aaaa|sk-bbbb|Bearer abc|"p"/)
  })
  it('contains no live objects: plain JSON round trip is lossless', () => {
    const rec = record('s1')
    assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec)
    assert.equal(Object.values(rec).some(v => typeof v === 'function'), false)
  })
  it('index has no transcript; runtime session round trips', () => {
    const rec = record('s1')
    const idx = toIndex(rec)
    assert.deepEqual([idx.title, idx.status, idx.messageCount, 'messages' in idx], ['Fix the parser', 'idle', 1, false])
    const s = toRuntimeSession(validateRecord(rec))
    assert.equal(s.messages.length, 1)
  })
  it('requires a user id', () => assert.throws(() => serializeSession(sessionOf('s1'), {}), (e) => e.code === 'persistence_invalid_record'))
})

describe('migration and validation', () => {
  it('passes current records through unchanged', () => { const r = record('s1'); assert.deepEqual(migrateSession(r), r) })
  it('runs explicit steps in order and refuses gaps', () => {
    const migrations = { 1: (r) => ({ ...r, schemaVersion: 2, renamed: r.title }), 2: (r) => ({ ...r, schemaVersion: 3, extra: true }) }
    const out = migrateSession({ ...record('s1'), schemaVersion: 1 }, { migrations, target: 3 })
    assert.deepEqual([out.schemaVersion, out.renamed, out.extra], [3, 'Fix the parser', true])
    assert.throws(() => migrateSession({ ...record('s1'), schemaVersion: 1 }, { migrations: {}, target: 2 }), (e) => e.code === 'persistence_schema_unsupported')
    assert.throws(() => migrateSession({ ...record('s1'), schemaVersion: 1 }, { migrations: { 1: (r) => r }, target: 2 }), (e) => e.code === 'persistence_invalid_record')
  })
  it('refuses records from a newer schema and records without a version', () => {
    assert.throws(() => migrateSession({ ...record('s1'), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }), (e) => e.code === 'persistence_schema_unsupported')
    assert.throws(() => migrateSession({ id: 'x' }), (e) => e.code === 'persistence_invalid_record')
  })
  it('rejects malformed records with normalized errors', () => {
    for (const bad of [null, {}, { ...record('s1'), messages: 'nope' }, { ...record('s1'), status: 'zombie' }, { ...record('s1'), events: [{ id: 1 }] }, { ...record('s1'), userId: '' }]) {
      assert.throws(() => validateRecord(bad), (e) => e.code === 'persistence_invalid_record')
    }
  })
  it('a corrupted stored record fails load with a normalized error, not a crash', async () => {
    const p = createMemoryPersistence()
    await p.saveSession('alice', record('s1'))
    // write garbage straight into the doc store through a second adapter sharing nothing: simulate by saving an invalid record
    const bad = { ...record('s2'), messages: 'nope' }
    await p.saveSession('alice', bad)
    await assert.rejects(() => p.loadSession('alice', 's2'), (e) => e.code === 'persistence_invalid_record')
    assert.equal((await p.loadSession('alice', 's1')).id, 's1', 'other records still load')
  })
})

describe('architecture boundaries', () => {
  const root = path.resolve(import.meta.dirname, '..')
  async function sources(dir) {
    const out = []
    for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...await sources(rel))
      else if (/\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel)
    }
    return out
  }
  const importsOf = async (rel) => [...(await fs.readFile(path.join(root, rel), 'utf8')).matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2])

  it('runtime, sessions, context, validation, tools and workspace never import Firebase', async () => {
    for (const dir of ['agent', 'sessions', 'context', 'validation', 'tools', 'workspace', 'protocol', 'providers']) {
      for (const f of await sources(dir)) {
        const bad = (await importsOf(f)).filter(i => /firebase/i.test(i))
        assert.deepEqual(bad, [], `${f} imports ${bad}`)
      }
    }
  })
  it('only the Firestore adapter knows Firebase inside src/persistence', async () => {
    for (const f of await sources('persistence')) {
      const bad = (await importsOf(f)).filter(i => /firebase/i.test(i))
      assert.deepEqual(bad, [], f)
    }
  })
  it('browser-side code (client, shared persistence, protocol) imports no Node built-ins or server modules', async () => {
    const browserSide = [...await sources('client'), 'persistence/persistence.js', 'persistence/docStore.js', 'persistence/serializer.js', 'persistence/migration.js', 'persistence/adapters/localPersistence.js', 'sessions/title.js', 'App.jsx']
    for (const f of browserSide) {
      const bad = (await importsOf(f)).filter(i => /^node:/.test(i) || /\/(server|providers\/credentials)\//.test(i) || /filePersistence|firebasePersistence/.test(i))
      assert.deepEqual(bad.filter(i => !/\/testing\//.test(i)), [], `${f} imports ${bad}`)
    }
  })
  it('no module that runs in the browser reads a provider secret from the environment', async () => {
    for (const f of [...await sources('client'), 'App.jsx']) {
      const text = await fs.readFile(path.join(root, f), 'utf8')
      assert.doesNotMatch(text, /DEEPSEEK_API_KEY|VITE_[A-Z_]*API_KEY/, f)
    }
  })
})
