// Provider-neutral agent runtime. Owns session execution; independent of React.
//
// Turn flow: user message → provider stream → normalized events → idle.
// Tool infrastructure (Phase 2): executeTool() routes a tool call through
// session → workspace → registry → executor. Providers do not drive tools yet;
// the autonomous tool loop arrives in Phase 3.
import { createEvent } from '../protocol/events.js'
import { createError, isBluswanError, newId } from '../protocol/schemas.js'
import { createSessionManager } from '../sessions/sessionManager.js'
import { defaultRegistry } from '../providers/registry.js'
import { getRuntimeConfig, getDefaultModelRef } from '../config/runtimeConfig.js'
import { createAgentState, updateAgentState } from './agentState.js'
import { composeStopConditions, maxTurns, userCancelled, unrecoverableError } from './stopConditions.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { createLogger } from '../utils/logger.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { createToolExecutor } from '../tools/executor.js'
import { toolFailure } from '../tools/result.js'
import { resolveLimits } from '../config/runtimeConfig.js'

const log = createLogger('runtime')
const SENDABLE = new Set(['idle', 'waiting_user', 'error'])

function toBluswanError(e) {
  if (isBluswanError(e)) return e
  return createError({ code: 'runtime_error', message: e?.message ?? 'Unexpected runtime failure', cause: e })
}

