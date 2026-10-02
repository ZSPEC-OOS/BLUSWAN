// Review surface of the runtime: authoritative changed files, per-file diffs, command output, user-driven revert.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { parseNumstat } from '../workspace/git.js'
import { isCurrent } from '../validation/validationState.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

async function setup({ git = true, turns = [] } = {}) {
  const fx = await createFixtureRepo({ git }); cleanups.push(() => fx.cleanup())
  const wm = createNodeWorkspaceManager()
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([createFakeProvider({ turns })]), workspaces: wm, approvals: 'unattended', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), enableAutomaticValidation: false, permissionMode: 'full_auto' },
  })
  const ws = await wm.openWorkspace({ root: fx.root })
  const session = runtime.startSession({ workspaceId: ws.id, model: { provider: 'fake', model: 'm' } })
  const events = []
  runtime.subscribe(session.id, e => events.push(e))
  const exec = (name, input) => runtime.executeTool(session.id, { name, input })
  return { fx, ws, runtime, session, events, exec, id: session.id }
}

describe('git changes', () => {
  it('parses numstat including renames and binaries', () => {
    const raw = '3\t1\tsrc/a.js\0-\t-\timg.png\0'
    assert.deepEqual(parseNumstat(raw), [
      { additions: 3, deletions: 1, binary: false, path: 'src/a.js' }, { additions: 0, deletions: 0, binary: true, path: 'img.png' },
    ])
    assert.deepEqual(parseNumstat('0\t0\t\0old.js\0new.js\0'), [{ additions: 0, deletions: 0, binary: false, from: 'old.js', path: 'new.js' }])
  })

  it('reports kinds and exact line counts from git', async () => {
    const h = await setup()
    await h.exec('apply_patch', { patch: FIX_ADD_PATCH })
    await h.exec('write_file', { path: 'src/new.js', content: 'a\nb\nc\n' })
    await h.exec('delete_file', { path: 'src/index.js' })
    await fs.writeFile(path.join(h.fx.root, 'bin.dat'), Buffer.from([0, 1, 2, 0]))
    const st = await h.runtime.getWorkspaceState(h.id)
    assert.equal(st.source, 'git')
    const by = Object.fromEntries(st.files.map(f => [f.path, f]))
    assert.deepEqual([by['src/math.js'].status, by['src/math.js'].additions, by['src/math.js'].deletions], ['modified', 1, 1])
    assert.deepEqual([by['src/new.js'].status, by['src/new.js'].additions, by['src/new.js'].untracked], ['untracked', 3, true])
    assert.deepEqual([by['src/index.js'].status, by['src/index.js'].deletions], ['deleted', 3])
    assert.equal(by['bin.dat'].binary, true)
    assert.equal(st.summary.files, 4)
    assert.equal(st.summary.additions, 1 + 3)
    assert.equal(st.repository.branch, 'main')
  })

  it('exposes staged renames', async () => {
    const h = await setup()
    h.fx.git('mv', 'tests/math.test.js', 'tests/m2.test.js')
    const f = (await h.runtime.getWorkspaceState(h.id)).files.find(x => x.path === 'tests/m2.test.js')
    assert.deepEqual([f.status, f.from, f.staged], ['renamed', 'tests/math.test.js', true])
  })

  it('revision advances on mutations', async () => {
    const h = await setup()
    const r0 = (await h.runtime.getWorkspaceState(h.id)).revision
    await h.exec('write_file', { path: 'x.txt', content: '1' })
    assert.ok((await h.runtime.getWorkspaceState(h.id)).revision > r0)
  })

  it('falls back to session-tracked changes outside git, and says so', async () => {
    const h = await setup({ git: false })
    await h.exec('write_file', { path: 'a.txt', content: 'hello\n' })
    const st = await h.runtime.getWorkspaceState(h.id)
    assert.equal(st.source, 'session')
    assert.deepEqual(st.files.map(f => [f.path, f.status, f.additions]), [['a.txt', 'added', null]])
    const d = await h.runtime.getFileDiff(h.id, 'a.txt')
    assert.deepEqual([d.source, d.contents], ['session', 'hello\n'])
    await assert.rejects(() => h.runtime.revertFile(h.id, 'a.txt'), (e) => e.code === 'revert_unsupported')
  })
})

