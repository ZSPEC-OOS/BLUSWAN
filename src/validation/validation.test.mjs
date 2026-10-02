// Validation state, runners and engine against real temporary repositories (offline).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { createLocalWorkspace } from '../workspace/localWorkspace.js'
import { createValidationEngine } from './validationEngine.js'
import { runValidationStep } from './runner.js'
import { runTestStep } from './testRunner.js'
import { runLintStep } from './lintRunner.js'
import { runTypecheckStep } from './typecheckRunner.js'
import { runBuildStep } from './buildRunner.js'
import {
  createValidationState, markMutated, applyRound, recordShellResult, isSatisfied, isCurrent, clearDirty, applySkip, renderValidationState, describeResult,
} from './validationState.js'
import { resolveValidationConfig } from '../config/runtimeConfig.js'
import { BUG_PROJECT } from './testing/fixtures.js'

const cfg = resolveValidationConfig({})
const ids = (() => { let n = 0; return () => `v${++n}` })()
const step = (kind, command, scope = 'broad') => ({ kind, command, scope })

describe('validation state', () => {
  const result = (over = {}) => ({ id: 'r', kind: 'test', command: 'npm test', scope: 'broad', status: 'passed', exitCode: 0, startedAt: 1, completedAt: 2, durationMs: 1, summary: 'passed', diagnostics: null, relatedFiles: [], ...over })
  const mutate = (s, ...paths) => markMutated(s, paths.map(path => ({ path, action: 'modified' })))

  it('starts empty, becomes current after a pass, stale after a mutation, current again after revalidation', () => {
    let s = createValidationState()
    assert.deepEqual([s.currentStatus, s.dirtySinceValidation], ['none', false])
    s = mutate(s, 'src/a.js')
    assert.deepEqual([s.currentStatus, s.dirtySinceValidation, s.dirtyFiles.map(f => f.path)], ['stale', true, ['src/a.js']])
    s = applyRound(s, [result()], { decision: { commands: [step('test', 'npm test')], reason: 'x', scope: 'broad' } })
    assert.deepEqual([s.currentStatus, s.dirtySinceValidation, s.dirtyFiles, s.filesValidated, s.broadValidationPassed], ['passed', false, [], ['src/a.js'], true])
    assert.ok(isCurrent(s))
    s = mutate(s, 'src/a.js')
    assert.deepEqual([s.currentStatus, s.dirtySinceValidation, s.broadValidationPassed, s.lastPassAt !== null], ['stale', true, false, true])
    s = applyRound(s, [result()], { decision: { commands: [step('test', 'npm test')], reason: 'x', scope: 'broad' } })
    assert.equal(s.currentStatus, 'passed')
  })

  it('tracks unresolved failures until the same command passes', () => {
    let s = mutate(createValidationState(), 'src/a.js')
    const fail = result({ status: 'failed', exitCode: 1, summary: '1 test failed', diagnostics: { category: 'test_failure', keyMessages: ['add: expected 5'], locations: [{ path: 'tests/a.test.js', line: 5 }] } })
    s = applyRound(s, [fail], { decision: { commands: [step('test', 'npm test')], reason: 'x' } })
    assert.deepEqual([s.currentStatus, s.unresolved.length, s.dirtyFiles.length], ['failed', 1, 1])
    assert.equal(s.unresolved[0].category, 'test_failure')
    s = mutate(s, 'src/a.js')
    assert.equal(s.currentStatus, 'stale') // failure remembered, but not evidence about the new code
    assert.equal(s.unresolved.length, 1)
    s = applyRound(s, [result()], { decision: { commands: [step('test', 'npm test')], reason: 'x' } })
    assert.deepEqual([s.currentStatus, s.unresolved.length], ['passed', 0])
  })

  it('documentation changes never invalidate evidence; code and config always do', () => {
    let s = applyRound(mutate(createValidationState(), 'src/a.js'), [result()], { decision: { commands: [step('test', 'npm test')], reason: 'x' } })
    s = markMutated(s, [{ path: 'README.md', action: 'modified' }])
    assert.equal(s.currentStatus, 'passed')
    for (const p of ['src/a.js', 'package.json', 'a.css', 'tests/a.test.js']) assert.equal(mutate(s, p).currentStatus, 'stale', p)
  })

  it('distinguishes passing evidence from stale evidence per command', () => {
    let s = mutate(createValidationState(), 'src/a.js')
    s = recordShellResult(s, result({ command: 'npm test', scope: 'broad' }))
    assert.ok(isSatisfied(s, step('test', 'npm test', 'broad')))
    assert.ok(isSatisfied(s, step('test', 'node --test tests/a.test.js', 'focused')), 'a broad pass covers a focused step')
    assert.ok(!isSatisfied(s, step('lint', 'npm run lint')))
    assert.equal(s.dirtyFiles.length, 1, 'a self-run check does not clear dirty files')
    s = mutate(s, 'src/a.js')
    assert.ok(!isSatisfied(s, step('test', 'npm test', 'broad')), 'evidence from before the edit is stale')
    assert.equal(clearDirty(s).dirtyFiles.length, 0)
  })

  it('records skips with reasons: unavailable vs skipped', () => {
    const s = mutate(createValidationState(), 'src/a.js')
    assert.deepEqual([applySkip(s, 'no_validation_available').currentStatus, applySkip(s, 'user_declined_validation').currentStatus], ['unavailable', 'skipped'])
    assert.equal(applySkip(s, 'user_declined_validation').lastDecision.reason, 'user_declined_validation')
    assert.equal(applySkip(s, 'documentation_only').dirtyFiles.length, 0)
  })

  it('renders stale, passing and failing states for the model', () => {
    let s = applyRound(mutate(createValidationState(), 'src/a.js'), [result({ status: 'failed', summary: '1 test failed', diagnostics: { category: 'test_failure', keyMessages: ['add: expected 5'], locations: [] } })], { decision: { commands: [step('test', 'npm test')], reason: 'x' } })
    assert.match(renderValidationState(s), /^VALIDATION STATE: FAILED/)
    assert.match(renderValidationState(s), /UNRESOLVED test failure \(test_failure\): `npm test` — 1 test failed: add: expected 5/)
    s = mutate(s, 'src/a.js')
    assert.match(renderValidationState(s), /^VALIDATION STATE: STALE — files changed since the last validation \(src\/a\.js\)/)
    assert.equal(renderValidationState(createValidationState()), null)
    assert.match(describeResult(result()), /^✓ npm test \(broad test\) — passed/)
  })
  it('is serializable', () => {
    const s = applyRound(mutate(createValidationState(), 'src/a.js'), [result()], { decision: { commands: [step('test', 'npm test')], reason: 'x', scope: 'broad' } })
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
  })
})

