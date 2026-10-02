import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectEvents, createProjector, statusFromRuntime } from './projectEvents.js'
import { toolLabel, toolInfo, groupHeader, validationLabel, fileActionLabel, TOOL_INFO } from './toolDisplay.js'
import { friendlyError, friendlyToolError } from './friendlyError.js'
import { createEvent } from '../../protocol/events.js'

let n = 0
const ev = (type, data = {}) => createEvent(type, 's', data, { timestamp: 1_000 + ++n })
const started = (id, tool, inputSummary = {}) => ev('tool.started', { toolCallId: id, tool, inputSummary })
const completed = (id, tool, inputSummary = {}, outputSummary = {}) => ev('tool.completed', { toolCallId: id, tool, inputSummary, durationMs: 120, outputSummary })
const failed = (id, tool, code, inputSummary = {}) => ev('tool.failed', { toolCallId: id, tool, inputSummary, durationMs: 3, error: { code, message: `${code} happened` } })
const kinds = (v) => v.entries.map(e => e.kind)
const groups = (v) => v.entries.filter(e => e.kind === 'activity')

describe('tool display', () => {
  it('maps technical tool names to readable titles and categories', () => {
    const titles = Object.fromEntries(Object.entries(TOOL_INFO).map(([k, v]) => [k, v.title]))
    assert.deepEqual(titles, {
      read_file: 'Read', read_many_files: 'Read files', list_directory: 'List directory', search_files: 'Search files', grep: 'Search code',
      apply_patch: 'Modify files', write_file: 'Write file', delete_file: 'Delete file', shell: 'Run command', git_status: 'Check git status', git_diff: 'Inspect changes',
    })
    assert.equal(toolInfo('mystery').title, 'mystery')
  })
  it('labels running and finished actions', () => {
    assert.equal(toolLabel('read_file', { path: 'src/a.js' }), 'Reading src/a.js')
    assert.equal(toolLabel('read_file', { path: 'src/a.js' }, true), 'Read src/a.js')
    assert.equal(toolLabel('grep', { pattern: 'refreshToken' }, true), 'Searched “refreshToken”')
    assert.equal(toolLabel('shell', { command: 'npm test' }), 'Running npm test')
    assert.equal(toolLabel('read_many_files', { paths: ['a', 'b', 'c'] }, true), 'Read 3 files')
    assert.equal(toolLabel('git_diff', {}, true), 'Inspected changes')
    assert.equal(fileActionLabel('created', 'tests/a.test.js'), 'Created tests/a.test.js')
    assert.equal(validationLabel('test', 'failed'), 'Tests failed')
    assert.equal(validationLabel('lint', null, true), 'Running lint')
    assert.equal(groupHeader('read', [{ status: 'done', paths: ['a', 'b'] }, { status: 'done', paths: ['b', 'c'] }]), 'Read 3 files')
  })
})