describe('file diffs', () => {
  it('returns a per-file unified diff against HEAD for modified, new and deleted files', async () => {
    const h = await setup()
    await h.exec('apply_patch', { patch: FIX_ADD_PATCH })
    await h.exec('write_file', { path: 'src/new.js', content: 'a\n' })
    await h.exec('delete_file', { path: 'src/index.js' })
    const mod = await h.runtime.getFileDiff(h.id, 'src/math.js')
    assert.match(mod.diff, /^diff --git a\/src\/math\.js/); assert.match(mod.diff, /^\+ {2}return a \+ b$/m); assert.doesNotMatch(mod.diff, /index\.js|new\.js/)
    assert.match((await h.runtime.getFileDiff(h.id, 'src/new.js')).diff, /new file mode[\s\S]*\+a/)
    assert.match((await h.runtime.getFileDiff(h.id, 'src/index.js')).diff, /deleted file mode[\s\S]*-import/)
  })
  it('includes staged changes', async () => {
    const h = await setup()
    await h.exec('write_file', { path: 'src/math.js', content: 'export const z = 1\n' })
    h.fx.git('add', 'src/math.js')
    assert.match((await h.runtime.getFileDiff(h.id, 'src/math.js')).diff, /\+export const z = 1/)
  })
})

describe('revert', () => {
  it('reverts one file, leaves the other, refreshes state, and makes validation stale', async () => {
    const h = await setup()
    await h.exec('apply_patch', { patch: FIX_ADD_PATCH })
    await h.exec('write_file', { path: 'src/index.js', content: 'console.log(1)\n' })
    // pretend a validation round passed on the current code
    const before = h.runtime.getSession(h.id)
    assert.equal(before.changedFiles.length, 2)
    const res = await h.runtime.revertFile(h.id, 'src/math.js')
    assert.equal(res.ok, true)
    const st = await h.runtime.getWorkspaceState(h.id)
    assert.deepEqual(st.files.map(f => f.path), ['src/index.js'])
    assert.equal(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8'), (await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8')))
    assert.match(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8'), /a - b/)
    assert.deepEqual(h.runtime.getSession(h.id).changedFiles.map(f => f.path), ['src/index.js'])
    assert.equal(isCurrent(h.runtime.getSession(h.id).validation), false)
    assert.equal(h.runtime.getSession(h.id).validation.currentStatus, 'stale')
    const ev = h.events.find(e => e.type === 'file.reverted')
    assert.deepEqual([ev.data.path, ev.data.action], ['src/math.js', 'reverted'])
    assert.ok(!h.runtime.getSession(h.id).contextSummary.filesChanged.some(f => f.path === 'src/math.js'))
  })

  it('removes a new file and restores a deleted one', async () => {
    const h = await setup()
    await h.exec('write_file', { path: 'n.txt', content: 'x' })
    await h.exec('delete_file', { path: 'src/index.js' })
    await h.runtime.revertFile(h.id, 'n.txt'); await h.runtime.revertFile(h.id, 'src/index.js')
    await assert.rejects(() => fs.access(path.join(h.fx.root, 'n.txt')))
    await fs.access(path.join(h.fx.root, 'src/index.js'))
    assert.equal((await h.runtime.getWorkspaceState(h.id)).summary.files, 0)
  })

  it('fails honestly: nothing to revert, escaping paths, and running sessions', async () => {
    const h = await setup()
    await assert.rejects(() => h.runtime.revertFile(h.id, 'src/math.js'), (e) => e.code === 'nothing_to_revert')
    await assert.rejects(() => h.runtime.revertFile(h.id, '../outside.txt'), (e) => e.code === 'revert_failed')
    await assert.rejects(() => h.runtime.revertFile(h.id, '.git/config'), (e) => e.code === 'revert_failed')
    assert.equal(h.events.some(e => e.type === 'file.reverted'), false)
  })
})

describe('command log', () => {
  it('keeps stdout, stderr, exit code, duration and truncation for shell calls', async () => {
    const h = await setup()
    await h.runtime.executeTool(h.id, { id: 'c1', name: 'shell', input: { command: 'echo out; echo err 1>&2; exit 3' } })
    await h.runtime.executeTool(h.id, { id: 'c2', name: 'shell', input: { command: 'echo token=sk-abcdefgh12345' } })
    const list = h.runtime.listCommands(h.id)
    assert.deepEqual(list.map(c => [c.id, c.exitCode, c.status]), [['c1', 3, 'failed'], ['c2', 0, 'passed']])
    assert.equal('stdout' in list[0], false, 'listing carries no output')
    const c1 = h.runtime.getCommand(h.id, 'c1')
    assert.deepEqual([c1.stdout.trim(), c1.stderr.trim(), typeof c1.durationMs], ['out', 'err', 'number'])
    assert.doesNotMatch(h.runtime.getCommand(h.id, 'c2').stdout, /sk-abcdefgh/)
  })
  it('records timeouts', async () => {
    const h = await setup()
    await h.runtime.executeTool(h.id, { id: 't', name: 'shell', input: { command: 'sleep 5', timeoutMs: 200 } })
    const c = h.runtime.getCommand(h.id, 't')
    assert.deepEqual([c.timedOut, c.status], [true, 'timeout'])
  })
})
