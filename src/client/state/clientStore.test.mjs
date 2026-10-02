// Client state against the real runtime, session manager, tools and workspace; the model is scripted.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createClientStore } from './clientStore.js'
import { createSettingsStore } from '../settings/settingsStore.js'
import { createAgentRuntime } from '../../agent/runtime.js'
import { createProviderRegistry } from '../../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../../agent/testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../../workspace/node.js'
import { createFixtureRepo } from '../../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../../config/runtimeConfig.js'
import { createError } from '../../protocol/schemas.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const tick = () => new Promise(r => setTimeout(r, 0))
const until = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }

async function setup({ respond, mode = 'auto_edit', validate, withWorkspace = true } = {}) {
  const fx = await createFixtureRepo()
  cleanups.push(() => fx.cleanup())
  const wm = createNodeWorkspaceManager()
  const provider = createFakeProvider({ respond, validate })
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([provider]), workspaces: wm, approvals: 'interactive', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), enableAutomaticValidation: false, permissionMode: mode },
  })
  const settings = createSettingsStore({ storage: null })
  const store = createClientStore({ runtime, settings, selectModel: () => ({ provider: 'fake', model: 'm' }) })
  cleanups.push(() => store.destroy())
  if (withWorkspace) await store.openWorkspace({ root: fx.root })
  const snap = () => store.getSnapshot()
  const view = () => snap().active.view
  return { fx, wm, provider, runtime, settings, store, snap, view, requests: provider.requests }
}
const scripted = (...turns) => { let n = 0; return (req) => turns[n++]?.(req) ?? [] }

