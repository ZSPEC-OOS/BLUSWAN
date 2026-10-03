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
import { createSessionSummary, observeUserMessage, observeToolResult, observeRevert } from '../context/sessionSummary.js'
import { describeObservation } from '../context/toolContext.js'
import { observeFileRead, invalidateFiles } from '../context/repositoryContext.js'
import { runProviderTurn } from './providerTurn.js'
import { executeToolCalls } from './toolScheduler.js'
import { serializeToolResult, summarizeToolResult } from './toolResults.js'
import { redactSecrets } from '../utils/redact.js'
import { createLogger } from '../utils/logger.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { createToolExecutor } from '../tools/executor.js'
import { toolFailure } from '../tools/result.js'
import { assertCodingCapable } from '../providers/capabilities.js'
import { evaluateEscalation } from '../routing/escalation.js'
import { MODES, TIERS } from '../routing/profiles.js'
import { decidePermission, describePermission, isPermissionMode, BLOCKED_MESSAGE, DEFAULT_PERMISSION_MODE } from '../tools/permissionModes.js'
import { createValidationEngine } from '../validation/validationEngine.js'
import { createValidationState, markMutated, recordShellResult } from '../validation/validationState.js'
import { createCompletion, collectGitEvidence, formatValidationCycle, formatEvidenceOnly, describeValidationCycle } from './completion.js'
import { createRunCounters, decideRecovery } from './recovery.js'
import { checkClaims } from './claimChecker.js'

const log = createLogger('runtime')
// A finished, cancelled or failed run leaves the conversation open for the next user message.
const SENDABLE = new Set(['idle', 'completed', 'cancelled', 'error', 'waiting_user', 'interrupted'])

function toBluswanError(e) {
  if (isBluswanError(e)) return e
  log.warn('unexpected runtime failure', { name: e?.name, message: redactSecrets(String(e?.message ?? '')).slice(0, 200) })
  return createError({ code: 'runtime_error', message: e?.message ?? 'Unexpected runtime failure', cause: e })
}

const sum = (a, b) => ({
  input: a.input + b.input, output: a.output + b.output, reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0), total: a.total + b.total,
  ...(a.cachedInput != null || b.cachedInput != null ? { cachedInput: (a.cachedInput ?? 0) + (b.cachedInput ?? 0) } : {}),
})

