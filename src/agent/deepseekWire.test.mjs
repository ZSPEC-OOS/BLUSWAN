// The real DeepSeek adapter (real fetch + SSE parsing) talking to a local mock server, driving the
// real runtime, tools and workspace. Offline: the server listens on 127.0.0.1 only.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAgentRuntime } from './runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createDeepSeekProvider } from '../providers/deepseek.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], ...extra })}\n\n`
const toolTurn = (id, name, args, text = '') => [
  ...(text ? [chunk({ content: text })] : []),
  chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
  // arguments streamed in small fragments
  ...(JSON.stringify(args).match(/.{1,9}/gs) ?? []).map(f => chunk({ tool_calls: [{ index: 0, function: { arguments: f } }] })),
  chunk({}, 'tool_calls', { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
  'data: [DONE]\n\n',
]
const finalTurn = (text) => [chunk({ content: text.slice(0, 5) }), chunk({ content: text.slice(5) }, 'stop', { usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 } }), 'data: [DONE]\n\n']

describe('DeepSeek wire protocol through the whole stack', () => {
  let server, baseUrl, fx, wm, bodies, script

  before(async () => {
    fx = await createFixtureRepo()
    wm = createNodeWorkspaceManager()
    bodies = []
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', () => {
        bodies.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(raw) })
        const turn = script[bodies.length - 1]
        if (typeof turn === 'number') { res.writeHead(turn, { 'content-type': 'application/json' }); res.end('{"error":"nope"}'); return }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(turn.join(''))
      })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => { server.close(); await fx.cleanup() })

  function runtimeFor() {
    const provider = createDeepSeekProvider({ getConfig: () => ({ apiKey: 'sk-test-0123456789', baseUrl, model: 'deepseek-chat' }) })
    return createAgentRuntime({
      providers: createProviderRegistry([provider]), workspaces: wm, sleep: async () => {},
      config: { ...loadRuntimeConfig({}), maxTransportRetries: 2 },
    })
  }

  it('runs read → patch → test → answer over HTTP/SSE with correct tool continuation payloads', async () => {
    bodies.length = 0
    script = [
      toolTurn('call_1', 'read_file', { path: 'src/math.js' }, 'Reading the file. '),
      toolTurn('call_2', 'apply_patch', { patch: FIX_ADD_PATCH }),
      toolTurn('call_3', 'shell', { command: 'npm test' }),
      finalTurn('Fixed add(); npm test passes.'),
    ]
    const runtime = runtimeFor()
    const workspace = await wm.openWorkspace({ root: fx.root })
    const session = runtime.startSession({ workspaceId: workspace.id, model: { provider: 'deepseek', model: 'deepseek-chat' } })
    const done = await runtime.sendMessage(session.id, 'Fix add()')

    assert.equal(done.status, 'completed', JSON.stringify(done.events.find(e => e.type === 'session.failed')))
    assert.equal(bodies.length, 4)
    assert.ok(bodies.every(b => b.auth === 'Bearer sk-test-0123456789' && b.url === '/chat/completions'))
    assert.deepEqual(bodies[0].body.tools.map(t => t.function.name).sort(), ['apply_patch', 'delete_file', 'git_diff', 'git_status', 'grep', 'list_directory', 'read_file', 'read_many_files', 'search_files', 'shell', 'write_file'])

    // second request carries the assistant tool call (text + call) and the tool result in native format
    const msgs = bodies[1].body.messages
    assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant', 'tool'])
    assert.equal(msgs[2].content, 'Reading the file. ')
    assert.deepEqual(msgs[2].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/math.js"}' } }])
    assert.equal(msgs[3].tool_call_id, 'call_1')
    assert.match(msgs[3].content, /return a - b/)
    assert.match(bodies[3].body.messages.at(-1).content, /Exit code: 0/)

    assert.deepEqual(done.changedFiles, [{ path: 'src/math.js', action: 'modified' }])
    assert.equal(done.messages.at(-1).content, 'Fixed add(); npm test passes.')
    assert.deepEqual(done.tokenUsage, { input: 100 * 3 + 150, output: 20 * 3 + 10, reasoning: 0, total: 120 * 3 + 160 })
  })

  it('retries a transient 503 and then succeeds', async () => {
    bodies.length = 0
    script = [503, finalTurn('Hello there')]
    const runtime = runtimeFor()
    const session = runtime.startSession({ model: { provider: 'deepseek', model: 'deepseek-chat' } })
    const done = await runtime.sendMessage(session.id, 'hi')
    assert.equal(done.status, 'completed')
    assert.equal(bodies.length, 2)
    assert.ok(done.events.some(e => e.type === 'provider.retry' && e.data.reason === 'provider_error'))
  })

  it('does not retry a 401 and reports a concise, secret-free error', async () => {
    bodies.length = 0
    script = [401]
    const runtime = runtimeFor()
    const session = runtime.startSession({ model: { provider: 'deepseek', model: 'deepseek-chat' } })
    const done = await runtime.sendMessage(session.id, 'hi')
    assert.equal(bodies.length, 1)
    const failed = done.events.find(e => e.type === 'session.failed').data.error
    assert.equal(failed.code, 'authentication_error')
    assert.ok(!JSON.stringify(done.events).includes('0123456789'))
  })
})
