// Small deterministic stop conditions and the repeated-call guard.
//
// Conditions inspect a context and return null (continue) or { reason }.
// context: { turnCount, signal, error, failedTurns }

export const maxTurns = (limit) => (ctx) =>
  ctx.turnCount >= limit ? { reason: 'max_turns' } : null

export const userCancelled = () => (ctx) =>
  ctx.signal?.aborted ? { reason: 'cancelled' } : null

export const unrecoverableError = () => (ctx) =>
  ctx.error && ctx.error.retryable === false ? { reason: 'provider_failure' } : null

/** Stops after `limit` consecutive turns in which every tool call failed (no observation made progress). */
export const noProgress = (limit) => (ctx) =>
  (ctx.failedTurns ?? 0) >= limit ? { reason: 'no_progress' } : null

export function composeStopConditions(...conditions) {
  return (ctx) => {
    for (const c of conditions) {
      const hit = c(ctx)
      if (hit) return hit
    }
    return null
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Tool name + normalized (key-order-independent) arguments. */
export function toolSignature(name, input) {
  return `${name}:${stable(input ?? {})}`
}

/**
 * Detects identical consecutive tool calls. The `threshold`-th consecutive repeat is answered with a
 * corrective observation ('warn'); one further repeat ends the run ('stop'). Any different call resets it.
 */
export function createLoopGuard({ threshold = 3 } = {}) {
  let last = null
  let count = 0
  return {
    /** @returns {'ok'|'warn'|'stop'} */
    observe(name, input) {
      const sig = toolSignature(name, input)
      count = sig === last ? count + 1 : 1
      last = sig
      if (count > threshold) return 'stop'
      if (count === threshold) return 'warn'
      return 'ok'
    },
    reset() { last = null; count = 0 },
  }
}
