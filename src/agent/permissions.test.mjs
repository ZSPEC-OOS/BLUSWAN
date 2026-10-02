// Real pending approvals in the runtime: modes, waiting_permission, approve/deny/cancel, blocked commands.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { decidePermission, describePermission, PERMISSION_MODES, MODE_INFO, isPermissionMode } from '../tools/permissionModes.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

async function setup({ turns, mode = 'auto_edit', approvals = 'interactive' }) {
  const fx = await createFixtureRepo()
  cleanups.push(() => fx.cleanup())
  const wm = createNodeWorkspaceManager()
  const provider = createFakeProvider({ turns })
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([provider]), workspaces: wm, approvals, sleep: async () => {},
    config: { ...loadRuntimeConfig({}), enableAutomaticValidation: false, permissionMode: mode },
  })
  const ws = await wm.openWorkspace({ root: fx.root })
  const session = runtime.startSession({ workspaceId: ws.id, model: { provider: 'fake', model: 'm' } })
  const events = []
  runtime.subscribe(session.id, e => events.push(e))
  const requested = () => events.filter(e => e.type === 'permission.requested')
  const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise(r => setTimeout(r, 5)) } }
  return { fx, ws, provider, runtime, session, events, requested, waitFor, send: (t = 'go') => runtime.sendMessage(session.id, t) }
}
const toolMsg = (s, id) => s.messages.find(m => m.toolCallId === id)

describe('permission policy', () => {
  it('maps every mode and effect deterministically; prohibited is always blocked', () => {
    const table = Object.fromEntries(PERMISSION_MODES.map(m => [m, ['read', 'workspace_write', 'destructive', 'dependency_change', 'external_effect', 'prohibited'].map(e => decidePermission(m, e)).join(',')]))
    assert.deepEqual(table, {
      ask: 'allow,ask,ask,ask,ask,block', auto_edit: 'allow,allow,ask,ask,ask,block', full_auto: 'allow,allow,allow,allow,ask,block',
    })
    assert.equal(decidePermission('nonsense', 'read'), 'ask') // unknown modes fail closed
    assert.equal(decidePermission('full_auto', 'made_up_effect'), 'ask')
    assert.ok(PERMISSION_MODES.every(m => MODE_INFO[m].label && MODE_INFO[m].description.length > 20))
    assert.ok(isPermissionMode('ask') && !isPermissionMode('yolo'))
  })
  it('describes requests in plain language without secrets', () => {
    assert.deepEqual(describePermission({ tool: 'shell', input: { command: 'npm install zod' }, effect: 'dependency_change' }), { action: 'run', command: 'npm install zod', description: 'This changes project dependencies.' })
    assert.deepEqual(describePermission({ tool: 'delete_file', input: { path: 'src/old.js' }, effect: 'destructive' }), { action: 'delete', paths: ['src/old.js'], description: 'This permanently deletes the file.' })
    assert.deepEqual(describePermission({ tool: 'apply_patch', input: { patch: '--- a/a.js\n+++ b/a.js\n@@\n--- /dev/null\n+++ b/new.js\n' }, effect: 'workspace_write' }).paths, ['a.js', 'new.js'])
    assert.ok(!describePermission({ tool: 'shell', input: { command: 'API_TOKEN=abc123 npm install' }, effect: 'dependency_change' }).command.includes('abc123'))
  })
})

