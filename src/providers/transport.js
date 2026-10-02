// The one HTTP+SSE transport every provider adapter shares: request/stream timeouts, caller cancellation,
// status mapping, SSE decoding. Adapters supply only their protocol (request shape + stream parser).
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import { isNormalized } from './errors.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('provider')

/** Yields the `data:` payloads of an SSE byte stream. */
export async function* readSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) yield tail.slice(5).trim()
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * Streams one model response.
 * @param {{ id:string, label:string, errors:object, request:object, config:object, caps:object,
 *           build:(config:object, request:object, caps:object)=>{url:string, headers:object, body:object},
 *           createParser:()=>{push:(chunk:object)=>object[], flush:()=>object[], finished:boolean},
 *           onEvent:(e:object)=>void, fetchImpl?:typeof fetch, requestTimeoutMs?:number, streamTimeoutMs?:number }} args
 * The parser's `push` receives each JSON payload; `[DONE]` ends a chat-completions style stream.
 */
export async function streamResponse({ id, label, errors, request, config, caps, build, createParser, onEvent, fetchImpl, requestTimeoutMs, streamTimeoutMs }) {
  const rt = getRuntimeConfig()
  const reqTimeout = requestTimeoutMs ?? rt.requestTimeoutMs
  const idleTimeout = streamTimeoutMs ?? rt.streamTimeoutMs

  const controller = new AbortController()
  let timedOut = false // false | 'request' | 'stream'
  const onCallerAbort = () => controller.abort()
  if (request.signal?.aborted) throw errors.err('cancelled', 'Request cancelled.')
  request.signal?.addEventListener('abort', onCallerAbort, { once: true })

  let timer = null
  const arm = (ms, kind) => {
    clearTimeout(timer)
    timer = setTimeout(() => { timedOut = kind; controller.abort() }, ms)
  }

  try {
    arm(reqTimeout, 'request')
    log.debug('stream start', { provider: id, model: request.model })
    const { url, headers, body } = build(config, request, caps)
    const res = await (fetchImpl ?? globalThis.fetch)(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 300) } catch { /* body unavailable */ }
      throw errors.fromResponse(res.status, detail)
    }
    if (!res.body) throw errors.invalid(`${label} returned no response body.`)

    const parser = createParser()
    arm(idleTimeout, 'stream')
    let sawDone = false
    for await (const data of readSse(res.body)) {
      arm(idleTimeout, 'stream')
      if (data === '[DONE]') { sawDone = true; break }
      let chunk
      try { chunk = JSON.parse(data) } catch { throw errors.invalid(`${label} returned a malformed stream chunk.`) }
      parser.push(chunk).forEach(onEvent)
      if (parser.finished && parser.stopOnFinish) break
    }
    if (!sawDone && !parser.finished) throw errors.invalid(`${label} stream ended before completion.`)
    parser.flush().forEach(onEvent)
  } catch (e) {
    if (isNormalized(e)) throw e
    if (e instanceof SyntaxError) throw errors.invalid(`${label} returned a malformed stream chunk.`)
    throw errors.fromException(e, { signal: controller.signal, timedOut })
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onCallerAbort)
  }
}
