// Phase 3 end-to-end: real runtime, session manager, event protocol, tool executor, workspace and
// git; only the model is scripted. No network, no API key.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgentRuntime } from './runtime.js'
import { createSessionManager } from '../sessions/sessionManager.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const WRONG_PATCH = `--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b
+  return a * b
 }
`
const CORRECT_PATCH = `--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a * b
+  return a + b
 }
`

describe('Phase 3 acceptance: failed-test recovery with a scripted model', () => {
  let fx, wm, sessions, runtime, provider, session, events
  before(async () => {
    fx = await createFixtureRepo()
    wm = createNodeWorkspaceManager()
    const workspace = await wm.openWorkspace({ root: fx.root })

    const lastTool = (req) => req.messages.at(-1).content
    provider = createFakeProvider({
      turns: [
        reply(say('I will inspect the implementation and its tests.'), call('t1', 'search_files', { query: 'math' })),
        reply(call('t2', 'read_many_files', { paths: ['src/math.js', 'tests/math.test.js'] })),
        reply(say('add() subtracts; patching it.'), call('t3', 'apply_patch', { patch: WRONG_PATCH })),
        reply(call('t4', 'shell', { command: 'npm test' })),
        (req) => { // the model reads the failing test output before correcting itself
          assert.match(lastTool(req), /Exit code: 1/)
          assert.match(lastTool(req), /add/)
          return reply(say('The test still fails: 2 * 3 is 6, not 5.'), call('t5', 'apply_patch', { patch: CORRECT_PATCH }))
        },
        reply(call('t6', 'shell', { command: 'npm test' })),
        reply(call('t7', 'git_diff', {})),
        (req) => {
          assert.match(lastTool(req), /return a \+ b/)
          return reply(say('Fixed add() in src/math.js (it subtracted instead of adding). Validation: npm test passed.'))
        },
      ],
    })
    sessions = createSessionManager()
    runtime = createAgentRuntime({
      providers: createProviderRegistry([provider]), sessions, workspaces: wm,
      config: { ...loadRuntimeConfig({}), maxTurns: 25 },
    })
    session = runtime.startSession({ workspaceId: workspace.id, model: { provider: 'fake', model: 'scripted' } })
    events = []
    runtime.subscribe(session.id, e => events.push(e))
  })
  after(() => fx.cleanup())

  it('drives read → wrong patch → failing test → corrective patch → passing test → final answer', async () => {
    const done = await runtime.sendMessage(session.id, 'Fix add() in src/math.js so the tests pass.')
    assert.equal(done.status, 'completed')
    assert.equal(provider.requests.length, 8)

    const tools = done.toolCalls.map(c => c.name)
    assert.deepEqual(tools, ['search_files', 'read_many_files', 'apply_patch', 'shell', 'apply_patch', 'shell', 'git_diff'])
    const shellRuns = done.messages.filter(m => m.role === 'tool' && m.name === 'shell').map(m => /Exit code: (\d+)/.exec(m.content)[1])
    assert.deepEqual(shellRuns, ['1', '0'])

    assert.equal(done.messages.at(-1).role, 'assistant')
    assert.match(done.messages.at(-1).content, /npm test passed/)
    assert.deepEqual(done.changedFiles, [{ path: 'src/math.js', action: 'modified' }])
    assert.equal(events.filter(e => e.type === 'file.changed').length, 2)
    assert.equal(events.at(-1).type, 'session.completed')
    assert.deepEqual(done.turns.map(t => t.turn), [1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('left the repository in the expected state (verified independently of the session)', async () => {
    const ws = wm.getWorkspace(session.workspaceId)
    const diff = await ws.gitDiff()
    assert.deepEqual(diff.files.map(f => [f.path, f.additions, f.deletions]), [['src/math.js', 1, 1]])
    assert.ok(diff.diff.includes('-  return a - b\n+  return a + b'))
    const status = await ws.gitStatus()
    assert.deepEqual(status.modified, ['src/math.js'])
    const test = await ws.runCommand('npm test')
    assert.equal(test.exitCode, 0)
    assert.match(await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8'), /return a \+ b/)
  })

  it('never touched the BLUSWAN tree and issued no git write operations', () => {
    assert.ok(!fx.root.startsWith(process.cwd()))
    const shellCommands = runtimeShellCommands(runtime.getSession(session.id))
    assert.ok(shellCommands.every(c => c === 'npm test'))
  })
})

function runtimeShellCommands(session) {
  return session.toolCalls.filter(c => c.name === 'shell').map(c => c.input.command)
}
