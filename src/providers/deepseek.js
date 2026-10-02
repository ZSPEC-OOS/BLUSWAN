// DeepSeek adapter (OpenAI-compatible chat completions API).
// All DeepSeek-specific behavior is confined to this module.
import { defineCapabilities } from './provider.js'
import { createError } from '../protocol/schemas.js'
import { getProviderConfig, getRuntimeConfig } from '../config/runtimeConfig.js'
import { textDelta, reasoningDelta, toolCallStart, toolCallDelta, toolCallComplete, usage, completed } from './normalize.js'
import { redactSecrets } from '../utils/redact.js'
import { createLogger } from '../utils/logger.js'

export const DEEPSEEK_ID = 'deepseek'
const log = createLogger('provider')

// Model metadata is data, not code paths. Longest matching prefix wins.
const MODEL_CAPABILITIES = [
  { prefix: 'deepseek-reasoner', caps: { toolCalling: true, reasoning: true, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 32768 } },
  { prefix: 'deepseek-', caps: { toolCalling: true, reasoning: false, parallelToolCalls: true, contextWindow: 128000, maxOutputTokens: 8192 } },
]
const FALLBACK_CAPABILITIES = { toolCalling: true, contextWindow: 128000, maxOutputTokens: 8192 }

export function capabilitiesFor(model = '') {
  const hit = MODEL_CAPABILITIES
    .filter(e => model.startsWith(e.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]
  return defineCapabilities(hit ? hit.caps : FALLBACK_CAPABILITIES)
}

const err = (code, message, extra = {}) => createError({ code, message, provider: DEEPSEEK_ID, ...extra })

/** Credentials and model checks that can run before any network request. */
export function validateProvider(model, config = getProviderConfig(DEEPSEEK_ID)) {
  validateConfig(config, model || config.model)
}

/** Throws configuration_error when required settings are absent. */
export function validateConfig(config, model) {
  if (!config?.apiKey) {
    throw err('configuration_error', 'DeepSeek API key is not configured on the server (set DEEPSEEK_API_KEY).')
  }
  if (!config.baseUrl) throw err('configuration_error', 'DeepSeek base URL is not configured.')
  if (!model) throw err('configuration_error', 'No DeepSeek model selected (set DEEPSEEK_MODEL).')
}

export function buildHeaders(config) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }
}

export function buildUrl(config) {
  return `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/**
 * Canonical messages → DeepSeek messages.
 * Assistant `reasoning` is echoed back only on tool-call turns of the current exchange (after the last
 * user message): DeepSeek's thinking mode needs it to continue a tool sequence and ignores nothing else.
 */
export function normalizeMessages(messages = []) {
  const lastUser = messages.map(m => m.role).lastIndexOf('user')
  return messages.map((m, i) => {
    const out = { role: m.role, content: m.content }
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: argumentsJson(c) },
      }))
      if (m.reasoning && i > lastUser) out.reasoning_content = m.reasoning
    }
    if (m.role === 'tool') out.tool_call_id = m.toolCallId
    return out
  })
}

// Malformed model arguments are never re-sent (the API rejects invalid JSON in history).
function argumentsJson(call) {
  if (call.input && typeof call.input === 'object') return JSON.stringify(call.input)
  return '{}'
}

/** Canonical tool descriptors ({name, description, inputSchema}) → DeepSeek function tools. */
export function normalizeTools(tools = []) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} } },
  }))
}

export function buildRequestBody(request, caps) {
  const body = {
    model: request.model,
    messages: normalizeMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.temperature !== undefined && !caps.reasoning) body.temperature = request.temperature
  const max = Math.min(request.maxOutputTokens ?? caps.maxOutputTokens, caps.maxOutputTokens)
  body.max_tokens = max
  if (request.tools?.length && caps.toolCalling) body.tools = normalizeTools(request.tools)
  return body
}

/** Maps an HTTP failure to the canonical error model. */
export function errorFromResponse(status, detail = '') {
  const message = `DeepSeek request failed (${status})${detail ? `: ${redactSecrets(detail)}` : ''}`
  if (status === 401 || status === 403) return err('authentication_error', message)
  if (status === 429) return err('rate_limit', message, { retryable: true })
  if (status >= 500) return err('provider_error', message, { retryable: true })
  return err('provider_error', message)
}

export function errorFromException(e, { signal, timedOut } = {}) {
  if (timedOut === 'request') return err('provider_timeout', 'DeepSeek did not respond in time (request timeout).', { retryable: true, cause: e })
  if (timedOut === 'stream') return err('provider_timeout', 'DeepSeek stream stalled (no data within the inactivity timeout).', { retryable: true, cause: e })
  if (signal?.aborted || e?.name === 'AbortError') return err('cancelled', 'Request cancelled.', { cause: e })
  return err('network_error', `DeepSeek network failure: ${e?.message ?? 'unknown'}`, { retryable: true, cause: e })
}

/**
 * Stateful parser for streaming chunks (already JSON-decoded).
 * push(chunk) → neutral events; flush() → tool_call_complete events (in index order) + completed.
 * Tool-call arguments arrive fragmented and are only parsed once the stream finishes.
 */
export function createChunkParser() {
  const pending = new Map()
  let finishReason = null
  let done = false

  function drainToolCalls() {
    const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([index, c]) => {
      const id = c.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`
      const raw = c.args
      try {
        const input = raw.trim() === '' ? {} : JSON.parse(raw)
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments must be a JSON object')
        return toolCallComplete({ id, name: c.name, input, rawArguments: raw })
      } catch (e) {
        return toolCallComplete({
          id, name: c.name, input: null, rawArguments: raw,
          inputError: `Tool arguments for "${c.name}" were not valid JSON (${e.message}). Resend the call with a complete JSON object.`,
        })
      }
    })
    pending.clear()
    return calls
  }

  return {
    push(chunk) {
      if (chunk?.error) {
        throw err('provider_error', `DeepSeek stream error: ${redactSecrets(chunk.error.message ?? 'unknown')}`)
      }
      const events = []
      const choice = chunk?.choices?.[0]
      const delta = choice?.delta
      if (delta?.reasoning_content) events.push(reasoningDelta(delta.reasoning_content))
      if (delta?.content) events.push(textDelta(delta.content))
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0
        let slot = pending.get(index)
        if (!slot) {
          slot = { id: tc.id ?? '', name: '', args: '' }
          pending.set(index, slot)
          slot.name = tc.function?.name ?? ''
          events.push(toolCallStart({ index, id: slot.id, name: slot.name }))
        } else {
          if (tc.id && !slot.id) slot.id = tc.id
          if (tc.function?.name) slot.name += tc.function.name
        }
        const frag = tc.function?.arguments
        if (frag) {
          slot.args += frag
          events.push(toolCallDelta({ index, id: slot.id, argumentsDelta: frag }))
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (chunk?.usage) {
        events.push(usage({
          input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, total: chunk.usage.total_tokens,
          reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens,
        }))
      }
      return events
    },
    get finished() { return finishReason !== null },
    flush() {
      if (done) return []
      done = true
      if (finishReason === 'insufficient_system_resource') {
        throw err('provider_error', 'DeepSeek ended the response early (insufficient system resource).', { retryable: true })
      }
      return [...drainToolCalls(), completed(finishReason ?? 'stop')]
    },
  }
}

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
    try { reader.releaseLock() } catch {}
  }
}

