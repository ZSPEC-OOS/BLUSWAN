import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLocalWorkspace } from './localWorkspace.js'
import { createNodeWorkspaceManager } from './node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from './testing/fixtureRepo.js'
import { assertWorkspace } from './workspace.js'
import { loadRuntimeConfig, DEFAULT_LIMITS } from '../config/runtimeConfig.js'

const code = c => e => e?.code === c

describe('LocalWorkspace', () => {
  let fx, ws
  beforeEach(async () => { fx = await createFixtureRepo(); ws = await createLocalWorkspace({ root: fx.root }) })
  afterEach(() => fx.cleanup())

  it('implements the Workspace interface and records baseline metadata', () => {
    assertWorkspace(ws)
    assert.equal(ws.root, fx.root)
    assert.equal(ws.metadata.repository.isGitRepository, true)
    assert.equal(ws.metadata.baseline.branch, 'main')
    assert.match(ws.metadata.baseline.headSha, /^[0-9a-f]{40}$/)
    assert.equal(ws.metadata.baseline.initialStatus.clean, true)
  })

  it('detects repository metadata', () => {
    const r = ws.metadata.repository
    assert.deepEqual(r.manifests, ['package.json'])
    assert.equal(r.packageManager, 'npm')
    assert.equal(r.name, path.basename(fx.root))
  })

  it('rejects missing roots', async () => {
    await assert.rejects(createLocalWorkspace({ root: path.join(fx.root, 'nope') }), code('workspace_not_found'))
  })

  describe('readFile', () => {
    it('reads whole files and ranges', async () => {
      const all = await ws.readFile('src/math.js')
      assert.equal(all.totalLines, 7)
      assert.equal(all.content, (await fs.readFile(path.join(fx.root, 'src/math.js'), 'utf8')))
      const part = await ws.readFile('src/math.js', { startLine: 5, endLine: 6 })
      assert.deepEqual([part.startLine, part.endLine, part.content], [5, 6, 'export function multiply(a, b) {\n  return a * b\n'])
    })
    it('reports errors with codes', async () => {
      await assert.rejects(ws.readFile('nope.js'), code('file_not_found'))
      await assert.rejects(ws.readFile('src'), code('not_a_file'))
      await assert.rejects(ws.readFile('../x'), code('path_outside_workspace'))
      await assert.rejects(ws.readFile('src/math.js', { startLine: 99 }), code('invalid_input'))
      await assert.rejects(ws.readFile('src/math.js', { startLine: 3, endLine: 2 }), code('invalid_input'))
    })
    it('rejects binary files', async () => {
      await fs.writeFile(path.join(fx.root, 'bin.dat'), Buffer.from([1, 0, 2]))
      await assert.rejects(ws.readFile('bin.dat'), code('binary_file'))
    })
    it('truncates at line boundaries with a continuation hint', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxReadBytes: 40 } })
      const r = await small.readFile('src/math.js')
      assert.equal(r.truncated, true)
      assert.ok(Buffer.byteLength(r.content) <= 40)
      assert.equal(r.nextStartLine, r.endLine + 1)
      assert.ok(r.content.endsWith('\n'))
    })
    it('refuses files above maxFileBytes', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxFileBytes: 10 } })
      await assert.rejects(small.readFile('src/math.js'), code('output_limit_exceeded'))
    })
  })

  describe('writeFile / deleteFile', () => {
    it('creates, overwrites, and reports which', async () => {
      const c = await ws.writeFile('deep/er/x.txt', 'one')
      assert.deepEqual([c.created, c.overwritten, c.bytesWritten], [true, false, 3])
      const o = await ws.writeFile('deep/er/x.txt', 'twelve')
      assert.deepEqual([o.created, o.overwritten, o.bytesWritten], [false, true, 6])
      assert.equal(await fs.readFile(path.join(fx.root, 'deep/er/x.txt'), 'utf8'), 'twelve')
    })
    it('rejects traversal, protected paths, directories, and oversize content', async () => {
      await assert.rejects(ws.writeFile('../x', 'a'), code('path_outside_workspace'))
      await assert.rejects(ws.writeFile('/tmp/x', 'a'), code('path_outside_workspace'))
      await assert.rejects(ws.writeFile('.git/config', 'a'), code('permission_denied'))
      await assert.rejects(ws.writeFile('src', 'a'), code('not_a_file'))
      await assert.rejects(ws.writeFile('src/math.js/x', 'a'), code('not_a_directory'))
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxWriteBytes: 3 } })
      await assert.rejects(small.writeFile('x', 'toolong'), code('output_limit_exceeded'))
    })
    it('deletes files only', async () => {
      assert.deepEqual(await ws.deleteFile('src/index.js'), { path: 'src/index.js', deleted: true })
      assert.equal(await ws.exists('src/index.js'), false)
      await assert.rejects(ws.deleteFile('src/index.js'), code('file_not_found'))
      await assert.rejects(ws.deleteFile('src'), code('not_a_file'))
      await assert.rejects(ws.deleteFile('../x'), code('path_outside_workspace'))
      await assert.rejects(ws.deleteFile('.git/HEAD'), code('permission_denied'))
    })
    it('never writes through a symlink that escapes the workspace', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-out-'))
      try {
        await fs.symlink(outside, path.join(fx.root, 'escape'))
        await assert.rejects(ws.writeFile('escape/x.txt', 'a'), code('path_outside_workspace'))
        await assert.rejects(fs.access(path.join(outside, 'x.txt')))
      } finally { await fs.rm(outside, { recursive: true, force: true }) }
    })
  })

  describe('listDirectory / stat / exists', () => {
    it('lists the root and nested directories with stable ordering', async () => {
      const root = await ws.listDirectory('')
      assert.deepEqual(root.entries.map(e => [e.name, e.type]),
        [['.git', 'directory'], ['src', 'directory'], ['tests', 'directory'], ['package.json', 'file']])
      assert.equal(root.entries[0].ignored, true)
      const nested = await ws.listDirectory('src')
      assert.deepEqual(nested.entries.map(e => e.path), ['src/index.js', 'src/math.js'])
    })
    it('supports depth and rejects bad input', async () => {
      const deep = await ws.listDirectory('', { depth: 2 })
      assert.ok(deep.entries.some(e => e.path === 'src/math.js'))
      assert.ok(!deep.entries.some(e => e.path.startsWith('.git/')))
      await assert.rejects(ws.listDirectory('', { depth: 99 }), code('invalid_input'))
      await assert.rejects(ws.listDirectory('../'), code('path_outside_workspace'))
      await assert.rejects(ws.listDirectory('package.json'), code('not_a_directory'))
      await assert.rejects(ws.listDirectory('missing'), code('file_not_found'))
    })
    it('reports symlinks as symlinks without following them', async () => {
      await fs.symlink('src', path.join(fx.root, 'lnk'))
      const e = (await ws.listDirectory('')).entries.find(x => x.name === 'lnk')
      assert.equal(e.type, 'symlink')
    })
    it('caps entries', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxDirectoryEntries: 2 } })
      const r = await small.listDirectory('')
      assert.equal(r.entries.length, 2)
      assert.equal(r.truncated, true)
    })
    it('stat and exists', async () => {
      const s = await ws.stat('src/math.js')
      assert.deepEqual([s.type, s.path], ['file', 'src/math.js'])
      assert.equal((await ws.stat('src')).type, 'directory')
      assert.equal(await ws.exists('nope'), false)
      await assert.rejects(ws.exists('../etc'), code('path_outside_workspace'))
    })
  })

  describe('searchFiles / grep', () => {
    it('ranks basename matches above path matches, deterministically', async () => {
      const r = await ws.searchFiles('math')
      assert.deepEqual(r.matches.map(m => m.path), ['src/math.js', 'tests/math.test.js'])
      assert.deepEqual((await ws.searchFiles('math')).matches, r.matches)
    })
    it('supports globs, path scope, and limits', async () => {
      assert.deepEqual((await ws.searchFiles('*.test.js')).matches.map(m => m.path), ['tests/math.test.js'])
      assert.deepEqual((await ws.searchFiles('*.js', { path: 'src' })).matches.map(m => m.path), ['src/index.js', 'src/math.js'])
      const limited = await ws.searchFiles('js', { limit: 1 })
      assert.equal(limited.matches.length, 1)
      assert.equal(limited.truncated, true)
    })
    it('ignores generated directories', async () => {
      await fs.mkdir(path.join(fx.root, 'node_modules/pkg'), { recursive: true })
      await fs.writeFile(path.join(fx.root, 'node_modules/pkg/math.js'), 'x')
      assert.ok(!(await ws.searchFiles('math')).matches.some(m => m.path.startsWith('node_modules')))
    })
    it('sees new files after writes', async () => {
      await ws.searchFiles('zzz')
      await ws.writeFile('src/zzz.js', 'x')
      assert.equal((await ws.searchFiles('zzz')).matches.length, 1)
    })
    it('greps literal and regex patterns with positions', async () => {
      const lit = await ws.grep('a * b')
      assert.deepEqual(lit.matches, [{ path: 'src/math.js', line: 6, column: 10, text: '  return a * b' }])
      const re = await ws.grep('return a [-*] b', { regex: true })
      assert.equal(re.matches.length, 2)
      assert.equal((await ws.grep('RETURN A', { caseSensitive: true })).matches.length, 0)
      assert.equal((await ws.grep('RETURN A')).matches.length, 2)
    })
    it('filters by path and honors limits', async () => {
      assert.deepEqual([...new Set((await ws.grep('add', { path: 'tests' })).matches.map(m => m.path))], ['tests/math.test.js'])
      const r = await ws.grep('a', { limit: 2 })
      assert.equal(r.matches.length, 2)
      assert.equal(r.truncated, true)
    })
    it('rejects invalid regex and empty patterns; skips binary files', async () => {
      await assert.rejects(ws.grep('(', { regex: true }), code('invalid_input'))
      await assert.rejects(ws.grep(''), code('invalid_input'))
      await fs.writeFile(path.join(fx.root, 'bin.dat'), Buffer.from('needle\0'))
      assert.ok(!(await ws.grep('needle')).matches.length)
    })
  })

  describe('applyPatch', () => {
    const read = rel => fs.readFile(path.join(fx.root, rel), 'utf8')

    it('applies a valid patch', async () => {
      const r = await ws.applyPatch(FIX_ADD_PATCH)
      assert.deepEqual([r.changedFiles, r.appliedHunks], [['src/math.js'], 1])
      assert.match(await read('src/math.js'), /return a \+ b/)
    })
    it('applies multi-hunk and multi-file patches including create and delete', async () => {
      const r = await ws.applyPatch(`--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b
+  return a + b
 }
@@ -5,3 +5,3 @@
 export function multiply(a, b) {
-  return a * b
+  return b * a
 }
--- /dev/null
+++ b/docs/NOTES.md
@@ -0,0 +1 @@
+notes
--- a/src/index.js
+++ /dev/null
@@ -1,3 +0,0 @@
-import { add } from './math.js'
-
-console.log(add(1, 2))
`)
      assert.equal(r.appliedHunks, 4)
      assert.deepEqual(r.files, [
        { path: 'src/math.js', change: 'modified' }, { path: 'docs/NOTES.md', change: 'created' }, { path: 'src/index.js', change: 'deleted' }])
      assert.match(await read('src/math.js'), /b \* a/)
      assert.equal(await read('docs/NOTES.md'), 'notes\n')
      assert.equal(await ws.exists('src/index.js'), false)
    })
    it('is atomic: a failing later file leaves every file untouched', async () => {
      const before = await read('src/math.js')
      await assert.rejects(ws.applyPatch(`${FIX_ADD_PATCH}--- /dev/null
+++ b/created.txt
@@ -0,0 +1 @@
+x
--- a/tests/math.test.js
+++ b/tests/math.test.js
@@ -1,2 +1,2 @@
-no such line
+replacement
 also missing
`), code('patch_apply_failed'))
      assert.equal(await read('src/math.js'), before)
      assert.equal(await ws.exists('created.txt'), false)
    })
    it('rolls back earlier writes when a later write fails', async () => {
      const before = await read('src/math.js')
      // Planning passes (the path does not exist) but the write fails: src/index.js is a file, not a directory.
      await assert.rejects(ws.applyPatch(`${FIX_ADD_PATCH}--- /dev/null
+++ b/src/index.js/sub/new.txt
@@ -0,0 +1 @@
+x
`), code('patch_apply_failed'))
      assert.equal(await read('src/math.js'), before)
      assert.equal((await ws.gitStatus()).clean, true)
    })
    it('rejects malformed patches and traversal', async () => {
      await assert.rejects(ws.applyPatch('garbage'), code('patch_parse_error'))
      await assert.rejects(ws.applyPatch('--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n'), code('path_outside_workspace'))
      await assert.rejects(ws.applyPatch('--- /dev/null\n+++ b/../evil.txt\n@@ -0,0 +1 @@\n+x\n'), code('path_outside_workspace'))
      await assert.rejects(ws.applyPatch('--- /dev/null\n+++ /abs/evil.txt\n@@ -0,0 +1 @@\n+x\n'), code('path_outside_workspace'))
      await assert.rejects(ws.applyPatch('--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n'), code('permission_denied'))
    })
    it('rejects missing targets, existing creates, and directory targets', async () => {
      await assert.rejects(ws.applyPatch('--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-a\n+b\n'), code('file_not_found'))
      await assert.rejects(ws.applyPatch('--- /dev/null\n+++ b/src/math.js\n@@ -0,0 +1 @@\n+x\n'), code('already_exists'))
      await assert.rejects(ws.applyPatch('--- a/src\n+++ b/src\n@@ -1 +1 @@\n-a\n+b\n'), code('not_a_file'))
    })
    it('refuses patches that exceed the size limit', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxPatchBytes: 10 } })
      await assert.rejects(small.applyPatch(FIX_ADD_PATCH), code('output_limit_exceeded'))
    })
  })

  describe('git', () => {
    it('reports a clean repository', async () => {
      const s = await ws.gitStatus()
      assert.deepEqual([s.clean, s.branch, s.staged, s.modified, s.deleted, s.untracked], [true, 'main', [], [], [], []])
      const d = await ws.gitDiff()
      assert.deepEqual([d.diff, d.files, d.truncated], ['', [], false])
    })
    it('reports modified, deleted, staged and untracked files', async () => {
      await ws.writeFile('src/math.js', 'changed\n')
      await ws.deleteFile('src/index.js')
      await ws.writeFile('new.txt', 'n\n')
      await ws.writeFile('staged.txt', 's\n')
      fx.git('add', 'staged.txt')
      const s = await ws.gitStatus()
      assert.equal(s.clean, false)
      assert.deepEqual(s.modified, ['src/math.js'])
      assert.deepEqual(s.deleted, ['src/index.js'])
      assert.deepEqual(s.untracked, ['new.txt'])
      assert.deepEqual(s.staged, ['staged.txt'])
    })
    it('diffs modifications, untracked files, paths and staged changes', async () => {
      await ws.applyPatch(FIX_ADD_PATCH)
      await ws.writeFile('new.txt', 'n\n')
      const all = await ws.gitDiff()
      assert.deepEqual(all.files.map(f => f.path).sort(), ['new.txt', 'src/math.js'])
      assert.ok(all.diff.includes('+  return a + b'))
      assert.deepEqual([all.additions, all.deletions], [2, 1])
      const one = await ws.gitDiff({ path: 'src/math.js' })
      assert.deepEqual(one.files.map(f => f.path), ['src/math.js'])
      assert.equal((await ws.gitDiff({ staged: true })).diff, '')
      fx.git('add', 'src/math.js')
      assert.deepEqual((await ws.gitDiff({ staged: true })).files.map(f => f.path), ['src/math.js'])
    })
    it('truncates large diffs', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxDiffBytes: 60 } })
      await small.applyPatch(FIX_ADD_PATCH)
      const d = await small.gitDiff()
      assert.equal(d.truncated, true)
      assert.ok(Buffer.byteLength(d.diff) <= 60)
      assert.equal(d.files.length, 1)
    })
    it('treats path arguments literally and confines them to the workspace', async () => {
      await assert.rejects(ws.gitDiff({ path: '../x' }), code('path_outside_workspace'))
      assert.equal((await ws.gitDiff({ path: ':(top)*' })).diff, '')
    })
    it('fails gracefully outside a git repository', async () => {
      const plain = await createFixtureRepo({ git: false })
      try {
        const w = await createLocalWorkspace({ root: plain.root })
        assert.equal(w.metadata.repository.isGitRepository, false)
        assert.equal(w.metadata.baseline.initialStatus, null)
        await assert.rejects(w.gitStatus(), code('git_not_repository'))
        await assert.rejects(w.gitDiff(), code('git_not_repository'))
      } finally { await plain.cleanup() }
    })
    it('handles a repository with no commits', async () => {
      const empty = await createFixtureRepo({ files: { 'a.txt': 'a\n' }, git: false })
      try {
        empty.git('init', '-q', '-b', 'main')
        const w = await createLocalWorkspace({ root: empty.root })
        assert.equal(w.metadata.repository.headSha, null)
        assert.deepEqual((await w.gitStatus()).untracked, ['a.txt'])
      } finally { await empty.cleanup() }
    })
  })
})

