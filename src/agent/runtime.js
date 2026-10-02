// Provider-neutral agent runtime. Owns session execution; independent of React.
//
// Every provider turn is built by the context engine (src/context): the runtime never sends raw
// session history. Canonical session state is complete; the provider sees a bounded working view.
//
// One canonical loop:  user message → [ provider turn → tool calls → tool results ]* → final response.
// One turn = one provider response (plus the tool calls it requested and their results).
// The runtime never builds provider payloads or touches Node APIs: providers, tools and
// workspaces are injected.
import { createEvent } from '../protocol/events.js'
import { createError, isBluswanError, newId } from '../protocol/schemas.js'
import { createSessionManager } from '../sessions/sessionManager.js'
import { defaultRegistry } from '../providers/registry.js'
import { getRuntimeConfig, getDefaultModelRef, resolveLimits } from '../config/runtimeConfig.js'
import { createAgentState, updateAgentState } from './agentState.js'
import {
  composeStopConditions, maxTurns, userCancelled, noProgress, createLoopGuard,
} from './stopConditions.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { createContextEngine } from '../context/contextEngine.js'
import { createProviderSummarizer } from '../context/compaction.js'
import { createSessionSummary, observeUserMessage, observeToolResult } from '../context/sessionSummary.js'
import { describeObservation } from '../context/toolContext.js'
import { observeFileRead, invalidateFiles } from '../context/repositoryContext.js'
import { runProviderTurn } from './providerTurn.js'
import { executeToolCalls } from './toolScheduler.js'
import { serializeToolResult, summarizeToolResult } from './toolResults.js'
import { createLogger } from '../utils/logger.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { createToolExecutor } from '../tools/executor.js'
import { toolFailure } from '../tools/result.js'

const log = createLogger('runtime')
// A finished, cancelled or failed run leaves the conversation open for the next user message.
const SENDABLE = new Set(['idle', 'completed', 'cancelled', 'error', 'waiting_user'])

function toBluswanError(e) {
  if (isBluswanError(e)) return e
  log.warn('unexpected runtime failure', { name: e?.name, message: e?.message })
  return createError({ code: 'runtime_error', message: e?.message ?? 'Unexpected runtime failure', cause: e })
}

const sum = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0), total: a.total + b.total })

