import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createDefaultToolRegistry, createToolRegistry, CANONICAL_TOOLS } from './registry.js'
import { createToolExecutor } from './executor.js'
import { createLocalWorkspace } from '../workspace/localWorkspace.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { resolveLimits } from '../config/runtimeConfig.js'

const REQUIRED = ['read_file', 'read_many_files', 'list_directory', 'search_files', 'grep', 'apply_patch', 'write_file', 'delete_file', 'shell', 'git_status', 'git_diff']

describe('tool registry', () => {
  it('registers the canonical tool set with provider-neutral definitions', () => {
    const reg = createDefaultToolRegistry()
    assert.deepEqual(reg.listTools().map(t => t.name).sort(), [...REQUIRED].sort())
    for (const t of reg.listTools()) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/)
      assert.ok(t.description.length > 10 && t.description.length < 300, t.name)
      assert.equal(t.inputSchema.type, 'object')
      assert.equal(typeof t.execute, 'function')
    }
    assert.deepEqual(reg.describeTools().map(t => Object.keys(t)), REQUIRED.map(() => ['name', 'description', 'inputSchema']))
  })
  it('exposes no synonyms for shell', () => {
    const names = createDefaultToolRegistry().listTools().map(t => t.name)
    for (const n of ['run_command', 'execute_command', 'terminal']) assert.ok(!names.includes(n))
  })
  it('classifies effects statically', () => {
    const p = n => createDefaultToolRegistry().getTool(n).permission
    assert.equal(p('read_file'), 'read')
    assert.equal(p('grep'), 'read')
    assert.equal(p('apply_patch'), 'workspace_write')
    assert.equal(p('write_file'), 'workspace_write')
    assert.equal(p('delete_file'), 'destructive')
  })
  it('validates registration', () => {
    const reg = createToolRegistry()
    assert.throws(() => reg.registerTool({ name: 'BadName', execute() {}, inputSchema: { type: 'object' }, permission: 'read' }))
    assert.throws(() => reg.registerTool({ name: 'x', execute() {}, inputSchema: { type: 'object' }, permission: 'nope' }))
    reg.registerTool(CANONICAL_TOOLS[0])
    assert.throws(() => reg.registerTool(CANONICAL_TOOLS[0]), /already registered/)
    assert.equal(reg.hasTool('read_file'), true)
    assert.equal(reg.getTool('missing'), null)
  })
})

