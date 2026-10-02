// The provider-facing view of the conversation: canonical session messages → bounded, structurally
// valid messages. Messages are grouped into exchanges (a user message and everything the agent did
// for it) and cycles (an assistant message plus the tool results it requested). Cycles are atomic:
// a tool call is never separated from its results, and shrinking only rewrites content.
import { createError } from '../protocol/schemas.js'
import { compactToolContent, compactToolCall, supersededContent } from './toolContext.js'

const READ_TOOLS = new Set(['read_file', 'read_many_files'])

const invalid = (message) => createError({ code: 'context_invalid_history', message })

/** Every assistant tool call must be answered by exactly one tool message directly after it. */
export function validateHistory(messages) {
  let pending = null
  for (const m of messages) {
    if (pending) {
      if (m.role !== 'tool') throw invalid('A tool call has no result in the conversation history.')
      if (!pending.has(m.toolCallId)) throw invalid(`Tool result ${m.toolCallId} does not match a pending tool call.`)
      pending.delete(m.toolCallId)
      if (pending.size === 0) pending = null
    } else if (m.role === 'tool') {
      throw invalid(`Tool result ${m.toolCallId} has no matching tool call.`)
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      pending = new Set(m.toolCalls.map(c => c.id))
    }
  }
  if (pending) throw invalid('The conversation ends with unanswered tool calls.')
}

/** @returns {{user:object|null, cycles:{assistant:object, tools:object[]}[]}[]} */
export function splitExchanges(messages) {
  const exchanges = []
  for (const m of messages) {
    if (m.role === 'user') exchanges.push({ user: m, cycles: [] })
    else {
      if (!exchanges.length) exchanges.push({ user: null, cycles: [] })
      const ex = exchanges[exchanges.length - 1]
      if (m.role === 'tool') ex.cycles[ex.cycles.length - 1]?.tools.push(m)
      else ex.cycles.push({ assistant: m, tools: [] })
    }
  }
  return exchanges
}

export const exchangeMessages = (ex) => [...(ex.user ? [ex.user] : []), ...ex.cycles.flatMap(c => [c.assistant, ...c.tools])]

/** Messages strictly after `boundaryId` (history already folded into the summary is not resent). */
export function afterBoundary(messages, boundaryId) {
  if (!boundaryId) return messages
  const i = messages.findIndex(m => m.id === boundaryId)
  return i < 0 ? messages : messages.slice(i + 1)
}

/** Tool messages whose file read was invalidated by a later modification of the same file. */
function supersededReads(exchanges) {
  const order = exchanges.flatMap(ex => ex.cycles.flatMap(c => c.tools))
  const lastMutation = new Map()
  order.forEach((m, i) => { for (const c of m.meta?.changed ?? []) lastMutation.set(c.path, i) })
  const stale = new Map()
  order.forEach((m, i) => {
    if (!READ_TOOLS.has(m.name)) return
    const paths = (m.meta?.paths ?? []).filter(p => (lastMutation.get(p) ?? -1) > i)
    if (paths.length) stale.set(m.id, paths)
  })
  return stale
}

/**
 * @param {object[]} exchanges  output of splitExchanges (already past the fold boundary)
 * @param {{estimator:object, stripNarration?:boolean, compactTools?:boolean, recentToolBudget?:number,
 *          dropMiddleCycles?:boolean}} options
 * @returns {{messages:object[], sources:string[], stats:{compactedTools:number, strippedNarration:number, superseded:number, droppedCycles:number}}}
 */
export function renderConversation(exchanges, { estimator, stripNarration = false, compactTools = false, recentToolBudget = 0, dropMiddleCycles = false }) {
  const stats = { compactedTools: 0, strippedNarration: 0, superseded: 0, droppedCycles: 0 }
  const lastEx = exchanges.length - 1
  const stale = supersededReads(exchanges)

  // Which tool messages stay verbatim once compaction is active: the active (latest) cycle always,
  // then the newest results while they fit the recent-tool budget.
  const full = new Set()
  if (compactTools) {
    let used = 0
    for (let e = lastEx; e >= 0; e--) {
      for (let c = exchanges[e].cycles.length - 1; c >= 0; c--) {
        const cycle = exchanges[e].cycles[c]
        const pinned = e === lastEx && c === exchanges[e].cycles.length - 1
        const cost = cycle.tools.reduce((n, m) => n + estimator.estimateTokens(m.content), 0)
        if (pinned || used + cost <= recentToolBudget) { cycle.tools.forEach(m => full.add(m.id)); used += cost }
      }
    }
  }

  const messages = []
  const sources = [] // id of the canonical session message each output message came from
  const push = (msg, src) => { messages.push(msg); sources.push(src) }
  exchanges.forEach((ex, e) => {
    if (ex.user) push({ role: 'user', content: ex.user.content }, ex.user.id)
    const active = e === lastEx
    const keepFrom = dropMiddleCycles && active ? ex.cycles.length - 1 : 0
    stats.droppedCycles += keepFrom
    ex.cycles.forEach((cycle, c) => {
      if (c < keepFrom) return
      const latest = active && c === ex.cycles.length - 1
      const old = compactTools && !cycle.tools.every(m => full.has(m.id))
      const a = cycle.assistant
      const out = { role: 'assistant', content: a.content }
      if (stripNarration && a.toolCalls?.length && !latest && a.content) { out.content = ''; stats.strippedNarration++ }
      if (a.toolCalls?.length) out.toolCalls = old ? a.toolCalls.map(call => compactToolCall(call)) : a.toolCalls
      if (a.reasoning && active) out.reasoning = a.reasoning // hidden reasoning only survives for the active exchange
      push(out, a.id)
      for (const t of cycle.tools) {
        let content = t.content
        if (stale.has(t.id)) { content = supersededContent(t, stale.get(t.id)); stats.superseded++ }
        else if (compactTools && !full.has(t.id)) { content = compactToolContent(t); stats.compactedTools++ }
        push({ role: 'tool', toolCallId: t.toolCallId, name: t.name, content }, t.id)
      }
    })
  })
  return { messages, sources, stats }
}