/**
 * @param {{getConfig?:()=>object, fetchImpl?:typeof fetch, requestTimeoutMs?:number, streamTimeoutMs?:number}} [deps]
 */
export function createDeepSeekProvider({
  getConfig = () => getProviderConfig(DEEPSEEK_ID),
  fetchImpl,
  requestTimeoutMs,
  streamTimeoutMs,
} = {}) {
  return {
    id: DEEPSEEK_ID,
    capabilities: capabilitiesFor,
    normalizeMessages,
    normalizeTools,
    validate: (model) => validateProvider(model, getConfig()),

    async stream(request, { onEvent }) {
      const config = getConfig()
      const model = request.model || config.model
      validateConfig(config, model)

      const caps = capabilitiesFor(model)
      const rt = getRuntimeConfig()
      const reqTimeout = requestTimeoutMs ?? rt.requestTimeoutMs
      const idleTimeout = streamTimeoutMs ?? rt.streamTimeoutMs

      // Internal controller combines caller cancellation with timeouts.
      const controller = new AbortController()
      let timedOut = false // false | 'request' | 'stream'
      const onCallerAbort = () => controller.abort()
      if (request.signal?.aborted) throw err('cancelled', 'Request cancelled.')
      request.signal?.addEventListener('abort', onCallerAbort, { once: true })

      let timer = null
      const arm = (ms, kind) => {
        clearTimeout(timer)
        timer = setTimeout(() => { timedOut = kind; controller.abort() }, ms)
      }

      try {
        arm(reqTimeout, 'request')
        log.debug('stream start', { model })
        const doFetch = fetchImpl ?? globalThis.fetch
        const res = await doFetch(buildUrl(config), {
          method: 'POST',
          headers: buildHeaders(config),
          body: JSON.stringify(buildRequestBody({ ...request, model }, caps)),
          signal: controller.signal,
        })
        if (!res.ok) {
          let detail = ''
          try { detail = (await res.text()).slice(0, 300) } catch {}
          throw errorFromResponse(res.status, detail)
        }
        if (!res.body) throw err('invalid_response', 'DeepSeek returned no response body.')

        const parser = createChunkParser()
        arm(idleTimeout, 'stream')
        let sawDone = false
        for await (const data of readSse(res.body)) {
          arm(idleTimeout, 'stream')
          if (data === '[DONE]') { sawDone = true; break }
          let chunk
          try { chunk = JSON.parse(data) } catch {
            throw err('invalid_response', 'DeepSeek returned a malformed stream chunk.')
          }
          parser.push(chunk).forEach(onEvent)
        }
        if (!sawDone && !parser.finished) throw err('invalid_response', 'DeepSeek stream ended before completion.')
        parser.flush().forEach(onEvent)
      } catch (e) {
        if (e && typeof e === 'object' && 'retryable' in e && 'code' in e) throw e
        if (e instanceof SyntaxError) throw err('invalid_response', 'DeepSeek returned a malformed stream chunk.')
        throw errorFromException(e, { signal: controller.signal, timedOut })
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}
