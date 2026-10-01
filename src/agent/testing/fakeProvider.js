// Deterministic scripted provider for tests. Demonstrates the runtime is provider-neutral.
import { defineCapabilities } from '../../providers/provider.js'
import { textDelta, reasoningDelta, toolCallComplete, usage, completed } from '../../providers/normalize.js'

/** Event builders for scripting a provider response. */
export const say = (text) => textDelta(text)
export const think = (text) => reasoningDelta(text)
export const call = (id, name, input = {}) => toolCallComplete({ id, name, input })
export const badCall = (id, name, rawArguments) => toolCallComplete({ id, name, input: null, rawArguments, inputError: 'not valid JSON' })
/** One complete provider response: parts + usage + completion. */
export function reply(...parts) {
  const hasCalls = parts.some(p => p.type === 'tool_call_complete')
  return [...parts, usage({ input: 10, output: 5 }), completed(hasCalls ? 'tool_calls' : 'stop')]
}

/**
 * @param {{id?:string, script?:object[], turns?:Array<object[]|((request:object, n:number)=>object[])>,
 *          failWith?:object, hang?:boolean, failures?:object[]}} [opts]
 * `script`: events emitted on every request. `turns`: one entry per request (an array of events, or a
 * async function `(request, n, emit)` that may stream via `emit` and wait; return remaining events); exhausting it throws. `failures`: errors thrown by the first requests
 * (before any event) — for retry tests. `hang`: never resolves unless the signal aborts.
 */
export function createFakeProvider({ id = 'fake', script = [], turns = null, failWith = null, hang = false, failures = [], validate } = {}) {
  const requests = []
  const pendingFailures = [...failures]
  let served = 0
  return {
    id,
    requests,
    capabilities: () => defineCapabilities({ toolCalling: true }),
    normalizeMessages: (m) => m,
    normalizeTools: (t) => t,
    ...(validate ? { validate } : {}),
    async stream(request, { onEvent }) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      if (pendingFailures.length) throw pendingFailures.shift() // does not consume a scripted turn
      const n = ++served
      let events = script
      if (turns) {
        const t = turns[n - 1]
        if (t === undefined) throw new Error(`fake provider script exhausted at request ${n}`)
        events = typeof t === 'function' ? (await t(request, n, onEvent)) ?? [] : t
      }
      for (const ev of events) {
        if (request.signal?.aborted) break
        const r = onEvent(ev)
        if (r && typeof r.then === 'function') await r
      }
      if (hang) {
        await new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      }
      if (failWith) throw failWith
    },
  }
}
