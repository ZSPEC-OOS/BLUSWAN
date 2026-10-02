// Shared execution of one validation step: safety re-check, bounded run, normalization.
// Per-kind runners (testRunner.js, lintRunner.js, …) only choose timeouts and the kind.
import { classifyCommand } from '../tools/permissions.js'
import { classifyFailure } from './failureClassifier.js'
import { parseOutput, stripAnsi } from './resultParser.js'

const AUTO_ALLOWED = new Set(['read', 'workspace_write'])
const EXCERPT_CHARS = 3_000
// Non-interactive, colorless, single-run behavior for test/lint tooling.
export const VALIDATION_ENV = Object.freeze({ CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' })

/** Keeps the beginning and the end: tool summaries are usually at the end, the first error at the start. */
export function excerpt(text, max = EXCERPT_CHARS) {
  if (text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.3)
  return { text: `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(text.length - (max - head))}`, truncated: true }
}

/**
 * @param {{workspace:object, step:{kind:string,command:string,scope:string,relatedFiles?:string[]}, timeoutMs:number,
 *          signal?:AbortSignal, id:string, now:()=>number, maxOutputChars?:number}} args
 * @returns {Promise<object>} canonical validation result
 */
export async function runValidationStep({ workspace, step, timeoutMs, signal, id, now, maxOutputChars = EXCERPT_CHARS }) {
  const startedAt = now()
  const base = { id, kind: step.kind, command: step.command, scope: step.scope, startedAt, relatedFiles: step.relatedFiles ?? [] }
  const finish = (fields) => {
    const completedAt = now()
    return { exitCode: null, summary: '', diagnostics: null, outputExcerpt: '', outputTruncated: false, ...base, ...fields, completedAt, durationMs: Math.max(0, completedAt - startedAt) }
  }

  const effect = classifyCommand(step.command)
  if (!AUTO_ALLOWED.has(effect.effect)) {
    return finish({ status: 'skipped', summary: `not run automatically (${effect.effect}): ${effect.reason}`, diagnostics: { category: 'configuration_error', summary: 'unsafe validation command', keyMessages: [], locations: [], counts: {} } })
  }
  if (signal?.aborted) return finish({ status: 'cancelled', summary: 'cancelled before it started' })

  let run
  try {
    run = await workspace.runCommand(step.command, { timeoutMs, env: VALIDATION_ENV, signal })
  } catch (e) {
    return finish({ status: 'error', summary: `could not run: ${String(e?.message ?? e).slice(0, 200)}`, diagnostics: classifyFailure({ kind: step.kind, exitCode: null, spawnError: String(e?.message ?? e) }) })
  }
  const combined = stripAnsi(`${run.stderr}\n${run.stdout}`).trim()
  const ex = excerpt(combined, maxOutputChars)
  const common = { exitCode: run.exitCode, outputExcerpt: ex.text, outputTruncated: ex.truncated || run.truncated }

  if (run.cancelled) return finish({ ...common, status: 'cancelled', summary: 'cancelled' })
  if (run.timedOut) {
    const d = classifyFailure({ kind: step.kind, exitCode: run.exitCode, timedOut: true })
    return finish({ ...common, status: 'failed', summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, diagnostics: d })
  }
  if (run.exitCode === 0) {
    const counts = parseOutput(step.kind, combined, { root: workspace.root }).counts
    const n = counts.passed
    return finish({ ...common, status: 'passed', summary: step.kind === 'test' && n ? `${n} passed` : 'passed' })
  }
  const d = classifyFailure({ kind: step.kind, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, root: workspace.root })
  const unavailable = d.category === 'command_not_found' || (d.category === 'configuration_error' && /does not define this script/.test(d.summary))
  return finish({ ...common, status: unavailable ? 'unavailable' : 'failed', summary: d.summary, diagnostics: d })
}
