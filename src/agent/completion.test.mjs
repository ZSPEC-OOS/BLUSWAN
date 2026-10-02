// Completion grounded in validation evidence. Real runtime, session manager, context engine,
// tool executor, validation engine and workspace; only the model is scripted.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from './testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'
import { BUG_PROJECT, NO_VALIDATION_PROJECT } from '../validation/testing/fixtures.js'
import { checkClaims } from './claimChecker.js'
import { decideRecovery, createRunCounters } from './recovery.js'

const patchTo = (from, to) => `--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a ${from} b\n+  return a ${to} b\n }\n`
const WRONG = patchTo('-', '*')
const RIGHT_FROM_WRONG = patchTo('*', '+')
const FIX = patchTo('-', '+')
const addBody = (op) => `export function add(a, b) {\n  return a ${op} b\n}\n\nexport function multiply(a, b) {\n  return a * b\n}\n`

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

async function setup({ files = BUG_PROJECT, turns, config = {}, user = 'Fix add() in src/math.js.' } = {}) {
  const fx = await createFixtureRepo({ files })
  cleanups.push(() => fx.cleanup())
  const wm = createNodeWorkspaceManager()
  const requests = []
  const provider = createFakeProvider({ respond: (req, n) => { requests.push(req); const t = turns[n - 1]; if (!t) throw new Error(`script exhausted at request ${n}`); return t(req, n) } })
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([provider]), workspaces: wm, sleep: async () => {},
    config: { ...loadRuntimeConfig({}), maxTurns: 40, ...config },
  })
  const ws = await wm.openWorkspace({ root: fx.root })
  const session = runtime.startSession({ workspaceId: ws.id, model: { provider: 'fake', model: 'scripted' } })
  const events = []
  runtime.subscribe(session.id, e => events.push(e))
  const send = (text = user) => runtime.sendMessage(session.id, text)
  const lastTool = (req) => req.messages.at(-1)
  return { fx, ws, runtime, session, events, requests, provider, send, lastTool, types: () => events.map(e => e.type) }
}
const valEvents = (events) => events.filter(e => e.type === 'validation.completed').map(e => [e.data.kind, e.data.status])
const run0 = (s) => s.runs.at(-1)

