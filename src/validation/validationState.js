// Validation evidence for one session: what ran, what it proved, and whether the code has changed
// since. Evidence is bound to a mutation counter, so a pass can never be mistaken for proof about
// code that was edited afterwards. Plain serializable data (session.validation).
import { classifyChange } from './changedFileStrategy.js'

const MAX_RESULTS = 20
const keepLast = (arr, n) => (arr.length > n ? arr.slice(arr.length - n) : arr)
const KIND_LABEL = { test: 'test', lint: 'lint', typecheck: 'typecheck', build: 'build', format_check: 'format check', custom: 'check' }

export function createValidationState() {
  return {
    lastRunAt: null, results: [], lastRoundStatus: 'none', currentStatus: 'none',
    filesValidated: [], dirtySinceValidation: false, dirtyFiles: [], broadValidationPassed: false,
    unresolved: [], mutationSeq: 0, validatedSeq: 0, lastDecision: null, lastPassAt: null,
  }
}

function derive(state) {
  const stale = state.mutationSeq > state.validatedSeq
  return {
    ...state,
    dirtySinceValidation: stale,
    currentStatus: stale ? 'stale' : state.lastRoundStatus,
    broadValidationPassed: stale ? false : state.broadValidationPassed,
  }
}

/** True when the latest evidence describes the current workspace (not stale). */
export const isCurrent = (state) => !!state && state.mutationSeq === state.validatedSeq

/**
 * Records successful file mutations. Documentation never invalidates evidence; any code or config
 * mutation does (conservative: correctness over optimization).
 * @param {{path:string,action:string}[]} changes
 */
export function markMutated(state, changes) {
  const files = [...state.dirtyFiles]
  let bump = false
  for (const c of changes) {
    const i = files.findIndex(f => f.path === c.path)
    if (i >= 0) files.splice(i, 1)
    files.push({ path: c.path, action: c.action })
    if (classifyChange(c.path) !== 'docs') bump = true
  }
  return derive({ ...state, dirtyFiles: files, mutationSeq: state.mutationSeq + (bump ? 1 : 0) })
}

/**
 * Records results (each stamped with the mutation counter at the time it ran). `fullPlan` marks a
 * round that completed every planned step; only then are the dirty files considered validated.
 */
export function recordResults(state, results, { now = Date.now(), decision = null, fullPlan = false } = {}) {
  const stamped = results.map(r => ({ ...compactResult(r), seq: state.mutationSeq }))
  const all = keepLast([...state.results, ...stamped], MAX_RESULTS)
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error')
  const cancelled = results.some(r => r.status === 'cancelled')
  const passedAll = results.length > 0 && results.every(r => r.status === 'passed')
  let round
  if (cancelled) round = 'cancelled'
  else if (failed.length) round = 'failed'
  else if (passedAll) round = 'passed'
  else if (results.some(r => r.status === 'unavailable')) round = 'unavailable'
  else if (results.some(r => r.status === 'passed')) round = 'passed'
  else round = 'skipped'

  const solved = new Set(results.filter(r => r.status === 'passed').map(r => r.command))
  let unresolved = state.unresolved.filter(u => !solved.has(u.command))
  for (const r of failed) {
    unresolved = [...unresolved.filter(u => u.command !== r.command), {
      kind: r.kind, command: r.command, category: r.diagnostics?.category ?? 'unknown', summary: r.summary,
      keyMessages: (r.diagnostics?.keyMessages ?? []).slice(0, 3), locations: (r.diagnostics?.locations ?? []).slice(0, 3),
      since: state.unresolved.find(u => u.command === r.command)?.since ?? r.completedAt,
    }]
  }
  const planPassed = fullPlan && passedAll && !cancelled
  return derive({
    ...state,
    results: all, lastRunAt: now, lastRoundStatus: round, validatedSeq: cancelled ? state.validatedSeq : state.mutationSeq,
    lastPassAt: passedAll ? now : state.lastPassAt,
    unresolved,
    filesValidated: planPassed ? state.dirtyFiles.map(f => f.path) : state.filesValidated,
    dirtyFiles: planPassed ? [] : state.dirtyFiles,
    broadValidationPassed: passedAll && results.some(r => r.scope === 'broad') ? true : state.broadValidationPassed,
    lastDecision: decision ? { reason: decision.reason, scope: decision.scope, commands: decision.commands.map(c => c.command) } : state.lastDecision,
  })
}

