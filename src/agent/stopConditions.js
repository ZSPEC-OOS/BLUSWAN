// Composable stop conditions. Each condition inspects a context and returns
// null (continue) or { reason }.
//
// context: { turnCount, signal, error }

export const maxTurns = (limit) => (ctx) =>
  ctx.turnCount >= limit ? { reason: 'max_turns' } : null

export const userCancelled = () => (ctx) =>
  ctx.signal?.aborted ? { reason: 'cancelled' } : null

export const unrecoverableError = () => (ctx) =>
  ctx.error && ctx.error.retryable === false ? { reason: 'provider_failure' } : null

export function composeStopConditions(...conditions) {
  return (ctx) => {
    for (const c of conditions) {
      const hit = c(ctx)
      if (hit) return hit
    }
    return null
  }
}
