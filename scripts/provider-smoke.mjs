#!/usr/bin/env node
// Optional LIVE smoke test for one provider (excluded from `npm test`, never run in CI by default).
//
//   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... npm run test:deepseek      (also test:kimi, test:openai, test:anthropic)
//   DEEPSEEK_API_KEY=... npm run test:deepseek-flash                   (Flash profile: deepseek-flash, reasoning effort high)
//   DEEPSEEK_API_KEY=... npm run test:deepseek-pro                     (Pro profile: deepseek-v4-pro, reasoning effort high)
// A second argument pins the model and runs it through the routing path (canonical reasoningEffort), like Flash/Pro do in production.
//
// Runs one trivial bug-fix task in a disposable git repository and checks that a real tool call happened, the file
// changed and the fixture's tests pass. Exit codes: 0 PASS, 1 FAIL, 2 NOT RUN (no credentials).
import { runEvalTask } from '../src/eval/harness.js'
import { taskById } from '../src/eval/tasks.js'
import { defaultRegistry } from '../src/providers/registry.js'
import { getProviderConfig } from '../src/config/runtimeConfig.js'
import { createRouting } from '../src/agent/routingBridge.js'
import { parseRoutingEnv } from '../src/config/routingConfig.js'

const provider = process.argv[2]
if (!provider || !defaultRegistry.hasProvider(provider)) {
  console.error(`Usage: node scripts/provider-smoke.mjs <${defaultRegistry.listProviders().join('|')}>`)
  process.exit(2)
}
const cfg = getProviderConfig(provider)
const prefix = provider.toUpperCase()
const pinned = process.argv[3] || null
const model = pinned || cfg.model
if (!cfg.apiKey || !model) {
  console.log(`NOT RUN: set ${prefix}_API_KEY${pinned ? '' : ` and ${prefix}_MODEL`} to run the live ${provider}${pinned ? `/${pinned}` : ''} smoke test.`)
  process.exit(2)
}
// A pinned model runs through the routing path so the canonical reasoning effort reaches the provider adapter.
const routing = pinned ? createRouting({
  routing: parseRoutingEnv({ BLUSWAN_FAST_PROVIDER: provider, BLUSWAN_FAST_MODEL: pinned, BLUSWAN_ADVANCED_PROVIDER: provider, BLUSWAN_ADVANCED_MODEL: pinned }),
  providers: defaultRegistry, isConfigured: () => !!cfg.apiKey,
}) : null
const r = await runEvalTask({ task: taskById('fix-bug'), model: { provider, model }, ...(routing ? { routing, modelPreference: 'fast' } : {}), maxTurns: 12, timeoutMs: 180_000 })
const checks = {
  'session completed': r.sessionStatus === 'completed',
  'a real tool call occurred': r.toolCalls > 0,
  'src/math.js was changed': r.changedFiles.includes('src/math.js'),
  'tests pass in the fixture': r.success,
  ...(routing ? { 'ran on the pinned model with reasoning effort': r.route?.segments?.[0]?.model === pinned && r.route.segments[0].reasoningEffort === 'high' } : {}),
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(`turns: ${r.turns}, tokens: ${r.tokens.total}, duration: ${(r.durationMs / 1000).toFixed(1)}s`)
if (r.error) console.log(`error: ${r.error.code}: ${r.error.message}`)
const ok = Object.values(checks).every(Boolean)
console.log(`LIVE ${provider.toUpperCase()}${pinned ? ` ${pinned}` : ''} SMOKE TEST: ${ok ? 'PASS' : 'FAILED'}`)
process.exit(ok ? 0 : 1)
