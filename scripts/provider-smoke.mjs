#!/usr/bin/env node
// Optional LIVE smoke test for one provider (excluded from `npm test`, never run in CI by default).
//
//   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... npm run test:deepseek      (also test:kimi, test:openai, test:anthropic)
//
// Runs one trivial bug-fix task in a disposable git repository and checks that a real tool call happened, the file
// changed and the fixture's tests pass. Exit codes: 0 PASS, 1 FAIL, 2 NOT RUN (no credentials).
import { runEvalTask } from '../src/eval/harness.js'
import { taskById } from '../src/eval/tasks.js'
import { defaultRegistry } from '../src/providers/registry.js'
import { getProviderConfig } from '../src/config/runtimeConfig.js'

const provider = process.argv[2]
if (!provider || !defaultRegistry.hasProvider(provider)) {
  console.error(`Usage: node scripts/provider-smoke.mjs <${defaultRegistry.listProviders().join('|')}>`)
  process.exit(2)
}
const cfg = getProviderConfig(provider)
const prefix = provider.toUpperCase()
if (!cfg.apiKey || !cfg.model) {
  console.log(`NOT RUN: set ${prefix}_API_KEY and ${prefix}_MODEL to run the live ${provider} smoke test.`)
  process.exit(2)
}
const r = await runEvalTask({ task: taskById('fix-bug'), model: { provider, model: cfg.model }, maxTurns: 12, timeoutMs: 180_000 })
const checks = {
  'session completed': r.sessionStatus === 'completed',
  'a real tool call occurred': r.toolCalls > 0,
  'src/math.js was changed': r.changedFiles.includes('src/math.js'),
  'tests pass in the fixture': r.success,
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(`turns: ${r.turns}, tokens: ${r.tokens.total}, duration: ${(r.durationMs / 1000).toFixed(1)}s`)
if (r.error) console.log(`error: ${r.error.code}: ${r.error.message}`)
const ok = Object.values(checks).every(Boolean)
console.log(`LIVE ${provider.toUpperCase()} SMOKE TEST: ${ok ? 'PASS' : 'FAILED'}`)
process.exit(ok ? 0 : 1)