export function createAgentRuntime({
  providers = defaultRegistry,
  sessions = createSessionManager(),
  config = getRuntimeConfig(),
  workspaces = null, // workspace manager; sessions with a workspaceId get tools
  tools = createDefaultToolRegistry(),
  toolPolicy,
  now = () => Date.now(),
  sleep, // test seam for retry backoff
  random,
} = {}) {
  const agents = new Map() // sessionId → agent state
  const toolControllers = new Map() // sessionId → Set<AbortController> for manual executeTool calls
  const limits = resolveLimits({}, config)
  const toolExecutor = createToolExecutor({ registry: tools, policy: toolPolicy, limits, now })
  const contextEngine = createContextEngine({ config, now })
  const observations = new WeakMap() // tool result → compact observation (stored on the tool message)

  function updateSummary(sessionId, fn) {
    const s = sessions.get(sessionId)
    sessions.update(sessionId, { contextSummary: fn(s.contextSummary ?? createSessionSummary(now())) })
  }

  /** Deterministic context state, updated as soon as a tool result exists. */
  async function observeResult(sessionId, workspace, call, result) {
    const obs = describeObservation(call, result)
    observations.set(result, obs)
    updateSummary(sessionId, (summary) => observeToolResult(summary, { call, result, now: now() }))
    if (result.ok) {
      try {
        if (result.tool === 'read_file') await observeFileRead(workspace, result.output)
        else if (result.tool === 'read_many_files') for (const f of result.output.files) if (f.ok) await observeFileRead(workspace, f)
      } catch { /* cache misses never affect the run */ }
    }
    if (obs.changed.length) invalidateFiles(workspace, obs.changed.map(c => c.path))
    if (tools.getTool(call.name)?.permission !== 'read' || call.name === 'shell') contextEngine.invalidateWorkspace(workspace.id)
    return obs
  }

  const emit = (sessionId, type, data) =>
    sessions.appendEvent(sessionId, createEvent(type, sessionId, data, { timestamp: now() }))

  function setAgent(sessionId, patch) {
    const next = updateAgentState(agents.get(sessionId), patch, now())
    agents.set(sessionId, next)
    return next
  }

  function startSession({ workspaceId = null, model } = {}) {
    if (workspaceId !== null && workspaces && !workspaces.getWorkspace(workspaceId)) {
      throw new Error(`Unknown workspace: ${workspaceId}`)
    }
    const session = sessions.create({ workspaceId, model: model ?? getDefaultModelRef(config) })
    agents.set(session.id, createAgentState(session.id, now()))
    emit(session.id, 'session.started', { model: session.model, workspaceId })
    return sessions.get(session.id)
  }

  // ─── Tool execution ─────────────────────────────────────────────────────────

  function recordToolCall(sessionId, record) {
    const calls = sessions.get(sessionId).toolCalls
    const i = calls.findIndex(c => c.id === record.id)
    sessions.update(sessionId, { toolCalls: i < 0 ? [...calls, record] : calls.map((c, k) => (k === i ? record : c)) })
  }

  function trackChangedFile(sessionId, { path, action }) {
    const files = sessions.get(sessionId).changedFiles.filter(f => f.path !== path)
    sessions.update(sessionId, { changedFiles: [...files, { path, action }] })
  }

  /** Runs one tool call against the session's workspace, recording history and events. Never throws for tool failures. */
  async function runTool(sessionId, call, signal) {
    const session = sessions.get(sessionId)
    const record = { id: call.id, name: call.name, input: call.input, status: 'running', resultSummary: null, startedAt: now(), completedAt: null }
    recordToolCall(sessionId, record)

    const workspace = session.workspaceId && workspaces ? workspaces.getWorkspace(session.workspaceId) : null
    let result
    if (!workspace) {
      result = { ...toolFailure(call.name, 'workspace_not_found',
        session.workspaceId ? `Workspace not found: ${session.workspaceId}` : 'Session has no workspace'), toolCallId: call.id, durationMs: 0 }
      emit(sessionId, 'tool.started', { toolCallId: call.id, tool: call.name })
      emit(sessionId, 'tool.failed', { toolCallId: call.id, tool: call.name, durationMs: 0, error: result.error })
    } else {
      result = await toolExecutor.execute({
        workspace, call, signal,
        emit: (type, data) => {
          emit(sessionId, type, data)
          if (type === 'file.changed') trackChangedFile(sessionId, data)
        },
      })
    }
    if (workspace) await observeResult(sessionId, workspace, call, result)
    const cancelled = result.error?.code === 'command_cancelled'
    recordToolCall(sessionId, {
      ...record, status: cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed',
      resultSummary: summarizeToolResult(result), completedAt: now(),
    })
    return result
  }

  /**
   * Executes one tool call against the session's workspace without a model (tests, tooling).
   * Resolves with the normalized tool result; tool failures never reject.
   */
  async function executeTool(sessionId, call) {
    if (!sessions.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    if (!call || typeof call.name !== 'string') throw new Error('Tool call requires a name')
    const controller = new AbortController()
    if (!toolControllers.has(sessionId)) toolControllers.set(sessionId, new Set())
    toolControllers.get(sessionId).add(controller)
    try {
      return await runTool(sessionId, { id: call.id ?? `tool_${newId()}`, name: call.name, input: call.input ?? {} }, controller.signal)
    } finally {
      toolControllers.get(sessionId)?.delete(controller)
    }
  }

  // ─── The agent loop ─────────────────────────────────────────────────────────

  function validateRun(session) {
    const provider = providers.getProvider(session.model.provider)
    if (!session.model.model) {
      throw createError({ code: 'configuration_error', message: 'No model is configured for this session.', provider: session.model.provider })
    }
    provider.validate?.(session.model.model) // credentials etc.; throws a normalized error before any request
    let workspace = null
    if (session.workspaceId) {
      workspace = workspaces?.getWorkspace(session.workspaceId) ?? null
      if (!workspace) throw createError({ code: 'configuration_error', message: `Workspace not found: ${session.workspaceId}` })
    }
    return { provider, workspace }
  }

  /** Commits streamed text as an assistant message (used for cancelled/failed turns and stop notices). */
  function commitAssistantText(sessionId, text) {
    const message = sessions.appendMessage(sessionId, { role: 'assistant', content: text })
    emit(sessionId, 'assistant.text.completed', { messageId: message.id, text })
  }

  function uniqueToolCalls(sessionId, calls) {
    const seen = new Set(sessions.get(sessionId).messages.flatMap(m => (m.toolCalls ?? []).map(c => c.id)))
    return calls.map(c => {
      let id = c.id
      while (!id || seen.has(id)) id = `call_${newId().slice(0, 8)}`
      seen.add(id)
      return { ...c, id }
    })
  }

  /** Records per-build context metrics on the session and announces compaction (metadata only). */
  function noteContext(sessionId, ctx) {
    const prev = sessions.get(sessionId).contextStats
    sessions.update(sessionId, {
      contextStats: {
        compactionCount: prev.compactionCount + (ctx.compacted ? 1 : 0),
        lastCompactionAt: ctx.compacted ? now() : prev.lastCompactionAt,
        builds: prev.builds + 1,
        last: ctx.metrics,
      },
    })
    if (ctx.compacted) {
      emit(sessionId, 'context.compacted', {
        estimatedTokens: ctx.metrics.estimatedInputTokens, maxTokens: ctx.metrics.maxInputTokens,
        droppedItems: ctx.metrics.droppedItems, summarizedItems: ctx.metrics.summarizedItems,
        steps: ctx.steps, summaryRevision: (ctx.summaryUpdate ?? sessions.get(sessionId).contextSummary)?.revision ?? 0,
      })
    }
  }

  /** @returns {Promise<{kind:'completed'}|{kind:'stopped', error:object, notice:string}>} throws on cancel/provider failure */
  async function runAgent(sessionId, controller) {
    const { signal } = controller
    const { provider, workspace } = validateRun(sessions.get(sessionId))
    const system = buildSystemPrompt()
    const toolDefs = workspace ? tools.describeTools() : []
    const summarizer = config.summarizeWithModel
      ? createProviderSummarizer({ provider, model: sessions.get(sessionId).model.model, signal }) : null
    const guard = createLoopGuard({ threshold: config.maxIdenticalToolCalls })
    const shouldStop = composeStopConditions(userCancelled(), maxTurns(config.maxTurns), noProgress(config.maxFailedTurns))
    let turnCount = 0
    let failedTurns = 0

    for (;;) {
      const stop = shouldStop({ turnCount, signal, failedTurns })
      if (stop?.reason === 'cancelled') throw createError({ code: 'cancelled', message: 'Session cancelled.' })
      if (stop?.reason === 'max_turns') {
        return { kind: 'stopped', error: createError({ code: 'max_turns', message: `Reached the maximum of ${config.maxTurns} agent turns.` }),
          notice: `I stopped after reaching the limit of ${config.maxTurns} agent turns. Work completed so far is preserved in the workspace (see the changed files and git diff); send another message to continue.` }
      }
      if (stop?.reason === 'no_progress') {
        return { kind: 'stopped', error: createError({ code: 'no_progress', message: `${failedTurns} consecutive turns made no progress (every tool call failed).` }),
          notice: 'I stopped because several consecutive turns made no progress (every tool call failed). Work completed so far is preserved in the workspace; tell me how to proceed.' }
      }

      turnCount += 1
      const turnNo = sessions.get(sessionId).turns.length + 1
      setAgent(sessionId, { turnCount: agents.get(sessionId).turnCount + 1 })
      const startedAt = now()
      const model = sessions.get(sessionId).model
      const acc = { text: '' }
      const ctx = await contextEngine.build({
        session: sessions.get(sessionId), workspace, capabilities: provider.capabilities(model.model),
        tools: toolDefs, system, summarizer, requestedOutputTokens: config.maxOutputTokens,
      })
      if (ctx.summaryUpdate) sessions.update(sessionId, { contextSummary: ctx.summaryUpdate })
      noteContext(sessionId, ctx)
      let turn
      try {
        turn = await runProviderTurn({
          provider, signal, config, acc,
          request: {
            model: model.model,
            messages: ctx.messages,
            tools: ctx.tools,
            temperature: config.temperature,
            maxOutputTokens: config.maxOutputTokens,
            metadata: { sessionId, turn: turnNo },
          },
          onText: (text) => emit(sessionId, 'assistant.text.delta', { text }),
          onReasoning: () => emit(sessionId, 'assistant.reasoning.status', { text: 'Thinking…' }),
          onRetry: (info) => emit(sessionId, 'provider.retry', { ...info, provider: model.provider }),
          sleep, random,
        })
      } catch (e) {
        if (acc.text) commitAssistantText(sessionId, acc.text) // keep what the user already saw streaming
        throw e
      }

      // Commit the assistant message (text and tool calls together) before any tool runs.
      const calls = uniqueToolCalls(sessionId, turn.toolCalls)
      const message = sessions.appendMessage(sessionId, {
        role: 'assistant', content: turn.text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
      })
      if (turn.text !== '' || calls.length === 0) emit(sessionId, 'assistant.text.completed', { messageId: message.id, text: turn.text })
      const s = sessions.get(sessionId)
      sessions.update(sessionId, {
        tokenUsage: sum(s.tokenUsage, turn.usage),
        turns: [...s.turns, {
          turn: turnNo, startedAt, completedAt: now(), provider: model.provider, model: model.model,
          toolCalls: calls.map(c => ({ id: c.id, name: c.name })), usage: turn.usage, finishReason: turn.finishReason, context: ctx.metrics,
        }],
      })

      if (calls.length === 0) return { kind: 'completed' }

      // Loop guard: warn once on the Nth identical consecutive call, stop on the next.
      let stopRepeat = false
      const planned = calls.map(c => {
        const verdict = stopRepeat ? 'stop' : guard.observe(c.name, c.input)
        if (verdict === 'stop') stopRepeat = true
        const preflightError = c.inputError ? { code: 'invalid_input', message: c.inputError }
          : verdict === 'warn' ? { code: 'loop_detected', message: `The same ${c.name} call has been repeated ${config.maxIdenticalToolCalls} times with the same arguments and no new result. Choose a different approach.` }
            : verdict === 'stop' ? { code: 'loop_detected', message: 'Skipped: the same tool call kept repeating.' } : undefined
        return { id: c.id, name: c.name, input: c.input ?? {}, ...(preflightError ? { preflightError } : {}), skip: verdict === 'stop' }
      })

      const results = await executeToolCalls({
        registry: tools, calls: planned, signal,
        run: (c) => (c.skip ? skippedResult(sessionId, c, 'loop_detected', c.preflightError.message) : runTool(sessionId, c, signal)),
        skipped: (c) => skippedResult(sessionId, c, 'tool_cancelled', 'Cancelled before execution.'),
      })
      results.forEach((result, i) => {
        sessions.appendMessage(sessionId, {
          role: 'tool', toolCallId: planned[i].id, name: planned[i].name,
          content: serializeToolResult(result, { maxChars: limits.maxToolResultChars }),
          meta: observations.get(result) ?? describeObservation(planned[i], result),
        })
      })
      failedTurns = results.every(r => !r.ok) ? failedTurns + 1 : 0

      if (stopRepeat) {
        return { kind: 'stopped', error: createError({ code: 'loop_detected', message: 'The agent kept repeating the same tool call.' }),
          notice: 'I stopped because I kept repeating the same tool call without making progress. Work completed so far is preserved in the workspace; tell me how you would like to proceed.' }
      }
    }
  }

  function skippedResult(sessionId, call, code, message) {
    const result = { ...toolFailure(call.name, code, message), toolCallId: call.id, durationMs: 0 }
    recordToolCall(sessionId, {
      id: call.id, name: call.name, input: call.input, status: code === 'tool_cancelled' ? 'cancelled' : 'failed',
      resultSummary: summarizeToolResult(result), startedAt: now(), completedAt: now(),
    })
    return result
  }

  function finishCancelled(sessionId) {
    sessions.cancel(sessionId)
    setAgent(sessionId, { status: 'cancelled', abortController: null })
    emit(sessionId, 'session.cancelled', {})
  }

  /**
   * Submits a user message and runs the agent loop to completion. Resolves with the session snapshot;
   * provider and runtime failures are reported through events and session status, not rejection.
   * Rejects with a normalized `session_busy` error if a run is already active.
   * Lifecycle: idle → running → completed | cancelled | error; every state is reopenable by the next message.
   */
  async function sendMessage(sessionId, content) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.status === 'running' || !SENDABLE.has(session.status)) {
      throw createError({ code: 'session_busy', message: `Session is ${session.status}; wait for the current run to finish or stop it.` })
    }
    if (typeof content !== 'string' || content.trim() === '') throw new Error('Message content is required')

    const controller = new AbortController()
    setAgent(sessionId, { status: 'running', abortController: controller, error: null })
    sessions.setStatus(sessionId, 'running') // synchronous: closes the race for concurrent sendMessage calls
    const message = sessions.appendMessage(sessionId, { role: 'user', content })
    updateSummary(sessionId, (summary) => observeUserMessage(summary, message, now()))
    emit(sessionId, 'user.message', { messageId: message.id, content })
    emit(sessionId, 'session.updated', { status: 'running' })

    try {
      const outcome = await runAgent(sessionId, controller)
      setAgent(sessionId, { status: 'completed', abortController: null })
      if (outcome.kind === 'completed') {
        sessions.setStatus(sessionId, 'completed')
        emit(sessionId, 'session.completed', { turns: sessions.get(sessionId).turns.length })
      } else {
        commitAssistantText(sessionId, outcome.notice)
        setAgent(sessionId, { status: 'error', error: outcome.error })
        sessions.setStatus(sessionId, 'error')
        emit(sessionId, 'session.failed', { error: outcome.error })
      }
    } catch (e) {
      const error = toBluswanError(e)
      if (error.code === 'cancelled' || controller.signal.aborted) {
        finishCancelled(sessionId)
      } else {
        log.warn('run failed', { sessionId, code: error.code })
        setAgent(sessionId, { status: 'error', abortController: null, error })
        sessions.setStatus(sessionId, 'error')
        emit(sessionId, 'session.failed', { error })
      }
    }
    return sessions.get(sessionId)
  }

  /** Aborts the in-flight provider request and any running tool (including shell processes). Completed edits are kept. */
  function cancelSession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.status === 'cancelled') return session
    for (const c of toolControllers.get(sessionId) ?? []) c.abort()
    const controller = agents.get(sessionId)?.abortController
    if (controller && session.status === 'running') {
      controller.abort() // the running loop finalizes the cancellation
    } else {
      finishCancelled(sessionId)
    }
    return sessions.get(sessionId)
  }

  /**
   * Development/evaluation aid: how the next provider request would be composed for this session.
   * Metadata only (sources, priorities, token estimates) — no message bodies, so no secrets. Has no side effects.
   */
  async function debugContext(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    const { provider, workspace } = validateRun(session)
    const ctx = await contextEngine.build({
      session, workspace, capabilities: provider.capabilities(session.model.model), dryRun: true,
      tools: workspace ? tools.describeTools() : [], system: buildSystemPrompt(), requestedOutputTokens: config.maxOutputTokens,
    })
    return {
      estimatedTokens: ctx.totalEstimatedTokens, budget: ctx.budget, sections: ctx.sections, compacted: ctx.compacted, steps: ctx.steps,
      selectedItems: ctx.items, omittedItems: ctx.omitted, metrics: ctx.metrics,
      summaryRevision: (session.contextSummary ?? {}).revision ?? 0, stats: session.contextStats,
    }
  }

  /** Marks a session explicitly finished. */
  function completeSession(sessionId) {
    sessions.setStatus(sessionId, 'completed')
    emit(sessionId, 'session.completed', {})
    return sessions.get(sessionId)
  }

  return {
    startSession,
    createSession: startSession,
    sendMessage,
    cancelSession,
    completeSession,
    executeTool,
    debugContext,
    listTools: () => tools.describeTools(),
    getSession: (id) => sessions.get(id),
    listProviders: () => providers.listProviders(),
    /**
     * subscribe(listener) for all sessions, or subscribe(sessionId, listener) for one.
     * @returns {()=>void} unsubscribe
     */
    subscribe(a, b) {
      const [sessionId, listener] = typeof a === 'function' ? [null, a] : [a, b]
      return sessions.subscribe((event, snapshot) => { if (!sessionId || snapshot.id === sessionId) listener(event, snapshot) })
    },
  }
}