describe('completion grounded in validation evidence', () => {
  it('edit → validate → fail → feed diagnostics back → repair → revalidate → pass → grounded final (the key scenario)', async () => {
    const h = await setup({
      turns: [
        () => reply(say('Inspecting.'), call('c1', 'read_file', { path: 'src/math.js' })),
        () => reply(call('c2', 'apply_patch', { patch: WRONG })),
        () => reply(say('Fixed it.')), // completion candidate → runtime validates before accepting
        (req) => { // the model receives the failure evidence, classified
          const t = req.messages.at(-1)
          assert.equal(t.role, 'tool'); assert.equal(t.name, 'validation')
          assert.match(t.content, /Status: failed/)
          assert.match(t.content, /✗ node --test tests\/math\.test\.js \(focused test\) — FAILED \[test_failure\]: 1 test failed, 1 passed/)
          assert.match(t.content, /Locations: tests\/math\.test\.js/)
          assert.match(t.content, /UNRESOLVED/)
          assert.match(req.messages[0].content, /VALIDATION STATE: FAILED/) // enters the context at high priority
          return reply(call('c3', 'apply_patch', { patch: RIGHT_FROM_WRONG }))
        },
        () => reply(say('Now it is correct.')), // stale → revalidate
        (req) => { // pass evidence incl. git
          const t = req.messages.at(-1).content
          assert.match(t, /Status: passed/)
          assert.match(t, /COMPLETION EVIDENCE[\s\S]*src\/math\.js \(modified\)/)
          assert.match(t, /✓ node --test tests\/math\.test\.js \(focused test\)/)
          assert.match(t, /✓ npm run lint/); assert.match(t, /✓ npm run build/)
          assert.match(t, /Git:\n- 1 files changed \(\+1 −1\)/)
          return reply(say('Fixed add() in src/math.js. The tests, lint and build all pass.'))
        },
      ],
    })
    const done = await h.send()
    assert.equal(done.status, 'completed')
    assert.equal(h.requests.length, 6)
    assert.deepEqual(valEvents(h.events), [['test', 'failed'], ['test', 'passed'], ['lint', 'passed'], ['build', 'passed']])
    assert.deepEqual(h.events.filter(e => e.type === 'validation.started').map(e => e.data.command), ['node --test tests/math.test.js', 'node --test tests/math.test.js', 'npm run lint', 'npm run build'])
    const run = run0(done)
    assert.equal(run.outcome, 'success')
    assert.deepEqual(run.validation, {
      validationCommandsRun: 4, validationPasses: 3, validationFailures: 1, validationDurationMs: run.validation.validationDurationMs,
      recoveryRounds: 1, automaticRounds: 2, finalValidationStatus: 'passed', firstPassSuccess: false, repairSuccess: true, staleValidationPrevented: 0,
    })
    assert.equal(done.validation.currentStatus, 'passed')
    assert.deepEqual(done.validation.unresolved, [])
    assert.deepEqual(run.warnings, [])
    assert.equal(done.contextSummary.unresolvedIssues.length, 0)
    assert.match(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8'), /a \+ b/)
    // the session-completed event carries the outcome
    assert.equal(h.events.at(-1).type, 'session.completed')
    assert.deepEqual([h.events.at(-1).data.outcome, h.events.at(-1).data.runId], ['success', run.id])
    // every runtime-initiated call has a result, so history stays valid
    for (const m of done.messages.filter(x => x.toolCalls)) assert.ok(m.toolCalls.every(c => done.messages.some(t => t.toolCallId === c.id)))
  })

  it('does not accept earlier passing validation as proof after another edit', async () => {
    const h = await setup({
      turns: [
        () => reply(call('c1', 'apply_patch', { patch: FIX })),
        () => reply(say('Done.')), // → validation passes (round 1)
        () => reply(call('c2', 'write_file', { path: 'src/index.js', content: 'console.log("changed")\n' })), // edits again after the pass
        () => reply(say('All done, tests pass.')), // → must revalidate
        () => reply(say('Everything passes for the current code.')),
      ],
    })
    const done = await h.send()
    assert.equal(h.requests.length, 5)
    assert.equal(h.events.filter(e => e.type === 'validation.started').length, 6) // 3 checks in each of two rounds
    assert.equal(run0(done).validation.automaticRounds, 2)
    assert.equal(run0(done).validation.staleValidationPrevented, 1)
    assert.equal(run0(done).outcome, 'success')
    assert.equal(done.validation.currentStatus, 'passed')
  })

  it('stops automatic repair at the round limit, preserves evidence, and never reports success', async () => {
    const wrongOps = ['*', '/', '%']
    const turns = []
    wrongOps.forEach((op, i) => {
      turns.push(() => reply(call(`w${i}`, 'write_file', { path: 'src/math.js', content: addBody(op) })))
      turns.push(() => reply(say(`Attempt ${i + 1} done.`)))
    })
    turns.push((req) => {
      const t = req.messages.at(-1).content
      assert.match(t, /Automatic validation will not continue \(validation round limit reached\)/)
      assert.match(t, /UNRESOLVED: `node --test tests\/math\.test\.js` test_failure/)
      assert.match(req.messages[0].content, /VALIDATION STATE: FAILED/)
      return reply(say('I could not fix add(): the math test still fails after three attempts.'))
    })
    const h = await setup({ turns })
    const done = await h.send()
    assert.equal(h.requests.length, 7)
    assert.equal(h.events.filter(e => e.type === 'validation.started').length, 3, 'no fourth automatic round')
    assert.equal(done.status, 'completed') // the conversation stays usable...
    const run = run0(done)
    assert.equal(run.outcome, 'failed') // ...but the run is not a success
    assert.deepEqual([run.validation.automaticRounds, run.validation.validationFailures, run.validation.finalValidationStatus], [3, 3, 'failed'])
    assert.equal(done.validation.unresolved.length, 1)
    assert.equal(done.contextSummary.unresolvedIssues.length, 1)
    assert.equal(h.events.at(-1).data.outcome, 'failed')
  })

  it('flags an unsupported success claim after a failed run without rewriting the response', async () => {
    const h = await setup({
      turns: [
        () => reply(call('c1', 'write_file', { path: 'src/math.js', content: addBody('*') })),
        () => reply(say('Done.')), // validation fails
        () => reply(say('All tests pass now.')), // false claim, no code change since the failure
        () => reply(say('Actually, the test still fails and I did not fix it.')),
      ],
      config: { maxRecoveryRounds: 3 },
    })
    const done = await h.send()
    const claims = h.events.filter(e => e.type === 'completion.warning')
    assert.equal(done.messages.find(m => m.content === 'All tests pass now.') !== undefined, true, 'the response is never rewritten')
    assert.equal(run0(done).outcome, 'failed')
    // the false claim was intercepted before it became the final answer: evidence was presented instead
    assert.ok(h.requests[3].messages.at(-1).content.includes('will not be rerun automatically'))
    assert.equal(claims.length, 0)
  })

  it('does not rerun a failing check on unchanged code (no-progress)', async () => {
    const h = await setup({
      turns: [
        () => reply(call('c1', 'write_file', { path: 'src/math.js', content: addBody('*') })),
        () => reply(say('Done.')), // validate → fail
        () => reply(say('I think it is fine.')), // no change since failure → evidence, no rerun
        () => reply(say('The add test is still failing; I have not resolved it.')),
      ],
    })
    const done = await h.send()
    assert.equal(h.events.filter(e => e.type === 'validation.started').length, 1)
    assert.match(h.requests[3].messages.at(-1).content, /No code changed since the failing validation/)
    assert.equal(run0(done).outcome, 'failed')
    assert.equal(h.requests.length, 4)
  })

  it('counts a check the agent ran itself and only runs what is still missing', async () => {
    const h = await setup({
      turns: [
        () => reply(call('c1', 'apply_patch', { patch: FIX })),
        () => reply(call('c2', 'shell', { command: 'npm test' })),
        () => reply(say('Tests pass.')), // runtime still needs lint and build, not the test again
        () => reply(say('Fixed; tests, lint and build pass.')),
      ],
    })
    const done = await h.send()
    assert.deepEqual(h.events.filter(e => e.type === 'validation.started').map(e => e.data.command), ['npm run lint', 'npm run build'])
    assert.equal(run0(done).outcome, 'success')
    assert.deepEqual(run0(done).warnings, [])
  })

  it('lets the run finish when the project has no validation commands (state: unavailable)', async () => {
    const h = await setup({
      files: NO_VALIDATION_PROJECT,
      turns: [() => reply(call('c1', 'write_file', { path: 'src/app.js', content: 'export const x = 2\n' })), () => reply(say('Updated x.'))],
    })
    const done = await h.send('Set x to 2.')
    assert.equal(done.status, 'completed')
    assert.equal(h.requests.length, 2)
    assert.equal(h.events.filter(e => e.type.startsWith('validation.')).length, 0)
    assert.equal(done.validation.currentStatus, 'unavailable')
    assert.equal(done.validation.lastDecision.reason, 'no_validation_available')
    assert.equal(run0(done).outcome, 'success')
  })

  it('respects "do not run tests" and records that validation was skipped', async () => {
    const h = await setup({
      turns: [() => reply(call('c1', 'apply_patch', { patch: FIX })), () => reply(say('Fixed add(). I did not run the tests, as requested.'))],
    })
    const done = await h.send('Fix add() in src/math.js. Do not run tests.')
    assert.equal(h.events.filter(e => e.type.startsWith('validation.')).length, 0)
    assert.equal(done.validation.currentStatus, 'skipped')
    assert.equal(done.validation.lastDecision.reason, 'user_declined_validation')
    assert.equal(run0(done).outcome, 'success')
    assert.equal(h.requests.length, 2)
  })

  it('flags a validation claim made when no check ran', async () => {
    const h = await setup({
      turns: [() => reply(call('c1', 'apply_patch', { patch: FIX })), () => reply(say('Fixed add(). All tests pass.'))],
    })
    const done = await h.send('Fix add(). Do not run tests.')
    const w = h.events.filter(e => e.type === 'completion.warning')
    assert.equal(w.length, 1)
    assert.deepEqual([w[0].data.kind, w[0].data.claim], ['test', 'tests pass'])
    assert.equal(run0(done).outcome, 'warning')
    assert.equal(done.messages.at(-1).content, 'Fixed add(). All tests pass.')
  })

  it('never auto-runs a validation script that has external effects', async () => {
    const files = { ...BUG_PROJECT, 'package.json': JSON.stringify({ name: 'x', type: 'module', scripts: { test: "node -e \"require('fs').writeFileSync('pwned','x')\" && git push origin main", build: 'node scripts/build.mjs' } }) }
    const h = await setup({ files, turns: [() => reply(call('c1', 'apply_patch', { patch: FIX })), () => reply(say('Done.')), () => reply(say('Build passes.'))] })
    const done = await h.send()
    assert.deepEqual(h.events.filter(e => e.type === 'validation.started').map(e => e.data.command), ['npm run build'])
    await assert.rejects(fs.access(path.join(h.fx.root, 'pwned')))
    assert.equal(run0(done).outcome, 'success')
  })

  it('skips code validation for documentation-only changes', async () => {
    const h = await setup({ turns: [() => reply(call('c1', 'write_file', { path: 'README.md', content: '# Docs\n' })), () => reply(say('Updated the README.'))] })
    const done = await h.send('Update the README.')
    assert.equal(h.events.filter(e => e.type.startsWith('validation.')).length, 0)
    assert.equal(done.validation.lastDecision.reason, 'documentation_only')
    assert.equal(h.requests.length, 2)
  })

  it('considers broader checks when configuration changes', async () => {
    const pkg = JSON.stringify({ name: 'fixture', version: '1.0.1', type: 'module', scripts: JSON.parse(BUG_PROJECT['package.json']).scripts })
    const h = await setup({ turns: [() => reply(call('c1', 'write_file', { path: 'package.json', content: pkg })), () => reply(say('Bumped the version.')), () => reply(say('Done.'))] })
    const done = await h.send('Bump the version.')
    const cmds = h.events.filter(e => e.type === 'validation.started').map(e => e.data.command)
    assert.deepEqual(cmds, ['npm test', 'npm run lint', 'npm run build'].slice(0, 1)) // the failing add() test stops the round
    assert.equal(done.validation.lastDecision.reason, 'config_changed_and_test_command_available')
    assert.equal(done.validation.lastDecision.commands.length, 3)
  })

  it('cancels active validation: process killed, result cancelled, no recovery, run cancelled', async () => {
    const files = { ...BUG_PROJECT, 'package.json': JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'sleep 6.77' } }) }
    const h = await setup({ files, turns: [() => reply(call('c1', 'write_file', { path: 'src/a.js', content: 'export const a = 1\n' })), () => reply(say('Done.')), () => reply(say('unreachable'))] })
    const unsub = h.runtime.subscribe(h.session.id, e => { if (e.type === 'validation.started') setTimeout(() => h.runtime.cancelSession(h.session.id), 200) })
    const t0 = Date.now()
    const done = await h.send('Add a.js.')
    unsub()
    assert.ok(Date.now() - t0 < 6_000)
    assert.equal(done.status, 'cancelled')
    assert.equal(h.requests.length, 2) // no recovery turn
    assert.deepEqual(valEvents(h.events), [['test', 'cancelled']])
    assert.equal(run0(done).outcome, 'cancelled')
    assert.equal(done.validation.lastRoundStatus, 'cancelled')
    await new Promise(r => setTimeout(r, 100))
    let alive = true
    try { execSync("pgrep -f '[s]leep 6.77'", { stdio: 'pipe' }) } catch { alive = false }
    assert.equal(alive, false)
    // history stays valid: the runtime-initiated call has a result
    assert.ok(done.messages.some(m => m.role === 'tool' && m.name === 'validation'))
  })

  it('reports validation timeouts as failures with category "timeout"', async () => {
    const files = { ...BUG_PROJECT, 'package.json': JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'sleep 5.55' } }) }
    const h = await setup({
      files, config: { defaultTestTimeoutMs: 300, broadTestTimeoutMs: 300 },
      turns: [
        () => reply(call('c1', 'write_file', { path: 'src/a.js', content: 'export const a = 1\n' })), () => reply(say('Done.')),
        (req) => { assert.match(req.messages.at(-1).content, /FAILED \[timeout\]: timed out after 0s/); return reply(say('The test command times out; I cannot confirm it passes.')) },
        () => reply(say('The test command times out and I could not verify the change.')),
      ],
    })
    const done = await h.send('Add a.js.')
    assert.equal(done.validation.unresolved[0].category, 'timeout')
    assert.equal(done.status, 'completed')
    await new Promise(r => setTimeout(r, 100))
    let alive = true
    try { execSync("pgrep -f '[s]leep 5.55'", { stdio: 'pipe' }) } catch { alive = false }
    assert.equal(alive, false)
  })

  it('does not ask the model to repair what no edit can fix (missing tooling is "unavailable", not a failure)', async () => {
    const files = { ...BUG_PROJECT, 'package.json': JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'definitely-not-installed-runner' } }) }
    const h = await setup({ files, turns: [() => reply(call('c1', 'write_file', { path: 'src/a.js', content: 'export const a = 1\n' })), () => reply(say('Done.')), () => reply(say('Added a.js; the test tool is not installed so I could not run tests.'))] })
    const done = await h.send('Add a.js.')
    assert.deepEqual(valEvents(h.events), [['test', 'unavailable']])
    assert.equal(done.validation.unresolved.length, 0)
    assert.equal(run0(done).outcome, 'success')
  })

  it('can be switched off', async () => {
    const h = await setup({ config: { enableAutomaticValidation: false }, turns: [() => reply(call('c1', 'apply_patch', { patch: WRONG })), () => reply(say('Done.'))] })
    const done = await h.send()
    assert.equal(h.requests.length, 2)
    assert.equal(done.validation.lastDecision.reason, 'automatic_validation_disabled')
  })

  it('exposes the policy decision and discovered commands for debugging', async () => {
    const h = await setup({ turns: [() => reply(call('c1', 'apply_patch', { patch: WRONG })), () => reply(say('x'))], config: { enableAutomaticValidation: false } })
    await h.send()
    const dbg = await h.runtime.debugValidation(h.session.id)
    assert.equal(dbg.project.ecosystem, 'node')
    assert.deepEqual(dbg.discoveredCommands.map(c => c.command), ['npm test', 'npm run lint', 'npm run build'])
    assert.equal(dbg.runs.length, 1)
    assert.ok('policyDecision' in dbg && 'state' in dbg)
  })
})