export function createAgentRuntime({
  providers = defaultRegistry,
  sessions = createSessionManager(),
  config = getRuntimeConfig(),
  workspaces = null, // workspace manager; sessions with a workspaceId get tools
  workspaceNotes = null, // async (workspaceId) => text appended to the system prompt (e.g. the branch workflow the user manages)
  tools = createDefaultToolRegistry(),
  routing = null, // adaptive routing (agent/routingBridge.js createRouting); null = manual provider/model selection only
  toolPolicy,
  approvals = 'unattended', // 'interactive': actions that need approval wait for approvePermission/denyPermission; 'unattended': they fail with permission_required
  now = () => Date.now(),
  sleep, // test seam for retry backoff
  random,
} = {}) {
  const agents = new Map() // sessionId → agent state
  const toolControllers = new Map() // sessionId → Set<AbortController> for manual executeTool calls
  const limits = resolveLimits({}, config)
  const toolExecutor = createToolExecutor({ registry: tools, policy: toolPolicy, limits, now })
  const contextEngine = createContextEngine({ config, now })
  let permissionMode = isPermissionMode(config.permissionMode) ? config.permissionMode : DEFAULT_PERMISSION_MODE
  const pendingPermissions = new Map() // permissionId → { request, approve(), deny() }
  const validationEngine = createValidationEngine({ config, now })
  const completion = createCompletion({ validationEngine })
  const observations = new WeakMap() // tool result → compact observation (stored on the tool message)

  function updateSummary(sessionId, fn) {
    const s = sessions.get(sessionId)
    sessions.update(sessionId, { contextSummary: fn(s.contextSummary ?? createSessionSummary(now())) })
  }

  function setValidation(sessionId, next) { sessions.update(sessionId, { validation: next }) }
  const validationOf = (sessionId) => sessions.get(sessionId).validation ?? createValidationState()

  /** Validation results enter the structured summary exactly like shell checks (commands, failures, resolution). */
  function recordValidationSummary(sessionId, results) {
    for (const r of results.filter(x => ['passed', 'failed', 'error'].includes(x.status))) {
      const shellLike = { ok: true, tool: 'shell', output: { command: r.command, exitCode: r.status === 'passed' ? 0 : (r.exitCode ?? 1), stdout: r.diagnostics?.keyMessages?.join('\n') || r.outputExcerpt || r.summary, stderr: '' } }
      updateSummary(sessionId, (summary) => observeToolResult(summary, { call: { name: 'shell', input: { command: r.command } }, result: shellLike, now: now() }))
    }
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
    if (obs.changed.length || call.name === 'shell') bumpRevision(workspace.id)
    if (obs.changed.length) {
      invalidateFiles(workspace, obs.changed.map(c => c.path))
      setValidation(sessionId, markMutated(validationOf(sessionId), obs.changed)) // earlier evidence no longer describes the code
      validationEngine.invalidate(workspace, obs.changed.map(c => c.path))
    }
    if (call.name === 'shell') {
      try {
        const check = await validationEngine.fromShell(workspace, call, result) // checks the agent runs itself count as evidence
        if (check) setValidation(sessionId, recordShellResult(validationOf(sessionId), check, { now: now() }))
      } catch { /* evidence capture must never break a run */ }
    }
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

  function startSession({ workspaceId = null, model, id, modelPreference = null } = {}) {
    if (workspaceId !== null && workspaces && !workspaces.getWorkspace(workspaceId)) {
      throw new Error(`Unknown workspace: ${workspaceId}`)
    }
    const session = sessions.create({ workspaceId, model: model ?? getDefaultModelRef(config), id, modelPreference })
    agents.set(session.id, createAgentState(session.id, now()))
    emit(session.id, 'session.started', { model: session.model, workspaceId, modelPreference: session.modelPreference })
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


  // ─── Workspace review state (changes, diffs, command output, revert) ───────

  const workspaceRevisions = new Map() // workspaceId → counter, bumped by anything that may change files
  const commandLogs = new Map() // sessionId → [{ id, source, command, … stdout, stderr }]
  const MAX_COMMANDS = 200
  const MAX_STREAM_CHARS = 64_000

  const bumpRevision = (workspaceId) => { if (workspaceId) workspaceRevisions.set(workspaceId, (workspaceRevisions.get(workspaceId) ?? 0) + 1); return workspaceRevisions.get(workspaceId) ?? 0 }
  const revisionOf = (workspaceId) => workspaceRevisions.get(workspaceId) ?? 0

  /** Bounded, redacted copy of command output; the UI shows exactly this (and says when it is cut). */
  function boundStream(text) {
    const t = redactSecrets(String(text ?? ''))
    return t.length > MAX_STREAM_CHARS ? { text: `${t.slice(0, MAX_STREAM_CHARS)}`, cut: true } : { text: t, cut: false }
  }

  function addCommand(sessionId, record) {
    const list = commandLogs.get(sessionId) ?? []
    const i = list.findIndex(c => c.id === record.id)
    if (i >= 0) list[i] = record
    else list.push(record)
    if (list.length > MAX_COMMANDS) list.splice(0, list.length - MAX_COMMANDS)
    commandLogs.set(sessionId, list)
    const { stdout: _o, stderr: _e, ...meta } = record // output stays out of the event stream; fetch it with getCommand
    emit(sessionId, 'command.completed', meta)
  }

  function recordShellCommand(sessionId, call, result, startedAt) {
    const out = result.output ?? {}
    const so = boundStream(out.stdout)
    const se = boundStream(out.stderr)
    const cancelled = result.error?.code === 'command_cancelled' || !!out.cancelled
    const timedOut = result.error?.code === 'command_timeout' || !!out.timedOut
    addCommand(sessionId, {
      id: call.id, source: 'shell', command: redactSecrets(call.input?.command ?? out.command ?? ''), cwd: out.cwd ?? '',
      exitCode: out.exitCode ?? null, signal: out.signal ?? null, timedOut, cancelled,
      status: cancelled ? 'cancelled' : timedOut ? 'timeout' : !result.ok ? 'error' : out.exitCode === 0 ? 'passed' : 'failed',
      durationMs: out.durationMs ?? Math.max(0, now() - startedAt), startedAt, completedAt: now(),
      stdout: so.text, stderr: se.text, truncated: !!out.truncated || so.cut || se.cut,
      error: !result.ok && !cancelled && !timedOut ? result.error?.message ?? null : null,
    })
  }

  function recordValidationCommands(sessionId, results) {
    for (const r of results) {
      const text = boundStream(r.outputExcerpt)
      addCommand(sessionId, {
        id: r.id, source: 'validation', kind: r.kind, command: redactSecrets(r.command), cwd: '', exitCode: r.exitCode ?? null, signal: null,
        timedOut: /timed out/.test(r.summary ?? ''), cancelled: r.status === 'cancelled', status: r.status, durationMs: r.durationMs ?? 0,
        startedAt: r.startedAt ?? null, completedAt: r.completedAt ?? null, stdout: text.text, stderr: '', combined: true,
        truncated: !!r.outputTruncated || text.cut, error: null,
      })
    }
  }

  const workspaceOf = (session) => (session?.workspaceId && workspaces ? workspaces.getWorkspace(session.workspaceId) : null)
  const asSessionFile = (f) => ({
    path: f.path, status: f.action === 'created' || f.action === 'added' ? 'added' : f.action === 'deleted' ? 'deleted' : 'modified',
    additions: null, deletions: null, binary: false, staged: false, untracked: false,
  })

  /** One authoritative read of the review state: git when the workspace is a repository, else session history. */
  async function getWorkspaceState(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) throw createError({ code: 'not_found', message: 'Unknown session.' })
    const workspace = workspaceOf(session)
    const validation = session.validation ?? createValidationState()
    const base = { sessionId, workspaceId: session.workspaceId, revision: revisionOf(session.workspaceId), updatedAt: now(), validation }
    if (!workspace) return { ...base, source: 'none', repository: null, files: session.changedFiles.map(asSessionFile), summary: { files: session.changedFiles.length, additions: null, deletions: null } }
    const repository = await workspace.refreshRepository().catch(() => workspace.metadata.repository)
    const repo = { name: repository.name, branch: repository.branch ?? null, headSha: repository.headSha ?? null, isGitRepository: !!repository.isGitRepository }
    if (repo.isGitRepository && workspace.gitChanges) {
      try {
        const ch = await workspace.gitChanges()
        const before = new Set((workspace.metadata.baseline.initialStatus?.entries ?? []).map(e => e.path))
        const files = ch.files.map(f => ({ ...f, preexisting: before.has(f.path) && !session.changedFiles.some(c => c.path === f.path) }))
        return { ...base, source: 'git', repository: { ...repo, branch: ch.branch, headSha: ch.headSha }, files, summary: { files: files.length, additions: ch.additions, deletions: ch.deletions } }
      } catch (e) {
        return { ...base, source: 'session', repository: repo, error: { code: e?.code ?? 'git_error', message: 'Could not read the repository state.' }, files: session.changedFiles.map(asSessionFile), summary: { files: session.changedFiles.length, additions: null, deletions: null } }
      }
    }
    return { ...base, source: 'session', repository: repo, files: session.changedFiles.map(asSessionFile), summary: { files: session.changedFiles.length, additions: null, deletions: null } }
  }

  /** Unified diff of one file against HEAD (git), or its current contents when no git diff exists. */
  async function getFileDiff(sessionId, filePath, { from } = {}) {
    const session = sessions.get(sessionId)
    const workspace = workspaceOf(session)
    if (!workspace) throw createError({ code: 'workspace_not_found', message: 'No repository is connected to this session.' })
    const revision = revisionOf(session.workspaceId)
    if (workspace.metadata.repository?.isGitRepository) {
      const d = await workspace.gitDiff({ path: filePath, againstHead: true, alsoPaths: from ? [from] : [] })
      return { source: 'git', path: filePath, revision, diff: d.diff, truncated: d.truncated, additions: d.additions, deletions: d.deletions, binary: d.files.some(f => f.binary) }
    }
    const tracked = session.changedFiles.find(f => f.path === filePath)
    if (tracked?.action === 'deleted') return { source: 'session', path: filePath, revision, contents: null, deleted: true }
    const r = await workspace.readFile(filePath, { maxBytes: 200_000 })
    return { source: 'session', path: filePath, revision, contents: r.content, truncated: !!r.truncated }
  }

  /**
   * User-driven revert of one file (confirmed in the UI). Not exposed to the model. Discards the file's
   * uncommitted changes, then brings session, validation and context state back in line with the workspace.
   */
  async function revertFile(sessionId, filePath) {
    const session = sessions.get(sessionId)
    if (!session) throw createError({ code: 'not_found', message: 'Unknown session.' })
    if (session.status === 'running' || session.status === 'waiting_permission') {
      throw createError({ code: 'session_busy', message: 'Stop BLUSWAN before reverting a file.' })
    }
    const workspace = workspaceOf(session)
    if (!workspace?.revertFile || !workspace.metadata.repository?.isGitRepository) {
      throw createError({ code: 'revert_unsupported', message: 'Reverting files needs a Git repository.' })
    }
    let result
    try {
      result = await workspace.revertFile(filePath)
    } catch (e) {
      throw createError({ code: e?.code === 'nothing_to_revert' ? 'nothing_to_revert' : 'revert_failed', message: e?.code === 'nothing_to_revert' ? 'That file has no uncommitted changes.' : `Could not revert ${filePath}.`, cause: e?.message })
    }
    const revision = bumpRevision(session.workspaceId)
    sessions.update(sessionId, { changedFiles: sessions.get(sessionId).changedFiles.filter(f => f.path !== filePath) })
    setValidation(sessionId, markMutated(validationOf(sessionId), [{ path: filePath, action: 'reverted' }])) // earlier evidence no longer describes this code
    updateSummary(sessionId, (summary) => observeRevert(summary, { path: filePath, now: now() }))
    invalidateFiles(workspace, [filePath])
    validationEngine.invalidate(workspace, [filePath])
    contextEngine.invalidateWorkspace(workspace.id)
    emit(sessionId, 'file.reverted', { path: filePath, action: 'reverted', result: result.action, revision })
    return { ok: true, path: filePath, result: result.action, revision }
  }


  // ─── Persistence hooks (the runtime itself never touches storage) ───────────

  /** Serializable snapshot for persistence: the session plus the bounded command log. */
  function exportSession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return null
    return { session, commands: (commandLogs.get(sessionId) ?? []).map(c => ({ ...c })) }
  }

  /**
   * Re-creates a session from persisted state. Nothing from the previous process is running: a session that was
   * active is registered as `interrupted` (with a `session.interrupted` event) and is never resumed automatically.
   * @param {{session:object, commands?:object[]}} saved
   * @param {{note?:object}} [options] `note` is attached to the session.updated event (e.g. workspace drift info)
   */
  function restoreSession({ session, commands = [] }, { note = null } = {}) {
    if (sessions.get(session.id)) throw createError({ code: 'session_busy', message: 'Session is already loaded.' })
    const wasActive = session.status === 'running' || session.status === 'waiting_permission'
    sessions.load(wasActive ? { ...session, status: 'interrupted' } : session)
    agents.set(session.id, createAgentState(session.id, now()))
    commandLogs.set(session.id, commands.slice(-MAX_COMMANDS))
    if (wasActive) {
      // Tool calls the model declared but that never returned (the process vanished) get an explicit "unknown" result,
      // so the history stays valid for the provider and the model is told to check the workspace instead of assuming.
      const answered = new Set(sessions.get(session.id).messages.filter(m => m.role === 'tool').map(m => m.toolCallId))
      for (const m of sessions.get(session.id).messages) {
        for (const c of m.toolCalls ?? []) {
          if (answered.has(c.id)) continue
          sessions.appendMessage(session.id, {
            role: 'tool', toolCallId: c.id, name: c.name,
            content: `Tool: ${c.name}\nStatus: interrupted\nThe application stopped before this call returned. It may or may not have taken effect; inspect the workspace (git status / git diff) before relying on it.`,
            meta: { ok: false, compact: `${c.name} was interrupted; its effect is unknown.`, paths: [], hits: [], changed: [] },
          })
        }
      }
      sessions.update(session.id, { toolCalls: sessions.get(session.id).toolCalls.map(c => (c.status === 'running' ? { ...c, status: 'interrupted' } : c)) })
      emit(session.id, 'session.interrupted', { previousStatus: session.status, reason: 'restart' })
    }
    if (note) emit(session.id, 'session.updated', { status: sessions.get(session.id).status, restored: true, ...note })
    return sessions.get(session.id)
  }

  /**
   * Brings a restored session in line with the workspace as it is now: the files it may still call "changed", and
   * validation evidence that no longer describes the code.
   */
  function reconcileSession(sessionId, { changedFiles, workspaceChanged = false, changedPaths = [] } = {}) {
    const session = sessions.get(sessionId)
    if (!session) return null
    if (changedFiles) sessions.update(sessionId, { changedFiles })
    if (workspaceChanged && (session.validation?.results?.length || session.validation?.mutationSeq)) {
      const paths = changedPaths.length ? changedPaths : ['workspace']
      setValidation(sessionId, markMutated(validationOf(sessionId), paths.map(path => ({ path: path === 'workspace' ? 'workspace.external' : path, action: 'external' }))))
    }
    return sessions.get(sessionId)
  }

  // ─── Permissions ────────────────────────────────────────────────────────────

  /**
   * Builds the authorization hook for one session's tool calls. Policy comes from the permission mode and the
   * tool's effect class. When approval is needed and approvals are interactive, the call really waits:
   * the session enters waiting_permission, `permission.requested` is emitted, and the tool runs only after
   * approvePermission(); denial (or cancellation) is returned to the model as an ordinary tool failure.
   */
  function authorizeFor(sessionId, signal) {
    return async ({ toolCallId, tool, input, effect, reason }) => {
      const action = decidePermission(permissionMode, effect)
      if (action === 'allow') return { allowed: true }
      if (action === 'block') return { allowed: false, code: 'permission_denied', message: BLOCKED_MESSAGE }
      if (approvals !== 'interactive') {
        return { allowed: false, code: 'permission_required', message: `This action requires user approval (${effect}): ${reason ?? tool}` }
      }
      if (signal.aborted) return { allowed: false, code: 'tool_cancelled', message: 'Cancelled before approval.' }

      const request = { id: `perm_${newId()}`, sessionId, toolCallId, tool, effect, createdAt: now(), ...describePermission({ tool, input, effect }) }
      return new Promise((resolve) => {
        let done = false
        const settle = (decision, outcome) => {
          if (done) return
          done = true
          signal.removeEventListener('abort', onAbort)
          pendingPermissions.delete(request.id)
          emit(sessionId, 'permission.resolved', { id: request.id, toolCallId, decision: outcome })
          if (sessions.get(sessionId)?.status === 'waiting_permission' && !signal.aborted) {
            sessions.setStatus(sessionId, 'running')
            emit(sessionId, 'session.updated', { status: 'running' })
          }
          resolve(decision)
        }
        const onAbort = () => settle({ allowed: false, code: 'tool_cancelled', message: 'Cancelled while waiting for approval.' }, 'cancelled')
        signal.addEventListener('abort', onAbort, { once: true })
        pendingPermissions.set(request.id, {
          request,
          approve: () => settle({ allowed: true }, 'approved'),
          deny: () => settle({ allowed: false, code: 'permission_denied', message: 'The user denied this action.' }, 'denied'),
        })
        sessions.setStatus(sessionId, 'waiting_permission')
        emit(sessionId, 'session.updated', { status: 'waiting_permission' })
        emit(sessionId, 'permission.requested', request)
      })
    }
  }

  function resolvePermission(sessionId, permissionId, decision) {
    const entry = pendingPermissions.get(permissionId)
    if (!entry || entry.request.sessionId !== sessionId) return false
    entry[decision]()
    return true
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
        workspace, call, signal, authorize: authorizeFor(sessionId, signal),
        emit: (type, data) => {
          emit(sessionId, type, data)
          if (type === 'file.changed') trackChangedFile(sessionId, data)
        },
      })
    }
    if (workspace) await observeResult(sessionId, workspace, call, result)
    if (call.name === 'shell' && (result.ok || result.output)) recordShellCommand(sessionId, call, result, record.startedAt)
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
      // acting on a repository needs tool calling: decided from capabilities, never from the provider's name
      assertCodingCapable(provider.capabilities(session.model.model), { provider: session.model.provider, model: session.model.model })
    }
    return { provider, workspace }
  }

  // ─── Adaptive routing ───────────────────────────────────────────────────────
  // The router picks a profile (provider, model, reasoning effort) per user request; everything after that is the
  // one existing agent loop. The route lives on the run object, so concurrent runs never share a tier.

  /** Bounded facts about the session the router may use for follow-ups; never message content. */
  function routingContext(session) {
    const last = [...(session.runs ?? [])].reverse().find(r => r.route)
    return {
      prior: last ? { tier: last.route.finalTier, score: last.route.score ?? 0, failedValidation: last.outcome === 'failed' || last.validation?.finalValidationStatus === 'failed' } : null,
      changedFiles: session.changedFiles.length,
      unresolvedFailures: (session.validation?.unresolved ?? []).length,
    }
  }

  const routeEventData = (route) => ({ mode: route.mode, tier: route.tier, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort, source: route.source, reasonCodes: route.reasonCodes })

  /** Resolves this request's route (Auto: signals/classifier; Flash/Pro: the forced profile) and points the session at it. */
  async function routeRun(sessionId, content, controller, run) {
    const session = sessions.get(sessionId)
    if (!session.modelPreference) return // manual selection (and every pre-routing session): session.model runs as chosen
    if (!routing) throw createError({ code: 'configuration_error', message: 'Automatic model selection is not configured on this server. Choose a model in Settings.' })
    const route = await routing.router.route({ mode: session.modelPreference, message: content, context: routingContext(session), signal: controller.signal })
    if (controller.signal.aborted) throw createError({ code: 'cancelled', message: 'Session cancelled.' })
    run.route = { ...route, initialTier: route.tier, escalated: false }
    sessions.update(sessionId, { model: { provider: route.provider, model: route.model } })
    log.info('route selected', { sessionId, ...routeEventData(route), classifier: route.classifier?.outcome ?? null }) // codes and ids only: never prompts or reasoning
    emit(sessionId, 'model.route.selected', routeEventData(route))
    emit(sessionId, 'session.updated', { status: sessions.get(sessionId).status, model: sessions.get(sessionId).model })
  }

  /** At a safe turn boundary: moves a Fast run to the Advanced profile (once, never back). History and state are untouched. */
  function maybeEscalate(sessionId, run, failedTurns) {
    if (!run.route || run.route.escalationBlocked) return false
    const verdict = evaluateEscalation(run.route, {
      recoveryRounds: run.counters.recoveryRounds, repairSucceeded: run.counters.repairSucceeded, sawFailure: run.counters.sawFailure,
      failedTurns, newChangedFiles: Math.max(0, sessions.get(sessionId).changedFiles.length - run.changedAtStart),
    })
    if (!verdict.escalate) return false
    const target = routing?.profiles?.advanced
    try {
      if (!target || routing.evaluation.tiers.advanced?.ok === false) throw new Error('advanced profile unavailable')
      const provider = providers.getProvider(target.provider)
      provider.validate?.(target.model)
      assertCodingCapable(provider.capabilities(target.model), { provider: target.provider, model: target.model })
    } catch (e) {
      run.route = {
        ...run.route,
        escalationRequired: true,
        escalationFailureReason: 'advanced_unavailable',
        escalationReason: verdict.reasonCode,
      }
      log.warn('escalation required but unavailable', { sessionId, reason: verdict.reasonCode, provider: target?.provider ?? null })
      throw createError({
        code: 'configuration_error',
        provider: target?.provider ?? null,
        message: 'BLUSWAN determined this request needs Pro, but the Pro profile is unavailable. Work completed so far is preserved. Restore the Pro profile or choose how to continue.',
        cause: e?.message,
      })
    }
    const from = run.route.tier
    run.route = { ...run.route, tier: TIERS.ADVANCED, provider: target.provider, model: target.model, reasoningEffort: target.reasoningEffort, escalated: true, escalationReason: verdict.reasonCode }
    sessions.update(sessionId, { model: { provider: target.provider, model: target.model } })
    log.info('route escalated', { sessionId, from, to: TIERS.ADVANCED, reasonCode: verdict.reasonCode })
    emit(sessionId, 'model.route.escalated', { from, to: TIERS.ADVANCED, provider: target.provider, model: target.model, reasoningEffort: target.reasoningEffort, reasonCode: verdict.reasonCode })
    emit(sessionId, 'session.updated', { status: sessions.get(sessionId).status, model: sessions.get(sessionId).model })
    return true
  }

  /** Safe usage/outcome summary of a routed run, grouped into one segment per tier. Never contains prompts or reasoning. */
  function summarizeRoute(run, turns) {
    const segments = []
    for (const t of turns) {
      let seg = segments.at(-1)
      if (!seg || seg.tier !== t.tier) {
        seg = { tier: t.tier, provider: t.provider, model: t.model, reasoningEffort: t.reasoningEffort ?? null, turns: 0, toolCalls: 0, input: 0, output: 0, reasoning: 0, cachedInput: 0, durationMs: 0 }
        segments.push(seg)
      }
      seg.turns += 1; seg.toolCalls += t.toolCalls.length; seg.durationMs += Math.max(0, t.completedAt - t.startedAt)
      seg.input += t.usage?.input ?? 0; seg.output += t.usage?.output ?? 0; seg.reasoning += t.usage?.reasoning ?? 0; seg.cachedInput += t.usage?.cachedInput ?? 0
    }
    const r = run.route
    return {
      requestedMode: r.mode, initialTier: r.initialTier, finalTier: r.tier, escalated: r.escalated, escalationReason: r.escalationReason ?? null,
      escalationRequired: !!r.escalationRequired, escalationFailureReason: r.escalationFailureReason ?? null,
      source: r.source, reasonCodes: r.reasonCodes, score: r.score ?? null,
      classifier: r.classifier ? { used: true, outcome: r.classifier.outcome, usage: r.classifier.usage, durationMs: r.classifier.durationMs } : { used: false },
      segments,
    }
  }

  /**
   * Sets the routing preference for the NEXT run (auto | fast | advanced), or null for a manual provider/model
   * selection. Allowed only between runs. Flash/Pro point the session at that profile immediately.
   */
  function setModelPreference(sessionId, mode) {
    const session = sessions.get(sessionId)
    if (!session) throw createError({ code: 'not_found', message: 'Unknown session.' })
    if (session.status === 'running' || session.status === 'waiting_permission') {
      throw createError({ code: 'session_busy', message: 'Stop BLUSWAN before changing the model.' })
    }
    if (mode !== null && ![MODES.AUTO, MODES.FAST, MODES.ADVANCED].includes(mode)) throw createError({ code: 'invalid_request', message: 'Choose Auto, Flash or Pro.' })
    if (mode !== null) {
      if (!routing) throw createError({ code: 'configuration_error', message: 'Automatic model selection is not configured on this server.' })
      const need = mode === MODES.AUTO ? [TIERS.FAST, TIERS.ADVANCED] : [mode === MODES.FAST ? TIERS.FAST : TIERS.ADVANCED]
      for (const tier of need) {
        const t = routing.evaluation.tiers[tier]
        if (!t?.ok) throw createError({ code: 'configuration_error', message: t?.reason ?? 'That model profile is unavailable.' })
      }
    }
    const patch = { modelPreference: mode }
    if (mode === MODES.FAST || mode === MODES.ADVANCED) {
      const p = routing.profiles[mode]
      patch.model = { provider: p.provider, model: p.model }
    }
    sessions.update(sessionId, patch)
    const next = sessions.get(sessionId)
    emit(sessionId, 'session.updated', { status: next.status, model: next.model, modelPreference: next.modelPreference })
    return { modelPreference: next.modelPreference, model: next.model }
  }

  /**
   * Chooses the model for the NEXT run. Allowed only between runs; the canonical history, summary, workspace and
   * validation state carry over unchanged (nothing provider-specific is stored, so nothing needs migrating).
   */
  function setSessionModel(sessionId, model) {
    const session = sessions.get(sessionId)
    if (!session) throw createError({ code: 'not_found', message: 'Unknown session.' })
    if (session.status === 'running' || session.status === 'waiting_permission') {
      throw createError({ code: 'session_busy', message: 'Stop BLUSWAN before changing the model.' })
    }
    if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string' || !model.model) {
      throw createError({ code: 'invalid_request', message: 'Choose a provider and a model.' })
    }
    const provider = providers.getProvider(model.provider) // unknown provider → configuration_error
    if (session.workspaceId) assertCodingCapable(provider.capabilities(model.model), { provider: model.provider, model: model.model })
    sessions.update(sessionId, { model: { provider: model.provider, model: model.model }, modelPreference: null }) // an explicit provider/model is a manual choice
    emit(sessionId, 'session.updated', { status: sessions.get(sessionId).status, model: { provider: model.provider, model: model.model }, modelPreference: null })
    return sessions.get(sessionId).model
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

  const userInstructionsFor = (session) => [
    [...session.messages].reverse().find(m => m.role === 'user')?.content ?? '',
    ...(session.contextSummary?.decisions ?? []).map(d => d.text),
  ]

  async function decideCompletion(sessionId, workspace, run) {
    const session = sessions.get(sessionId)
    try {
      return await completion.decide({ session, workspace, counters: run.counters, userInstructions: userInstructionsFor(session) })
    } catch (e) {
      log.warn('completion check failed', { message: redactSecrets(String(e?.message ?? '')).slice(0, 200) })
      return { action: 'complete', reason: 'validation_planning_failed', state: validationOf(sessionId), outcome: 'warning' }
    }
  }

  /** The model produced a final answer: record the evidence state, check its validation claims, set the outcome. */
  function finishRun(sessionId, decision, text, run) {
    if (decision.state !== sessions.get(sessionId).validation) setValidation(sessionId, decision.state)
    const warnings = checkClaims(text, decision.state)
    for (const w of warnings) {
      run.counters.warnings.push(w)
      emit(sessionId, 'completion.warning', { claim: w.claim, kind: w.kind, problem: w.problem })
    }
    const outcome = decision.outcome === 'success' && warnings.length ? 'warning' : decision.outcome
    return { kind: 'completed', outcome, reason: decision.reason }
  }

  /** Runs the planned checks (or just presents evidence) and records the result as a runtime-initiated tool cycle. */
  async function runCompletionCycle(sessionId, workspace, signal, run, cycle, call) {
    const c = run.counters
    const changedFiles = () => sessions.get(sessionId).changedFiles
    let content
    let meta
    try {
      let state = cycle.state
      if (cycle.action === 'validate') {
        c.validationRounds += 1
        if (cycle.staleBlocked) c.staleValidationPrevented += 1
        const ran = await validationEngine.run({ workspace, decision: cycle.plan, state, signal, emit: (type, data) => emit(sessionId, type, data) })
        state = ran.state
        setValidation(sessionId, state)
        recordValidationSummary(sessionId, ran.results)
        recordValidationCommands(sessionId, ran.results)
        const failed = ran.results.some(r => r.status === 'failed' || r.status === 'error')
        const allPassed = ran.results.length > 0 && ran.results.every(r => r.status === 'passed')
        c.commandsRun += ran.results.length
        c.passes += ran.results.filter(r => r.status === 'passed').length
        c.failures += ran.results.filter(r => r.status === 'failed' || r.status === 'error').length
        c.durationMs += ran.results.reduce((n, r) => n + r.durationMs, 0)
        if (c.firstRoundPassed === null) c.firstRoundPassed = allPassed
        let recovery = { action: 'continue', reason: 'none' }
        if (failed) {
          recovery = decideRecovery({ results: ran.results, counters: c, config: validationEngine.config, mutationSeq: state.mutationSeq })
          c.sawFailure = true
          c.lastFailureSeq = state.mutationSeq
          if (recovery.action === 'continue') c.recoveryRounds += 1
          else c.evidencePresented = true
        } else if (allPassed && c.sawFailure) c.repairSucceeded = true
        const git = failed && recovery.action === 'continue' ? null : await collectGitEvidence(workspace)
        content = formatValidationCycle({ plan: cycle.plan, results: ran.results, state, changedFiles: changedFiles(), git, recovery })
        meta = describeValidationCycle({ results: ran.results, state })
      } else {
        c.evidencePresented = true
        content = formatEvidenceOnly({ state, changedFiles: changedFiles(), git: await collectGitEvidence(workspace), reason: cycle.reason })
        meta = describeValidationCycle({ results: [], state, evidenceOnly: true })
      }
    } finally {
      // The assistant message already declared this call; it must always receive a result.
      sessions.appendMessage(sessionId, {
        role: 'tool', toolCallId: call.id, name: 'validation',
        content: content ?? 'Tool: validation\nStatus: interrupted',
        meta: meta ?? { ok: false, compact: 'Validation was interrupted.', paths: [], hits: [], changed: [] },
      })
    }
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
  async function runAgent(sessionId, controller, run) {
    const { signal } = controller
    let { provider, workspace } = validateRun(sessions.get(sessionId))
    const notes = workspaceNotes ? await workspaceNotes(sessions.get(sessionId).workspaceId).catch(() => '') : ''
    const system = notes ? `${buildSystemPrompt()}\n\n${notes}` : buildSystemPrompt()
    const toolDefs = workspace ? tools.describeTools() : []
    let summarizer = config.summarizeWithModel
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

      // Safe boundary for Flash → Pro: between turns, after the cancel check, with every earlier tool call finished.
      if (maybeEscalate(sessionId, run, failedTurns)) {
        provider = validateRun(sessions.get(sessionId)).provider
        summarizer = config.summarizeWithModel ? createProviderSummarizer({ provider, model: sessions.get(sessionId).model.model, signal }) : null
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
            ...(run.route?.reasoningEffort ? { reasoningEffort: run.route.reasoningEffort } : {}),
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
      let calls = uniqueToolCalls(sessionId, turn.toolCalls)

      // No tool calls = a completion candidate. Completion is grounded in validation evidence: when checks
      // are warranted, the runtime runs them (as a runtime-initiated cycle) and the model sees the result.
      let cycle = null
      let completionDecision = null
      if (calls.length === 0) {
        completionDecision = await decideCompletion(sessionId, workspace, run)
        if (completionDecision.action !== 'complete') {
          cycle = completionDecision
          calls = [{ id: `validation_${run.counters.validationRounds + 1}_${newId().slice(0, 6)}`, name: 'validation',
            input: { action: cycle.action, reason: cycle.reason, commands: cycle.plan?.commands.map(c => c.command) ?? [] } }]
        }
      }
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
          ...(run.route ? { tier: run.route.tier, reasoningEffort: run.route.reasoningEffort } : {}),
        }],
      })

      if (cycle) {
        await runCompletionCycle(sessionId, workspace, signal, run, cycle, calls[0])
        failedTurns = 0
        continue
      }
      if (calls.length === 0) return finishRun(sessionId, completionDecision, turn.text, run)

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

  /** Appends the run record (one per user request) with its outcome and validation metrics. */
  function finalizeRun(sessionId, run, outcome) {
    const s = sessions.get(sessionId)
    const c = run.counters
    const record = {
      id: run.id, userMessageId: run.userMessageId, startedAt: run.startedAt, completedAt: now(), outcome,
      turns: s.turns.length - run.turnsAtStart, changedFiles: s.changedFiles.map(f => f.path),
      warnings: c.warnings,
      ...(run.route ? { route: summarizeRoute(run, s.turns.slice(run.turnsAtStart)) } : {}),
      validation: {
        validationCommandsRun: c.commandsRun, validationPasses: c.passes, validationFailures: c.failures, validationDurationMs: c.durationMs,
        recoveryRounds: c.recoveryRounds, automaticRounds: c.validationRounds, finalValidationStatus: (s.validation ?? createValidationState()).currentStatus,
        firstPassSuccess: c.firstRoundPassed, repairSuccess: c.repairSucceeded, staleValidationPrevented: c.staleValidationPrevented,
      },
    }
    sessions.update(sessionId, { runs: [...(s.runs ?? []), record] })
    return record
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

    const run = { id: `run_${newId()}`, userMessageId: message.id, startedAt: now(), counters: createRunCounters(), turnsAtStart: session.turns.length, changedAtStart: session.changedFiles.length, route: null }
    try {
      await routeRun(sessionId, content, controller, run)
      const outcome = await runAgent(sessionId, controller, run)
      setAgent(sessionId, { status: 'completed', abortController: null })
      if (outcome.kind === 'completed') {
        const record = finalizeRun(sessionId, run, outcome.outcome)
        sessions.setStatus(sessionId, 'completed')
        const final = sessions.get(sessionId)
        emit(sessionId, 'session.completed', {
          turns: final.turns.length, outcome: record.outcome, runId: record.id,
          unresolvedFailures: (final.validation?.unresolved ?? []).length, warnings: record.warnings.length,
        })
      } else {
        finalizeRun(sessionId, run, 'failed')
        commitAssistantText(sessionId, outcome.notice)
        setAgent(sessionId, { status: 'error', error: outcome.error })
        sessions.setStatus(sessionId, 'error')
        emit(sessionId, 'session.failed', { error: outcome.error })
      }
    } catch (e) {
      const error = toBluswanError(e)
      if (error.code === 'cancelled' || controller.signal.aborted) {
        finalizeRun(sessionId, run, 'cancelled')
        finishCancelled(sessionId)
      } else {
        finalizeRun(sessionId, run, 'failed')
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
    if (controller && (session.status === 'running' || session.status === 'waiting_permission')) {
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

  /** Development aid: detected project, discovered commands, validation state, and what the policy would do now. */
  async function debugValidation(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    const { workspace } = validateRun(session)
    if (!workspace) return { project: null, discoveredCommands: [], state: session.validation, policyDecision: null, runs: session.runs }
    const info = await validationEngine.debug({ workspace, state: session.validation ?? createValidationState(), userInstructions: userInstructionsFor(session) })
    return { ...info, runs: session.runs }
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
    approvePermission: (sessionId, permissionId) => resolvePermission(sessionId, permissionId, 'approve'),
    denyPermission: (sessionId, permissionId) => resolvePermission(sessionId, permissionId, 'deny'),
    getPendingPermissions: (sessionId) => [...pendingPermissions.values()].map(e => e.request).filter(r => !sessionId || r.sessionId === sessionId),
    getPermissionMode: () => permissionMode,
    setPermissionMode(mode) {
      if (!isPermissionMode(mode)) throw new Error(`Unknown permission mode: ${mode}`)
      permissionMode = mode
      return permissionMode
    },
    listSessions: () => sessions.list(),
    /** Deletes conversation state only (never repository files). Refuses while a run is active. */
    async deleteSession(sessionId) {
      const s = sessions.get(sessionId)
      if (!s) return false
      if (s.status === 'running' || s.status === 'waiting_permission') {
        throw createError({ code: 'session_busy', message: 'Stop the running session before deleting it.' })
      }
      agents.delete(sessionId)
      toolControllers.delete(sessionId)
      commandLogs.delete(sessionId)
      await sessions.delete(sessionId)
      return true
    },
    /** Is the configured provider/model usable (credentials, model)? No network request. */
    checkModel(model) {
      try {
        const provider = providers.getProvider(model.provider)
        if (!model.model) return { ok: false, code: 'configuration_error', reason: 'no_model', message: 'No model is configured.' }
        provider.validate?.(model.model)
        return { ok: true }
      } catch (e) {
        const msg = String(e?.message ?? '')
        return { ok: false, code: e?.code ?? 'configuration_error', reason: /api key/i.test(msg) ? 'no_api_key' : /model/i.test(msg) ? 'no_model' : 'unavailable', message: msg }
      }
    },
    listProviders: () => providers.listProviders(),
    listModels: (providerId) => providers.listModels(providerId),
    resolveModel: (providerId, modelId) => providers.resolveModel(providerId, modelId),
    setSessionModel,
    setModelPreference,
    getRouting: () => routing?.public ?? null,
    exportSession,
    restoreSession,
    reconcileSession,
    getWorkspaceState,
    getFileDiff,
    revertFile,
    getWorkspaceRevision: (workspaceId) => revisionOf(workspaceId),
    listCommands: (sessionId) => (commandLogs.get(sessionId) ?? []).map(({ stdout: _o, stderr: _e, ...meta }) => meta),
    getCommand: (sessionId, id) => (commandLogs.get(sessionId) ?? []).find(c => c.id === id) ?? null,
    canOpenWorkspaces: () => !!workspaces,
    listWorkspaces: () => (workspaces ? workspaces.listWorkspaces() : []),
    async openWorkspace(spec) {
      if (!workspaces) throw createError({ code: 'configuration_error', message: 'This host cannot open repositories.' })
      const ws = await workspaces.openWorkspace(spec)
      return { id: ws.id, root: ws.root, ...ws.metadata }
    },
    debugContext,
    debugValidation,
    listTools: () => tools.describeTools(),
    getSession: (id) => sessions.get(id),
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