describe('runCommand', () => {
  let fx, ws
  before(async () => { fx = await createFixtureRepo(); ws = await createLocalWorkspace({ root: fx.root }) })
  after(() => fx.cleanup())

  it('runs in the workspace root and captures streams and exit codes', async () => {
    const ok = await ws.runCommand('pwd && echo out && echo err 1>&2')
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.stdout.split('\n')[0], fx.root)
    assert.match(ok.stdout, /out/)
    assert.equal(ok.stderr.trim(), 'err')
    const bad = await ws.runCommand('exit 3')
    assert.deepEqual([bad.exitCode, bad.timedOut, bad.cancelled], [3, false, false])
  })

  it('runs the fixture test command', async () => {
    const r = await ws.runCommand('npm test')
    assert.equal(r.exitCode, 1) // intentional add() bug
    assert.match(r.stdout + r.stderr, /add/)
  })

  it('passes explicit env but scrubs inherited secrets', async () => {
    process.env.BLUSWAN_TEST_API_KEY = 'leak'
    try {
      const r = await ws.runCommand('echo "[$BLUSWAN_TEST_API_KEY][$FOO]"', { env: { FOO: 'bar' } })
      assert.equal(r.stdout.trim(), '[][bar]')
    } finally { delete process.env.BLUSWAN_TEST_API_KEY }
  })

  it('times out and reports timedOut', async () => {
    const started = Date.now()
    const r = await ws.runCommand('sleep 30', { timeoutMs: 200 })
    assert.equal(r.timedOut, true)
    assert.ok(Date.now() - started < 5000)
  })

  it('clamps per-call timeouts to the configured maximum', async () => {
    const w = await createLocalWorkspace({ root: fx.root, limits: { maxShellTimeoutMs: 150 } })
    const r = await w.runCommand('sleep 30', { timeoutMs: 60_000 })
    assert.equal(r.timedOut, true)
  })

  it('cancels via AbortSignal and kills the whole process tree', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 300)
    const r = await ws.runCommand('sleep 60 & echo $!; wait', { signal: ctl.signal })
    assert.equal(r.cancelled, true)
    const pid = Number(r.stdout.trim().split('\n')[0])
    assert.ok(pid > 0)
    await new Promise(res => setTimeout(res, 100))
    let alive = true
    try {
      process.kill(pid, 0)
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
      alive = stat ? !/^\d+ \(.*\) Z/.test(stat) : true
    } catch { alive = false }
    assert.equal(alive, false, 'background child must not survive cancellation')
  })

  it('returns immediately if already aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const r = await ws.runCommand('echo hi', { signal: ctl.signal })
    assert.deepEqual([r.cancelled, r.stdout], [true, ''])
  })

  it('truncates output, keeping the start and end', async () => {
    const w = await createLocalWorkspace({ root: fx.root, limits: { maxShellOutputBytes: 100 } })
    const r = await w.runCommand(`node -e "process.stdout.write('A'.repeat(500) + 'B'.repeat(500))"`)
    assert.equal(r.truncated, true)
    assert.ok(r.stdout.startsWith('AAAA') && r.stdout.endsWith('BBBB'))
    assert.match(r.stdout, /bytes omitted/)
    assert.ok(r.stdout.length < 200)
  })

  it('rejects empty commands', async () => {
    await assert.rejects(ws.runCommand('  '), code('invalid_input'))
  })
})

