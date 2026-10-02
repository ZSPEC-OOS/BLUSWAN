#!/usr/bin/env node
// Live coding evaluation against a configured provider. Raw metrics only; separate from `npm test`.
//
//   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... npm run eval -- --provider deepseek [--task fix-bug] [--json]
//
// Uses disposable repositories under the OS temp directory. Exit codes: 0 all tasks succeeded, 1 some failed, 2 not run.
import { runEval, formatResults } from '../src/eval/harness.js'
import { TASKS, taskById } from '../src/eval/tasks.js'
import { defaultRegistry } from '../src/providers/registry.js'
import { getProviderConfig } from '../src/config/runtimeConfig.js'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null }
const json = args.includes('--json')
const provider = flag('--provider') ?? 'deepseek'
const taskId = flag('--task')
const cfg = defaultRegistry.hasProvider(provider) ? getProviderConfig(provider) : null
const model = flag('--model') ?? cfg?.model
if (!cfg?.apiKey || !model) {
  console.log(`NOT RUN: configure ${provider.toUpperCase()}_API_KEY and ${provider.toUpperCase()}_MODEL (or pass --model) to evaluate ${provider}.`)
  process.exit(2)
}
const tasks = taskId ? [taskById(taskId)].filter(Boolean) : TASKS
if (!tasks.length) { console.error(`Unknown task: ${taskId}. Tasks: ${TASKS.map(t => t.id).join(', ')}`); process.exit(2) }

const results = await runEval({ tasks, model: { provider, model } })
console.log(json ? JSON.stringify(results, null, 2) : formatResults(results))
process.exit(results.every(r => r.success) ? 0 : 1)
