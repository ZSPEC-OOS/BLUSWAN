// Bounded retry with exponential backoff and jitter for ONE provider request.
// The caller decides which failures are retryable; cancellation is never retried.

/** Exponential backoff capped at maxDelayMs, with 50–100% jitter. */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs, random = Math.random }) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.round(exp * (0.5 + random() * 0.5))
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * @param {(attempt:number)=>Promise<T>} fn  attempt starts at 1
 * @param {{maxRetries:number, baseDelayMs:number, maxDelayMs:number, shouldRetry:(e:*)=>boolean,
 *          onRetry?:(info:{attempt:number,error:*,delayMs:number})=>void, signal?:AbortSignal,
 *          sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>, random?:()=>number}} opts
 * @template T
 */
export async function withRetry(fn, { maxRetries, baseDelayMs, maxDelayMs, shouldRetry, onRetry, signal, sleep = defaultSleep, random }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      if (signal?.aborted || attempt > maxRetries || !shouldRetry(e)) throw e
      const delayMs = backoffDelay(attempt, { baseDelayMs, maxDelayMs, random })
      onRetry?.({ attempt, error: e, delayMs })
      await sleep(delayMs, signal)
    }
  }
}
