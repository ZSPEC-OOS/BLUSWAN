// One provider turn: stream a single model response into text, reasoning, tool calls and usage,
// with bounded retry around this one request. Knows nothing about sessions or tools.
import { createError, isBluswanError } from '../protocol/schemas.js'
import { withRetry } from '../providers/retry.js'

const emptyUsage = () => ({ input: 0, output: 0, reasoning: 0, total: 0 })

/**
 * Retry is only safe while nothing from the failed attempt has been shown: HTTP 429/5xx, connection
 * failures and request timeouts happen before the first byte. A failure after content began is surfaced.
 *
 * @param {{provider:object, request:object, signal:AbortSignal, config:object, acc:{text:string},
 *          onText:(t:string)=>void, onReasoning:()=>void, onRetry:(info:object)=>void,
 *          sleep?:Function, random?:()=>number}} args
 * `acc.text` always holds the text streamed so far (so a cancelled turn can keep its partial output).
 * @returns {Promise<{text:string, reasoning:string, toolCalls:object[], usage:object, finishReason:string}>}
 */
export async function runProviderTurn({ provider, request, signal, config, acc, onText, onReasoning, onRetry, sleep, random }) {
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(createError({ code: 'cancelled', message: 'Session cancelled.' }))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
  aborted.catch(() => {})

  let received = false

  async function attempt() {
    const turn = { reasoning: '', toolCalls: [], usage: emptyUsage(), finishReason: 'stop' }
    acc.text = ''
    received = false
    const stream = provider.stream({ ...request, signal }, {
      onEvent(ev) {
        if (signal.aborted) return
        switch (ev.type) {
          case 'text_delta':
            received = true
            acc.text += ev.text
            onText(ev.text)
            break
          case 'reasoning_delta':
            if (!turn.reasoning) onReasoning()
            received = true
            turn.reasoning += ev.text
            break
          case 'tool_call_start':
          case 'tool_call_delta':
            received = true
            break
          case 'tool_call_complete':
            received = true
            turn.toolCalls.push({ id: ev.id, name: ev.name, input: ev.input, ...(ev.inputError ? { inputError: ev.inputError } : {}) })
            break
          case 'usage':
            turn.usage = { input: ev.input, output: ev.output, reasoning: ev.reasoning ?? 0, total: ev.total, ...(ev.cachedInput != null ? { cachedInput: ev.cachedInput } : {}) }
            break
          case 'completed':
            turn.finishReason = ev.finishReason
            break
          case 'error':
            throw ev.error
          default:
            break
        }
      },
    })
    stream.catch(() => {}) // the race below observes the rejection
    await Promise.race([stream, aborted])
    return { ...turn, text: acc.text }
  }

  return withRetry(attempt, {
    maxRetries: config.maxTransportRetries ?? 0,
    baseDelayMs: config.retryBaseDelayMs ?? 500,
    maxDelayMs: config.retryMaxDelayMs ?? 8000,
    shouldRetry: (e) => isBluswanError(e) && e.retryable && !received,
    onRetry: ({ attempt: n, error, delayMs }) => onRetry({ attempt: n, reason: error.code, delayMs }),
    signal, sleep, random,
  })
}
