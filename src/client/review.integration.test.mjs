// Acceptance: one deterministic session through the real runtime, git, tools, validation and client
// store — change → review → inspect evidence → revert → refresh → stale validation → keep talking.
import { describe, it, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { importComponent, render, h } from './testing/renderJsx.mjs'
import { createClientStore } from './state/clientStore.js'
import { createSettingsStore } from './settings/settingsStore.js'
import { createAgentRuntime } from '../agent/runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../agent/testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const scripted = (...turns) => {
  let n = 0
  return (req) => (/still changed/.test(req.messages.filter(m => m.role === 'user').at(-1)?.content ?? '') ? reply(say('Only math.js is still changed.')) : turns[n++]?.() ?? reply(say('done')))
}

let AppShell
before(async () => { AppShell = (await importComponent('AppShell.jsx')).default })

async function setup(respond, { storage = mem(), permissionMode = 'full_auto' } = {}) {
  const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([createFakeProvider({ respond })]), workspaces: createNodeWorkspaceManager(), approvals: 'interactive', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), permissionMode },
  })
  const settings = createSettingsStore({ storage: null })
  const store = createClientStore({ runtime, settings, selectModel: () => ({ provider: 'fake', model: 'm' }), workspaceStorage: storage, debounceMs: 5 })
  cleanups.push(() => store.destroy())
  await store.openWorkspace({ root: fx.root })
  const review = () => store.getSnapshot().active.review
  const settle = async () => { await store.workspace.idle(); await new Promise(r => setTimeout(r, 15)); await store.workspace.idle() }
  return { fx, runtime, store, settings, review, settle }
}