describe('friendly errors', () => {
  it('uses plain language and never leaks stack traces', () => {
    assert.equal(friendlyError({ code: 'rate_limit', provider: 'deepseek' }), 'DeepSeek is temporarily rate-limited. The request could not continue.')
    assert.match(friendlyError({ code: 'authentication_error', provider: 'deepseek' }), /rejected the API key/)
    assert.match(friendlyError({ code: 'network_error', provider: 'deepseek' }), /Couldn't reach DeepSeek/)
    assert.match(friendlyError({ code: 'max_turns' }), /step limit/)
    assert.match(friendlyError({ code: 'context_budget_exceeded' }), /Start a new chat/)
    assert.equal(friendlyError({ code: 'runtime_error', message: 'TypeError: x is undefined\n    at foo (bar.js:1:1)' }), 'Something went wrong while running this request.')
    assert.equal(friendlyError(undefined), 'Something went wrong while running this request.')
    assert.equal(friendlyToolError({ code: 'file_not_found' }), 'file not found')
    assert.equal(friendlyToolError({ code: 'zzz' }), 'failed')
  })
})

describe('event projection', () => {
  it('turns a tool call into one row whose status changes (no duplicates)', () => {
    const v = projectEvents([ev('user.message', { messageId: 'u1', content: 'hi' }), started('t1', 'read_file', { path: 'src/a.js' }), completed('t1', 'read_file', { path: 'src/a.js' }, { path: 'src/a.js', lines: 10 })])
    assert.deepEqual(kinds(v), ['user', 'activity'])
    const g = groups(v)[0]
    assert.equal(g.items.length, 1)
    assert.deepEqual([g.items[0].status, g.items[0].label, g.status], ['done', 'Read src/a.js', 'done'])
  })

  it('groups consecutive reads and keeps details expandable', () => {
    const v = projectEvents([
      started('1', 'read_file', { path: 'src/services/auth.js' }), completed('1', 'read_file', { path: 'src/services/auth.js' }),
      started('2', 'read_file', { path: 'src/auth/AuthProvider.jsx' }), completed('2', 'read_file', { path: 'src/auth/AuthProvider.jsx' }),
      started('3', 'read_many_files', { paths: ['tests/auth.test.js', 'package.json'] }), completed('3', 'read_many_files', { paths: ['tests/auth.test.js', 'package.json'] }, { count: 2, paths: ['tests/auth.test.js', 'package.json'] }),
    ])
    assert.equal(groups(v).length, 1)
    assert.equal(groups(v)[0].header, 'Read 4 files')
    assert.deepEqual(groups(v)[0].items.flatMap(i => i.paths), ['src/services/auth.js', 'src/auth/AuthProvider.jsx', 'tests/auth.test.js', 'package.json'])
  })

  it('starts a new group when the category changes or narration intervenes (chronological order is preserved)', () => {
    const v = projectEvents([
      ev('user.message', { messageId: 'u', content: 'fix' }),
      ev('assistant.text.delta', { text: "I'll look." }), ev('assistant.text.completed', { messageId: 'a1', text: "I'll look." }),
      started('1', 'read_file', { path: 'a.js' }), completed('1', 'read_file', { path: 'a.js' }),
      started('2', 'grep', { pattern: 'x' }), completed('2', 'grep', { pattern: 'x' }, { matches: 3, files: 2 }),
      ev('assistant.text.delta', { text: 'Now editing.' }), ev('assistant.text.completed', { messageId: 'a2', text: 'Now editing.' }),
      started('3', 'read_file', { path: 'b.js' }), completed('3', 'read_file', { path: 'b.js' }),
    ])
    assert.deepEqual(kinds(v), ['user', 'assistant', 'activity', 'activity', 'assistant', 'activity'])
    assert.deepEqual(groups(v).map(g => g.category), ['read', 'search', 'read'])
  })

  it('streams many deltas into ONE assistant entry and finalizes without duplicating', () => {
    const p = createProjector()
    for (const piece of ['Hel', 'lo ', 'wor', 'ld']) p.push(ev('assistant.text.delta', { text: piece }))
    let v = p.getView()
    assert.deepEqual([v.entries.length, v.entries[0].kind, v.entries[0].text, v.entries[0].streaming, v.streaming], [1, 'assistant', 'Hello world', true, true])
    p.push(ev('assistant.text.completed', { messageId: 'm1', text: 'Hello world' }))
    v = p.getView()
    assert.deepEqual([v.entries.length, v.entries[0].text, v.entries[0].streaming, v.streaming, v.entries[0].id], [1, 'Hello world', false, false, 'a:m1'])
  })

  it('renders a completed-only message once and ignores empty assistant turns (tool-only turns)', () => {
    assert.deepEqual(projectEvents([ev('assistant.text.completed', { messageId: 'm', text: 'Done.' })]).entries.map(e => e.text), ['Done.'])
    assert.equal(projectEvents([ev('assistant.text.completed', { messageId: 'm', text: '' })]).entries.length, 0)
    const v = projectEvents([ev('assistant.text.delta', { text: 'x' }), ev('assistant.text.completed', { messageId: 'm', text: '' })])
    assert.equal(v.entries.length, 0)
  })

  it('shows file mutations as Modified/Created/Deleted rows, without patch contents', () => {
    const v = projectEvents([
      started('p', 'apply_patch', { patch: '[500 chars]' }),
      ev('file.changed', { toolCallId: 'p', path: 'src/auth.js', action: 'modified' }), ev('file.changed', { toolCallId: 'p', path: 'tests/auth.test.js', action: 'created' }),
      completed('p', 'apply_patch', { patch: '[500 chars]' }, { files: 2, hunks: 3 }),
      started('d', 'delete_file', { path: 'src/old.js' }), ev('file.changed', { toolCallId: 'd', path: 'src/old.js', action: 'deleted' }), completed('d', 'delete_file', { path: 'src/old.js' }),
    ])
    const g = groups(v)[0]
    assert.equal(g.header, 'Changed 3 files')
    assert.deepEqual(g.items[0].details, ['Modified src/auth.js', 'Created tests/auth.test.js'])
    assert.equal(g.items[0].label, 'Changed 2 files')
    assert.equal(g.items[1].label, 'Deleted src/old.js')
    assert.ok(!JSON.stringify(v).includes('500 chars'))
  })

  it('renders commands, marking non-zero exits and timeouts as failures with bounded details', () => {
    const v = projectEvents([
      started('c1', 'shell', { command: 'npm test -- auth' }), completed('c1', 'shell', { command: 'npm test -- auth' }, { exitCode: 0, excerpt: '18 passed' }),
      started('c2', 'shell', { command: 'npm test' }), completed('c2', 'shell', { command: 'npm test' }, { exitCode: 1, excerpt: '1 failing' }),
      started('c3', 'shell', { command: 'sleep 99' }), completed('c3', 'shell', { command: 'sleep 99' }, { exitCode: null, timedOut: true }),
    ])
    const items = groups(v)[0].items
    assert.deepEqual(items.map(i => [i.status, i.label]), [['done', 'Ran npm test -- auth'], ['failed', 'npm test failed (exit 1)'], ['failed', 'sleep 99 timed out']])
    assert.ok(items[0].details.includes('18 passed'))
    assert.equal(groups(v)[0].header, 'Ran 3 commands')
  })

  it('shows tool failures compactly and subdued for routine reads', () => {
    const v = projectEvents([started('r', 'read_file', { path: 'src/typo.js' }), failed('r', 'read_file', 'file_not_found', { path: 'src/typo.js' })])
    const item = groups(v)[0].items[0]
    assert.deepEqual([item.status, item.label, item.subdued], ['failed', 'Read src/typo.js — file not found', true])
    assert.match(item.details.at(-1), /file_not_found/)
  })

  it('projects validation as compact first-class activity', () => {
    const v = projectEvents([
      ev('validation.started', { validationId: 'v1', kind: 'test', command: 'node --test tests/a.test.js', scope: 'focused' }),
      ev('validation.completed', { validationId: 'v1', kind: 'test', command: 'node --test tests/a.test.js', scope: 'focused', status: 'passed', summary: '18 passed', durationMs: 1400 }),
      ev('validation.started', { validationId: 'v2', kind: 'build', command: 'npm run build', scope: 'broad' }),
      ev('validation.completed', { validationId: 'v2', kind: 'build', command: 'npm run build', scope: 'broad', status: 'failed', summary: 'build failed', durationMs: 900 }),
      ev('validation.started', { validationId: 'v3', kind: 'lint', command: 'npm run lint', scope: 'broad' }),
      ev('validation.completed', { validationId: 'v3', kind: 'lint', command: 'npm run lint', scope: 'broad', status: 'unavailable', summary: 'tool missing', durationMs: 10 }),
    ])
    const g = groups(v)[0]
    assert.equal(g.category, 'validation')
    assert.deepEqual(g.items.map(i => [i.status, i.label]), [['done', 'Tests passed — 18 passed'], ['failed', 'Build failed — build failed'], ['skipped', 'Lint unavailable']])
    assert.deepEqual(g.items[0].details, ['node --test tests/a.test.js (focused)', '18 passed', '1.4s'])
    assert.equal(g.header, 'Checks: 1 passed, 1 failed')
    assert.equal(g.status, 'failed')
  })

  it('reduces retries to one subdued notice and never alarms', () => {
    const v = projectEvents([ev('provider.retry', { attempt: 1, reason: 'rate_limit', delayMs: 10 }), ev('provider.retry', { attempt: 2, reason: 'rate_limit', delayMs: 20 })])
    assert.deepEqual(v.entries.map(e => [e.kind, e.tone, e.text]), [['notice', 'subdued', 'Retried model request (2×)']])
  })

  it('represents permission requests and their resolution as one entry', () => {
    const req = { id: 'perm1', tool: 'shell', effect: 'dependency_change', action: 'run', command: 'npm install zod', description: 'This changes project dependencies.' }
    const p = createProjector()
    p.push(ev('permission.requested', req))
    let v = p.getView()
    assert.deepEqual([v.status, v.pendingPermission.id, v.entries[0].status], ['waiting', 'perm1', 'pending'])
    p.push(ev('permission.resolved', { id: 'perm1', decision: 'approved' }))
    v = p.getView()
    assert.deepEqual([v.entries.length, v.entries[0].status, v.pendingPermission, v.status], [1, 'approved', null, 'working'])
  })

  it('shows Stopped on cancellation, ends running rows, and keeps the transcript', () => {
    const v = projectEvents([ev('user.message', { messageId: 'u', content: 'go' }), started('t', 'shell', { command: 'sleep 60' }), ev('session.cancelled', {})])
    assert.equal(v.status, 'stopped')
    assert.equal(groups(v)[0].items[0].status, 'skipped')
    assert.deepEqual(v.entries.at(-1), { kind: 'outcome', id: v.entries.at(-1).id, outcome: 'cancelled', text: 'Stopped', detail: 'Changes already made were kept.' })
    assert.equal(v.workingLabel, null)
  })

  it('renders runtime errors as concise notices with expandable technical details', () => {
    const v = projectEvents([ev('session.failed', { error: { code: 'rate_limit', provider: 'deepseek', message: 'DeepSeek request failed (429): slow down\n at fetch (x.js:1)' } })])
    const e = v.entries[0]
    assert.deepEqual([v.status, e.kind, e.text, e.recoverable], ['error', 'error', 'DeepSeek is temporarily rate-limited. The request could not continue.', true])
    assert.match(e.details, /^rate_limit: DeepSeek request failed/)
    assert.ok(!e.text.includes(' at '))
  })

  it('summarizes the run outcome, including unresolved validation', () => {
    assert.deepEqual(projectEvents([ev('session.completed', { outcome: 'success', runId: 'r1' })]).entries.map(e => [e.outcome, e.text]), [['success', 'Completed']])
    const failedRun = projectEvents([ev('session.completed', { outcome: 'failed', runId: 'r2', unresolvedFailures: 1 })])
    assert.deepEqual([failedRun.entries[0].text, failedRun.entries[0].detail, failedRun.status], ['Validation incomplete', '1 check still failing', 'completed'])
    assert.equal(projectEvents([ev('session.completed', { outcome: 'warning', runId: 'r3' })]).entries[0].text, 'Completed with warnings')
    assert.match(projectEvents([ev('completion.warning', { claim: 'tests pass', problem: 'no such check ran' })]).entries[0].text, /Unverified: “tests pass”/)
  })

  it('derives the working label from real events, never timers', () => {
    const p = createProjector()
    p.push(ev('user.message', { messageId: 'u', content: 'go' }))
    assert.equal(p.getView().workingLabel, 'Working…')
    p.push(ev('assistant.reasoning.status', { text: 'Thinking…' }))
    assert.equal(p.getView().workingLabel, 'Thinking…')
    p.push(started('t', 'read_file', { path: 'src/a.js' }))
    assert.equal(p.getView().workingLabel, 'Reading src/a.js…')
    p.push(completed('t', 'read_file', { path: 'src/a.js' }))
    p.push(started('c', 'shell', { command: 'npm test' }))
    assert.equal(p.getView().workingLabel, 'Running npm test…')
    p.push(ev('assistant.text.delta', { text: 'x' }))
    assert.equal(p.getView().workingLabel, 'Writing…')
    p.push(ev('session.completed', { outcome: 'success', runId: 'r' }))
    assert.equal(p.getView().workingLabel, null)
  })

  it('ignores infrastructure events and is deterministic', () => {
    const events = [ev('session.started', {}), ev('context.compacted', {}), ev('user.message', { messageId: 'u', content: 'x' }), started('t', 'git_status'), completed('t', 'git_status', {}, { clean: true })]
    assert.deepEqual(projectEvents(events), projectEvents(events))
    assert.deepEqual(kinds(projectEvents(events)), ['user', 'activity'])
    assert.equal(groups(projectEvents(events))[0].header, 'Inspected repository state')
  })

  it('returns stable entry identities for unchanged entries (memoization-friendly)', () => {
    const p = createProjector()
    p.push(ev('user.message', { messageId: 'u', content: 'x' }))
    const a = p.getView()
    p.push(ev('assistant.text.delta', { text: 'hi' }))
    const b = p.getView()
    assert.equal(a.entries[0], b.entries[0])
    assert.notEqual(a, b)
    assert.equal(p.getView(), b)
  })

  it('handles thousands of events efficiently', () => {
    const p = createProjector()
    const t0 = Date.now()
    for (let i = 0; i < 3000; i++) { p.push(started(`t${i}`, 'read_file', { path: `f${i}.js` })); p.push(completed(`t${i}`, 'read_file', { path: `f${i}.js` })) }
    const v = p.getView()
    assert.equal(groups(v).length, 1)
    assert.ok(Date.now() - t0 < 5_000)
  })

  it('maps runtime statuses to user-facing ones', () => {
    assert.deepEqual(['idle', 'running', 'waiting_permission', 'completed', 'cancelled', 'error'].map(statusFromRuntime), ['ready', 'working', 'waiting', 'completed', 'stopped', 'error'])
  })
})

describe('restored sessions', () => {
  const ev = (type, data = {}, i = 0) => ({ id: `e${i}-${type}`, type, sessionId: 's', timestamp: 1000 + i, data })
  it('an interrupted run closes unfinished activity and offers a way to continue, without claiming completion', () => {
    const v = projectEvents([
      ev('user.message', { messageId: 'u', content: 'Do it' }, 1), ev('tool.started', { toolCallId: 't', tool: 'shell', inputSummary: { command: 'sleep 30' } }, 2),
      ev('session.interrupted', { previousStatus: 'running', reason: 'restart' }, 3),
    ])
    assert.equal(v.status, 'interrupted')
    const out = v.entries.find(e => e.kind === 'outcome')
    assert.deepEqual([out.outcome, out.text], ['interrupted', 'Run interrupted']); assert.match(out.detail, /continue the conversation/)
    assert.ok(v.entries.filter(e => e.kind === 'activity').every(g => g.items.every(i => i.status !== 'running')))
  })
  it('restore notes: unavailable workspace, branch change, external change; silent otherwise', () => {
    const notes = (data) => projectEvents([ev('user.message', { messageId: 'u', content: 'x' }, 1), ev('session.updated', { status: 'idle', restored: true, ...data }, 2)]).entries.filter(e => e.kind === 'notice')
    assert.match(notes({ workspace: 'unavailable', workspaceReason: 'The repository folder no longer exists.' })[0].text, /Reconnect the workspace to continue coding\. The repository folder no longer exists/)
    assert.match(notes({ workspace: 'ok', branchChanged: { from: 'main', to: 'feature' } })[0].text, /now on branch feature \(this conversation last saw main\)/)
    assert.match(notes({ workspace: 'ok', workspaceChanged: true })[0].text, /Earlier test results no longer apply/)
    assert.deepEqual(notes({ workspace: 'ok' }), [])
  })
})
