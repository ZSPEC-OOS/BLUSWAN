// Routing comparison: the same fixture tasks run forced Flash, forced Pro and Auto, reporting raw outcomes side by
// side. It never folds anything into a quality score or a winner, and it reads no secrets — providers are injected.
import { runEvalTask } from './harness.js'

export const COMPARISON_MODES = Object.freeze(['fast', 'advanced', 'auto'])

/**
 * @param {{tasks:object[], routing:object, providers:object, config?:object, modes?:string[], maxTurns?:number, timeoutMs?:number}} options
 *   `routing` is the object from agent/routingBridge.js createRouting; `providers` the registry that serves both profiles.
 * @returns {Promise<object[]>} one raw row per (task, mode)
 */
export async function runRoutingComparison({ tasks, routing, providers, modes = COMPARISON_MODES, ...rest }) {
  const rows = []
  for (const task of tasks) {
    for (const mode of modes) {
      const first = mode === 'advanced' ? routing.profiles.advanced : routing.profiles.fast
      const r = await runEvalTask({ ...rest, task, providers, routing, modelPreference: mode, model: { provider: first.provider, model: first.model } })
      rows.push({ mode, ...r })
    }
  }
  return rows
}

/** Plain-text table: outcome, route taken and raw cost/time per (task, mode). Deliberately unranked. */
export function formatRoutingComparison(rows) {
  const body = rows.map(r => [r.task, r.mode, r.success ? 'pass' : 'FAIL', r.route ? `${r.route.initialTier}→${r.route.finalTier}${r.route.escalated ? ' (escalated)' : ''}` : '-', r.turns, r.toolCalls, r.tokens.input ?? 0, r.tokens.output ?? 0, r.tokens.reasoning ?? 0, `${(r.durationMs / 1000).toFixed(1)}s`])
  const head = ['task', 'mode', 'result', 'route', 'turns', 'tools', 'in', 'out', 'reasoning', 'time']
  const width = head.map((h, i) => Math.max(h.length, ...body.map(r => String(r[i]).length)))
  const line = (r) => r.map((c, i) => String(c).padEnd(width[i])).join('  ')
  return [line(head), ...body.map(line)].join('\n')
}