describe('sessions and navigation', () => {
  it('opening a repository creates a session bound to it; the header shows repo and branch', async () => {
    const h = await setup()
    const s = h.snap()
    assert.equal(s.sessions.length, 1)
    assert.equal(s.activeId, s.sessions[0].id)
    assert.deepEqual([s.workspace.available, s.workspace.branch, s.workspace.name], [true, 'main', path.basename(h.fx.root)])
    assert.deepEqual([s.active.composer.disabled, s.active.view.entries.length, s.sessions[0].title, s.sessions[0].status], [false, 0, 'New chat', 'ready'])
    assert.ok(!s.sessions.some(x => x.title.includes(s.activeId) || (x.workspaceName ?? '').includes(s.activeId)), 'internal ids are never shown as labels')
  })

  it('lists sessions with generated titles, status, changed-file counts, newest activity first', async () => {
    const h = await setup({ respond: scripted(() => reply(call('c1', 'write_file', { path: 'a.txt', content: 'x' })), () => reply(say('Done.')), () => reply(say('Second answer.'))) })
    const first = h.snap().activeId
    await h.store.sendMessage('Can you add a.txt with some content?').done
    const second = h.store.newSession()
    await h.store.sendMessage('Explain the layout').done
    const list = h.snap().sessions
    assert.deepEqual(list.map(s => s.id), [second, first])
    assert.deepEqual(list.map(s => s.title), ['Explain the layout', 'Add a.txt with some content'])
    assert.deepEqual(list.map(s => s.changedCount), [0, 1])
    assert.deepEqual(list.map(s => s.status), ['completed', 'completed'])
    assert.ok(list.every(s => s.workspaceName === path.basename(h.fx.root)))
  })

  it('"New chat" creates a fresh conversation in the same workspace without copying history', async () => {
    const h = await setup({ respond: scripted(() => reply(say('Hello.'))) })
    await h.store.sendMessage('first request').done
    const old = h.runtime.getSession(h.snap().activeId)
    const id = h.store.newSession()
    const fresh = h.runtime.getSession(id)
    assert.notEqual(id, old.id)
    assert.deepEqual([fresh.messages, fresh.turns, fresh.runs, fresh.workspaceId], [[], [], [], old.workspaceId])
    assert.equal(h.snap().active.view.entries.length, 0)
    assert.equal(h.snap().sessions.length, 2)
    assert.deepEqual(h.snap().active.model, { provider: 'fake', model: 'm' })
  })

  it('switching sessions keeps the running one working in the runtime', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const h = await setup({ respond: scripted(async () => { await gate; return reply(say('Finished in background.')) }, () => reply(say('Other chat answer.'))) })
    const a = h.snap().activeId
    const sent = h.store.sendMessage('long running task')
    await tick()
    const b = h.store.newSession()
    assert.equal(h.snap().sessions.find(s => s.id === a).running, true)
    assert.equal(h.snap().sessions.find(s => s.id === a).status, 'working')
    assert.equal(h.snap().active.composer.disabled, false, 'the other conversation is usable')
    assert.equal(h.runtime.getSession(a).status, 'running', 'not cancelled by switching views')
    h.store.selectSession(a)
    assert.equal(h.snap().active.composer.disabled, true)
    assert.equal(h.snap().active.composer.reason, 'BLUSWAN is working…')
    h.store.selectSession(b)
    release()
    await sent.done
    assert.equal(h.snap().sessions.find(s => s.id === a).status, 'completed')
    h.store.selectSession(a)
    assert.equal(h.view().entries.at(-2).text, 'Finished in background.')
  })

  it('does not submit a second message while the session is working', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const h = await setup({ respond: scripted(async () => { await gate; return reply(say('ok')) }) })
    const first = h.store.sendMessage('one')
    assert.equal(first.ok, true)
    await tick()
    assert.deepEqual(h.store.sendMessage('two'), { ok: false, reason: 'busy' })
    assert.deepEqual(h.store.sendMessage('   '), { ok: false, reason: 'empty' })
    release()
    await first.done
    assert.equal(h.requests.length, 1)
    assert.deepEqual(h.runtime.getSession(h.snap().activeId).messages.filter(m => m.role === 'user').map(m => m.content), ['one'])
  })

  it('keeps conversation and workspace for follow-up messages in the same session', async () => {
    const h = await setup({ respond: scripted(() => reply(call('c1', 'write_file', { path: 'a.txt', content: '1' })), () => reply(say('Created a.txt.')), () => reply(say('Added the follow-up.'))) })
    const id = h.snap().activeId
    await h.store.sendMessage('Create a.txt').done
    assert.equal(h.snap().active.composer.disabled, false, 'composer is available again immediately')
    await h.store.sendMessage('Also mention it in notes').done
    assert.equal(h.snap().activeId, id)
    assert.equal(h.snap().sessions.length, 1)
    assert.deepEqual(h.view().entries.filter(e => e.kind === 'user' || e.kind === 'assistant').map(e => e.text), ['Create a.txt', 'Created a.txt.', 'Also mention it in notes', 'Added the follow-up.'])
    assert.equal(h.runtime.getSession(id).workspaceId, h.snap().workspace.id)
    assert.equal(h.requests[2].messages.filter(m => m.role === 'user').length, 2, 'the model saw the earlier turn')
  })

  it('shows the user message immediately and keeps it when the run fails', async () => {
    const h = await setup({ respond: () => { throw createError({ code: 'rate_limit', message: 'slow down', provider: 'fake', retryable: true }) } })
    const sent = h.store.sendMessage('please do the thing')
    assert.equal(h.view().entries[0].text, 'please do the thing') // optimistic: present before the run finishes
    await sent.done
    const entries = h.view().entries
    assert.deepEqual(entries.map(e => e.kind), ['user', 'notice', 'error']) // retries are a subdued notice, then the final error
    assert.deepEqual([entries[1].tone, entries[1].text], ['subdued', 'Retried model request (2×)'])
    assert.equal(entries[2].text, 'fake is temporarily rate-limited. The request could not continue.')
    assert.equal(h.snap().sessions[0].status, 'error')
    assert.equal(h.snap().active.composer.disabled, false, 'the user can try again')
    assert.ok(!JSON.stringify(entries).includes('at '), 'no stack frames in the conversation')
  })

  it('surfaces rejected sends as a notice instead of dropping them', async () => {
    const h = await setup({ respond: scripted(() => reply(say('ok'))) })
    h.runtime.sendMessage = async () => { throw createError({ code: 'session_busy', message: 'busy' }) }
    const r = h.store.sendMessage('hello')
    await r.done
    assert.deepEqual([h.snap().notice.kind, h.snap().notice.text], ['error', 'BLUSWAN is still working on the previous request.'])
    h.store.dismissNotice()
    assert.equal(h.snap().notice, null)
  })
})

