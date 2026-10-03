#!/usr/bin/env node
// Live routing comparison: the same fixture tasks forced Flash, forced Pro and Auto, raw outcomes only.
//
//   BLUSWAN_FAST_MODEL=... BLUSWAN_ADVANCED_MODEL=... DEEPSEEK_API_KEY=... npm run eval:routing [-- --task fix-bug] [--json]
//
// Spends real tokens on the configured profiles; never part of `npm test`. Exit codes: 0 all rows passed, 1 some failed,
// 2 not run (routing or credentials missing). Nothing is ranked.
import { runRoutingComparison, formatRoutingComparison } from '../src/eval/routingEval.js'
import { TASKS, taskById } from '../src/eval/tasks.js'
import { defaultRegistry } from '../src/providers/registry.js'
import { createRouting } from '../src/agent/routingBridge.js'
import { getRuntimeConfig, getProviderConfig } from '../src/config/runtimeConfig.js'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null }
const json = args.includes('--json')
const taskId = flag('--task')
const config = getRuntimeConfig()
const routing = createRouting({ routing: config.routing, providers: defaultRegistry, isConfigured: (p) => !!getProviderConfig(p, config).apiKey })
if (!routing?.available) {
  console.log(`NOT RUN: routing is not available (${routing ? routing.evaluation.problems.join(' ') : 'set BLUSWAN_MODEL_MODE and the BLUSWAN_FAST_* / BLUSWAN_ADVANCED_* variables'}).`)
  process.exit(2)
}
const tasks = taskId ? [taskById(taskId)].filter(Boolean) : TASKS
if (!tasks.length) { console.error(`Unknown task: ${taskId}. Tasks: ${TASKS.map(t => t.id).join(', ')}`); process.exit(2) }
const rows = await runRoutingComparison({ tasks, routing, providers: defaultRegistry })
console.log(json ? JSON.stringify(rows, null, 2) : formatRoutingComparison(rows))
process.exit(rows.every(r => r.success) ? 0 : 1)
