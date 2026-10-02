import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyChange, findRelatedTests, planValidation, userDeclinesValidation } from './changedFileStrategy.js'
import { describeProject } from './projectDetector.js'
import { discoverValidationCommands } from './commandDiscovery.js'
import { resolveValidationConfig } from '../config/runtimeConfig.js'

const config = resolveValidationConfig({})
const project = describeProject({ rootFiles: ['package.json', 'package-lock.json'], packageJson: { scripts: { test: 'node --test', lint: 'eslint .', build: 'vite build' } } })
const { byKind } = discoverValidationCommands(project)
const files = new Set(['src/math.js', 'src/index.js', 'tests/math.test.js', 'src/ui/Button.css', 'README.md', 'package.json', 'src/auth/session.js', 'src/lib/util.js', 'tests/session.test.js'])
const plan = (changed, over = {}) => planValidation({ project, byKind, changed: changed.map(path => ({ path, action: 'modified' })), fileSet: files, config, ...over })
const kinds = (p) => p.commands.map(c => `${c.kind}:${c.scope}`)

describe('change classification', () => {
  it('classifies paths into docs/test/config/dependency/style/source', () => {
    const c = classifyChange
    assert.deepEqual(['README.md', 'docs/guide.md', 'CHANGELOG.md', 'notes.txt'].map(c), ['docs', 'docs', 'docs', 'docs'])
    assert.deepEqual(['tests/a.js', 'src/a.test.ts', 'src/__tests__/b.js', 'tests/test_x.py', 'pkg/x_test.go'].map(c), ['test', 'test', 'test', 'test', 'test'])
    assert.deepEqual(['package.json', 'tsconfig.build.json', 'vite.config.js', 'eslint.config.js', 'Cargo.toml', '.github/workflows/ci.yml'].map(c), Array(6).fill('config'))
    assert.deepEqual(['package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum'].map(c), Array(4).fill('dependency'))
    assert.deepEqual(['a.css', 'x/y.scss'].map(c), ['style', 'style'])
    assert.deepEqual(['src/app.js', 'lib/x.py', 'index.html', 'data.bin'].map(c), Array(4).fill('source'))
  })
})

describe('targeted test discovery', () => {
  it('finds conventionally named tests across layouts', () => {
    const fs = new Set(['tests/auth.test.js', 'src/auth.test.js', 'src/__tests__/auth.test.js', 'tests/other.test.js', 'tests/test_auth.py', 'pkg/auth_test.go', 'tests/auth.spec.ts'])
    assert.deepEqual(findRelatedTests('src/auth.js', fs), ['src/__tests__/auth.test.js', 'src/auth.test.js', 'tests/auth.spec.ts'])
    assert.deepEqual(findRelatedTests('src/auth.py', new Set(['tests/test_auth.py', 'tests/other.py'])), ['tests/test_auth.py'])
    assert.deepEqual(findRelatedTests('pkg/auth.go', new Set(['pkg/auth_test.go'])), ['pkg/auth_test.go'])
    assert.deepEqual(findRelatedTests('src/none.js', fs), [])
  })
  it('treats a changed test file as its own target', () => {
    assert.deepEqual(findRelatedTests('tests/a.test.js', new Set(['tests/a.test.js'])), ['tests/a.test.js'])
  })
  it('prefers the nearest directory', () => {
    const fs = new Set(['z/auth.test.js', 'src/auth/auth.test.js'])
    assert.equal(findRelatedTests('src/auth/auth.js', fs)[0], 'src/auth/auth.test.js')
  })
})