describe('stop', () => {
  it('invokes real runtime cancellation, keeps applied changes, and leaves the conversation usable', async () => {
    const h = await setup({
      respond: scripted(() => reply(call('w', 'write_file', { path: 'kept.txt', content: 'k' }), call('s', 'shell', { command: 'sleep 60' })), () => reply(say('Continuing after stop.'))),
    })
    const sent = h.store.sendMessage('write a file then wait')
    await until(() => h.view().entries.some(e => e.kind === 'activity' && e.items.some(i => i.id === 's' && i.status === 'running')))
    assert.equal(h.snap().active.composer.canStop, true)
    assert.equal(h.view().workingLabel, 'Running sleep 60…')
    const t0 = Date.now()
    assert.equal(h.store.cancel(), true)
    await sent.done
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(h.runtime.getSession(h.snap().activeId).status, 'cancelled') // the runtime was really cancelled
    assert.equal(h.view().status, 'stopped')
    assert.equal(h.view().entries.at(-1).text, 'Stopped')
    assert.deepEqual(h.snap().active.changedFiles, [{ path: 'kept.txt', action: 'created' }])
    assert.equal(await h.fx.cleanup && (await fs.readFile(path.join(h.fx.root, 'kept.txt'), 'utf8')), 'k')
    assert.deepEqual([h.snap().active.composer.disabled, h.snap().active.composer.canStop], [false, false])
    await h.store.sendMessage('carry on').done
    assert.equal(h.view().entries.at(-2).text, 'Continuing after stop.')
  })
})

describe('permissions', () => {
  it('pauses on a request, then resumes after "Allow once"', async () => {
    const h = await setup({ mode: 'ask', respond: scripted(() => reply(call('p', 'write_file', { path: 'new.txt', content: 'x' })), () => reply(say('Created new.txt.'))) })
    const sent = h.store.sendMessage('create new.txt')
    await until(() => h.view().pendingPermission)
    const p = h.view().pendingPermission
    assert.deepEqual([h.view().status, p.action, p.paths, p.effect], ['waiting', 'write', ['new.txt'], 'workspace_write'])
    assert.equal(h.snap().sessions[0].status, 'waiting')
    assert.equal(h.snap().active.composer.disabled, true)
    assert.equal(h.snap().active.composer.canStop, true, 'Stop stays available while waiting')
    assert.equal(h.requests.length, 1)
    assert.equal(h.store.approvePermission(p.id), true)
    await sent.done
    assert.deepEqual([h.view().status, h.view().pendingPermission], ['completed', null])
    assert.equal(await fs.readFile(path.join(h.fx.root, 'new.txt'), 'utf8'), 'x')
    assert.equal(h.view().entries.find(e => e.kind === 'permission').status, 'approved')
  })

  it('returns the denial to the model, which adapts', async () => {
    const h = await setup({
      respond: scripted(() => reply(call('d', 'delete_file', { path: 'src/index.js' })), (req) => { assert.match(req.messages.at(-1).content, /user denied/); return reply(say('I kept the file.')) }),
    })
    const sent = h.store.sendMessage('remove index.js')
    await until(() => h.view().pendingPermission)
    h.store.denyPermission(h.view().pendingPermission.id)
    await sent.done
    assert.equal(h.view().entries.find(e => e.kind === 'permission').status, 'denied')
    assert.equal(h.view().entries.at(-2).text, 'I kept the file.')
    await fs.access(path.join(h.fx.root, 'src/index.js')) // still there
  })

  it('Stop while waiting resolves the request as cancelled', async () => {
    const h = await setup({ mode: 'ask', respond: scripted(() => reply(call('p', 'write_file', { path: 'n.txt', content: 'x' }))) })
    const sent = h.store.sendMessage('go')
    await until(() => h.view().pendingPermission)
    h.store.cancel()
    await sent.done
    assert.equal(h.view().status, 'stopped')
    assert.equal(h.view().entries.find(e => e.kind === 'permission').status, 'cancelled')
    assert.equal(h.view().pendingPermission, null)
  })

  it('switches permission modes through the runtime and persists the choice', async () => {
    const h = await setup()
    assert.equal(h.snap().permissionMode, 'auto_edit')
    h.store.setPermissionMode('full_auto')
    assert.deepEqual([h.runtime.getPermissionMode(), h.snap().permissionMode, h.settings.get().permissionMode], ['full_auto', 'full_auto', 'full_auto'])
    assert.throws(() => h.store.setPermissionMode('yolo'))
  })
})

