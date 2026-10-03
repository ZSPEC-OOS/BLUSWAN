// Provider-neutral coding evaluation: runs fixture tasks through the real runtime with whatever provider/model it is
// given, then reports raw measurements. It never ranks providers or folds results into a single score.
import { createAgentRuntime } from '../agent/runtime.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo } from '../workspace/testing/fixtureRepo.js'
import { getRuntimeConfig } from '../config/runtimeConfig.js'

/** Same tool name + same input, issued more than once. */
export function countDuplicateCalls(toolCalls) {
  const seen = new Map()
  let dup = 0
  for (const c of toolCalls) {
    const key = `${c.name}:${JSON.stringify(c.input)}`
    if (seen.has(key)) dup += 1
    seen.set(key, true)
  }
  return dup
}

/**
 * @param {{task:object, model:{provider:string,model:string}, modelPreference?:('auto'|'fast'|'advanced'|null), routing?:object, providers?:object, config?:object, maxTurns?:number,
 *          timeoutMs?:number, now?:()=>number, permissionMode?:string}} options
 * @returns {Promise<object>} raw metrics for this one run
 */
export async function runEvalTask({ task, model, modelPreference = null, routing = null, providers, config = getRuntimeConfig(), maxTurns = 14, timeoutMs = 180_000, now = () => Date.now(), permissionMode = 'full_auto' }) {
  const fx = await createFixtureRepo({ files: task.files })
  const started = now()
  try {
    const workspaces = createNodeWorkspaceManager()
    const runtime = createAgentRuntime({ ...(providers ? { providers } : {}), ...(routing ? { routing } : {}), workspaces, config: { ...config, maxTurns, permissionMode }, approvals: 'unattended' })
    const ws = await workspaces.openWorkspace({ root: fx.root })
    const session = runtime.startSession({ workspaceId: ws.id, model, modelPreference })
    const timer = setTimeout(() => runtime.cancelSession(session.id), timeoutMs)
    let done
    try { done = await runtime.sendMessage(session.id, task.prompt) } finally { clearTimeout(timer) }
    const changed = (await ws.gitChanges?.())?.files.map(f => f.path) ?? done.changedFiles.map(f => f.path)
    const unnecessary = changed.filter(p => !task.expectedFiles.includes(p))
    const success = await Promise.resolve(task.check(ws)).catch(() => false)
    const failure = done.events.find(e => e.type === 'session.failed')?.data.error
    const route = done.runs.at(-1)?.route ?? null
    return {
      task: task.id, provider: model.provider, model: model.model,
      success: !!success, sessionStatus: done.status, validationStatus: done.validation?.currentStatus ?? 'none',
      validationPassed: done.validation?.currentStatus === 'passed',
      toolCalls: done.toolCalls.length, duplicateToolCalls: countDuplicateCalls(done.toolCalls),
      filesChanged: changed.length, unnecessaryFilesChanged: unnecessary.length, changedFiles: changed,
      turns: done.turns.length, tokens: { ...done.tokenUsage }, durationMs: now() - started,
      ...(route ? { route: { requestedMode: route.requestedMode, initialTier: route.initialTier, finalTier: route.finalTier, escalated: route.escalated, source: route.source, classifier: route.classifier, segments: route.segments } } : {}),
      ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
    }
  } finally {
    await fx.cleanup()
  }
}

/** Runs several tasks sequentially. */
export async function runEval({ tasks, ...rest }) {
  const results = []
  for (const task of tasks) results.push(await runEvalTask({ ...rest, task }))
  return results
}

/** Plain-text table of raw metrics (no ranking). */
export function formatResults(results) {
  const rows = results.map(r => [r.task, `${r.provider}/${r.model}`, r.success ? 'pass' : 'FAIL', r.validationStatus, r.turns, r.toolCalls, r.duplicateToolCalls, r.filesChanged, r.unnecessaryFilesChanged, r.tokens.total, `${(r.durationMs / 1000).toFixed(1)}s`])
  const head = ['task', 'model', 'result', 'validation', 'turns', 'tools', 'dup', 'files', 'extra', 'tokens', 'time']
  const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)))
  const line = (r) => r.map((c, i) => String(c).padEnd(width[i])).join('  ')
  return [line(head), ...rows.map(line)].join('\n')
}
