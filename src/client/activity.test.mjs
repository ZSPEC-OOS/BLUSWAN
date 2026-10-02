import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline, liveText, describeToolCall } from './activity.js'
import { createEvent } from '../protocol/events.js'

const ev = (type, data) => createEvent(type, 's', data)

describe('client activity timeline', () => {
  it('derives messages, tool activity, file changes and completion from events only', () => {
    const events = [
      ev('user.message', { content: 'Fix it' }),
      ev('assistant.text.completed', { text: "I'll look." }),
      ev('tool.started', { toolCallId: 'a', tool: 'grep', inputSummary: { pattern: 'refreshToken' } }),
      ev('tool.completed', { toolCallId: 'a' }),
      ev('tool.started', { toolCallId: 'b', tool: 'apply_patch', inputSummary: { patch: '[10 chars]' } }),
      ev('file.changed', { toolCallId: 'b', path: 'src/auth.js', action: 'modified' }),
      ev('tool.completed', { toolCallId: 'b' }),
      ev('tool.started', { toolCallId: 'c', tool: 'shell', inputSummary: { command: 'npm test' } }),
      ev('tool.failed', { toolCallId: 'c', error: { code: 'command_timeout', message: 'timed out' } }),
      ev('assistant.text.completed', { text: 'Done' }),
    ]
    const t = buildTimeline(events)
    assert.deepEqual(t.map(i => i.kind), ['user', 'assistant', 'tool', 'tool', 'tool', 'assistant'])
    assert.deepEqual(t.filter(i => i.kind === 'tool').map(i => [i.label, i.status]),
      [['Searching "refreshToken"', 'done'], ['Applying patch', 'done'], ['Running npm test', 'failed']])
    assert.deepEqual(t[3].changed, ['modified src/auth.js'])
    assert.equal(t[4].error, 'timed out')
  })

  it('shows retries, cancellation and normalized errors concisely', () => {
    const t = buildTimeline([
      ev('provider.retry', { attempt: 1, reason: 'rate_limit', delayMs: 10 }),
      ev('session.cancelled', {}),
      ev('session.failed', { error: { code: 'rate_limit', message: 'DeepSeek request failed (429)' } }),
    ])
    assert.deepEqual(t.map(i => i.kind), ['notice', 'notice', 'error'])
    assert.equal(t[2].text, 'DeepSeek request failed (429)')
  })

  it('tracks streaming text since the last committed message', () => {
    const base = [ev('user.message', { content: 'x' }), ev('assistant.text.delta', { text: 'Hel' }), ev('assistant.text.delta', { text: 'lo' })]
    assert.equal(liveText(base), 'Hello')
    assert.equal(liveText([...base, ev('assistant.text.completed', { text: 'Hello' })]), '')
  })

  it('labels every canonical tool and falls back for unknown ones', () => {
    assert.equal(describeToolCall('read_file', { path: 'src/a.js' }), 'Reading src/a.js')
    assert.equal(describeToolCall('read_many_files', { paths: ['a', 'b', 'c'] }), 'Reading 3 files')
    assert.equal(describeToolCall('git_status'), 'Checking git status')
    assert.equal(describeToolCall('mystery'), 'Running mystery')
  })

  it('shows validation activity with simple states and unverified-claim warnings', () => {
    const t = buildTimeline([
      ev('validation.started', { validationId: 'v1', kind: 'test', command: 'npm test', scope: 'focused' }),
      ev('validation.completed', { validationId: 'v1', kind: 'test', command: 'npm test', scope: 'focused', status: 'failed', summary: '1 test failed', durationMs: 5 }),
      ev('validation.started', { validationId: 'v2', kind: 'build', command: 'npm run build', scope: 'broad' }),
      ev('validation.completed', { validationId: 'v2', kind: 'build', command: 'npm run build', scope: 'broad', status: 'passed', summary: 'passed', durationMs: 5 }),
      ev('validation.started', { validationId: 'v3', kind: 'lint', command: 'npm run lint', scope: 'broad' }),
      ev('validation.completed', { validationId: 'v3', kind: 'lint', command: 'npm run lint', scope: 'broad', status: 'unavailable', summary: 'x', durationMs: 1 }),
      ev('completion.warning', { claim: 'tests pass', kind: 'test', problem: 'no such check ran after the latest changes' }),
    ])
    assert.deepEqual(t.slice(0, 3).map(i => [i.status, i.label]), [
      ['failed', 'tests failed: npm test'], ['done', 'build passed: npm run build'], ['skipped', 'lint unavailable: npm run lint'],
    ])
    assert.equal(t[0].error, '1 test failed')
    assert.deepEqual([t[3].kind, /Unverified claim: "tests pass"/.test(t[3].text)], ['notice', true])
  })
})
