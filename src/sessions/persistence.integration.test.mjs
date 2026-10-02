// Autosave, hydration and reconciliation against the real runtime, tools, git and validation.
// "Restarting the app" = a brand-new runtime/workspace manager/autosave over the same persistence adapter.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from '../agent/runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../agent/testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { createMemoryPersistence } from '../persistence/adapters/memoryPersistence.js'
import { createSessionAutosave } from './sessionStore.js'
import { createSessionHydrator } from './sessionHydrator.js'
import { createWorkspaceRepository, toWorkspaceRecord } from '../persistence/workspaceRepository.js'
import { snapshotWorkspace } from '../workspace/workspaceRestore.js'
import { serializeSession } from '../persistence/serializer.js'
import { projectEvents } from '../client/activity/projectEvents.js'

const USER = 'alice'
const HOST = 'host-1'
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const scripted = (...turns) => { let n = 0; return (req) => (req.messages.filter(m => m.role === 'user').at(-1)?.content.startsWith('FOLLOW') ? reply(say('Continuing from the summary.')) : turns[n++]?.(req) ?? reply(say('done'))) }

/** One "process": runtime + workspaces + autosave + hydrator over `adapter`. */
function boot(adapter, { respond, mode = 'full_auto', autosave: asOptions = {} } = {}) {
  const workspaces = createNodeWorkspaceManager()
  const provider = createFakeProvider({ respond })
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([provider]), workspaces, approvals: 'interactive', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), permissionMode: mode },
  })
  const owners = new Map()
  const autosave = createSessionAutosave({
    runtime, adapter, ownerOf: (id) => owners.get(id) ?? null, debounceMs: 10, retry: { attempts: 3, baseMs: 1 }, sleep: async () => {},
    snapshotFor: async (id) => { const ws = workspaces.getWorkspace(runtime.getSession(id).workspaceId); return ws ? snapshotWorkspace(ws) : null },
    ...asOptions,
  }).attach()
  const hydrator = createSessionHydrator({ adapter, runtime, workspaces, hostId: HOST })
  const proc = { runtime, workspaces, autosave, hydrator, owners, provider }
  cleanups.push(async () => { autosave.detach() })
  proc.open = async (root) => {
    const ws = await workspaces.openWorkspace({ root })
    await createWorkspaceRepository(adapter, { userId: USER }).save(toWorkspaceRecord({ userId: USER, workspace: ws, hostId: HOST }))
    return ws
  }
  proc.start = (workspaceId) => { const s = runtime.startSession({ workspaceId, model: { provider: 'fake', model: 'm' } }); owners.set(s.id, USER); return s }
  return proc
}

