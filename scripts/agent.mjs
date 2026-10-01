#!/usr/bin/env node
// Runs the BLUSWAN agent against a local repository from the terminal.
//
//   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... npm run agent -- --workspace ../my-repo "Fix the failing parser test"
//
// Streams assistant text and tool activity; Ctrl-C stops the run (completed edits are kept).
import { createAgentRuntime } from '../src/agent/runtime.js'
import { createNodeWorkspaceManager } from '../src/workspace/node.js'
import { describeToolCall } from '../src/client/activity.js'
import { getDefaultModelRef } from '../src/config/runtimeConfig.js'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null }
const root = flag('--workspace') ?? process.cwd()
const model = flag('--model')
const prompt = args.join(' ').trim()
if (!prompt) {
  console.error('Usage: npm run agent -- [--workspace DIR] [--model NAME] "request"')
  process.exit(2)
}

const workspaces = createNodeWorkspaceManager()
const runtime = createAgentRuntime({ workspaces })
const workspace = await workspaces.openWorkspace({ root })
const base = getDefaultModelRef()
const session = runtime.startSession({ workspaceId: workspace.id, model: { provider: base.provider, model: model ?? base.model } })

runtime.subscribe(session.id, (e) => {
  switch (e.type) {
    case 'assistant.text.delta': process.stdout.write(e.data.text); break
    case 'assistant.text.completed': process.stdout.write('\n'); break
    case 'tool.started': process.stdout.write(`▸ ${describeToolCall(e.data.tool, e.data.inputSummary)}\n`); break
    case 'tool.failed': process.stdout.write(`  ✗ ${e.data.error.code}: ${e.data.error.message.split('\n')[0]}\n`); break
    case 'file.changed': process.stdout.write(`  ${e.data.action} ${e.data.path}\n`); break
    case 'provider.retry': process.stdout.write(`  (retrying: ${e.data.reason}, attempt ${e.data.attempt})\n`); break
    case 'session.failed': console.error(`Error [${e.data.error.code}]: ${e.data.error.message}`); break
    case 'session.cancelled': console.error('Stopped.'); break
    default: break
  }
})
process.on('SIGINT', () => { runtime.cancelSession(session.id) })

const done = await runtime.sendMessage(session.id, prompt)
console.error(`\nstatus: ${done.status} · turns: ${done.turns.length} · tokens: ${done.tokenUsage.total} · changed: ${done.changedFiles.map(f => f.path).join(', ') || 'none'}`)
process.exit(done.status === 'completed' ? 0 : 1)