describe('Acceptance review session', () => {
  it('change → review diff → inspect validation and command output → revert → stale → continue', async () => {
    const h_ = await setup(scripted(
      () => reply(say('Looking. '), call('r', 'read_file', { path: 'src/math.js' })),
      () => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH }), call('w', 'write_file', { path: 'src/index.js', content: "import { add } from './math.js'\n\nconsole.log('sum', add(1, 2))\n" })),
      () => reply(call('s', 'shell', { command: 'echo evidence-line; echo warn-line 1>&2' })),
      () => reply(say('Fixed add() and updated the entry point.')), // runtime validates (npm test passes)
      () => reply(say('Fixed add(); the tests pass.')),
      () => reply(say('Only math.js is still changed.')),
    ))
    const { store, review, settle, fx, runtime } = h_
    const sent = store.sendMessage('Fix the failing add test')
    await sent.done
    await settle()

    // 2 files changed (authoritative git state)
    const snap = () => store.getSnapshot().active
    assert.equal(snap().view.status, 'completed')
    assert.equal(snap().changedCount, 2)
    assert.deepEqual(review().changedFiles.map(f => [f.path, f.letter]), [['src/index.js', 'M'], ['src/math.js', 'M']])
    assert.equal(review().gitBacked, true)
    assert.equal(review().diffSummary.files, 2)

    // activity → diff link: the file.changed item exists and selecting its path opens the matching diff
    const items = snap().view.entries.filter(e => e.kind === 'activity').flatMap(g => g.items)
    const patchItem = items.find(i => i.files?.some(f => f.path === 'src/math.js'))
    assert.ok(patchItem, 'activity carries file.changed metadata')
    await store.workspace.selectFile(patchItem.files[0].path); await settle()
    const diff = review().diff
    assert.equal(diff.status, 'ready'); assert.equal(diff.path, 'src/math.js')
    const lines = diff.parsed.files[0].hunks.flatMap(x => x.lines)
    assert.deepEqual(lines.filter(l => l.type !== 'context').map(l => [l.type, l.text.trim()]), [['del', 'return a - b'], ['add', 'return a + b']])

    // validation details: passed, current
    assert.equal(review().validation.state, 'current')
    const test = review().validation.rows.find(r => r.kind === 'test')
    assert.equal(test.status, 'passed')

    // command details: shell stdout/stderr and the validation command's recorded output
    const groups = review().commands
    assert.equal(groups.length, 1); assert.equal(groups[0].title, 'Fix the failing add test')
    const shellCmd = groups[0].commands.find(c => c.source === 'shell')
    const detail = store.workspace.getCommand(shellCmd.id)
    assert.deepEqual([detail.exitCode, detail.stdout.trim(), detail.stderr.trim()], [0, 'evidence-line', 'warn-line'])
    const valCmd = groups[0].commands.find(c => c.source === 'validation')
    assert.match(store.workspace.getCommand(valCmd.id).command, /npm|node/)

    // the rendered workspace (desktop, panel open) shows all of it
    store.workspace.setPanelOpen(true)
    const html = await render(await h(AppShell, { store, settings: h_.settings }))
    assert.match(html, /2 files changed/); assert.match(html, /src\/math\.js/); assert.match(html, /dl--add/); assert.match(html, /Revert file/)
    assert.doesNotMatch(html, /\b(V1|V2|V3|engine|cycle|completion gate)\b/i)

    // user reverts one file with confirmation
    store.workspace.requestRevert('src/math.js')
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /a \+ b/)
    assert.equal((await store.workspace.confirmRevert()).ok, true)
    await settle()
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /a - b/)
    assert.deepEqual(review().changedFiles.map(f => f.path), ['src/index.js'])
    assert.equal(snap().changedCount, 1)
    assert.equal(review().diffSummary.files, 1)
    assert.equal(review().ui.selectedPath, null)

    // validation no longer counts as proof of the current code
    assert.equal(review().validation.state, 'stale')
    assert.equal(review().validation.rows.find(r => r.kind === 'test').status, 'stale')
    assert.equal(runtime.getSession(snap().id).validation.currentStatus, 'stale')

    // the conversation stays active
    assert.equal(snap().composer.disabled, false)
    const follow = store.sendMessage('What is still changed?')
    assert.equal(follow.ok, true); await follow.done; await settle()
    assert.equal(snap().view.entries.filter(e => e.kind === 'assistant').at(-1).text, 'Only math.js is still changed.')
    assert.equal(snap().view.entries.filter(e => e.kind === 'user').length, 2)
  })

  it('Stop keeps the diff, files and command logs reviewable', async () => {
    const h_ = await setup(scripted(
      () => reply(call('w', 'write_file', { path: 'keep.txt', content: 'kept\n' })),
      () => reply(call('s', 'shell', { command: 'sleep 30' })),
    ))
    const sent = h_.store.sendMessage('long task')
    await until(() => h_.store.getSnapshot().active.view.entries.some(e => e.kind === 'activity' && e.items.some(i => i.tool === 'shell' && i.status === 'running')))
    h_.store.cancel(); await sent.done; await h_.settle()
    assert.equal(h_.store.getSnapshot().active.view.status, 'stopped')
    assert.deepEqual(h_.review().changedFiles.map(f => f.path), ['keep.txt'])
    const cmd = h_.review().commands[0].commands[0]
    assert.equal(cmd.cancelled, true)
    assert.equal(h_.store.workspace.getCommand(cmd.id).cancelled, true)
    await h_.store.workspace.selectFile('keep.txt'); await h_.settle()
    assert.match(h_.review().diff.parsed.files[0].hunks[0].lines[0].text, /kept/)
  })

  it('the diff stays reviewable while an approval is pending', async () => {
    const h_ = await setup(scripted(
      () => reply(call('w', 'write_file', { path: 'a.txt', content: '1\n' })),
      () => reply(call('d', 'delete_file', { path: 'src/index.js' })),
    ), { permissionMode: 'auto_edit' })
    const sent = h_.store.sendMessage('edit then delete')
    await until(() => h_.store.getSnapshot().active.view.pendingPermission)
    await h_.settle()
    assert.equal(h_.review().changedFiles.some(f => f.path === 'a.txt'), true)
    await h_.store.workspace.selectFile('a.txt'); await h_.settle()
    assert.equal(h_.review().diff.status, 'ready')
    h_.store.denyPermission(h_.store.getSnapshot().active.view.pendingPermission.id); await sent.done
  })

  it('desktop panel is closed by default, opens on demand, and mobile uses a sheet', async () => {
    const h_ = await setup(scripted(() => reply(call('w', 'write_file', { path: 'a.txt', content: 'x' })), () => reply(say('ok'))))
    await h_.store.sendMessage('go').done; await h_.settle()
    const closed = await render(await h(AppShell, { store: h_.store, settings: h_.settings }))
    assert.doesNotMatch(closed, /rpanel/); assert.match(closed, /1 file changed/)
    h_.store.workspace.togglePanel()
    assert.match(await render(await h(AppShell, { store: h_.store, settings: h_.settings })), /rpanel[\s\S]*role="separator"/)
    // mobile: no side column; sheet only after the user opens it, and a chip offers it
    h_.store.workspace.setPanelOpen(true)
    const mobileClosed = await render(await h(AppShell, { store: h_.store, settings: h_.settings, mobileOverride: true }))
    assert.doesNotMatch(mobileClosed, /rpanel/); assert.doesNotMatch(mobileClosed, /class="sheet"/); assert.match(mobileClosed, /changes-chip[^>]*>1 file changed/)
    h_.store.workspace.openChanges()
    const mobileOpen = await render(await h(AppShell, { store: h_.store, settings: h_.settings, mobileOverride: true }))
    assert.match(mobileOpen, /role="dialog"[^>]*aria-label="Workspace"/); assert.match(mobileOpen, /aria-label="Changed files"/)
    await h_.store.workspace.selectFile('a.txt'); await h_.settle()
    const detail = await render(await h(AppShell, { store: h_.store, settings: h_.settings, mobileOverride: true }))
    assert.doesNotMatch(detail, /aria-label="Changed files"/); assert.match(detail, /dl--add/); assert.match(detail, /‹ Changed files/)
  })
})
