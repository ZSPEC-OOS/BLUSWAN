import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseOutput } from './resultParser.js'
import { classifyFailure, FAILURE_CATEGORIES } from './failureClassifier.js'

const TAP_FAIL = `TAP version 13
# Subtest: add
not ok 1 - add
  ---
  duration_ms: 0.8
  type: 'test'
  location: '/work/repo/tests/math.test.js:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    -1 !== 5
    
  code: 'ERR_ASSERTION'
  expected: 5
  actual: -1
  ...
ok 2 - multiply
1..2
# tests 2
# pass 1
# fail 1
`
const ESLINT = `/work/repo/src/a.js
  3:7   error    'x' is assigned a value but never used  no-unused-vars
  9:1   warning  Unexpected console statement            no-console

✖ 2 problems (1 error, 1 warning)
`
const TSC = `src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(3,1): error TS2304: Cannot find name 'foo'.

Found 2 errors in 2 files.
`
const JEST = `FAIL tests/auth.test.js
  ● refresh › serializes calls

    expect(received).toBe(expected)
    Expected: 1
    Received: 2

      at Object.<anonymous> (tests/auth.test.js:84:20)

Tests:       1 failed, 17 passed, 18 total
`
const PYTEST = `FAILED tests/test_auth.py::test_refresh - AssertionError: assert 2 == 1
=========== 1 failed, 4 passed in 0.12s ===========
`
const BUILD = `vite v7.3.1 building for production...
✗ Build failed in 120ms
error during build:
src/App.jsx:12:3: ERROR: Could not resolve "./Missing"
`

describe('result parser', () => {
  it('parses node:test (TAP) failures with messages and locations', () => {
    const p = parseOutput('test', TAP_FAIL, { root: '/work/repo' })
    assert.deepEqual([p.counts.passed, p.counts.failed, p.counts.total], [1, 1, 2])
    assert.match(p.keyMessages[0], /add/)
    assert.deepEqual(p.locations[0], { path: 'tests/math.test.js', line: 5, column: 1 })
  })
  it('parses jest-style summaries and stack locations', () => {
    const p = parseOutput('test', JEST)
    assert.deepEqual([p.counts.failed, p.counts.passed, p.counts.total], [1, 17, 18])
    assert.ok(p.locations.some(l => l.path === 'tests/auth.test.js' && l.line === 84))
    assert.ok(p.keyMessages.some(m => /refresh/.test(m)))
  })
  it('parses pytest summaries', () => {
    const p = parseOutput('test', PYTEST)
    assert.deepEqual([p.counts.failed, p.counts.passed], [1, 4])
    assert.match(p.keyMessages[0], /tests\/test_auth\.py::test_refresh/)
  })
  it('parses ESLint stylish output', () => {
    const p = parseOutput('lint', ESLINT, { root: '/work/repo' })
    assert.deepEqual([p.counts.errors, p.counts.warnings], [1, 1])
    assert.match(p.keyMessages[0], /src\/a\.js:3 'x' is assigned a value but never used \(no-unused-vars\)/)
    assert.deepEqual(p.locations[0], { path: 'src/a.js', line: 3, column: 7 })
  })
  it('parses TypeScript errors in both formats', () => {
    const p = parseOutput('typecheck', TSC)
    assert.equal(p.counts.errors, 2)
    assert.match(p.keyMessages[0], /src\/a\.ts:10 TS2322/)
    assert.deepEqual(parseOutput('typecheck', "src/c.ts:4:2 - error TS2345: bad arg").locations[0], { path: 'src/c.ts', line: 4, column: 2 })
  })
  it('parses build errors', () => {
    const p = parseOutput('build', BUILD)
    assert.ok(p.counts.errors >= 1)
    assert.deepEqual(p.locations[0], { path: 'src/App.jsx', line: 12, column: 3 })
  })
  it('strips ANSI colors and tolerates garbage', () => {
    assert.equal(parseOutput('test', '\u001b[31mnot ok 1 - x\u001b[0m\n# fail 1').counts.failed, 1)
    assert.deepEqual(parseOutput('test', '').keyMessages, [])
    assert.deepEqual(parseOutput('custom', 'nothing relevant').locations, [])
  })
})

describe('failure classifier', () => {
  const c = (o) => classifyFailure({ exitCode: 1, ...o })
  it('classifies test failures with a summary and locations', () => {
    const r = c({ kind: 'test', stdout: TAP_FAIL, root: '/work/repo' })
    assert.equal(r.category, 'test_failure')
    assert.equal(r.summary, '1 test failed, 1 passed')
    assert.equal(r.locations[0].path, 'tests/math.test.js')
    assert.ok(r.keyMessages.length)
  })
  it('classifies lint, type and build failures', () => {
    assert.deepEqual([c({ kind: 'lint', stdout: ESLINT }).category, c({ kind: 'lint', stdout: ESLINT }).summary], ['lint_failure', '1 lint error, 1 warnings'])
    assert.deepEqual([c({ kind: 'typecheck', stdout: TSC }).category, c({ kind: 'typecheck', stdout: TSC }).summary], ['type_error', '2 type errors'])
    assert.equal(c({ kind: 'build', stderr: BUILD }).category, 'build_failure')
    assert.equal(c({ kind: 'test', stdout: TSC }).category, 'type_error') // a compiler error inside a test run
  })
  it('separates missing dependencies from code errors', () => {
    const dep = c({ kind: 'test', stderr: "Error: Cannot find module 'lodash'\n    at Function.Module._resolveFilename" })
    assert.deepEqual([dep.category, dep.summary], ['dependency_missing', 'missing dependency: lodash'])
    assert.equal(c({ kind: 'test', stderr: "ModuleNotFoundError: No module named 'requests'" }).category, 'dependency_missing')
    assert.notEqual(c({ kind: 'test', stderr: "Error: Cannot find module './helpers.js'" }).category, 'dependency_missing')
  })
  it('detects missing commands, scripts and configuration problems', () => {
    assert.equal(c({ kind: 'lint', exitCode: 127, stderr: 'sh: 1: eslint: not found' }).category, 'command_not_found')
    assert.equal(c({ kind: 'test', stderr: 'npm ERR! Missing script: "test"' }).category, 'configuration_error')
    assert.equal(c({ kind: 'typecheck', stdout: 'error TS5083: Cannot read file tsconfig.json' }).category, 'configuration_error')
    assert.equal(c({ kind: 'test', spawnError: 'spawn ENOENT', exitCode: null }).category, 'command_not_found')
  })
  it('detects timeouts, crashes and environment errors', () => {
    assert.equal(c({ kind: 'test', timedOut: true, exitCode: null }).category, 'timeout')
    assert.equal(c({ kind: 'test', stderr: 'Segmentation fault (core dumped)' }).category, 'runtime_crash')
    assert.equal(c({ kind: 'test', stderr: 'Error: listen EADDRINUSE: address already in use :::3000' }).category, 'environment_error')
  })
  it('falls back sensibly', () => {
    assert.equal(c({ kind: 'test', stdout: 'weird' }).category, 'test_failure')
    assert.equal(c({ kind: 'custom', stdout: 'weird' }).category, 'unknown')
    for (const k of ['test', 'lint', 'build', 'typecheck', 'custom']) assert.ok(FAILURE_CATEGORIES.includes(c({ kind: k, stdout: 'x' }).category))
  })
  it('only uses the documented categories', () => assert.equal(FAILURE_CATEGORIES.length, 11))
})
