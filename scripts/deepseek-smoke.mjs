#!/usr/bin/env node
// Optional LIVE verification against the real DeepSeek API. Excluded from `npm test`.
//
//   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... npm run test:deepseek
//
// Creates a disposable git repository in the OS temp directory, asks DeepSeek to fix a bug, and
// verifies that a real tool call happened, the file changed, and the repository's tests pass.
// Exit codes: 0 PASS, 1 FAIL, 2 NOT RUN (no credentials).
import { createAgentRuntime } from '../src/agent/runtime.js'
import { createNodeWorkspaceManager } from '../src/workspace/node.js'
import { createFixtureRepo } from '../src/workspace/testing/fixtureRepo.js'
import { getRuntimeConfig, getDefaultModelRef, getProviderConfig } from '../src/config/runtimeConfig.js'
import { describeToolCall } from '../src/client/activity.js'

const cfg = getProviderConfig('deepseek')
if (!cfg.apiKey || !getDefaultModelRef().model) {
  console.log('NOT RUN: set DEEPSEEK_API_KEY and DEEPSEEK_MODEL to run the live DeepSeek smoke test.')
  process.exit(2)
}

const fx = await createFixtureRepo()
let code = 1
try {
  const workspaces = createNodeWorkspaceManager()
  const runtime = createAgentRuntime({ workspaces, config: { ...getRuntimeConfig(), maxTurns: 12 } })
  const workspace = await workspaces.openWorkspace({ root: fx.root })
  const session = runtime.startSession({ workspaceId: workspace.id, model: getDefaultModelRef() })
  runtime.subscribe(session.id, (e) => {
    if (e.type === 'tool.started') console.log(`▸ ${describeToolCall(e.data.tool, e.data.inputSummary)}`)
    if (e.type === 'provider.retry') console.log(`  retry: ${e.data.reason}`)
  })
  const timer = setTimeout(() => runtime.cancelSession(session.id), 180_000)
  const done = await runtime.sendMessage(session.id,
    'The add() function in src/math.js returns the wrong result. Fix it so `npm test` passes, then run npm test to confirm.')
  clearTimeout(timer)

  const checks = {
    'session completed': done.status === 'completed',
    'a real tool call occurred': done.toolCalls.length > 0,
    'src/math.js was changed': done.changedFiles.some(f => f.path === 'src/math.js'),
    'tests pass in the fixture': (await workspace.runCommand('npm test')).exitCode === 0,
  }
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`turns: ${done.turns.length}, tokens: ${done.tokenUsage.total}`)
  if (done.status === 'error') console.log('error:', done.events.find(e => e.type === 'session.failed')?.data.error)
  code = Object.values(checks).every(Boolean) ? 0 : 1
  console.log(code === 0 ? 'LIVE DEEPSEEK SMOKE TEST: PASS' : 'LIVE DEEPSEEK SMOKE TEST: FAILED')
} finally {
  await fx.cleanup()
}
process.exit(code)