describe('autosave', () => {
  it('stores nothing for an empty draft, saves on the first message and again on completion, never per delta', async () => {
    const adapter = createMemoryPersistence()
    const saves = []
    const counting = { ...adapter, saveSession: async (...a) => { saves.push(a[1].events.length); return adapter.saveSession(...a) } }
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const p = boot(counting, { respond: scripted(() => reply(say('word '.repeat(200)))) })
    const ws = await p.open(fx.root)
    const s = p.start(ws.id)
    await p.autosave.flush()
    assert.equal(saves.length, 0); assert.deepEqual((await adapter.listSessions(USER)).items, [])
    await p.runtime.sendMessage(s.id, 'Explain the repo')
    await p.autosave.flush()
    const rec = await adapter.loadSession(USER, s.id)
    assert.equal(rec.status, 'completed'); assert.equal(rec.messages.filter(m => m.role === 'assistant').length, 1)
    assert.ok(saves.length >= 2 && saves.length <= 6, `a handful of writes, not one per delta (${saves.length})`)
    assert.equal(rec.events.some(e => e.type === 'assistant.text.delta'), false)
    assert.equal(p.autosave.status(s.id), 'saved')
  })

  it('persists messages, runs, summary, validation, changed files, command history and metadata', async () => {
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const adapter = createMemoryPersistence()
    const p = boot(adapter, { respond: scripted(
      () => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(call('s', 'shell', { command: 'echo hi' })),
      () => reply(say('Fixed.')), () => reply(say('Fixed and the tests pass.')),
    ) })
    const ws = await p.open(fx.root); const s = p.start(ws.id)
    await p.runtime.sendMessage(s.id, 'Fix the failing add test'); await p.autosave.flush()
    const rec = await adapter.loadSession(USER, s.id)
    assert.equal(rec.title, 'Fix the failing add test'); assert.equal(rec.userId, USER); assert.equal(rec.workspaceId, ws.id)
    assert.ok(rec.runs.length >= 1); assert.deepEqual(rec.changedFiles.map(f => f.path), ['src/math.js'])
    assert.ok(rec.contextSummary?.goal); assert.equal(rec.validationState.currentStatus, 'passed')
    assert.ok(rec.toolCalls.length >= 2); assert.ok(rec.commands.some(c => c.command === 'echo hi' && c.stdout.trim() === 'hi'))
    assert.equal(rec.workspaceSnapshot.branch, 'main'); assert.ok(rec.workspaceSnapshot.fingerprint)
    const idx = (await adapter.listSessions(USER)).items[0]
    assert.deepEqual([idx.id, idx.title, idx.status, idx.changedCount], [s.id, 'Fix the failing add test', 'completed', 1])
  })

  it('a save failure never breaks the run; retries succeed, permanent failure is reported', async () => {
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const adapter = createMemoryPersistence()
    let failures = 2
    const flaky = { ...adapter, saveSession: async (...a) => { if (failures-- > 0) throw new Error('network'); return adapter.saveSession(...a) } }
    const statuses = []
    const p = boot(flaky, { respond: scripted(() => reply(say('ok'))), autosave: { onStatus: (id, st) => statuses.push(st) } })
    const ws = await p.open(fx.root); const s = p.start(ws.id)
    await p.runtime.sendMessage(s.id, 'hello'); await p.autosave.flush()
    assert.equal(p.runtime.getSession(s.id).status, 'completed')
    assert.equal(p.autosave.status(s.id), 'saved'); assert.ok(p.autosave.metrics().retries >= 2)
    assert.equal((await adapter.loadSession(USER, s.id)).status, 'completed')

    const down = { ...adapter, saveSession: async () => { throw new Error('offline') } }
    const p2 = boot(down, { respond: scripted(() => reply(say('ok'))), autosave: { onStatus: (id, st) => statuses.push(`p2:${st}`) } })
    const ws2 = await p2.open(fx.root); const s2 = p2.start(ws2.id)
    await p2.runtime.sendMessage(s2.id, 'hello'); await p2.autosave.flush()
    assert.equal(p2.runtime.getSession(s2.id).status, 'completed', 'the run is unaffected')
    assert.equal(p2.autosave.status(s2.id), 'failed'); assert.ok(p2.autosave.metrics().failures >= 1)
    assert.ok(statuses.includes('p2:failed'))
  })

  it('refuses to overwrite newer data (revision conflict) and stops saving that session', async () => {
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const adapter = createMemoryPersistence()
    const p = boot(adapter, { respond: scripted(() => reply(say('one')), () => reply(say('two'))) })
    const ws = await p.open(fx.root); const s = p.start(ws.id)
    await p.runtime.sendMessage(s.id, 'first'); await p.autosave.flush()
    const other = await adapter.loadSession(USER, s.id)
    await adapter.saveSession(USER, { ...other, title: 'Edited elsewhere' }, { expectedRevision: other.revision }) // another writer
    await p.runtime.sendMessage(s.id, 'second'); await p.autosave.flush()
    assert.equal(p.autosave.status(s.id), 'conflict')
    assert.equal((await adapter.loadSession(USER, s.id)).title, 'Edited elsewhere', 'newer data is intact')
    assert.equal(p.autosave.metrics().conflicts, 1)
  })

  it('delete removes the record and its index entry (repository files untouched)', async () => {
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const adapter = createMemoryPersistence()
    const p = boot(adapter, { respond: scripted(() => reply(say('ok'))) })
    const ws = await p.open(fx.root); const s = p.start(ws.id)
    await p.runtime.sendMessage(s.id, 'hello'); await p.autosave.flush()
    await p.autosave.remove(s.id)
    assert.equal(await adapter.loadSession(USER, s.id), null); assert.deepEqual((await adapter.listSessions(USER)).items, [])
    await fs.access(path.join(fx.root, 'src/math.js'))
  })
})

