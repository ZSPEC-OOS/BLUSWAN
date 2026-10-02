// Deterministic session simulator for context tests: builds canonical session state the way the
// runtime does (messages with observations, event-derived summary) without any workspace or model.
import { createSession, createMessage, updateSession } from '../../protocol/schemas.js'
import { createContextEngine } from '../contextEngine.js'
import { createSessionSummary, observeUserMessage, observeToolResult } from '../sessionSummary.js'
import { describeObservation } from '../toolContext.js'
import { serializeToolResult } from '../../agent/toolResults.js'
import { buildSystemPrompt } from '../../agent/systemPrompt.js'

export const readResult = (path, content, { startLine = 1 } = {}) => ({
  ok: true, tool: 'read_file',
  output: { path, content, startLine, endLine: startLine + content.split('\n').length - 1, totalLines: startLine + content.split('\n').length - 1, truncated: false },
})
export const shellResult = (command, { exitCode = 0, stdout = '', stderr = '' } = {}) => ({
  ok: true, tool: 'shell', output: { command, cwd: '/w', exitCode, signal: null, stdout, stderr, timedOut: false, cancelled: false, truncated: false, durationMs: 5 },
})
export const grepResult = (matches) => ({ ok: true, tool: 'grep', output: { matches, truncated: false, filesSearched: 10 } })
export const patchResult = (...paths) => ({
  ok: true, tool: 'apply_patch',
  output: { changedFiles: paths, appliedHunks: paths.length, files: paths.map(p => ({ path: p, change: 'modified' })) },
})
export const failure = (tool, code, message) => ({ ok: false, tool, output: null, error: { code, message } })

/** Source-like text of roughly `lines` lines. */
export const fileBody = (name, lines = 40) =>
  Array.from({ length: lines }, (_, i) => (i === 0 ? `// ${name} module` : i % 5 === 1 ? `export function ${name}Fn${i}(a, b) {` : i % 5 === 3 ? '}' : `  return a + b + ${i}`)).join('\n')

export function createSimulator({ contextWindow = 12_000, maxOutputTokens = 1000, config = {}, summarizer = null, workspace = null } = {}) {
  const cfg = { maxOutputTokens, contextSafetyMarginTokens: 200, ...config }
  const engine = createContextEngine({ config: cfg, now: () => 1_000 })
  let session = createSession({ model: { provider: 'fake', model: 'm' }, id: 'sim' })
  let n = 0
  const id = (p) => `${p}${String(++n).padStart(4, '0')}`
  const add = (fields) => { const m = createMessage({ ...fields, id: id(fields.role[0]) }); session = updateSession(session, { messages: [...session.messages, m] }); return m }
  const summarize = (fn) => { session = updateSession(session, { contextSummary: fn(session.contextSummary ?? createSessionSummary(1_000)) }) }

  const sim = {
    get session() { return session },
    engine,
    user(text) { const m = add({ role: 'user', content: text }); summarize(s => observeUserMessage(s, m, 1_000)); return m },
    /** One assistant step: optional narration + one tool call with its (already computed) result. */
    tool(name, input, result, narration = '') {
      const callId = id('call')
      add({ role: 'assistant', content: narration, toolCalls: [{ id: callId, name, input }] })
      add({ role: 'tool', toolCallId: callId, name, content: serializeToolResult(result), meta: describeObservation({ name, input }, result) })
      summarize(s => observeToolResult(s, { call: { name, input }, result, now: 1_000 }))
    },
    final(text) { add({ role: 'assistant', content: text }) },
    /** Builds context the way the runtime does and persists any summary update. */
    async build(opts = {}) {
      const ctx = await engine.build({
        session, workspace, capabilities: { contextWindow, maxOutputTokens }, tools: [], system: buildSystemPrompt(),
        summarizer, requestedOutputTokens: maxOutputTokens, ...opts,
      })
      if (ctx.summaryUpdate && !opts.dryRun) session = updateSession(session, { contextSummary: ctx.summaryUpdate })
      return ctx
    },
  }
  return sim
}