describe('tool executor + tools', () => {
  let fx, ws, exec, events
  const run = async (name, input, opts = {}) => exec.execute({
    workspace: opts.workspace ?? ws, call: { name, input, id: opts.id }, signal: opts.signal, emit: (type, data) => events.push({ type, data }),
  })
  const fail = async (name, input, errCode) => {
    const r = await run(name, input)
    assert.equal(r.ok, false, `${name} should fail`)
    assert.equal(r.error.code, errCode, r.error.message)
    assert.equal(r.output === null || typeof r.output === 'object', true)
    return r
  }
  beforeEach(async () => {
    fx = await createFixtureRepo()
    ws = await createLocalWorkspace({ root: fx.root })
    exec = createToolExecutor({ registry: createDefaultToolRegistry() })
    events = []
  })
  afterEach(() => fx.cleanup())

  describe('executor', () => {
    it('returns the normalized result shape and emits started → completed with one call ID', async () => {
      const r = await run('read_file', { path: 'src/math.js' }, { id: 'tool_fixed' })
      assert.deepEqual(Object.keys(r).sort(), ['durationMs', 'error', 'metadata', 'ok', 'output', 'tool', 'toolCallId'])
      assert.deepEqual([r.ok, r.tool, r.error, r.toolCallId, typeof r.durationMs], [true, 'read_file', null, 'tool_fixed', 'number'])
      assert.deepEqual(events.map(e => e.type), ['tool.started', 'tool.completed'])
      assert.ok(events.every(e => e.data.toolCallId === 'tool_fixed' && e.data.tool === 'read_file'))
      assert.deepEqual(events[1].data.inputSummary, { path: 'src/math.js' })
    })
    it('generates unique tool call IDs', async () => {
      const a = await run('git_status', {})
      const b = await run('git_status', {})
      assert.match(a.toolCallId, /^tool_/)
      assert.notEqual(a.toolCallId, b.toolCallId)
    })
    it('emits tool.failed with a structured error', async () => {
      const r = await fail('read_file', { path: 'nope.js' }, 'file_not_found')
      assert.deepEqual(events.map(e => e.type), ['tool.started', 'tool.failed'])
      assert.equal(events[1].data.error.code, 'file_not_found')
      assert.equal(r.error.message, 'File not found: nope.js')
    })
    it('rejects unknown tools and invalid input', async () => {
      await fail('run_command', { command: 'ls' }, 'tool_not_found')
      await fail('read_file', {}, 'invalid_input')
      await fail('read_file', { path: 'a', extra: true }, 'invalid_input')
      await fail('read_file', { path: 5 }, 'invalid_input')
    })
    it('converts thrown non-tool errors to internal_error', async () => {
      const boom = createToolRegistry([{ name: 'boom', description: 'throws unexpectedly', permission: 'read', inputSchema: { type: 'object', properties: {} }, execute() { throw new Error('kaput') } }])
      const r = await createToolExecutor({ registry: boom }).execute({ workspace: ws, call: { name: 'boom' } })
      assert.deepEqual([r.ok, r.error.code, r.error.message], [false, 'internal_error', 'kaput'])
    })
    it('keeps secrets and bodies out of events', async () => {
      await run('write_file', { path: 'a.txt', content: 'TOP-SECRET-BODY' })
      await run('shell', { command: 'echo hi', env: { MY_TOKEN: 'sekret-value' } })
      const text = JSON.stringify(events)
      assert.ok(!text.includes('TOP-SECRET-BODY') && !text.includes('sekret-value'))
    })
    it('emits file.changed for mutations and updates nothing on failures', async () => {
      await run('write_file', { path: 'a.txt', content: 'x' })
      await run('delete_file', { path: 'a.txt' })
      await fail('delete_file', { path: 'a.txt' }, 'file_not_found')
      const changed = events.filter(e => e.type === 'file.changed').map(e => [e.data.path, e.data.change])
      assert.deepEqual(changed, [['a.txt', 'created'], ['a.txt', 'deleted']])
    })
    it('denies commands the policy does not allow, without running them', async () => {
      const r = await fail('shell', { command: 'git push origin main' }, 'permission_denied')
      assert.equal(r.metadata.effect, 'external_effect')
      await fail('shell', { command: 'npm install left-pad' }, 'permission_denied')
      await fail('shell', { command: 'rm -rf /' }, 'permission_denied')
      await fail('shell', { command: 'touch pwned && sudo true' }, 'permission_denied')
      assert.equal(await ws.exists('pwned'), false)
    })
    it('honors a widened policy except for prohibited commands', async () => {
      const wide = createToolExecutor({ registry: createDefaultToolRegistry(), policy: { allowedEffects: ['read', 'workspace_write', 'dependency_change'] } })
      const ok = await wide.execute({ workspace: ws, call: { name: 'shell', input: { command: 'echo npm install' } } })
      assert.equal(ok.ok, true)
      const denied = await wide.execute({ workspace: ws, call: { name: 'shell', input: { command: 'sudo true' } } })
      assert.equal(denied.error.code, 'permission_denied')
    })
  })

  describe('read_file', () => {
    it('reads a file and a range', async () => {
      const r = await run('read_file', { path: 'src/math.js' })
      assert.deepEqual([r.output.path, r.output.startLine, r.output.endLine, r.output.totalLines, r.output.truncated], ['src/math.js', 1, 7, 7, false])
      const part = await run('read_file', { path: 'src/math.js', startLine: 1, endLine: 3 })
      assert.equal(part.output.content, 'export function add(a, b) {\n  return a - b\n}\n')
    })
    it('fails for missing files, directories, and traversal', async () => {
      await fail('read_file', { path: 'missing.js' }, 'file_not_found')
      await fail('read_file', { path: 'src' }, 'not_a_file')
      await fail('read_file', { path: '../../etc/passwd' }, 'path_outside_workspace')
      await fail('read_file', { path: '/etc/passwd' }, 'path_outside_workspace')
    })
    it('marks truncation', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxReadBytes: 30 } })
      const r = await run('read_file', { path: 'src/math.js' }, { workspace: small })
      assert.equal(r.output.truncated, true)
    })
  })

  describe('read_many_files', () => {
    it('reads several files', async () => {
      const r = await run('read_many_files', { paths: ['src/math.js', 'src/index.js'] })
      assert.deepEqual(r.output.files.map(f => [f.path, f.ok]), [['src/math.js', true], ['src/index.js', true]])
    })
    it('reports partial failure per file', async () => {
      const r = await run('read_many_files', { paths: ['src/math.js', 'nope.js', '../x'] })
      assert.equal(r.ok, true)
      assert.deepEqual(r.output.files.map(f => f.error?.code ?? null), [null, 'file_not_found', 'path_outside_workspace'])
    })
    it('fails when every file fails, keeping per-file detail', async () => {
      const r = await fail('read_many_files', { paths: ['nope.js', 'nada.js'] }, 'file_not_found')
      assert.equal(r.output.files.length, 2)
    })
    it('enforces the per-call file limit and the total byte budget', async () => {
      const few = await createLocalWorkspace({ root: fx.root, limits: { maxReadManyFiles: 1 } })
      const over = await run('read_many_files', { paths: ['src/math.js', 'src/index.js'] }, { workspace: few })
      assert.equal(over.error.code, 'output_limit_exceeded')
      const tiny = await createLocalWorkspace({ root: fx.root, limits: { maxReadManyBytes: 'export function add(a, b) {\n'.length } })
      const r = await run('read_many_files', { paths: ['src/math.js', 'src/index.js', 'package.json'] }, { workspace: tiny })
      assert.equal(r.output.files[0].truncated, true)
      assert.equal(r.output.files[1].error.code, 'output_limit_exceeded')
    })
  })

  describe('list_directory', () => {
    it('lists the root by default', async () => {
      const r = await run('list_directory', {})
      assert.deepEqual(r.output.entries.map(e => e.name), ['.git', 'src', 'tests', 'package.json'])
    })
    it('lists nested directories and rejects traversal', async () => {
      assert.deepEqual((await run('list_directory', { path: 'src' })).output.entries.map(e => e.path), ['src/index.js', 'src/math.js'])
      await fail('list_directory', { path: '../' }, 'path_outside_workspace')
      await fail('list_directory', { depth: 0 }, 'invalid_input')
    })
  })

  describe('search_files', () => {
    it('matches filenames, paths, and globs', async () => {
      assert.equal((await run('search_files', { query: 'math' })).output.matches[0].path, 'src/math.js')
      assert.deepEqual((await run('search_files', { query: 'tests/' })).output.matches.map(m => m.path), ['tests/math.test.js'])
      assert.deepEqual((await run('search_files', { query: '*.test.js' })).output.matches.map(m => m.path), ['tests/math.test.js'])
    })
    it('applies limits', async () => {
      const r = await run('search_files', { query: 'js', limit: 2 })
      assert.equal(r.output.matches.length, 2)
      assert.equal(r.output.truncated, true)
    })
  })

  describe('grep', () => {
    it('finds literal and regex matches', async () => {
      assert.equal((await run('grep', { pattern: 'multiply' })).output.matches[0].line, 5)
      assert.equal((await run('grep', { pattern: 'return a [*-] b', regex: true })).output.matches.length, 2)
    })
    it('filters by path and applies limits', async () => {
      assert.deepEqual([...new Set((await run('grep', { pattern: 'add', path: 'src' })).output.matches.map(m => m.path))].sort(), ['src/index.js', 'src/math.js'])
      const r = await run('grep', { pattern: 'a', limit: 1 })
      assert.deepEqual([r.output.matches.length, r.output.truncated], [1, true])
    })
  })

  describe('apply_patch', () => {
    it('applies a patch and reports changed files', async () => {
      const r = await run('apply_patch', { patch: FIX_ADD_PATCH })
      assert.deepEqual(r.output, { changedFiles: ['src/math.js'], appliedHunks: 1, files: [{ path: 'src/math.js', change: 'modified' }] })
    })
    it('fails safely on malformed patches, bad context and traversal', async () => {
      await fail('apply_patch', { patch: 'nonsense' }, 'patch_parse_error')
      await fail('apply_patch', { patch: FIX_ADD_PATCH.replace('return a - b', 'return a * q') }, 'patch_apply_failed')
      await fail('apply_patch', { patch: '--- a/../../x\n+++ b/../../x\n@@ -1 +1 @@\n-a\n+b\n' }, 'path_outside_workspace')
      assert.equal((await ws.gitStatus()).clean, true)
    })
  })

  describe('write_file', () => {
    it('creates, then reports overwrite', async () => {
      assert.deepEqual((await run('write_file', { path: 'a/b.txt', content: 'hello' })).output, { path: 'a/b.txt', created: true, overwritten: false, bytesWritten: 5 })
      assert.equal((await run('write_file', { path: 'a/b.txt', content: 'hi' })).output.overwritten, true)
      assert.equal(await fs.readFile(path.join(fx.root, 'a/b.txt'), 'utf8'), 'hi')
    })
    it('rejects traversal', async () => {
      await fail('write_file', { path: '../evil', content: 'x' }, 'path_outside_workspace')
      await fail('write_file', { path: '.git/hooks/pre-commit', content: 'x' }, 'permission_denied')
    })
  })

  describe('delete_file', () => {
    it('deletes a file', async () => {
      assert.deepEqual((await run('delete_file', { path: 'src/index.js' })).output, { path: 'src/index.js', deleted: true })
    })
    it('rejects missing files, directories, and traversal', async () => {
      await fail('delete_file', { path: 'nope' }, 'file_not_found')
      await fail('delete_file', { path: 'src' }, 'not_a_file')
      await fail('delete_file', { path: '../x' }, 'path_outside_workspace')
      assert.equal(await ws.exists('src'), true)
    })
  })

  describe('shell', () => {
    it('captures stdout, stderr and exit code', async () => {
      const r = await run('shell', { command: 'echo out; echo err >&2' })
      assert.deepEqual([r.ok, r.output.exitCode, r.output.stdout.trim(), r.output.stderr.trim(), r.output.timedOut], [true, 0, 'out', 'err', false])
      assert.equal(r.metadata.effect, 'read')
    })
    it('reports non-zero exit as command_failed while keeping output', async () => {
      const r = await fail('shell', { command: 'echo partial; exit 4' }, 'command_failed')
      assert.equal(r.output.exitCode, 4)
      assert.equal(r.output.stdout.trim(), 'partial')
    })
    it('times out', async () => {
      const r = await fail('shell', { command: 'sleep 30', timeoutMs: 200 }, 'command_timeout')
      assert.equal(r.output.timedOut, true)
    })
    it('cancels on abort', async () => {
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), 200)
      const r = await run('shell', { command: 'sleep 30' }, { signal: ctl.signal })
      assert.equal(r.error.code, 'command_cancelled')
      assert.equal(events.at(-1).type, 'tool.failed')
    })
    it('truncates output and validates env', async () => {
      const small = await createLocalWorkspace({ root: fx.root, limits: { maxShellOutputBytes: 50 } })
      const r = await run('shell', { command: `node -e "console.log('z'.repeat(1000))"` }, { workspace: small })
      assert.equal(r.output.truncated, true)
      await fail('shell', { command: 'true', env: { A: 1 } }, 'invalid_input')
    })
    it('runs from the workspace root', async () => {
      assert.equal((await run('shell', { command: 'ls' })).output.stdout.includes('package.json'), true)
    })
  })

  describe('git_status / git_diff', () => {
    it('git_status: clean, modified, untracked', async () => {
      assert.equal((await run('git_status', {})).output.clean, true)
      await ws.writeFile('src/math.js', 'x\n')
      await ws.writeFile('u.txt', 'u\n')
      const s = (await run('git_status', {})).output
      assert.deepEqual([s.clean, s.modified, s.untracked], [false, ['src/math.js'], ['u.txt']])
    })
    it('git_diff: clean, modified, path filter', async () => {
      assert.equal((await run('git_diff', {})).output.diff, '')
      await run('apply_patch', { patch: FIX_ADD_PATCH })
      await ws.writeFile('src/index.js', 'changed\n')
      const all = (await run('git_diff', {})).output
      assert.deepEqual(all.files.map(f => f.path).sort(), ['src/index.js', 'src/math.js'])
      const one = (await run('git_diff', { path: 'src/math.js' })).output
      assert.deepEqual(one.files.map(f => f.path), ['src/math.js'])
      assert.equal(one.truncated, false)
    })
    it('return git_not_repository outside git', async () => {
      const plain = await createFixtureRepo({ git: false })
      try {
        const w = await createLocalWorkspace({ root: plain.root })
        const r = await run('git_status', {}, { workspace: w })
        assert.equal(r.error.code, 'git_not_repository')
      } finally { await plain.cleanup() }
    })
  })
})

describe('limits resolution', () => {
  it('lets workspace limits override defaults', () => {
    assert.equal(resolveLimits({ maxGrepResults: 3 }).maxGrepResults, 3)
  })
})