describe('management and readiness', () => {
  it('requires confirmation to delete a running session, then stops and deletes it (files untouched)', async () => {
    const h = await setup({ respond: scripted(() => reply(call('s', 'shell', { command: 'sleep 60' }))) })
    const a = h.snap().activeId
    const other = h.store.newSession()
    h.store.selectSession(a)
    const sent = h.store.sendMessage('wait')
    await until(() => h.view().entries.some(e => e.kind === 'activity'))
    assert.deepEqual(await h.store.deleteSession(a), { ok: false, reason: 'running', requiresConfirmation: true })
    assert.ok(h.runtime.getSession(a))
    assert.deepEqual(await h.store.deleteSession(a, { force: true }), { ok: true })
    await sent.done
    assert.equal(h.runtime.getSession(a), null)
    assert.equal(h.snap().activeId, other)
    assert.equal(h.snap().sessions.length, 1)
    assert.ok(await fs.access(path.join(h.fx.root, 'package.json')).then(() => true))
    assert.deepEqual(await h.store.deleteSession('nope'), { ok: false, reason: 'unknown' })
  })

  it('reports setup needs (no model / no key) without a low-level configuration error', async () => {
    const h = await setup({ validate: () => { throw createError({ code: 'configuration_error', message: 'DeepSeek API key is not configured (set DEEPSEEK_API_KEY).', provider: 'fake' }) } })
    assert.deepEqual([h.snap().setup.ready, h.snap().setup.reason], [false, 'no_api_key'])
    const ok = await setup({})
    assert.deepEqual(ok.snap().setup, { ready: true })
  })

  it('shows a missing-workspace state instead of crashing and disables the composer', async () => {
    const h = await setup()
    await h.wm.closeWorkspace(h.snap().workspace.id)
    h.store.refresh()
    const a = h.snap().active
    assert.deepEqual([a.workspaceMissing, a.workspace.available, a.composer.disabled], [true, false, true])
    assert.match(a.composer.reason, /no longer available/)
  })

  it('opening another repository creates a new session and never retargets an existing one', async () => {
    const h = await setup()
    const first = h.snap().activeId
    const second = await createFixtureRepo()
    cleanups.push(() => second.cleanup())
    const r = await h.store.openWorkspace({ root: second.root })
    assert.equal(r.ok, true)
    const sessions = h.runtime.listSessions()
    assert.equal(sessions.length, 2)
    assert.notEqual(h.runtime.getSession(first).workspaceId, h.runtime.getSession(r.sessionId).workspaceId)
    assert.equal(h.snap().activeId, r.sessionId)
    const bad = await h.store.openWorkspace({ root: path.join(second.root, 'does-not-exist') })
    assert.equal(bad.ok, false)
    assert.match(h.snap().notice.text, /Couldn't open that repository/)
  })

  it('works without a workspace (chat only) and attaches to sessions that already existed', async () => {
    const h = await setup({ withWorkspace: false })
    const early = h.runtime.startSession({ model: { provider: 'fake', model: 'm' } })
    const store2 = createClientStore({ runtime: h.runtime })
    cleanups.push(() => store2.destroy())
    assert.equal(store2.getSnapshot().activeId, early.id)
    assert.equal(store2.getSnapshot().workspace, null)
    assert.equal(h.store.newSession(), h.store.getSnapshot().activeId)
  })

  it('coalesces bursts and cleans up subscriptions', async () => {
    const h = await setup({ respond: scripted(() => reply(say('a'), say('b'), say('c'), say('d'))) })
    let notified = 0
    const off = h.store.subscribe(() => { notified++ })
    await h.store.sendMessage('go').done
    await tick()
    const total = notified
    assert.ok(total > 0 && total < 20, `notifications are coalesced (${total})`)
    off()
    h.store.refresh()
    await tick()
    assert.equal(notified, total, 'unsubscribed listeners are not called')
    h.store.destroy()
    h.runtime.startSession({ model: { provider: 'fake', model: 'm' } }) // no throw after destroy
  })

  it('returns the same snapshot object until something changes (useSyncExternalStore contract)', async () => {
    const h = await setup()
    assert.equal(h.store.getSnapshot(), h.store.getSnapshot())
    const before = h.store.getSnapshot()
    h.store.newSession()
    assert.notEqual(h.store.getSnapshot(), before)
  })
})

describe('settings store', () => {
  it('keeps only non-secret preferences, validates them, and survives storage failures', () => {
    const mem = new Map()
    const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
    const s = createSettingsStore({ storage })
    assert.deepEqual([s.get().permissionMode, s.get().provider], ['auto_edit', ''])
    s.update({ permissionMode: 'ask', model: ' deepseek-chat ', apiKey: ' sk-secret ' }) // a key is not a setting
    s.update({ permissionMode: 'yolo' }) // invalid → falls back to the default rather than storing garbage
    assert.equal(s.get().permissionMode, 'auto_edit')
    s.update({ permissionMode: 'full_auto' })
    assert.equal(s.get().model, 'deepseek-chat')
    assert.ok(!('apiKey' in s.get()))
    assert.doesNotMatch(mem.get('bluswan.settings'), /sk-secret|apiKey/)
    assert.equal(createSettingsStore({ storage }).get().permissionMode, 'full_auto')
    assert.doesNotThrow(() => createSettingsStore({ storage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } } }).update({ model: 'x' }))
  })
})
