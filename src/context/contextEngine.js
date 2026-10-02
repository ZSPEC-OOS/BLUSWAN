// The one canonical context pipeline: session + workspace + tool state → bounded provider request.
//
//   estimate → (if projected input > threshold) compact progressively → assemble → verify budget
//
// Deterministic, provider-neutral, and independent of any model. Full session history is never
// modified; the engine only decides which view of it the provider sees this turn, and (when it
// folds old exchanges into the summary) reports the new summary for the caller to persist.
import { createError } from '../protocol/schemas.js'
import { resolveContextConfig } from '../config/runtimeConfig.js'
import { defaultEstimator } from './tokenEstimator.js'
import { createTokenBudget } from './tokenBudget.js'
import { createSessionSummary, renderSummary } from './sessionSummary.js'
import { buildWorkspaceContext } from './workspaceContext.js'
import { buildRepositoryItems } from './repositoryContext.js'
import { validateHistory, splitExchanges, afterBoundary, renderConversation, exchangeMessages } from './conversationContext.js'
import { foldExchanges, applySummarizer } from './compaction.js'
import { assembleContext } from './contextBuilder.js'
import { renderValidationState } from '../validation/validationState.js'

const contextError = (code, message) => createError({ code, message })

export const BUDGET_MESSAGE = "The current session exceeds the model's usable context capacity and could not be compacted safely. Start a new session or narrow the request."

/**
 * @param {{estimator?:object, config?:object, now?:()=>number}} [options]
 */
