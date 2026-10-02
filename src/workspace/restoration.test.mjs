// How a persisted workspace reference behaves when the repository changed while the app was closed:
// moved, deleted, branch switched, new commits, uncommitted edits, no longer a git repository.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createNodeWorkspaceManager } from './node.js'
import { createFixtureRepo } from './testing/fixtureRepo.js'
import { snapshotWorkspace, restoreWorkspace, compareWithSnapshot } from './workspaceRestore.js'
import { toWorkspaceRecord } from '../persistence/workspaceRepository.js'

const HOST = 'host-1'
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
async function open(opts) {
  const fx = await createFixtureRepo(opts); cleanups.push(fx.cleanup)
  const workspaces = createNodeWorkspaceManager()
  const ws = await workspaces.openWorkspace({ root: fx.root })
  const record = toWorkspaceRecord({ userId: 'u', workspace: ws, hostId: HOST })
  return { fx, ws, record, snapshot: await snapshotWorkspace(ws), fresh: async () => { const m = createNodeWorkspaceManager(); return { m, restored: await restoreWorkspace(record, { workspaces: m, hostId: HOST }) } } }
}

describe('workspace restoration after the app was closed', () => {
  it('an untouched repository restores and compares as unchanged', async () => {
    const t = await open(); const { restored } = await t.fresh()
    assert.equal(restored.status, 'restored')
    const cmp = await compareWithSnapshot(t.snapshot, restored.workspace)
    assert.equal(cmp.changed, false); assert.equal(cmp.known, true); assert.deepEqual(cmp.paths, [])
  })
  it('uncommitted edits made meanwhile are reported with their paths', async () => {
    const t = await open(); await fs.writeFile(path.join(t.fx.root, 'src/math.js'), '// edited\n')
    const cmp = await compareWithSnapshot(t.snapshot, (await t.fresh()).restored.workspace)
    assert.equal(cmp.changed, true); assert.equal(cmp.headChanged, false); assert.deepEqual(cmp.paths, ['src/math.js'])
  })
  it('a branch switch is detected', async () => {
    const t = await open(); t.fx.git('checkout', '-q', '-b', 'feature/other')
    const cmp = await compareWithSnapshot(t.snapshot, (await t.fresh()).restored.workspace)
    assert.equal(cmp.branchChanged, true); assert.deepEqual(cmp.branch, { from: 'main', to: 'feature/other' })
  })
  it('new commits (HEAD moved) are detected even with a clean tree', async () => {
    const t = await open(); await fs.writeFile(path.join(t.fx.root, 'NOTES.md'), 'x\n'); t.fx.git('add', '-A'); t.fx.git('commit', '-q', '-m', 'more')
    const cmp = await compareWithSnapshot(t.snapshot, (await t.fresh()).restored.workspace)
    assert.equal(cmp.headChanged, true); assert.equal(cmp.changed, true); assert.notEqual(cmp.head.from, cmp.head.to)
  })
  it('a repository that stopped being a git repository is reported unknown, not "unchanged"', async () => {
    const t = await open(); await fs.rm(path.join(t.fx.root, '.git'), { recursive: true, force: true })
    const cmp = await compareWithSnapshot(t.snapshot, (await t.fresh()).restored.workspace)
    assert.equal(cmp.known, false); assert.equal(cmp.changed, true)
  })
  it('a repository that was never git restores and has no fingerprint to trust', async () => {
    const t = await open({ git: false }); assert.equal(t.snapshot.isGitRepository, false); assert.equal(t.snapshot.fingerprint, null)
    const cmp = await compareWithSnapshot(t.snapshot, (await t.fresh()).restored.workspace)
    assert.equal(cmp.known, false)
  })
  it('a moved or deleted folder is "unavailable" with a human reason; nothing throws', async () => {
    const t = await open(); const moved = `${t.fx.root}.moved`
    await fs.rename(t.fx.root, moved); cleanups.push(() => fs.rm(moved, { recursive: true, force: true }))
    const r = await restoreWorkspace(t.record, { workspaces: createNodeWorkspaceManager(), hostId: HOST })
    assert.equal(r.status, 'unavailable'); assert.match(r.reason, /no longer exists/); assert.equal(r.workspace, null)
    await fs.rm(moved, { recursive: true, force: true })
    assert.equal((await restoreWorkspace(t.record, { workspaces: createNodeWorkspaceManager(), hostId: HOST })).status, 'unavailable')
  })
  it('a path that became a file is unavailable, not an error', async () => {
    const t = await open(); await fs.rm(t.fx.root, { recursive: true, force: true }); await fs.writeFile(t.fx.root, 'now a file')
    assert.equal((await restoreWorkspace(t.record, { workspaces: createNodeWorkspaceManager(), hostId: HOST })).status, 'unavailable')
  })
  it('a record from another host needs a reconnect instead of pretending the path works', async () => {
    const t = await open()
    assert.equal((await restoreWorkspace(t.record, { workspaces: createNodeWorkspaceManager(), hostId: 'other-host' })).status, 'needs_reconnect')
  })
  it('after a move, reconnecting at the new location works with the same workspace id', async () => {
    const t = await open(); const moved = `${t.fx.root}-new`
    await fs.rename(t.fx.root, moved); cleanups.push(() => fs.rm(moved, { recursive: true, force: true }))
    const m = createNodeWorkspaceManager()
    const ws = await m.createWorkspace({ root: moved, id: t.record.id, kind: 'local' })
    assert.equal(ws.id, t.record.id)
    const cmp = await compareWithSnapshot(t.snapshot, ws)
    assert.equal(cmp.known, true)
  })
})
