// Deterministic scripted provider for tests. Demonstrates the runtime is provider-neutral.
import { defineCapabilities } from '../../providers/provider.js'

/**
 * @param {{id?:string, script?:object[], failWith?:object, hang?:boolean}} [opts]
 * `script` is a list of normalized provider events; `failWith` is a BluswanError
 * thrown after the script; `hang` never resolves unless the signal aborts.
 */
export function createFakeProvider({ id = 'fake', script = [], failWith = null, hang = false } = {}) {
  const requests = []
  return {
    id,
    requests,
    capabilities: () => defineCapabilities({ toolCalling: true }),
    normalizeMessages: (m) => m,
    normalizeTools: (t) => t,
    async stream(request, { onEvent }) {
      requests.push(request)
      for (const ev of script) onEvent(ev)
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
