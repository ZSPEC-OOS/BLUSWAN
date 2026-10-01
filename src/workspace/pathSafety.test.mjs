import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeRelativePath, resolveInWorkspace, isProtectedPath, assertMutablePath } from './pathSafety.js'

const code = c => e => e?.code === c

describe('normalizeRelativePath', () => {
  it('canonicalizes equivalent spellings', () => {
    assert.equal(normalizeRelativePath('./src/App.jsx'), 'src/App.jsx')
    assert.equal(normalizeRelativePath('src//App.jsx'), 'src/App.jsx')
    assert.equal(normalizeRelativePath('src/../lib/x.js'), 'lib/x.js')
    assert.equal(normalizeRelativePath(''), '')
    assert.equal(normalizeRelativePath('.'), '')
  })

  it('rejects traversal and absolute paths', () => {
    for (const bad of ['../../etc/passwd', '../outside-project', '/path/outside/workspace', 'a/../../b', '..', '..\\..\\x', 'C:\\Windows', '\\\\server\\share']) {
      assert.throws(() => normalizeRelativePath(bad), code('path_outside_workspace'), bad)
    }
  })

  it('rejects non-strings, NUL bytes, and empty paths when a file is required', () => {
    assert.throws(() => normalizeRelativePath(42), code('invalid_input'))
    assert.throws(() => normalizeRelativePath('a\0b'), code('invalid_input'))
    assert.throws(() => normalizeRelativePath('', { allowRoot: false }), code('invalid_input'))
  })

  it('protects .git from mutation', () => {
    assert.ok(isProtectedPath('.git/config'))
    assert.ok(!isProtectedPath('src/.gitignore'))
    assert.throws(() => assertMutablePath('.git/HEAD'), code('permission_denied'))
  })
})

describe('resolveInWorkspace (symlinks)', () => {
  let tmp, root, outsideDir
  before(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-ps-')))
    root = path.join(tmp, 'root')
    outsideDir = path.join(tmp, 'outside')
    await fs.mkdir(path.join(root, 'real'), { recursive: true })
    await fs.mkdir(outsideDir)
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret')
    await fs.symlink(outsideDir, path.join(root, 'escape'))
    await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(root, 'link.txt'))
    await fs.symlink(path.join(root, 'real'), path.join(root, 'inside'))
    await fs.symlink(path.join(tmp, 'missing-target'), path.join(root, 'dangling'))
  })
  after(() => fs.rm(tmp, { recursive: true, force: true }))

  it('allows normal and not-yet-existing paths', async () => {
    assert.equal(await resolveInWorkspace(root, 'real'), path.join(root, 'real'))
    assert.equal(await resolveInWorkspace(root, 'real/new/file.txt'), path.join(root, 'real/new/file.txt'))
    assert.equal(await resolveInWorkspace(root, ''), root)
  })

  it('allows symlinks that stay inside the workspace', async () => {
    await resolveInWorkspace(root, 'inside/file.txt')
  })

  it('rejects directory and file symlinks that escape', async () => {
    await assert.rejects(resolveInWorkspace(root, 'escape/secret.txt'), code('path_outside_workspace'))
    await assert.rejects(resolveInWorkspace(root, 'escape/new.txt'), code('path_outside_workspace'))
    await assert.rejects(resolveInWorkspace(root, 'link.txt'), code('path_outside_workspace'))
    await assert.rejects(resolveInWorkspace(root, 'dangling'), code('path_outside_workspace'))
  })

  it('can address an escaping symlink itself without following it', async () => {
    assert.equal(await resolveInWorkspace(root, 'link.txt', { followFinal: false }), path.join(root, 'link.txt'))
  })
})
