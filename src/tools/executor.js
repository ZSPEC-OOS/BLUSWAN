// Tool executor: resolve → validate → permission-check → execute → normalize → emit.
// Contains no tool logic; every operation lives in a tool definition or the workspace.
import { validateInput } from './validate.js'
import { checkPermission, DEFAULT_POLICY } from './permissions.js'
import { createToolResult, toolFailure, summarizeInput } from './result.js'
import { isWorkspaceError } from '../workspace/errors.js'
import { newId } from '../protocol/schemas.js'
import { resolveLimits } from '../config/runtimeConfig.js'

/**
 * @param {{registry:object, policy?:object, limits?:object, now?:()=>number}} options
 */
export function createToolExecutor({ registry, policy = DEFAULT_POLICY, limits = resolveLimits(), now = () => Date.now() }) {
  /**
   * @param {{workspace:object, call:{id?:string,name:string,input?:object}, signal?:AbortSignal,
   *          emit?:(type:string,data:object)=>void}} args
   * @returns {Promise<object>} normalized tool result (never throws for tool failures)
   */
  async function execute({ workspace, call, signal, emit = () => {} }) {
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
    if (!tool) return finish(toolFailure(name, 'tool_not_found', `Unknown tool: ${name}`))

    const validation = validateInput(tool.inputSchema, input)
    if (!validation.ok) return finish(toolFailure(name, 'invalid_input', validation.errors.join('; ')))

    const classified = tool.classify ? tool.classify(input) : { effect: tool.permission, reason: null }
    const decision = checkPermission(classified.effect, classified.reason, policy)
    if (!decision.allowed) {
      return finish(toolFailure(name, 'permission_denied', decision.reason, {
        details: { effect: decision.effect }, metadata: { effect: decision.effect },
      }))
    }
    const metadata = { effect: classified.effect }

    try {
      const output = await tool.execute({ workspace, signal, limits: workspace.metadata?.limits ?? limits, toolCallId }, input)
      const changes = tool.changes ? tool.changes(output) : []
      const result = finish(createToolResult({ tool: name, ok: true, output, metadata }))
      for (const c of changes) emit('file.changed', { toolCallId, tool: name, path: c.path, change: c.change })
      return result
    } catch (e) {
      if (isWorkspaceError(e)) {
        return finish(toolFailure(name, e.code, e.message, { details: e.details, output: e.output, metadata }))
      }
      return finish(toolFailure(name, 'internal_error', e?.message ?? 'Unexpected tool failure', { metadata }))
    }
  }

  return { execute }
}
