// The dogfooding procedure, offline: BLUSWAN repairs a seeded defect in a disposable worktree of its own repository.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { runDogfood, createDogfoodWorktree, checkoutState, DOGFOOD_TASKS, scriptedTurns, formatDogfood } from './dogfood.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../agent/testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const task = DOGFOOD_TASKS[0]
const scripted = (turns) => { let n = 0; return createProviderRegistry([createFakeProvider({ id: 'scripted', respond: () => { const t = turns[n++] ?? { text: 'done' }; return reply(...(t.text ? [say(t.text)] : []), ...(t.calls ?? []).map(c => call(c.id, c.name, c.input))) } })]) }
const worktrees = () => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO }).toString().split('\n').filter(l => l.startsWith('worktree ')).length

describe('dogfooding', () => {
  it('the seeded defect really breaks the repository\'s own test, and the check detects it', async () => {
    const wt = await createDogfoodWorktree({ repoRoot: REPO, task })
    try {
      const ws = await createNodeWorkspaceManager({ allowedRoots: [wt.parent] }).openWorkspace({ root: wt.root })
      assert.equal(await task.check(ws), false)
      assert.deepEqual((await ws.gitChanges()).files, [], 'the defect is committed, so the agent\'s diff is only its own change')
      await assert.rejects(fs.access(path.join(wt.root, '.env')))
      await assert.rejects(fs.access(path.join(wt.root, 'node_modules')))
    } finally { await wt.cleanup() }
  })

  it('the scripted run repairs it, leaves the primary checkout untouched, never pushes, and removes the worktree', async () => {
    const before = checkoutState(REPO); const count = worktrees()
    const report = await runDogfood({ repoRoot: REPO, task, model: { provider: 'scripted', model: 'reference' }, providers: async (root) => scripted(await scriptedTurns(task, root)) })
    assert.equal(report.outcome, 'success', JSON.stringify(report))
    assert.deepEqual(report.filesChanged, task.expectedFiles); assert.deepEqual(report.unexpectedFiles, [])
    assert.equal(report.primaryCheckoutUntouched, true); assert.equal(report.pushed, false); assert.equal(report.worktree, null)
    assert.deepEqual(checkoutState(REPO), before)
    assert.equal(worktrees(), count, 'the worktree was removed')
    assert.match(formatDogfood(report), /primary checkout untouched: yes · pushed: no/)
  })

  it('a model that changes nothing fails, whatever it claims', async () => {
    const report = await runDogfood({ repoRoot: REPO, task, model: { provider: 'scripted', model: 'idle' }, providers: scripted([{ text: 'All fixed, trust me.' }]) })
    assert.equal(report.outcome, 'failed'); assert.equal(report.checkPassed, false); assert.deepEqual(report.filesChanged, [])
    assert.equal(report.primaryCheckoutUntouched, true)
  })

  it('a model that wanders outside the expected files is reported', async () => {
    const turns = [{ calls: [{ id: 'w', name: 'write_file', input: { path: 'NOTES.dogfood.md', content: 'x\n' } }] }, { text: 'done' }]
    const report = await runDogfood({ repoRoot: REPO, task, model: { provider: 'scripted', model: 'wander' }, providers: scripted(turns) })
    assert.deepEqual(report.unexpectedFiles, ['NOTES.dogfood.md']); assert.equal(report.outcome, 'failed')
  })

  it('refuses to put the worktree inside the primary checkout', async () => {
    await assert.rejects(() => createDogfoodWorktree({ repoRoot: REPO, task, base: REPO }), /outside the primary checkout/)
    assert.ok(os.tmpdir())
  })
})