export function createAgentRuntime({
  providers = defaultRegistry,
  sessions = createSessionManager(),
  config = getRuntimeConfig(),
  workspaces = null, // workspace manager; required for executeTool and workspace-bound sessions
  tools = createDefaultToolRegistry(),
  toolPolicy,
  now = () => Date.now(),
} = {}) {
  const agents = new Map() // sessionId → agent state
  const toolControllers = new Map() // sessionId → Set<AbortController> of in-flight tool calls
  const toolExecutor = createToolExecutor({
    registry: tools, policy: toolPolicy, limits: resolveLimits({}, config), now,
  })

  const emit = (sessionId, type, data) =>
    sessions.appendEvent(sessionId, createEvent(type, sessionId, data, { timestamp: now() }))

  function setAgent(sessionId, patch) {
    const next = updateAgentState(agents.get(sessionId), patch, now())
    agents.set(sessionId, next)
    return next
  }

  function setStatus(sessionId, status) {
    sessions.setStatus(sessionId, status)
    emit(sessionId, 'session.updated', { status })
  }

  function finishCancelled(sessionId) {
    sessions.cancel(sessionId)
    setAgent(sessionId, { status: 'cancelled', abortController: null })
    emit(sessionId, 'session.cancelled', {})
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

  async function runTurn(sessionId, controller) {
    const session = sessions.get(sessionId)
    const provider = providers.getProvider(session.model.provider)
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...session.messages,
    ]
    let text = ''
    let streamError = null

    const aborted = new Promise((_, reject) => {
      const fail = () => reject(createError({ code: 'cancelled', message: 'Session cancelled.' }))
      if (controller.signal.aborted) fail()
      else controller.signal.addEventListener('abort', fail, { once: true })
    })
    aborted.catch(() => {}) // avoid unhandled rejection when the stream wins the race

    const stream = provider.stream({
      model: session.model.model,
      messages,
      tools: [],
      signal: controller.signal,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
    }, {
      onEvent(ev) {
        if (controller.signal.aborted) return
        switch (ev.type) {
          case 'text_delta':
            text += ev.text
            emit(sessionId, 'assistant.text.delta', { text: ev.text })
            break
          case 'reasoning_status':
            emit(sessionId, 'assistant.reasoning.status', { text: ev.text })
            break
          case 'usage': {
            const u = sessions.get(sessionId).tokenUsage
            sessions.update(sessionId, {
              tokenUsage: { input: u.input + ev.input, output: u.output + ev.output, total: u.total + ev.total },
            })
            break
          }
          case 'tool_call':
            // No tools are offered in Phase 1; a tool call is a protocol violation.
            streamError = createError({
              code: 'invalid_response', provider: session.model.provider,
              message: `Provider returned an unexpected tool call: ${ev.name}`,
            })
            break
          default:
            break
        }
      },
    })
    stream.catch(() => {}) // the race below observes the rejection

    await Promise.race([stream, aborted])
    if (streamError) throw streamError
    return text
  }

  /**
   * Submits a user message and runs one turn. Resolves with the session snapshot
   * when the turn ends; provider failures are reported via events, not rejection.
   */
  async function sendMessage(sessionId, content) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (!SENDABLE.has(session.status)) throw new Error(`Session is ${session.status}; cannot accept a message`)
    if (typeof content !== 'string' || content.trim() === '') throw new Error('Message content is required')

    const message = sessions.appendMessage(sessionId, { role: 'user', content })
    emit(sessionId, 'user.message', { messageId: message.id, content })

    const controller = new AbortController()
    setAgent(sessionId, { status: 'running', abortController: controller, error: null })
    setStatus(sessionId, 'running')

    const shouldStop = composeStopConditions(userCancelled(), maxTurns(config.maxTurns), unrecoverableError())
    let runTurns = 0

    try {
      const stop = shouldStop({ turnCount: runTurns, signal: controller.signal, error: null })
      if (stop) {
        if (stop.reason === 'cancelled') { finishCancelled(sessionId); return sessions.get(sessionId) }
        throw createError({ code: 'runtime_error', message: `Stopped before first turn: ${stop.reason}` })
      }

      runTurns += 1
      setAgent(sessionId, { turnCount: agents.get(sessionId).turnCount + 1 })
      const text = await runTurn(sessionId, controller)

      const reply = sessions.appendMessage(sessionId, { role: 'assistant', content: text })
      emit(sessionId, 'assistant.text.completed', { messageId: reply.id, text })
      setAgent(sessionId, { status: 'idle', abortController: null })
      setStatus(sessionId, 'idle')
    } catch (e) {
      const error = toBluswanError(e)
      if (error.code === 'cancelled' || controller.signal.aborted) {
        finishCancelled(sessionId)
      } else {
        log.warn('turn failed', { sessionId, code: error.code })
        setAgent(sessionId, { status: 'error', abortController: null, error })
        sessions.setStatus(sessionId, 'error')
        emit(sessionId, 'session.failed', { error })
      }
    }
    return sessions.get(sessionId)
  }

  function recordToolCall(sessionId, record) {
    const calls = sessions.get(sessionId).toolCalls
    const i = calls.findIndex(c => c.id === record.id)
    sessions.update(sessionId, { toolCalls: i < 0 ? [...calls, record] : calls.map((c, k) => (k === i ? record : c)) })
  }

  /**
   * Executes one tool call against the session's workspace and records it on the
   * session. Resolves with the normalized tool result; tool failures never reject.
   * @param {string} sessionId
   * @param {{id?:string, name:string, input?:object}} call
   */
  async function executeTool(sessionId, call) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.status === 'cancelled' || session.status === 'completed') {
      throw new Error(`Session is ${session.status}; cannot execute tools`)
    }
    if (!call || typeof call.name !== 'string') throw new Error('Tool call requires a name')
    const id = call.id ?? `tool_${newId()}`
    const input = call.input ?? {}
    const startedAt = now()
    const record = { id, name: call.name, input, result: null, status: 'running', startedAt, completedAt: null }

    const workspace = session.workspaceId && workspaces ? workspaces.getWorkspace(session.workspaceId) : null
    recordToolCall(sessionId, record)
    if (!workspace) {
      const result = { ...toolFailure(call.name, 'workspace_not_found',
        session.workspaceId ? `Workspace not found: ${session.workspaceId}` : 'Session has no workspace'), toolCallId: id, durationMs: 0 }
      emit(sessionId, 'tool.started', { toolCallId: id, tool: call.name })
      emit(sessionId, 'tool.failed', { toolCallId: id, tool: call.name, durationMs: 0, error: result.error })
      recordToolCall(sessionId, { ...record, result, status: 'failed', completedAt: now() })
      return result
    }

    const controller = new AbortController()
    if (!toolControllers.has(sessionId)) toolControllers.set(sessionId, new Set())
    toolControllers.get(sessionId).add(controller)
    try {
      const result = await toolExecutor.execute({
        workspace, call: { id, name: call.name, input }, signal: controller.signal,
        emit: (type, data) => {
          emit(sessionId, type, data)
          if (type === 'file.changed') {
            const files = sessions.get(sessionId).changedFiles
            if (!files.includes(data.path)) sessions.update(sessionId, { changedFiles: [...files, data.path] })
          }
        },
      })
      recordToolCall(sessionId, { ...record, result, status: result.ok ? 'completed' : 'failed', completedAt: now() })
      return result
    } finally {
      toolControllers.get(sessionId)?.delete(controller)
    }
  }

  /** Aborts any in-flight provider request and ends the session as cancelled. */
  function cancelSession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.status === 'cancelled') return session
    for (const c of toolControllers.get(sessionId) ?? []) c.abort()
    const controller = agents.get(sessionId)?.abortController
    if (controller) {
      controller.abort() // the in-flight turn finalizes the cancellation
    } else {
      finishCancelled(sessionId)
    }
    return sessions.get(sessionId)
  }

  /** Marks a session explicitly finished. */
  function completeSession(sessionId) {
    sessions.setStatus(sessionId, 'completed')
    emit(sessionId, 'session.completed', {})
    return sessions.get(sessionId)
  }

  return {
    startSession,
    sendMessage,
    cancelSession,
    completeSession,
    executeTool,
    listTools: () => tools.describeTools(),
    getSession: (id) => sessions.get(id),
    listProviders: () => providers.listProviders(),
    /** @param {(event:object, session:object)=>void} listener */
    subscribe: (listener) => sessions.subscribe(listener),
  }
}