export function createContextEngine({ estimator = defaultEstimator, config = {}, now = () => Date.now() } = {}) {
  const cfg = resolveContextConfig(config)
  const workspaceMemo = new Map() // `${workspace.id}:${level}` → text; invalidated after mutations

  async function workspaceText(workspace, level) {
    const key = `${workspace.id}:${level}`
    if (!workspaceMemo.has(key)) workspaceMemo.set(key, await buildWorkspaceContext(workspace, { level }))
    return workspaceMemo.get(key)
  }

  /** Call after anything that can change repository state (file mutations, shell commands). */
  function invalidateWorkspace(workspaceId) {
    for (const k of [...workspaceMemo.keys()]) if (k.startsWith(`${workspaceId}:`)) workspaceMemo.delete(k)
  }

  /** Hook for dynamic tool exposure; currently the full core set is offered. */
  const selectTools = (tools) => tools

  /**
   * @param {{session:object, workspace?:object|null, capabilities:object, tools?:object[], system:string,
   *          summarizer?:Function|null, dryRun?:boolean, requestedOutputTokens?:number}} args
   * @returns {Promise<object>} { messages, tools, budget, sections, items, omitted, compacted, steps, summaryUpdate, metrics, diagnostics }
   */
  async function build({ session, workspace = null, capabilities, tools = [], system, summarizer = null, dryRun = false, requestedOutputTokens }) {
    const history = session.messages
    validateHistory(history)

    const toolDefs = selectTools(tools, session)
    const toolSchemaTokens = estimator.estimateToolSchemaTokens(toolDefs)
    const budget = createTokenBudget({ capabilities, config, toolTokens: toolSchemaTokens, requestedOutputTokens })
    if (budget.availableInputTokens <= 0) {
      throw contextError('context_budget_exceeded', "The model's context window is too small for the tool definitions and output reservation.")
    }

    let summary = session.contextSummary ?? createSessionSummary(now())
    const users = history.filter(m => m.role === 'user')
    const lastUser = users[users.length - 1] ?? null
    const requests = users.slice(-3).reverse().map(m => m.content)
    const searchHits = history.filter(m => m.role === 'tool').slice(-6).flatMap(m => m.meta?.hits ?? [])

    const validationText = renderValidationState(session.validation) // current evidence; high priority, kept at every level
    const withValidation = (rendered, extra) => (extra ? { ...(rendered ?? {}), text: [rendered?.text, extra].filter(Boolean).join('\n\n') } : rendered)
    const plan = { stripNarration: false, compactTools: false, recentToolBudget: cfg.maxToolContextTokens, repoLevel: 'full', summaryLevel: undefined, workspaceLevel: 'full', dropMiddleCycles: false }
    let exchanges = splitExchanges(afterBoundary(history, summary.lastCompactedMessageId))
    const foldedMessages = []
    const omitted = []
    const repoMemo = new Map()
    const repo = async (level) => {
      if (!workspace) return { items: [] }
      if (!repoMemo.has(level)) repoMemo.set(level, await buildRepositoryItems({ workspace, summary, requests, searchHits, estimator, cfg, level }))
      return repoMemo.get(level)
    }

    async function assemble() {
      const conversation = renderConversation(exchanges, { estimator, ...plan })
      const last = exchanges[exchanges.length - 1]
      const latestCycle = last?.cycles[last.cycles.length - 1]
      const pinned = new Set([latestCycle?.assistant.id, ...(latestCycle?.tools ?? []).map(t => t.id)])
      const recent = new Set(exchanges.slice(-cfg.minRecentExchanges - 1).flatMap(exchangeMessages).map(m => m.id))
      const priorityOf = (id, m) => (id === lastUser?.id ? 'critical' : pinned.has(id) ? 'high' : recent.has(id) ? (m.role === 'tool' ? 'low' : 'medium') : 'low')
      const built = assembleContext({
        estimator, systemText: system,
        workspaceText: workspace ? await workspaceText(workspace, plan.workspaceLevel) : null,
        summary: withValidation(renderSummary(summary, { estimator, maxTokens: cfg.maxSummaryTokens, level: plan.summaryLevel }), validationText),
        repository: (await repo(plan.repoLevel)).items, conversation, priorityOf,
      })
      return { built, conversation }
    }

    const foldWhile = async (keep, state) => {
      let st = state
      while (exchanges.length - 1 > keep && st.built.totalTokens > budget.compactionTarget) {
        const { summary: next, folded } = foldExchanges(summary, exchanges, 1, now())
        const tokens = estimator.estimateContextTokens(folded.map(m => ({ role: m.role, content: m.content, toolCalls: m.toolCalls })))
        omitted.push({ type: 'exchange', source: folded[0].id, reason: 'folded into session summary', estimatedTokens: tokens })
        summary = next
        foldedMessages.push(...folded)
        exchanges = exchanges.slice(1)
        st = await assemble()
      }
      return st
    }

    let state = await assemble()
    const steps = []
    const triggered = state.built.totalTokens > budget.compactionThreshold

    if (triggered) {
      const progressive = [
        ['strip_narration', async () => { plan.stripNarration = true }],
        ['compact_tool_outputs', async () => { plan.compactTools = true }],
        ['fold_history', async (st) => foldWhile(cfg.minRecentExchanges, st)],
        ['reduce_repository', async () => { plan.repoLevel = 'minimal' }],
        ['reduce_summary', async () => { plan.summaryLevel = 'core' }],
        ['shrink_recent_tool_results', async () => { plan.recentToolBudget = 0 }],
        ['fold_recent_history', async (st) => foldWhile(0, st)],
        ['drop_repository', async () => { plan.repoLevel = 'none' }],
        ['minimal_workspace', async () => { plan.workspaceLevel = 'minimal' }],
        ['drop_middle_cycles', async () => { plan.dropMiddleCycles = true }],
      ]
      try {
        for (const [name, apply] of progressive) {
          if (state.built.totalTokens <= budget.compactionTarget) break
          const foldedBefore = foldedMessages.length
          const next = await apply(state)
          state = next && next.built ? next : await assemble()
          if (!name.includes('fold') || foldedMessages.length > foldedBefore) steps.push(name)
        }
      } catch (e) {
        if (e?.code) throw e
        throw contextError('context_compaction_failed', 'Context compaction failed unexpectedly.')
      }
      if (foldedMessages.length && summarizer && !dryRun) {
        const res = await applySummarizer(summarizer, summary, foldedMessages, now())
        if (!res.error) { summary = res.summary; state = await assemble() }
      }
    }

    if (state.built.totalTokens > budget.availableInputTokens) throw contextError('context_budget_exceeded', BUDGET_MESSAGE)
    validateHistory(state.built.messages.slice(1)) // self-check: compaction must leave valid structure

    const { built, conversation } = state
    const compacted = steps.length > 0
    const sections = { ...built.sections, toolSchemas: toolSchemaTokens }
    const metrics = {
      estimatedInputTokens: built.totalTokens + toolSchemaTokens,
      maxInputTokens: budget.availableInputTokens + toolSchemaTokens,
      summaryTokens: built.sections.summary,
      conversationTokens: built.sections.conversation,
      repositoryTokens: built.sections.repository,
      toolTokens: built.sections.tools,
      workspaceTokens: built.sections.workspace,
      systemTokens: built.sections.system,
      toolSchemaTokens,
      compactionOccurred: compacted,
      droppedItems: foldedMessages.length + conversation.stats.droppedCycles,
      summarizedItems: conversation.stats.compactedTools + conversation.stats.superseded + conversation.stats.strippedNarration,
    }
    return {
      messages: built.messages,
      tools: toolDefs,
      budget,
      estimatedTokens: built.totalTokens,
      totalEstimatedTokens: built.totalTokens + toolSchemaTokens,
      sections,
      items: built.items,
      omitted,
      compacted,
      steps,
      summaryUpdate: foldedMessages.length || summary !== session.contextSummary ? summary : null,
      foldedMessageCount: foldedMessages.length,
      metrics,
      diagnostics: {
        totalEstimatedTokens: built.totalTokens + toolSchemaTokens,
        maxInputTokens: budget.availableInputTokens + toolSchemaTokens,
        compacted,
        sections,
      },
    }
  }

  return { build, invalidateWorkspace, config: cfg, estimator }
}
