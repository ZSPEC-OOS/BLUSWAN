// Compaction helpers: folding old exchanges into the summary, and the optional model-assisted
// summarizer. Deterministic extraction is always the base; the model only adds decisions/facts.
import { exchangeMessages } from './conversationContext.js'
import { observeFolded, applySummarizerPatch, renderSummary } from './sessionSummary.js'
import { compactToolContent } from './toolContext.js'
import { createError } from '../protocol/schemas.js'

/**
 * Folds whole exchanges (oldest first) into the summary. Returns the new summary and the folded
 * messages. Canonical session history is untouched; only the fold boundary advances.
 */
export function foldExchanges(summary, exchanges, count, now) {
  const folded = exchanges.slice(0, count).flatMap(exchangeMessages)
  return { summary: observeFolded(summary, folded, now), folded }
}

const SYSTEM = 'You maintain a compact engineering summary for a coding agent. Respond with ONLY a JSON object: ' +
  '{"decisions": string[], "importantFacts": string[]}. decisions: standing constraints or design choices the user or agent made ' +
  '(e.g. "Keep the public API unchanged"). importantFacts: durable facts needed to continue (commands, locations, gotchas). ' +
  'Each item under 200 characters, at most 6 items per list. No narration, no reasoning, no secrets.'

const squash = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

/** Small, bounded input for the summarizer: existing summary + a digest of the folded messages. */
export function buildSummarizationPrompt(summary, folded) {
  const lines = folded.slice(-40).map(m => {
    if (m.role === 'tool') return `tool(${m.name}): ${squash(compactToolContent(m), 240)}`
    if (m.role === 'assistant') return `assistant: ${squash(m.content || (m.toolCalls ?? []).map(c => c.name).join(', '), 240)}`
    return `user: ${squash(m.content, 400)}`
  })
  const existing = renderSummary(summary, { maxTokens: 800, level: 'core' })?.text ?? '(none yet)'
  return `EXISTING SUMMARY\n${existing}\n\nOLDER CONVERSATION BEING FOLDED\n${lines.join('\n')}`
}

function parsePatch(text) {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) throw new Error('no JSON object in summarizer output')
  const obj = JSON.parse(m[0])
  const strings = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, 6).map(x => squash(x, 200)) : [])
  return { decisions: strings(obj.decisions), importantFacts: strings(obj.importantFacts) }
}

/**
 * A summarizer that uses the session's own provider through the provider abstraction, with its own
 * tiny prompt (never the coding-agent context pipeline) and no tools. Failures reject; the engine
 * falls back to deterministic compaction.
 */
export function createProviderSummarizer({ provider, model, signal, maxOutputTokens = 500 }) {
  return async ({ summary, folded }) => {
    let text = ''
    await provider.stream({
      model, tools: [], signal, temperature: 0, maxOutputTokens,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildSummarizationPrompt(summary, folded) }],
      metadata: { purpose: 'summarization' },
    }, { onEvent: (e) => { if (e.type === 'text_delta') text += e.text } })
    return parsePatch(text)
  }
}

export async function applySummarizer(summarizer, summary, folded, now) {
  try {
    const patch = await summarizer({ summary, folded })
    return { summary: applySummarizerPatch(summary, patch, now), error: null }
  } catch (e) {
    if (e?.code === 'cancelled') throw e
    return { summary, error: createError({ code: 'context_compaction_failed', message: 'Model-assisted summary failed; used deterministic compaction.', cause: e }) }
  }
}
