// The OpenAI-compatible "chat completions" wire protocol, shared by the adapters whose services speak it
// (DeepSeek, Kimi). Differences between those services are options here, not forks of the code.
import { textDelta, reasoningDelta, toolCallStart, toolCallDelta, toolCallComplete, usage, completed } from './normalize.js'

// Malformed model arguments are never re-sent (APIs reject invalid JSON in history).
const argumentsJson = (call) => (call.input && typeof call.input === 'object' ? JSON.stringify(call.input) : '{}')

/**
 * @param {{ errors:object, label:string, echoReasoning?:boolean, extraUsage?:(chunk:object)=>object }} options
 *   echoReasoning: send the assistant's reasoning back on tool-call turns of the current exchange (needed by thinking
 *   models to continue a tool sequence).
 */
export function createChatCompletionsProtocol({ errors, label, echoReasoning = true }) {
  /** Canonical messages → chat-completions messages. */
  function normalizeMessages(messages = []) {
    const lastUser = messages.map(m => m.role).lastIndexOf('user')
    return messages.map((m, i) => {
      const out = { role: m.role, content: m.content }
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: argumentsJson(c) } }))
        if (echoReasoning && m.reasoning && i > lastUser) out.reasoning_content = m.reasoning
      }
      if (m.role === 'tool') out.tool_call_id = m.toolCallId
      return out
    })
  }

  /** Canonical tool descriptors ({name, description, inputSchema}) → function tools. */
  const normalizeTools = (tools = []) => tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} } },
  }))

  function buildRequestBody(request, caps) {
    const body = { model: request.model, messages: normalizeMessages(request.messages), stream: true, stream_options: { include_usage: true } }
    if (request.temperature !== undefined && !caps.reasoning) body.temperature = request.temperature
    body.max_tokens = Math.min(request.maxOutputTokens ?? caps.maxOutputTokens, caps.maxOutputTokens)
    if (request.tools?.length && caps.toolCalling) body.tools = normalizeTools(request.tools)
    return body
  }

  /** Stateful parser: push(chunk) → neutral events; flush() → tool_call_complete (index order) + completed. */
  function createChunkParser() {
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
          return toolCallComplete({ id, name: c.name, input: null, rawArguments: raw, inputError: `Tool arguments for "${c.name}" were not valid JSON (${e.message}). Resend the call with a complete JSON object.` })
        }
      })
      pending.clear()
      return calls
    }

    return {
      push(chunk) {
        if (chunk?.error) throw errors.fromStream(chunk.error.message, chunk.error.type ?? chunk.error.code)
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
          if (frag) { slot.args += frag; events.push(toolCallDelta({ index, id: slot.id, argumentsDelta: frag })) }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const u = chunk?.usage ?? choice?.usage // some services report usage inside the choice
        if (u) {
          events.push(usage({
            input: u.prompt_tokens, output: u.completion_tokens, total: u.total_tokens,
            reasoning: u.completion_tokens_details?.reasoning_tokens,
            cachedInput: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens,
          }))
        }
        return events
      },
      get finished() { return finishReason !== null },
      flush() {
        if (done) return []
        done = true
        if (finishReason === 'insufficient_system_resource') throw errors.err('provider_error', `${label} ended the response early (insufficient system resource).`, { retryable: true })
        return [...drainToolCalls(), completed(finishReason ?? 'stop')]
      },
    }
  }

  return { normalizeMessages, normalizeTools, buildRequestBody, createChunkParser }
}