describe('recovery policy', () => {
  const cfg = { maxRecoveryRounds: 3, maxAutomaticValidationRounds: 3 }
  const failed = (category) => [{ status: 'failed', diagnostics: { category } }]
  it('continues for repairable failures and stops at the limits', () => {
    const c = createRunCounters()
    assert.equal(decideRecovery({ results: failed('test_failure'), counters: c, config: cfg, mutationSeq: 1 }).action, 'continue')
    assert.equal(decideRecovery({ results: [{ status: 'passed' }], counters: c, config: cfg, mutationSeq: 1 }).reason, 'no_failure')
    assert.deepEqual(decideRecovery({ results: failed('test_failure'), counters: { ...c, validationRounds: 3 }, config: cfg, mutationSeq: 2 }), { action: 'stop', reason: 'validation_round_limit_reached' })
    assert.deepEqual(decideRecovery({ results: failed('test_failure'), counters: { ...c, recoveryRounds: 3 }, config: cfg, mutationSeq: 2 }), { action: 'stop', reason: 'recovery_limit_reached' })
  })
  it('stops when nothing can be repaired by editing, or no progress was made', () => {
    const c = createRunCounters()
    assert.equal(decideRecovery({ results: failed('dependency_missing'), counters: c, config: cfg, mutationSeq: 1 }).action, 'stop')
    assert.equal(decideRecovery({ results: failed('environment_error'), counters: c, config: cfg, mutationSeq: 1 }).reason, 'not_repairable_environment_error')
    assert.deepEqual(decideRecovery({ results: failed('test_failure'), counters: { ...c, sawFailure: true, lastFailureSeq: 4 }, config: cfg, mutationSeq: 4 }), { action: 'stop', reason: 'no_progress_since_last_failure' })
    assert.equal(decideRecovery({ results: failed('test_failure'), counters: { ...c, sawFailure: true, lastFailureSeq: 4 }, config: cfg, mutationSeq: 5 }).action, 'continue')
  })
})