/** A full planned round (the validation engine ran every step). */
export const applyRound = (state, results, opts = {}) => recordResults(state, results, { ...opts, fullPlan: !!opts.decision && results.length === opts.decision.commands.length })

/** A check the agent ran itself through the shell; it is evidence but does not by itself clear the dirty files. */
export const recordShellResult = (state, result, opts = {}) => recordResults(state, [result], opts)

/** True when a passing result of this kind already describes the current code (a broad pass covers a focused step). */
export function isSatisfied(state, step) {
  return state.results.some(r => r.seq === state.mutationSeq && r.status === 'passed' && r.kind === step.kind
    && (r.command === step.command || (r.scope === 'broad' && step.scope === 'focused')))
}

/** The check was already tried for this exact code and could not run (tool missing, nothing to run): retrying cannot help. */
export const wasUnavailable = (state, step) => state.results.some(r => r.seq === state.mutationSeq && r.command === step.command && (r.status === 'unavailable' || r.status === 'skipped'))

/** The dirty files have been validated by the checks that apply to them. */
export const clearDirty = (state) => derive({ ...state, dirtyFiles: [], filesValidated: state.dirtyFiles.map(f => f.path) })

/** Nothing ran, deliberately: records why. `no_validation_available` yields status "unavailable". */
export function applySkip(state, reason, { now = Date.now() } = {}) {
  const status = reason === 'no_validation_available' ? 'unavailable' : 'skipped'
  const docsOnly = reason === 'documentation_only' || reason === 'no_changes'
  return derive({
    ...state, lastRunAt: now, lastRoundStatus: state.unresolved.length && reason !== 'user_declined_validation' && status === 'skipped' ? state.lastRoundStatus : status,
    validatedSeq: state.mutationSeq, dirtyFiles: docsOnly ? [] : state.dirtyFiles, lastDecision: { reason, scope: null, commands: [] },
  })
}

/** Keeps results small enough to store on the session (full output lives only in the tool message). */
export function compactResult(r) {
  const { outputExcerpt: _drop, ...rest } = r
  return rest
}

const MARK = { passed: '✓', failed: '✗', error: '✗', skipped: '–', unavailable: '–', cancelled: '–' }

/** One-line description of a result for evidence blocks and activity text. */
export function describeResult(r) {
  const detail = r.status === 'passed' ? r.summary : `${r.status.toUpperCase()}${r.diagnostics?.category ? ` [${r.diagnostics.category}]` : ''}: ${r.summary}`
  return `${MARK[r.status] ?? '-'} ${r.command} (${r.scope} ${KIND_LABEL[r.kind] ?? r.kind}) — ${detail}`
}

/** Compact validation state for the model (included at high priority by the context engine). */
export function renderValidationState(state, { maxFiles = 6 } = {}) {
  if (!state || (state.currentStatus === 'none' && !state.results.length && !state.unresolved.length)) return null
  const files = state.dirtyFiles.map(f => f.path)
  const head = state.currentStatus === 'stale'
    ? `VALIDATION STATE: STALE — files changed since the last validation (${files.slice(0, maxFiles).join(', ')}${files.length > maxFiles ? ', …' : ''}). Earlier results do not describe the current workspace.`
    : `VALIDATION STATE: ${state.currentStatus.toUpperCase()}${state.broadValidationPassed ? ' (broad validation passed)' : ''}`
  const lines = [head]
  const latest = new Map()
  for (const r of state.results) latest.set(`${r.kind}:${r.command}`, r)
  for (const r of [...latest.values()].slice(-5)) lines.push(`- ${describeResult(r)}`)
  for (const u of state.unresolved) {
    lines.push(`- UNRESOLVED ${u.kind} failure (${u.category}): \`${u.command}\` — ${u.summary}${u.keyMessages.length ? `: ${u.keyMessages[0]}` : ''}`)
  }
  return lines.join('\n')
}