describe('WorkspaceManager', () => {
  let fx
  before(async () => { fx = await createFixtureRepo() })
  after(() => fx.cleanup())

  it('creates, retrieves, lists, and closes workspaces', async () => {
    const m = createNodeWorkspaceManager()
    const ws = await m.openWorkspace({ root: fx.root })
    assert.equal(m.getWorkspace(ws.id), ws)
    assert.equal(await m.openWorkspace({ root: fx.root }), ws)
    assert.deepEqual(m.listWorkspaces().map(w => w.id), [ws.id])
    assert.equal(await m.closeWorkspace(ws.id), true)
    assert.equal(m.getWorkspace(ws.id), null)
    assert.equal(await m.closeWorkspace(ws.id), false)
  })

  it('enforces allowed roots and known kinds', async () => {
    const m = createNodeWorkspaceManager({ allowedRoots: [path.join(fx.root, 'src')] })
    await assert.rejects(m.openWorkspace({ root: fx.root }), code('path_outside_workspace'))
    await assert.rejects(m.openWorkspace({ root: path.join(fx.root, 'src'), kind: 'cloud' }), code('invalid_input'))
    const ok = await m.openWorkspace({ root: path.join(fx.root, 'src') })
    assert.equal(ok.root, path.join(fx.root, 'src'))
  })

  it('does not share state between managers', async () => {
    const a = createNodeWorkspaceManager()
    const b = createNodeWorkspaceManager()
    const ws = await a.openWorkspace({ root: fx.root })
    assert.equal(b.getWorkspace(ws.id), null)
  })
})

describe('runtime limits config', () => {
  it('provides defaults and env overrides', () => {
    assert.deepEqual({ ...loadRuntimeConfig({}).limits }, { ...DEFAULT_LIMITS })
    const c = loadRuntimeConfig({ VITE_BLUSWAN_LIMIT_MAX_GREP_RESULTS: '7', VITE_BLUSWAN_LIMIT_MAX_SHELL_TIMEOUT_MS: 'junk' })
    assert.equal(c.limits.maxGrepResults, 7)
    assert.equal(c.limits.maxShellTimeoutMs, DEFAULT_LIMITS.maxShellTimeoutMs)
    for (const k of ['maxReadBytes', 'maxReadManyFiles', 'maxReadManyBytes', 'maxGrepResults', 'maxShellOutputBytes', 'maxDiffBytes', 'defaultShellTimeoutMs', 'maxShellTimeoutMs', 'maxDirectoryDepth']) {
      assert.ok(DEFAULT_LIMITS[k] > 0, k)
    }
  })
})
