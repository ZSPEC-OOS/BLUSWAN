// Phase 2 acceptance: deterministic workspace/tool pipeline. No model, no network, no API key.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from './runtime.js'
import { createSessionManager } from '../sessions/sessionManager.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { createProviderRegistry } from '../providers/registry.js'

const model = { provider: 'deepseek', model: 'placeholder' }

describe('Phase 2 acceptance: repository → patch → test → diff, no AI provider', () => {
  let fx, workspaceManager, sessionManager, runtime, session, events
  before(async () => {
    fx = await createFixtureRepo()
    workspaceManager = createNodeWorkspaceManager()
    sessionManager = createSessionManager()
    runtime = createAgentRuntime({ providers: createProviderRegistry([]), sessions: sessionManager, workspaces: workspaceManager })
    events = []
    runtime.subscribe(e => events.push(e))
  })
  after(() => fx.cleanup())

  it('runs the full scenario through runtime.executeTool', async () => {
    const workspace = await workspaceManager.openWorkspace({ root: fx.root })
    session = runtime.startSession({ workspaceId: workspace.id, model })
    const exec = (name, input) => runtime.executeTool(session.id, { name, input })

    // open → inspect
    assert.equal(workspace.metadata.repository.isGitRepository, true)
    const listing = await exec('list_directory', {})
    assert.ok(listing.output.entries.some(e => e.path === 'src'))

    // search + read
    const found = await exec('search_files', { query: 'math' })
    assert.equal(found.output.matches[0].path, 'src/math.js')
    const g = await exec('grep', { pattern: 'a - b' })
    assert.equal(g.output.matches[0].line, 2)
    const read = await exec('read_file', { path: 'src/math.js' })
    assert.match(read.output.content, /return a - b/)

    assert.equal((await exec('read_file', { path: 'src/missing.js' })).error.code, 'file_not_found')

    // the fixture test fails before the fix
    const before = await exec('shell', { command: 'npm test' })
    assert.equal(before.ok, true)
    assert.notEqual(before.output.exitCode, 0)

    // patch
    const patched = await exec('apply_patch', { patch: FIX_ADD_PATCH })
    assert.equal(patched.ok, true, patched.error?.message)
    assert.deepEqual(patched.output.changedFiles, ['src/math.js'])

    // test passes after the fix
    const after = await exec('shell', { command: 'npm test' })
    assert.equal(after.ok, true, after.error?.message)
    assert.equal(after.output.exitCode, 0)
    assert.match(after.output.stdout, /# pass 2/)
    assert.match(after.output.stdout, /# fail 0/)

    // git state
    const status = await exec('git_status', {})
    assert.equal(status.output.clean, false)
    assert.deepEqual(status.output.modified, ['src/math.js'])
    assert.equal(status.output.branch, 'main')
    const diff = await exec('git_diff', {})
    assert.deepEqual(diff.output.files, [{ path: 'src/math.js', additions: 1, deletions: 1, binary: false }])
    assert.ok(diff.output.diff.includes('-  return a - b\n+  return a + b'))

    // on disk
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /return a \+ b/)

    // the real BLUSWAN tree was not touched
    assert.ok(!fx.root.startsWith(process.cwd()))
  })

  it('records tool calls, changed files and events on the session', () => {
    const s = runtime.getSession(session.id)
    assert.equal(s.workspaceId, session.workspaceId)
    assert.equal(s.toolCalls.length, 10)
    assert.ok(s.toolCalls.every(c => c.status === 'completed' || c.status === 'failed'))
    const patch = s.toolCalls.find(c => c.name === 'apply_patch')
    assert.deepEqual([patch.status, patch.resultSummary.ok, typeof patch.startedAt, typeof patch.completedAt], ['completed', true, 'number', 'number'])
    assert.deepEqual(s.changedFiles, [{ path: 'src/math.js', action: 'modified' }])

    const forTool = id => events.filter(e => e.data.toolCallId === id).map(e => e.type)
    assert.deepEqual(forTool(patch.id), ['tool.started', 'file.changed', 'tool.completed'])
    const failed = s.toolCalls.find(c => c.status === 'failed')
    assert.deepEqual(forTool(failed.id), ['tool.started', 'tool.failed'])
  })

  it('exposes the canonical tool descriptors', () => {
    assert.equal(runtime.listTools().length, 11)
  })
})

describe('runtime tool execution edge cases', () => {
  let fx, wm, runtime
  before(async () => {
    fx = await createFixtureRepo()
    wm = createNodeWorkspaceManager()
    runtime = createAgentRuntime({ providers: createProviderRegistry([]), workspaces: wm })
  })
  after(() => fx.cleanup())

  it('fails with workspace_not_found for sessions without a workspace', async () => {
    const s = runtime.startSession({ model })
    const r = await runtime.executeTool(s.id, { name: 'read_file', input: { path: 'x' } })
    assert.deepEqual([r.ok, r.error.code], [false, 'workspace_not_found'])
    assert.equal(runtime.getSession(s.id).toolCalls[0].status, 'failed')
  })

  it('rejects unknown workspaces at session start and unknown sessions at execution', async () => {
    assert.throws(() => runtime.startSession({ workspaceId: 'ws_missing', model }), /Unknown workspace/)
    await assert.rejects(runtime.executeTool('nope', { name: 'git_status' }), /Unknown session/)
  })

  it('does not accept per-call filesystem roots: tools only see the session workspace', async () => {
    const ws = await wm.openWorkspace({ root: fx.root })
    const s = runtime.startSession({ workspaceId: ws.id, model })
    const r = await runtime.executeTool(s.id, { name: 'read_file', input: { path: '/etc/passwd', root: '/' } })
    assert.equal(r.error.code, 'invalid_input')
    const t = await runtime.executeTool(s.id, { name: 'read_file', input: { path: '../../etc/passwd' } })
    assert.equal(t.error.code, 'path_outside_workspace')
  })

  it('propagates session cancellation to a running shell command', async () => {
    const ws = await wm.openWorkspace({ root: fx.root })
    const s = runtime.startSession({ workspaceId: ws.id, model })
    const types = []
    const unsub = runtime.subscribe(e => { if (e.sessionId === s.id) types.push(e.type) })
    const pending = runtime.executeTool(s.id, { name: 'shell', input: { command: 'sleep 60' } })
    await new Promise(r => setTimeout(r, 300))
    runtime.cancelSession(s.id)
    const started = Date.now()
    const r = await pending
    unsub()
    assert.ok(Date.now() - started < 5000)
    assert.equal(r.error.code, 'command_cancelled')
    assert.ok(types.includes('tool.failed') && types.includes('session.cancelled'))
    assert.equal(runtime.getSession(s.id).status, 'cancelled')
    // a stopped run leaves the conversation reopenable
    assert.equal((await runtime.executeTool(s.id, { name: 'git_status' })).ok, true)
  })
})