describe('hydration after a restart', () => {
  async function persisted(respond, mode) {
    const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
    const adapter = createMemoryPersistence()
    const p1 = boot(adapter, { respond, mode })
    const ws = await p1.open(fx.root); const s = p1.start(ws.id)
    return { fx, adapter, p1, ws, s }
  }

  it('restores a completed session intact and continues it with context from the summary', async () => {
    const { fx, adapter, p1, ws, s } = await persisted(scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('Fixed.')), () => reply(say('Fixed; tests pass.'))))
    await p1.runtime.sendMessage(s.id, 'Fix the failing add test'); await p1.autosave.flush(); p1.autosave.detach()
    const goal = p1.runtime.getSession(s.id).contextSummary.goal

    const requests = []
    const p2 = boot(adapter, { respond: (req) => { requests.push(req); return reply(say('Continuing from the summary.')) } })
    const h = await p2.hydrator.hydrate(USER, s.id)
    p2.owners.set(s.id, USER); p2.autosave.adopt(s.id, { revision: h.record.revision })
    assert.equal(h.session.status, 'completed'); assert.equal(h.interrupted, false); assert.equal(h.workspace.status, 'restored')
    assert.equal(h.session.messages.length, p1.runtime.getSession(s.id).messages.length)
    assert.equal(h.session.contextSummary.goal, goal)
    assert.equal(p2.runtime.getSession(s.id).validation.currentStatus, 'passed', 'nothing changed outside: evidence stays current')
    assert.deepEqual(h.session.changedFiles.map(f => f.path), ['src/math.js'])
    await p2.runtime.sendMessage(s.id, 'FOLLOW UP: what did we change?')
    const last = requests.at(-1)
    assert.match(JSON.stringify(last.messages), /Fix the failing add test/, 'earlier conversation reaches the model')
    assert.equal(p2.runtime.getSession(s.id).workspaceId, ws.id)
    await p2.autosave.flush()
    assert.equal((await adapter.loadSession(USER, s.id)).messages.at(-1).content, 'Continuing from the summary.')
    void fx
  })

  it('a session persisted while running restores as interrupted; applied changes are discovered; the user can continue', async () => {
    const { fx, adapter, p1, s } = await persisted(scripted(() => reply(call('w', 'write_file', { path: 'half.txt', content: 'done before the crash\n' })), () => reply(call('sh', 'shell', { command: 'sleep 30' }))))
    const sent = p1.runtime.sendMessage(s.id, 'Create half.txt then wait')
    await until(() => p1.runtime.getSession(s.id).toolCalls.some(c => c.name === 'shell' && c.status === 'running'))
    await p1.autosave.flush(s.id)
    assert.equal((await adapter.loadSession(USER, s.id)).status, 'running', 'what was on disk when the process died')
    p1.autosave.detach(); p1.runtime.cancelSession(s.id); await sent.catch(() => {})

    const p2 = boot(adapter, { respond: scripted() })
    const h = await p2.hydrator.hydrate(USER, s.id)
    p2.owners.set(s.id, USER)
    assert.equal(h.interrupted, true); assert.equal(h.session.status, 'interrupted')
    assert.equal(h.session.events.at(-1).type, 'session.interrupted')
    assert.equal(p2.runtime.getSession(s.id).toolCalls.find(c => c.name === 'shell').status, 'interrupted', 'not silently marked completed')
    const view = projectEvents(h.session.events)
    assert.equal(view.status, 'interrupted'); assert.ok(!JSON.stringify(view.entries).includes('"status":"running"'))
    await fs.access(path.join(fx.root, 'half.txt'))
    assert.deepEqual((await p2.runtime.getWorkspaceState(s.id)).files.map(f => f.path), ['half.txt'], 'work already applied is visible')
    const r = await p2.runtime.sendMessage(s.id, 'FOLLOW UP: continue'); void r
    assert.equal(p2.runtime.getSession(s.id).status, 'completed')
    assert.equal(p2.provider.requests.length, 1, 'nothing was replayed automatically')
  })

  it('waiting_permission restores as interrupted and the pending request is gone', async () => {
    const { adapter, p1, s } = await persisted(scripted(() => reply(call('d', 'delete_file', { path: 'src/index.js' }))), 'auto_edit')
    const sent = p1.runtime.sendMessage(s.id, 'delete index')
    await until(() => p1.runtime.getSession(s.id).status === 'waiting_permission')
    await p1.autosave.flush(s.id); p1.autosave.detach()
    p1.runtime.cancelSession(s.id); await sent.catch(() => {})
    const p2 = boot(adapter, { respond: scripted() })
    const h = await p2.hydrator.hydrate(USER, s.id)
    assert.equal(h.session.status, 'interrupted'); assert.deepEqual(p2.runtime.getPendingPermissions(s.id), [])
  })

  it('failed and idle sessions restore with their own status', async () => {
    const { adapter, p1, s } = await persisted(() => { throw new Error('provider exploded') })
    await p1.runtime.sendMessage(s.id, 'go').catch(() => {}); await p1.autosave.flush()
    const status = (await adapter.loadSession(USER, s.id)).status
    assert.ok(['error', 'completed'].includes(status))
    const p2 = boot(adapter, { respond: scripted() })
    assert.equal((await p2.hydrator.hydrate(USER, s.id)).session.status, status)
  })

  it('external repository changes while the app was closed win: changed files corrected, validation stale, drift reported', async () => {
    const { fx, adapter, p1, s } = await persisted(scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('Fixed.')), () => reply(say('Fixed; tests pass.'))))
    await p1.runtime.sendMessage(s.id, 'Fix the failing add test'); await p1.autosave.flush(); p1.autosave.detach()
    assert.equal(p1.runtime.getSession(s.id).validation.currentStatus, 'passed')
    // while closed: the user commits the fix on a new branch and edits another file
    fx.git('checkout', '-q', '-b', 'feature'); fx.git('add', '-A'); fx.git('commit', '-q', '-m', 'fix')
    await fs.writeFile(path.join(fx.root, 'src/index.js'), 'console.log("edited outside")\n')
    const p2 = boot(adapter, { respond: scripted() })
    const h = await p2.hydrator.hydrate(USER, s.id)
    assert.deepEqual(h.session.changedFiles, [], 'src/math.js is committed now; git wins')
    assert.equal(h.drift.branchChanged, true); assert.deepEqual(h.drift.branch, { from: 'main', to: 'feature' }); assert.equal(h.drift.headChanged, true)
    assert.equal(h.session.validation.currentStatus, 'stale', 'green status is not carried over to different code')
    const note = h.session.events.at(-1)
    assert.equal(note.type, 'session.updated'); assert.deepEqual(note.data.branchChanged, { from: 'main', to: 'feature' })
    assert.deepEqual((await p2.runtime.getWorkspaceState(s.id)).files.map(f => f.path), ['src/index.js'])
  })

  it('unchanged repository keeps validation current; a missing snapshot is treated conservatively', async () => {
    const { adapter, p1, s } = await persisted(scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('Fixed.')), () => reply(say('ok'))))
    await p1.runtime.sendMessage(s.id, 'Fix it'); await p1.autosave.flush(); p1.autosave.detach()
    const rec = await adapter.loadSession(USER, s.id)
    await adapter.saveSession(USER, { ...rec, workspaceSnapshot: null }, { expectedRevision: rec.revision })
    const p2 = boot(adapter, { respond: scripted() })
    assert.equal((await p2.hydrator.hydrate(USER, s.id)).session.validation.currentStatus, 'stale')
  })

  it('a missing workspace restores the conversation with a reconnect state; nothing is deleted', async () => {
    const { fx, adapter, p1, s } = await persisted(scripted(() => reply(say('hello'))))
    await p1.runtime.sendMessage(s.id, 'hi'); await p1.autosave.flush(); p1.autosave.detach()
    await fx.cleanup()
    const p2 = boot(adapter, { respond: scripted() })
    const h = await p2.hydrator.hydrate(USER, s.id)
    assert.equal(h.workspace.status, 'unavailable'); assert.match(h.workspace.reason, /no longer exists/)
    assert.equal(h.session.messages.length, 2)
    assert.equal(h.session.events.at(-1).data.workspace, 'unavailable')
    assert.ok(await adapter.loadSession(USER, s.id), 'the record is still there')
  })

  it('a workspace from another host asks to reconnect instead of pretending the path works', async () => {
    const { adapter, p1, s } = await persisted(scripted(() => reply(say('hello'))))
    await p1.runtime.sendMessage(s.id, 'hi'); await p1.autosave.flush(); p1.autosave.detach()
    const p2 = boot(adapter, { respond: scripted() })
    p2.hydrator = createSessionHydrator({ adapter, runtime: p2.runtime, workspaces: p2.workspaces, hostId: 'another-machine' })
    assert.equal((await p2.hydrator.hydrate(USER, s.id)).workspace.status, 'needs_reconnect')
  })

  it('corrupt and foreign records fail with normalized errors', async () => {
    const { adapter, p1, s } = await persisted(scripted(() => reply(say('hello'))))
    await p1.runtime.sendMessage(s.id, 'hi'); await p1.autosave.flush(); p1.autosave.detach()
    const p2 = boot(adapter, { respond: scripted() })
    assert.equal(await p2.hydrator.hydrate('mallory', s.id), null, 'another user\'s id resolves to nothing')
    const rec = await adapter.loadSession(USER, s.id)
    await adapter.saveSession(USER, { ...rec, messages: 'garbage' }, { expectedRevision: rec.revision })
    await assert.rejects(() => p2.hydrator.hydrate(USER, s.id), (e) => e.code === 'persistence_invalid_record')
    await adapter.saveSession(USER, { ...rec, schemaVersion: 99 }, { expectedRevision: rec.revision + 1 })
    await assert.rejects(() => p2.hydrator.hydrate(USER, s.id), (e) => e.code === 'persistence_schema_unsupported')
    assert.equal(p2.runtime.getSession(s.id), null, 'nothing half-loaded')
  })

  it('no credentials or live objects are present in what was stored', async () => {
    const { adapter, p1, s } = await persisted(scripted(() => reply(call('sh', 'shell', { command: 'echo token=sk-livesecret-123456789' })), () => reply(say('ok'))))
    await p1.runtime.sendMessage(s.id, 'run it'); await p1.autosave.flush()
    const text = JSON.stringify(await adapter.loadSession(USER, s.id))
    assert.doesNotMatch(text, /sk-livesecret/)
    assert.doesNotMatch(text, /abortController|AbortSignal/)
    void serializeSession
  })
})
