// Test fixtures: a provider-NATIVE streaming response for each wire format, built from a neutral description.
// The same scenario ("text", "tool call", "fragmented arguments", …) is rendered as chat-completions chunks, Responses
// API events or Messages API events, so one contract suite can run against every adapter.

/** Splits a JSON string into n fragments (inside strings and multi-byte characters too). */
export const fragments = (text, n = 3) => {
  const size = Math.max(1, Math.ceil(text.length / n))
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))
}

/** @typedef {{ text?:string[], reasoning?:string[], calls?:{id:string,name:string,args:string,parts?:number}[], usage?:{input:number,output:number,reasoning?:number,cached?:number}, finish?:'stop'|'tool_calls'|'length' }} Scenario */

const sse = (events) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')

const chat = (sc, { reasoningField = 'reasoning_content' } = {}) => {
  const chunks = []
  for (const t of sc.reasoning ?? []) chunks.push({ choices: [{ index: 0, delta: { [reasoningField]: t } }] })
  for (const t of sc.text ?? []) chunks.push({ choices: [{ index: 0, delta: { content: t } }] })
  ;(sc.calls ?? []).forEach((c, index) => {
    const parts = fragments(c.args, c.parts ?? 3)
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: parts[0] ?? '' } }] } }] })
    for (const p of parts.slice(1)) chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: p } }] } }] })
  })
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: sc.finish ?? ((sc.calls ?? []).length ? 'tool_calls' : 'stop') }] })
  if (sc.usage) chunks.push({ choices: [], usage: { prompt_tokens: sc.usage.input, completion_tokens: sc.usage.output, total_tokens: sc.usage.input + sc.usage.output, ...(sc.usage.reasoning != null ? { completion_tokens_details: { reasoning_tokens: sc.usage.reasoning } } : {}), ...(sc.usage.cached != null ? { prompt_tokens_details: { cached_tokens: sc.usage.cached } } : {}) } })
  return sse([...chunks, '[DONE]'])
}

const responses = (sc) => {
  const ev = [{ type: 'response.created', response: { id: 'resp_1' } }]
  let index = 0
  for (const t of sc.reasoning ?? []) ev.push({ type: 'response.reasoning_summary_text.delta', delta: t, output_index: index })
  if (sc.text?.length) {
    ev.push({ type: 'response.output_item.added', output_index: index, item: { type: 'message', role: 'assistant' } })
    for (const t of sc.text) ev.push({ type: 'response.output_text.delta', output_index: index, delta: t })
    ev.push({ type: 'response.output_item.done', output_index: index, item: { type: 'message' } })
    index++
  }
  for (const c of sc.calls ?? []) {
    ev.push({ type: 'response.output_item.added', output_index: index, item: { type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: '' } })
    for (const p of fragments(c.args, c.parts ?? 3)) ev.push({ type: 'response.function_call_arguments.delta', output_index: index, item_id: `fc_${c.id}`, delta: p })
    ev.push({ type: 'response.function_call_arguments.done', output_index: index, arguments: c.args })
    ev.push({ type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: c.args } })
    index++
  }
  const u = sc.usage
  const response = {
    id: 'resp_1', status: sc.finish === 'length' ? 'incomplete' : 'completed', ...(sc.finish === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(u ? { usage: { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output, ...(u.reasoning != null ? { output_tokens_details: { reasoning_tokens: u.reasoning } } : {}), ...(u.cached != null ? { input_tokens_details: { cached_tokens: u.cached } } : {}) } } : {}),
  }
  ev.push({ type: sc.finish === 'length' ? 'response.incomplete' : 'response.completed', response })
  return sse(ev)
}

const anthropic = (sc) => {
  const u = sc.usage ?? { input: 0, output: 0 }
  const ev = [{ type: 'message_start', message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: u.input - (u.cached ?? 0), output_tokens: 1, ...(u.cached != null ? { cache_read_input_tokens: u.cached } : {}) } } }, { type: 'ping' }]
  let index = 0
  if (sc.reasoning?.length) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
    for (const t of sc.reasoning) ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } })
    ev.push({ type: 'content_block_stop', index }); index++
  }
  if (sc.text?.length) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const t of sc.text) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })
    ev.push({ type: 'content_block_stop', index }); index++
  }
  for (const c of sc.calls ?? []) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } })
    for (const p of fragments(c.args, c.parts ?? 3)) ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } })
    ev.push({ type: 'content_block_stop', index }); index++
  }
  const stop = sc.finish === 'length' ? 'max_tokens' : (sc.calls ?? []).length ? 'tool_use' : 'end_turn'
  ev.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: u.output } }, { type: 'message_stop' })
  return sse(ev)
}

export const WIRE = { chat, responses, anthropic }

/** Native error payloads for in-stream failures. */
export const streamError = {
  chat: (message, type = 'server_error') => sse([{ error: { message, type } }]),
  responses: (message, code = 'server_error') => sse([{ type: 'error', message, code }]),
  anthropic: (message, type = 'overloaded_error') => sse([{ type: 'error', error: { type, message } }]),
}

/** A fetch that serves `bodyFor(call)` as an SSE response and records every call. */
export function mockFetch(handler) {
  const calls = []
  const f = async (url, init) => {
    const call = { url, init, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} }
    calls.push(call)
    const r = await handler(call, calls.length, init?.signal)
    if (r instanceof Response) return r
    const enc = new TextEncoder()
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(r)); c.close() } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  f.calls = calls
  return f
}