describe('runtime approvals', () => {
  it('pauses for approval, then runs the tool once and lets the model continue', async () => {
    const h = await setup({ turns: [reply(call('c1', 'shell', { command: 'npm install --help' })), reply(say('Installed (help only).'))] })
    const run = h.send()
    await h.waitFor(() => h.requested().length === 1)
    const req = h.requested()[0].data
    assert.deepEqual([req.tool, req.effect, req.action, req.command, req.toolCallId], ['shell', 'dependency_change', 'run', 'npm install --help', 'c1'])
    assert.equal(h.runtime.getSession(h.session.id).status, 'waiting_permission')
    assert.equal(h.runtime.getPendingPermissions(h.session.id).length, 1)
    assert.equal(h.events.filter(e => e.type === 'tool.completed').length, 0, 'nothing ran yet')
    assert.equal(h.provider.requests.length, 1, 'the model loop is paused')
    await assert.rejects(h.send('second'), e => e.code === 'session_busy')

    assert.equal(h.runtime.approvePermission(h.session.id, req.id), true)
    assert.equal(h.runtime.approvePermission(h.session.id, req.id), false, 'a decision applies once')
    const done = await run
    assert.equal(done.status, 'completed')
    assert.deepEqual(h.events.filter(e => e.type.startsWith('permission.')).map(e => [e.type, e.data.decision]), [['permission.requested', undefined], ['permission.resolved', 'approved']])
    assert.equal(done.toolCalls.filter(c => c.id === 'c1').length, 1, 'executed exactly once')
    assert.match(toolMsg(done, 'c1').content, /Status: ok/)
    assert.deepEqual(h.runtime.getPendingPermissions(), [])
  })

  it('returns a structured denial to the model, which adapts', async () => {
    const h = await setup({
      turns: [
        reply(call('d1', 'delete_file', { path: 'src/index.js' })),
        (req) => { assert.match(req.messages.at(-1).content, /Error \[permission_denied\]: The user denied this action\./); return reply(say('I left src/index.js in place.')) },
      ],
    })
    const run = h.send()
    await h.waitFor(() => h.requested().length === 1)
    assert.deepEqual([h.requested()[0].data.action, h.requested()[0].data.paths], ['delete', ['src/index.js']])
    h.runtime.denyPermission(h.session.id, h.requested()[0].data.id)
    const done = await run
    assert.equal(done.status, 'completed')
    assert.equal(await h.ws.exists('src/index.js'), true)
    assert.equal(done.toolCalls[0].status, 'failed')
    assert.equal(h.events.find(e => e.type === 'permission.resolved').data.decision, 'denied')
    assert.equal(h.events.filter(e => e.type === 'file.changed').length, 0)
  })

  it('Stop while waiting cancels the request and the run', async () => {
    const h = await setup({ turns: [reply(call('c1', 'write_file', { path: 'x.txt', content: 'x' })), reply(say('unreachable'))], mode: 'ask' })
    const run = h.send()
    await h.waitFor(() => h.requested().length === 1)
    h.runtime.cancelSession(h.session.id)
    const done = await run
    assert.equal(done.status, 'cancelled')
    assert.equal(h.events.find(e => e.type === 'permission.resolved').data.decision, 'cancelled')
    assert.equal(h.provider.requests.length, 1)
    assert.equal(await h.ws.exists('x.txt'), false)
    assert.deepEqual(h.runtime.getPendingPermissions(), [])
    assert.equal(done.messages.filter(m => m.role === 'tool').length, 1, 'history stays valid')
  })

  it('never prompts for prohibited operations: blocked in every mode', async () => {
    for (const mode of PERMISSION_MODES) {
      const h = await setup({ mode, turns: [reply(call('b1', 'shell', { command: 'sudo rm -rf /' })), (req) => { assert.match(req.messages.at(-1).content, /blocked by workspace safety policy/); return reply(say('ok')) }] })
      const done = await h.send()
      assert.equal(h.requested().length, 0, mode)
      assert.equal(done.toolCalls[0].status, 'failed')
      assert.equal(done.status, 'completed')
    }
  })

  it('Ask / Auto Edit / Full Auto change what needs approval', async () => {
    const edit = () => [reply(call('e1', 'write_file', { path: 'new.txt', content: 'x' })), reply(say('ok'))]
    const ask = await setup({ mode: 'ask', turns: edit() })
    const askRun = ask.send()
    await ask.waitFor(() => ask.requested().length === 1)
    ask.runtime.approvePermission(ask.session.id, ask.requested()[0].data.id)
    await askRun
    assert.equal(await ask.ws.exists('new.txt'), true)

    const auto = await setup({ mode: 'auto_edit', turns: edit() })
    await auto.send()
    assert.equal(auto.requested().length, 0)
    assert.equal(await auto.ws.exists('new.txt'), true)

    const del = () => [reply(call('x1', 'delete_file', { path: 'src/index.js' })), reply(say('ok'))]
    const autoDelete = await setup({ mode: 'auto_edit', turns: del() })
    const autoDeleteRun = autoDelete.send()
    await autoDelete.waitFor(() => autoDelete.requested().length === 1)
    autoDelete.runtime.denyPermission(autoDelete.session.id, autoDelete.requested()[0].data.id)
    await autoDeleteRun

    const full = await setup({ mode: 'full_auto', turns: del() })
    await full.send()
    assert.equal(full.requested().length, 0)
    assert.equal(await full.ws.exists('src/index.js'), false)

    const push = await setup({ mode: 'full_auto', turns: [reply(call('p1', 'shell', { command: 'git push origin main' })), reply(say('ok'))] })
    const pushRun = push.send()
    await push.waitFor(() => push.requested().length === 1) // external effects always ask, even in Full Auto
    push.runtime.denyPermission(push.session.id, push.requested()[0].data.id)
    await pushRun
  })

  it('read-only and safe checks never ask, even in Ask mode', async () => {
    const h = await setup({ mode: 'ask', turns: [reply(call('r1', 'read_file', { path: 'src/math.js' }), call('r2', 'git_status', {}), call('r3', 'shell', { command: 'node --version' })), reply(say('ok'))] })
    const done = await h.send()
    assert.equal(h.requested().length, 0)
    assert.equal(done.status, 'completed')
  })

  it('unattended runtimes keep the headless behavior: unapproved actions fail with permission_required', async () => {
    const h = await setup({ approvals: 'unattended', mode: 'ask', turns: [reply(call('w1', 'write_file', { path: 'a.txt', content: 'x' })), (req) => { assert.match(req.messages.at(-1).content, /Error \[permission_required\]/); return reply(say('ok')) }] })
    await h.send()
    assert.equal(h.requested().length, 0)
    assert.equal(await h.ws.exists('a.txt'), false)
  })

  it('the mode can be changed at runtime and unknown modes are rejected', async () => {
    const h = await setup({ turns: [reply(say('hi'))] })
    assert.equal(h.runtime.getPermissionMode(), 'auto_edit')
    assert.equal(h.runtime.setPermissionMode('ask'), 'ask')
    assert.throws(() => h.runtime.setPermissionMode('yolo'), /Unknown permission mode/)
    assert.equal(h.runtime.getPermissionMode(), 'ask')
  })

  it('ignores decisions for unknown requests or other sessions', async () => {
    const h = await setup({ turns: [reply(call('c1', 'delete_file', { path: 'src/index.js' })), reply(say('done'))] })
    const run = h.send()
    await h.waitFor(() => h.requested().length === 1)
    const id = h.requested()[0].data.id
    assert.equal(h.runtime.approvePermission('other-session', id), false)
    assert.equal(h.runtime.approvePermission(h.session.id, 'perm_nope'), false)
    assert.equal(h.runtime.getSession(h.session.id).status, 'waiting_permission')
    h.runtime.denyPermission(h.session.id, id)
    await run
  })

  it('exposes session management and workspaces through the runtime', async () => {
    const h = await setup({ turns: [reply(say('hi'))] })
    assert.equal(h.runtime.listSessions().length, 1)
    assert.equal(h.runtime.listWorkspaces()[0].id, h.ws.id)
    const opened = await h.runtime.openWorkspace({ root: h.fx.root })
    assert.equal(opened.id, h.ws.id)
    await h.send()
    assert.equal(await h.runtime.deleteSession(h.session.id), true)
    assert.equal(h.runtime.getSession(h.session.id), null)
    assert.equal(await fs.access(path.join(h.fx.root, 'package.json')).then(() => true), true, 'repository files are untouched')
  })

  it('refuses to delete a running session', async () => {
    const h = await setup({ turns: [reply(call('c1', 'delete_file', { path: 'src/index.js' }))] })
    const run = h.send()
    await h.waitFor(() => h.requested().length === 1)
    await assert.rejects(h.runtime.deleteSession(h.session.id), e => e.code === 'session_busy')
    h.runtime.cancelSession(h.session.id)
    await run
    assert.equal(await h.runtime.deleteSession(h.session.id), true)
  })
})