describe('claim checker', () => {
  const state = (over = {}) => ({ results: [], mutationSeq: 1, validatedSeq: 1, unresolved: [], ...over })
  const passed = (kind) => ({ kind, status: 'passed', seq: 1 })
  it('accepts claims backed by current passing evidence', () => {
    assert.deepEqual(checkClaims('All tests pass, lint is clean, the build succeeds and type checking passes.', state({ results: ['test', 'lint', 'build', 'typecheck'].map(passed) })), [])
  })
  it('flags claims with no evidence, stale evidence, or an open failure', () => {
    assert.deepEqual(checkClaims('Tests pass and the build succeeds.', state({ results: [passed('test')] })).map(w => w.kind), ['build'])
    assert.equal(checkClaims('Tests pass.', state({ results: [{ ...passed('test'), seq: 0 }], mutationSeq: 1 })).length, 1)
    assert.match(checkClaims('Tests pass.', state({ results: [passed('test')], unresolved: [{ kind: 'test' }] }))[0].problem, /still failing/)
  })
  it('ignores negations and non-claims', () => {
    for (const t of ["I couldn't run the tests.", 'The tests did not pass.', 'I added a test for add().', 'Run the build to verify.', 'No tests were run.']) assert.deepEqual(checkClaims(t, state()), [], t)
  })
})