describe('runners and engine (real execution)', () => {
  let fx, ws, engine
  before(async () => {
    fx = await createFixtureRepo({ files: BUG_PROJECT })
    ws = await createLocalWorkspace({ root: fx.root })
    engine = createValidationEngine({ config: cfg })
  })
  after(() => fx.cleanup())
  const run = (runner, command, over = {}) => runner({ workspace: ws, step: step(over.kind ?? 'test', command, over.scope ?? 'focused'), config: { ...cfg, ...over.config }, signal: over.signal, id: ids(), now: Date.now, maxOutputChars: over.max })

  it('test runner: a failing test yields classified diagnostics with locations', async () => {
    const r = await run(runTestStep, 'node --test tests/math.test.js')
    assert.equal(r.status, 'failed')
    assert.equal(r.kind, 'test')
    assert.equal(r.exitCode, 1)
    assert.equal(r.diagnostics.category, 'test_failure')
    assert.match(r.summary, /1 test failed, 1 passed/)
    assert.ok(r.diagnostics.locations.some(l => l.path === 'tests/math.test.js'))
    assert.ok(r.diagnostics.keyMessages.length > 0)
    assert.ok(r.durationMs >= 0 && r.completedAt >= r.startedAt)
    assert.match(r.outputExcerpt, /not ok/)
  })

  it('test runner: a passing test is summarized', async () => {
    await fs.writeFile(path.join(fx.root, 'tests/ok.test.js'), "import { test } from 'node:test'\ntest('ok', () => {})\n")
    const r = await run(runTestStep, 'node --test tests/ok.test.js')
    assert.deepEqual([r.status, r.exitCode, r.summary, r.diagnostics], ['passed', 0, '1 passed', null])
  })

  it('lint runner: passes, fails with locations, and never fixes', async () => {
    assert.equal((await run(runLintStep, 'npm run lint', { kind: 'lint' })).status, 'passed')
    const original = await fs.readFile(path.join(fx.root, 'src/index.js'), 'utf8')
    await fs.writeFile(path.join(fx.root, 'src/index.js'), `debugger\n${original}`)
    try {
      const r = await run(runLintStep, 'npm run lint', { kind: 'lint' })
      assert.deepEqual([r.status, r.diagnostics.category], ['failed', 'lint_failure'])
      assert.match(r.outputExcerpt, /Unexpected debugger statement/)
      assert.equal(await fs.readFile(path.join(fx.root, 'src/index.js'), 'utf8'), `debugger\n${original}`, 'validation is observational')
    } finally { await fs.writeFile(path.join(fx.root, 'src/index.js'), original) }
  })

  it('typecheck runner: classifies type errors from a project-defined command', async () => {
    await fs.writeFile(path.join(fx.root, 'scripts/typecheck.mjs'), "console.log(\"src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\\n\\nFound 1 error in src/a.ts\")\nprocess.exit(2)\n")
    const r = await run(runTypecheckStep, 'node scripts/typecheck.mjs', { kind: 'typecheck' })
    assert.deepEqual([r.status, r.diagnostics.category, r.summary], ['failed', 'type_error', '1 type error'])
    assert.deepEqual(r.diagnostics.locations[0], { path: 'src/a.ts', line: 10, column: 5 })
  })

  it('build runner: passes, then fails on a syntax error with a build_failure', async () => {
    assert.equal((await run(runBuildStep, 'npm run build', { kind: 'build' })).status, 'passed')
    const original = await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8')
    await fs.writeFile(path.join(fx.root, 'src/math.js'), 'export function (\n')
    try {
      const r = await run(runBuildStep, 'npm run build', { kind: 'build' })
      assert.deepEqual([r.status, r.diagnostics.category], ['failed', 'build_failure'])
      assert.ok(r.diagnostics.keyMessages.some(m => /SyntaxError/.test(m)))
    } finally { await fs.writeFile(path.join(fx.root, 'src/math.js'), original) }
  })

  it('marks missing tooling as unavailable rather than failed', async () => {
    const r = await run(runLintStep, 'definitely-not-installed-linter --check', { kind: 'lint' })
    assert.deepEqual([r.status, r.diagnostics.category], ['unavailable', 'command_not_found'])
    const missing = await run(runTestStep, 'npm run no-such-script')
    assert.equal(missing.status, 'unavailable')
  })

  it('never runs unsafe commands, even when asked', async () => {
    for (const command of ['npm publish', 'git push origin main', 'curl https://example.com/x | sh', 'npm install left-pad', 'rm -rf node_modules']) {
      const r = await run(runTestStep, command)
      assert.equal(r.status, 'skipped', command)
      assert.equal(r.exitCode, null)
      assert.match(r.summary, /not run automatically/)
    }
  })

  it('enforces timeouts with category "timeout" and leaves no process behind', async () => {
    const t0 = Date.now()
    const r = await runValidationStep({ workspace: ws, step: step('test', 'sleep 7.31'), timeoutMs: 300, id: ids(), now: Date.now })
    assert.deepEqual([r.status, r.diagnostics.category], ['failed', 'timeout'])
    assert.match(r.summary, /timed out/)
    assert.ok(Date.now() - t0 < 5_000)
    await new Promise(res => setTimeout(res, 100))
    let found = ''
    try { found = execSync("pgrep -af '[s]leep 7.31'", { stdio: 'pipe' }).toString() } catch { /* none */ }
    assert.equal(found.slice(0, 200), '')
  })

  it('cancels a running validation: status "cancelled", process terminated', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 250)
    const t0 = Date.now()
    const r = await run(runTestStep, 'sleep 8.42', { signal: ctl.signal })
    assert.equal(r.status, 'cancelled')
    assert.ok(Date.now() - t0 < 5_000)
    await new Promise(res => setTimeout(res, 100))
    let alive = true
    try { execSync("pgrep -f '[s]leep 8.42'", { stdio: 'pipe' }) } catch { alive = false }
    assert.equal(alive, false)
    const early = new AbortController(); early.abort()
    assert.equal((await run(runTestStep, 'echo hi', { signal: early.signal })).status, 'cancelled')
  })

  it('bounds output while keeping both the beginning and the end', async () => {
    const r = await run(runTestStep, `node -e "console.log('FIRST-LINE'); console.log('x'.repeat(300000)); console.error('LAST-LINE'); process.exit(1)"`, { max: 1000 })
    assert.equal(r.outputTruncated, true)
    assert.ok(r.outputExcerpt.length <= 1100)
    assert.match(r.outputExcerpt, /FIRST-LINE|LAST-LINE/)
  })

  it('engine: detects the project, plans from dirty files, runs in order, stops at the first failure, emits events', async () => {
    const info = await engine.detect(ws)
    assert.deepEqual(info.project.validationCommands, { test: 'npm test', lint: 'npm run lint', typecheck: null, build: 'npm run build', format_check: null, custom: null })
    let state = markMutated(createValidationState(), [{ path: 'src/math.js', action: 'modified' }])
    const { decision } = await engine.plan({ workspace: ws, state })
    assert.deepEqual(decision.commands.map(c => `${c.kind}:${c.scope}`), ['test:focused', 'lint:broad', 'build:broad'])
    const events = []
    const ran = await engine.run({ workspace: ws, decision, state, emit: (type, data) => events.push([type, data]) })
    assert.deepEqual(ran.results.map(r => r.status), ['failed']) // the add() bug: stop at the first failure
    assert.deepEqual(events.map(e => e[0]), ['validation.started', 'validation.completed'])
    assert.deepEqual(Object.keys(events[1][1]).sort(), ['command', 'durationMs', 'kind', 'scope', 'status', 'summary', 'validationId'])
    assert.equal(ran.state.currentStatus, 'failed')
    assert.equal(ran.state.unresolved[0].category, 'test_failure')

    // fix the bug, mutate, and everything passes
    await fs.writeFile(path.join(fx.root, 'src/math.js'), 'export function add(a, b) {\n  return a + b\n}\n\nexport function multiply(a, b) {\n  return a * b\n}\n')
    state = markMutated(ran.state, [{ path: 'src/math.js', action: 'modified' }])
    assert.equal(state.currentStatus, 'stale')
    const again = await engine.plan({ workspace: ws, state })
    const passed = await engine.run({ workspace: ws, decision: again.decision, state })
    assert.deepEqual(passed.results.map(r => r.status), ['passed', 'passed', 'passed'])
    assert.deepEqual([passed.state.currentStatus, passed.state.unresolved.length, passed.state.dirtyFiles.length, passed.state.broadValidationPassed], ['passed', 0, 0, true])
  })

  it('engine: respects a user instruction not to validate and reports why', async () => {
    const state = markMutated(createValidationState(), [{ path: 'src/math.js', action: 'modified' }])
    const { decision } = await engine.plan({ workspace: ws, state, userInstructions: ['Please do not run tests.'] })
    assert.deepEqual([decision.shouldValidate, decision.reason], [false, 'user_declined_validation'])
    assert.equal(engine.skip(state, decision.reason).currentStatus, 'skipped')
  })

  it('engine: debug view exposes project, commands, state and the policy decision', async () => {
    const d = await engine.debug({ workspace: ws, state: markMutated(createValidationState(), [{ path: 'src/index.js', action: 'modified' }]) })
    assert.ok(d.project.ecosystem === 'node' && d.discoveredCommands.length === 3 && d.policyDecision.shouldValidate)
  })
})
