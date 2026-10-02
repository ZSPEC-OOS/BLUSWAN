#!/usr/bin/env node
// BLUSWAN working on BLUSWAN, in a disposable worktree. The checkout you run this from is never modified and nothing is pushed.
//
//   npm run dogfood                         scripted model: deterministic, offline, free (verifies the procedure)
//   npm run dogfood -- --provider deepseek  a real model (needs <PROVIDER>_API_KEY and <PROVIDER>_MODEL; billable)
//   options: --task <id>  --model <name>  --keep (keep the worktree to review the diff)  --json
import path from 'node:path'
import { runDogfood, formatDogfood, DOGFOOD_TASKS, dogfoodTaskById, scriptedTurns } from '../src/eval/dogfood.js'
import { createProviderRegistry, defaultRegistry } from '../src/providers/registry.js'
import { createFakeProvider, say, call, reply } from '../src/agent/testing/fakeProvider.js'
import { getProviderConfig } from '../src/config/runtimeConfig.js'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null }
const json = args.includes('--json'); const keep = args.includes('--keep')
const provider = flag('--provider'); const taskId = flag('--task') ?? DOGFOOD_TASKS[0].id
const task = dogfoodTaskById(taskId)
if (!task) { console.error(`Unknown task: ${taskId}. Tasks: ${DOGFOOD_TASKS.map(t => t.id).join(', ')}`); process.exit(2) }
const repoRoot = path.resolve(import.meta.dirname, '..')

let model; let providers
if (provider) {
  const cfg = defaultRegistry.hasProvider(provider) ? getProviderConfig(provider) : null
  model = { provider, model: flag('--model') ?? cfg?.model }
  if (!cfg?.apiKey || !model.model) { console.log(`NOT RUN: configure ${provider.toUpperCase()}_API_KEY and ${provider.toUpperCase()}_MODEL to dogfood with ${provider}.`); process.exit(2) }
} else {
  model = { provider: 'scripted', model: 'reference' }
  providers = async (worktreeRoot) => {
    const turns = await scriptedTurns(task, worktreeRoot); let n = 0
    return createProviderRegistry([createFakeProvider({ id: 'scripted', respond: () => { const t = turns[n++] ?? { text: 'done' }; return reply(...(t.text ? [say(t.text)] : []), ...(t.calls ?? []).map(c => call(c.id, c.name, c.input))) } })])
  }
}
const report = await runDogfood({ repoRoot, task, model, providers, keep })
console.log(json ? JSON.stringify(report, null, 2) : formatDogfood(report))
process.exit(report.outcome === 'success' ? 0 : 1)
