// Executes the tool calls of one assistant response with deterministic ordering.
//
// Calls are processed in emitted order. Consecutive read-only calls (static `read` effect, no
// per-input classification) run concurrently as a batch; every other call runs alone, so
// modifications and commands never race. Results are always returned in emitted order.

const isParallelSafe = (registry, call) => {
  const tool = registry.getTool(call.name)
  return !!tool && tool.permission === 'read' && !tool.classify && !call.preflightError
}

export function planBatches(registry, calls) {
  const batches = []
  for (const call of calls) {
    const last = batches[batches.length - 1]
    if (isParallelSafe(registry, call) && last?.parallel) last.calls.push(call)
    else batches.push({ parallel: isParallelSafe(registry, call), calls: [call] })
  }
  return batches
}

/**
 * @param {{registry:object, calls:object[], run:(call:object)=>Promise<object>, signal?:AbortSignal,
 *          skipped:(call:object)=>object}} args
 * `skipped(call)` builds the result for calls not executed because the run was cancelled.
 * @returns {Promise<object[]>} one result per call, in order
 */
export async function executeToolCalls({ registry, calls, run, signal, skipped }) {
  const results = []
  for (const batch of planBatches(registry, calls)) {
    if (signal?.aborted) {
      results.push(...batch.calls.map(skipped))
      continue
    }
    if (batch.parallel) results.push(...await Promise.all(batch.calls.map(run)))
    else results.push(await run(batch.calls[0]))
  }
  return results
}
