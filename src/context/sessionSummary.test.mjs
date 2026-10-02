import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionSummary, observeUserMessage, observeToolResult, observeFolded, applySummarizerPatch, renderSummary,
  extractConstraints, mergeRanges, isValidationCommand,
} from './sessionSummary.js'
import { readResult, shellResult, patchResult, failure } from './testing/simulator.js'

const obs = (s, name, input, result, now = 10) => observeToolResult(s, { call: { name, input }, result, now })

describe('session summary', () => {
  it('captures the goal once and tracks the current objective', () => {
    let s = createSessionSummary(1)
    s = observeUserMessage(s, { id: 'u1', content: 'Fix the authentication refresh race and add regression coverage.' }, 2)
    s = observeUserMessage(s, { id: 'u2', content: 'Now verify the concurrent refresh timeout cleanup.' }, 3)
    assert.match(s.goal, /authentication refresh race/)
    assert.match(s.currentObjective, /timeout cleanup/)
    assert.equal(s.lastUpdatedAt, 3)
  })

  it('extracts standing constraints as decisions, with the latest statement last', () => {
    assert.deepEqual(extractConstraints('Refactor auth. Do not change the AuthProvider public API. Use the server endpoint rather than direct Firebase access.'),
      ['Do not change the AuthProvider public API.', 'Use the server endpoint rather than direct Firebase access.'])
    let s = createSessionSummary(1)
    s = observeUserMessage(s, { id: 'u1', content: 'Keep the existing public API.' }, 2)
    s = observeUserMessage(s, { id: 'u2', content: 'Never touch the database schema.' }, 3)
    s = observeUserMessage(s, { id: 'u3', content: 'Keep the existing public API.' }, 4)
    assert.deepEqual(s.decisions.map(d => d.text), ['Never touch the database schema.', 'Keep the existing public API.'])
  })

  it('tracks files inspected with merged ranges and redundant rereads', () => {
    let s = createSessionSummary(1)
    s = obs(s, 'read_file', { path: 'src/a.js' }, readResult('src/a.js', 'x\n'.repeat(99)))
    s = obs(s, 'read_file', { path: 'src/a.js' }, readResult('src/a.js', 'x\n'.repeat(99)))
    s = obs(s, 'read_file', { path: 'src/a.js' }, readResult('src/a.js', 'y\n'.repeat(49), { startLine: 100 }))
    const f = s.filesInspected[0]
    assert.deepEqual(f.ranges, [[1, 149]])
    assert.deepEqual([f.readCount, f.repeatReads], [3, 1])
    assert.deepEqual(mergeRanges([[5, 9], [1, 3], [4, 4], [20, 25]]), [[1, 9], [20, 25]])
  })

  it('tracks files changed and whether they were validated afterwards', () => {
    let s = createSessionSummary(1)
    s = obs(s, 'read_file', { path: 'src/a.js' }, readResult('src/a.js', 'x'))
    s = obs(s, 'apply_patch', {}, patchResult('src/a.js'))
    assert.deepEqual(s.filesChanged.map(f => [f.path, f.action, f.validatedSinceChange]), [['src/a.js', 'modified', false]])
    assert.equal(s.filesInspected[0].modifiedSince, true)
    s = obs(s, 'shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 0 }))
    assert.equal(s.filesChanged[0].validatedSinceChange, true)
    s = obs(s, 'apply_patch', {}, patchResult('src/a.js'))
    assert.equal(s.filesChanged[0].validatedSinceChange, false) // a new change invalidates the earlier pass
  })

  it('records commands, validations, and unresolved failures until the same command passes', () => {
    let s = createSessionSummary(1)
    s = obs(s, 'apply_patch', {}, patchResult('src/a.js'))
    s = obs(s, 'shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 1, stderr: 'AssertionError: expected refresh call count 1, received 2' }), 20)
    assert.deepEqual(s.commandsRun.map(c => [c.command, c.exitCode, c.status, c.relatedFiles]), [['npm test', 1, 'failed', ['src/a.js']]])
    assert.equal(s.unresolvedIssues.length, 1)
    assert.match(s.unresolvedIssues[0].message, /expected refresh call count 1, received 2/)
    s = obs(s, 'shell', { command: 'ls' }, shellResult('ls', { exitCode: 0 })) // unrelated command does not resolve it
    assert.equal(s.unresolvedIssues.length, 1)
    s = obs(s, 'shell', { command: 'npm test' }, shellResult('npm test', { exitCode: 0 }), 30)
    assert.equal(s.unresolvedIssues.length, 0)
    assert.equal(s.resolvedIssues.length, 1)
    assert.deepEqual(s.validations.map(v => [v.command, v.status]), [['npm test', 'passed']])
  })

  it('records tool errors and resolves them when the same call later succeeds', () => {
    let s = createSessionSummary(1)
    s = obs(s, 'read_file', { path: 'src/typo.js' }, failure('read_file', 'file_not_found', 'File not found: src/typo.js'))
    assert.deepEqual(s.errorsEncountered.map(e => [e.tool, e.code, e.resolved]), [['read_file', 'file_not_found', false]])
    s = obs(s, 'read_file', { path: 'src/typo.js' }, readResult('src/typo.js', 'ok'))
    assert.equal(s.errorsEncountered[0].resolved, true)
  })

  it('classifies validation commands', () => {
    for (const c of ['npm test', 'npm run lint', 'node --test x', 'pytest -q', 'tsc --noEmit', 'cargo test', 'go vet ./...']) assert.ok(isValidationCommand(c), c)
    for (const c of ['ls -la', 'cat package.json', 'git status']) assert.ok(!isValidationCommand(c), c)
  })

  it('updates incrementally: folding bumps the revision and keeps a digest of earlier requests', () => {
    let s = createSessionSummary(1)
    s = observeUserMessage(s, { id: 'u1', content: 'First task' }, 2)
    const s2 = observeFolded(s, [{ id: 'u1', role: 'user', content: 'First task' }, { id: 'a1', role: 'assistant', content: 'done' }], 5)
    assert.deepEqual([s2.revision, s2.lastCompactedMessageId, s2.userRequests.map(r => r.text)], [1, 'a1', ['First task']])
    const s3 = observeFolded(s2, [{ id: 'u2', role: 'user', content: 'Second' }], 6)
    assert.equal(s3.revision, 2)
    assert.equal(s3.goal, s.goal) // never rebuilt from scratch
    assert.equal(observeFolded(s3, [], 7), s3)
  })

  it('merges model-assisted decisions and facts without duplicates', () => {
    let s = createSessionSummary(1)
    s = applySummarizerPatch(s, { decisions: ['Keep API stable'], importantFacts: ['Tests live in tests/'] }, 2)
    s = applySummarizerPatch(s, { decisions: ['keep api stable'], importantFacts: ['Tests live in tests/'] }, 3)
    assert.deepEqual([s.decisions.length, s.importantFacts.length], [1, 1])
  })

  it('is plain serializable data', () => {
    let s = observeUserMessage(createSessionSummary(1), { id: 'u', content: 'Do not break things here.' }, 2)
    s = obs(s, 'apply_patch', {}, patchResult('a.js'))
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
  })

  describe('rendering', () => {
    function rich() {
      let s = observeUserMessage(createSessionSummary(1), { id: 'u1', content: 'Fix authentication refresh race and add regression coverage. Do not change the AuthProvider public API.' }, 2)
      s = obs(s, 'read_file', { path: 'src/auth.js' }, readResult('src/auth.js', 'x\n'.repeat(219)))
      s = obs(s, 'apply_patch', {}, patchResult('src/auth.js', 'tests/auth.test.js'))
      s = obs(s, 'shell', { command: 'npm test -- auth' }, shellResult('npm test -- auth', { exitCode: 1, stdout: 'not ok 1 - concurrent refresh timeout' }))
      return s
    }
    it('renders goal, decisions, changed files, validation and unresolved issues', () => {
      const r = renderSummary(rich())
      assert.match(r.text, /^SESSION SUMMARY \(revision 0\)/)
      for (const re of [/Goal:\n.*authentication refresh race/, /Do not change the AuthProvider public API/, /src\/auth\.js \(modified, not validated since\)/,
        /Unresolved issues:\n.*npm test -- auth.* failing: .*concurrent refresh timeout/, /Validation:\n- `npm test -- auth`: failed \(exit 1\)/, /src\/auth\.js \(modified since read\)/]) {
        assert.match(r.text, re)
      }
    })
    it('drops optional sections first when over budget, keeping essential state', () => {
      const s = rich()
      const full = renderSummary(s, { maxTokens: 10_000 })
      const core = renderSummary(s, { maxTokens: full.tokens - 5 })
      assert.equal(full.level, 'full')
      assert.equal(core.level, 'core')
      assert.ok(!/Files inspected/.test(core.text) && /Files changed/.test(core.text) && /Unresolved issues/.test(core.text))
      const tiny = renderSummary(s, { maxTokens: 60 })
      assert.ok(tiny.tokens <= 60 + 5)
      assert.match(tiny.text, /Goal/)
    })
    it('returns null when there is nothing to report', () => {
      assert.equal(renderSummary(createSessionSummary(1)), null)
      assert.equal(renderSummary(null), null)
    })
  })
})