describe('validation policy', () => {
  it('runs focused validation for a source file with a related test, then static and build checks', () => {
    const p = plan(['src/math.js'])
    assert.equal(p.shouldValidate, true)
    assert.deepEqual(p.commands[0], { kind: 'test', command: 'node --test tests/math.test.js', scope: 'focused', source: 'package.json#scripts.test', reason: 'related_tests_found', relatedFiles: ['tests/math.test.js'] })
    assert.deepEqual(kinds(p), ['test:focused', 'lint:broad', 'build:broad'])
    assert.match(p.reason, /source_changed_and_test_command_available/)
  })
  it('falls back to the project test command when no related tests exist', () => {
    const p = plan(['src/lib/util.js'])
    assert.deepEqual(p.commands[0], { kind: 'test', command: 'npm test', scope: 'broad', source: 'package.json#scripts.test', reason: 'no_related_tests_found', relatedFiles: [] })
  })
  it('escalates to the full suite for significant or config changes', () => {
    assert.deepEqual(kinds(plan(['src/math.js', 'src/auth/session.js', 'src/lib/util.js'])), ['test:focused', 'lint:broad', 'test:broad', 'build:broad'])
    const cfg = plan(['package.json'])
    assert.ok(kinds(cfg).includes('build:broad'))
    assert.equal(cfg.categories.join(), 'config')
  })
  it('does not run unrelated suites for CSS-only changes', () => {
    assert.deepEqual(kinds(plan(['src/ui/Button.css'])), ['lint:broad', 'build:broad'])
  })
  it('only runs the affected tests for test-only changes', () => {
    assert.deepEqual(kinds(plan(['tests/math.test.js'])), ['test:focused', 'lint:broad'])
  })
  it('skips documentation-only and empty changes, recording why', () => {
    assert.deepEqual([plan(['README.md']).shouldValidate, plan(['README.md']).reason], [false, 'documentation_only'])
    assert.equal(plan([]).reason, 'no_changes')
    assert.equal(plan(['README.md', 'docs/a.md']).commands.length, 0)
  })
  it('skips when the user declines, validation is disabled, or the round limit is reached', () => {
    assert.equal(plan(['src/math.js'], { userInstructions: ['Fix add. Do not run tests.'] }).reason, 'user_declined_validation')
    assert.equal(plan(['src/math.js'], { config: { ...config, enableAutomaticValidation: false } }).reason, 'automatic_validation_disabled')
    assert.equal(plan(['src/math.js'], { roundsUsed: 3 }).reason, 'validation_round_limit_reached')
  })
  it('can disable broad validation', () => {
    assert.deepEqual(kinds(plan(['src/math.js', 'src/auth/session.js', 'src/lib/util.js'], { config: { ...config, enableBroadValidation: false } })), ['test:focused', 'lint:broad'])
  })
  it('reports no validation available when the project defines no checks', () => {
    const none = describeProject({ rootFiles: ['notes.txt'] })
    const p = planValidation({ project: none, byKind: discoverValidationCommands(none).byKind, changed: [{ path: 'a.js', action: 'modified' }], fileSet: new Set(), config })
    assert.deepEqual([p.shouldValidate, p.reason], [false, 'no_validation_available'])
  })
  it('adds a typecheck for typed projects', () => {
    const ts = describeProject({ rootFiles: ['package.json', 'tsconfig.json'], packageJson: { scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '5', vitest: '1' } } })
    const k = discoverValidationCommands(ts).byKind
    const p = planValidation({ project: ts, byKind: k, changed: [{ path: 'src/a.ts', action: 'modified' }], fileSet: new Set(['src/a.ts', 'src/a.test.ts']), config })
    assert.deepEqual(kinds(p), ['test:focused', 'typecheck:broad'])
    assert.equal(p.commands[0].command, 'npm test -- src/a.test.ts')
  })
  it('is explainable and deterministic', () => {
    const a = plan(['src/math.js']); const b = plan(['src/math.js'])
    assert.deepEqual(a, b)
    for (const c of a.commands) assert.ok(c.reason && c.source)
  })
  it('recognizes explicit user refusals only', () => {
    for (const t of ["Don't run the tests.", 'please skip tests', 'Do not run any tests', 'without running tests', 'no tests needed']) assert.ok(userDeclinesValidation([t]), t)
    for (const t of ['Run the tests after.', 'Add a test for add()', 'Fix the test runner']) assert.ok(!userDeclinesValidation([t]), t)
  })
})
