// Tool executor: resolve → validate → permission-check → execute → normalize → emit.
// Contains no tool logic; every operation lives in a tool definition or the workspace.
import { validateInput } from './validate.js'
import { checkPermission, DEFAULT_POLICY } from './permissions.js'
import { createToolResult, toolFailure, summarizeInput, summarizeOutput } from './result.js'
import { isWorkspaceError } from '../workspace/errors.js'
import { newId } from '../protocol/schemas.js'
import { resolveLimits } from '../config/runtimeConfig.js'

/**
 * @param {{registry:object, policy?:object, limits?:object, now?:()=>number}} options
 */
export function createToolExecutor({ registry, policy = DEFAULT_POLICY, limits = resolveLimits(), now = () => Date.now() }) {
  /**
   * `call.preflightError` ({code,message}) short-circuits execution with that failure (malformed model output, loop guard).
   * @param {{workspace:object, call:{id?:string,name:string,input?:object,preflightError?:object}, signal?:AbortSignal,
   *          emit?:(type:string,data:object)=>void}} args
   * @returns {Promise<object>} normalized tool result (never throws for tool failures)
   */
  async function execute({ workspace, call, signal, emit = () => {}, authorize = null }) {
    const started = now()
    const toolCallId = call.id ?? `tool_${newId()}`
    const name = call.name
    const input = call.input ?? {}
    const inputSummary = summarizeInput(input)
    const elapsed = () => Math.max(0, now() - started)

    const finish = (result, extra = {}) => {
      const final = { ...result, toolCallId, durationMs: elapsed() }
      if (final.ok) {
        emit('tool.completed', { toolCallId, tool: name, inputSummary, durationMs: final.durationMs, ...extra })
      } else {
        emit('tool.failed', {
          toolCallId, tool: name, inputSummary, durationMs: final.durationMs,
          error: { code: final.error.code, message: final.error.message.slice(0, 500) },
        })
      }
      return final
    }

    emit('tool.started', { toolCallId, tool: name, inputSummary })

    const tool = registry.getTool(name)
    if (!tool) return finish(toolFailure(name, 'unknown_tool', `Unknown tool: ${name}. Available tools: ${registry.listTools().map(t => t.name).join(', ')}`))
    if (call.preflightError) return finish(toolFailure(name, call.preflightError.code, call.preflightError.message))

    const validation = validateInput(tool.inputSchema, input)
    if (!validation.ok) return finish(toolFailure(name, 'invalid_input', validation.errors.join('; ')))

    const classified = tool.classify ? tool.classify(input) : { effect: tool.permission, reason: null }
    // With an `authorize` hook (the runtime's permission modes) approval may be awaited; `prohibited` never passes.
    if (authorize) {
      if (classified.effect === 'prohibited') {
        return finish(toolFailure(name, 'permission_denied', 'This command is blocked by workspace safety policy.', { details: { effect: 'prohibited' }, metadata: { effect: 'prohibited' } }))
      }
      const verdict = await authorize({ toolCallId, tool: name, input, effect: classified.effect, reason: classified.reason })
      if (!verdict.allowed) {
        return finish(toolFailure(name, verdict.code ?? 'permission_denied', verdict.message ?? 'This action was not allowed.', { details: { effect: classified.effect }, metadata: { effect: classified.effect } }))
      }
    }
    const decision = authorize ? { allowed: true } : checkPermission(classified.effect, classified.reason, policy, { classified: !!tool.classify })
    if (!decision.allowed) {
      return finish(toolFailure(name, decision.prohibited ? 'permission_denied' : 'permission_required', decision.reason, {
        details: { effect: decision.effect }, metadata: { effect: decision.effect },
      }))
    }
    const metadata = { effect: classified.effect }

    try {
      const output = await tool.execute({ workspace, signal, limits: workspace.metadata?.limits ?? limits, toolCallId }, input)
      const changes = tool.changes ? tool.changes(output) : []
      for (const c of changes) emit('file.changed', { toolCallId, tool: name, path: c.path, action: c.change })
      return finish(createToolResult({ tool: name, ok: true, output, metadata }), { outputSummary: summarizeOutput(name, output) })
    } catch (e) {
      if (isWorkspaceError(e)) {
        return finish(toolFailure(name, e.code, e.message, { details: e.details, output: e.output, metadata }))
      }
      return finish(toolFailure(name, 'internal_error', e?.message ?? 'Unexpected tool failure', { metadata }))
    }
  }

  return { execute }
}
