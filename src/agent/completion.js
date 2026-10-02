// Completion interception: when the model stops calling tools, decide whether the run may finish.
// Not a workflow phase — a single check that grounds completion in validation evidence:
//
//   complete          nothing needs checking (or what is needed is satisfied/skipped for a recorded reason)
//   validate          run the planned checks now; the model sees the evidence before its final answer
//   present_evidence  unresolved failure and no further automatic validation: tell the model exactly where things stand
import { createValidationState, isSatisfied, wasUnavailable, clearDirty } from '../validation/validationState.js'
import { describeResult, renderValidationState } from '../validation/validationState.js'

const SKIP_COMPLETES = new Set(['no_changes', 'documentation_only', 'user_declined_validation', 'automatic_validation_disabled', 'no_validation_available'])

/** Outcome of a run from its final evidence (the model's wording is checked separately by claimChecker). */
export function outcomeFor(state, { warnings = [] } = {}) {
  if (state.unresolved.length && state.mutationSeq === state.validatedSeq) return 'failed'
  if (state.mutationSeq > state.validatedSeq && state.dirtyFiles.length) return 'warning'
  if (warnings.length) return 'warning'
  return 'success'
}

/**
 * @param {{validationEngine:object}} deps
 */
export function createCompletion({ validationEngine }) {
  /**
   * @param {{session:object, workspace:object|null, counters:object, userInstructions:string[]}} input
   * @returns {Promise<{action:string, reason:string, state:object, plan?:object, outcome?:string, staleBlocked?:boolean}>}
   */
  async function decide({ session, workspace, counters, userInstructions }) {
    let state = session.validation ?? createValidationState()
    const done = (reason, extra = {}) => ({ action: 'complete', reason, state, outcome: outcomeFor(state), ...extra })
    if (!workspace) return done('no_workspace')

    const stale = state.mutationSeq > state.validatedSeq
    // Failure with no new code since: never rerun the same check on unchanged code.
    if (!stale && state.unresolved.length) {
      return counters.evidencePresented ? done('unresolved_validation_failure') : { action: 'present_evidence', reason: 'unresolved_validation_failure', state }
    }
    if (!state.dirtyFiles.length) return done('nothing_to_validate')

    const { decision } = await validationEngine.plan({ workspace, state, userInstructions, roundsUsed: counters.validationRounds })
    if (!decision.shouldValidate) {
      if (SKIP_COMPLETES.has(decision.reason)) {
        state = validationEngine.skip(state, decision.reason)
        return done(decision.reason, { state, outcome: outcomeFor(state) })
      }
      // round limit reached: report whatever evidence exists
      if (!counters.evidencePresented && (state.unresolved.length || stale)) return { action: 'present_evidence', reason: decision.reason, state }
      return done(decision.reason)
    }

    const remaining = decision.commands.filter(step => !isSatisfied(state, step) && !wasUnavailable(state, step))
    if (!remaining.length) {
      state = clearDirty(state)
      return done('all_planned_checks_already_passed', { state, outcome: outcomeFor(state) })
    }
    return {
      action: 'validate', reason: decision.reason, state,
      plan: { ...decision, commands: remaining },
      staleBlocked: stale && state.lastPassAt != null, // an earlier pass existed but no longer describes the code
    }
  }
  return { decide }
}

/** Read-only git facts for the evidence block (null for non-git workspaces or on failure). */
export async function collectGitEvidence(workspace) {
  if (!workspace.metadata?.repository?.isGitRepository) return null
  try {
    const [status, diff] = await Promise.all([workspace.gitStatus(), workspace.gitDiff()])
    return {
      modified: status.modified.length, staged: status.staged.length, deleted: status.deleted.length, untracked: status.untracked.length,
      files: diff.files.length, additions: diff.additions, deletions: diff.deletions, clean: status.clean,
    }
  } catch { return null }
}

/** The compact block the model receives before its final answer. */
export function buildCompletionEvidence({ state, changedFiles, git, note }) {
  const lines = ['COMPLETION EVIDENCE', 'Changed files:']
  if (changedFiles.length) for (const f of changedFiles) lines.push(`- ${f.path} (${f.action})`)
  else lines.push('- none')
  lines.push('Validation:')
  const latest = new Map()
  for (const r of state.results) latest.set(`${r.kind}:${r.command}`, r)
  const shown = [...latest.values()].filter(r => r.seq === state.mutationSeq)
  if (shown.length) for (const r of shown) lines.push(`- ${describeResult(r)}`)
  else lines.push(`- none for the current code (${state.currentStatus})`)
  for (const u of state.unresolved) lines.push(`- UNRESOLVED: \`${u.command}\` ${u.category}${u.keyMessages[0] ? ` — ${u.keyMessages[0]}` : ''}`)
  if (state.mutationSeq > state.validatedSeq) lines.push('- WARNING: files changed after the last validation')
  if (git) {
    lines.push('Git:')
    lines.push(git.clean ? '- working tree clean' : `- ${git.files} files changed (+${git.additions} −${git.deletions}); ${git.modified} modified, ${git.untracked} untracked`)
  }
  if (note) lines.push(note)
  return lines.join('\n')
}

const EXCERPT_FAILED = 1_800

/** Text of the runtime-initiated validation cycle (stored as the tool message). */
export function formatValidationCycle({ plan, results, state, changedFiles, git, recovery }) {
  const status = results.length && results.every(r => r.status === 'passed') ? 'passed' : results.some(r => r.status === 'cancelled') ? 'cancelled' : results.some(r => r.status === 'failed' || r.status === 'error') ? 'failed' : 'incomplete'
  const lines = ['Tool: validation', `Status: ${status}`, `Reason: ${plan.reason}`, 'Checks run (in order; stops at the first failure):']
  for (const r of results) lines.push(`- ${describeResult(r)}`)
  const skipped = plan.commands.slice(results.length)
  if (skipped.length) lines.push(`Not run: ${skipped.map(s => s.command).join(', ')}`)
  for (const r of results.filter(x => x.status === 'failed' || x.status === 'error')) {
    const d = r.diagnostics
    lines.push('', `Failure (${d?.category ?? 'unknown'}): ${r.summary}`)
    for (const m of d?.keyMessages ?? []) lines.push(`  • ${m}`)
    if (d?.locations?.length) lines.push(`  Locations: ${d.locations.map(l => `${l.path}:${l.line}`).join(', ')}`)
    if (r.outputExcerpt) lines.push('Output excerpt:', r.outputExcerpt.length > EXCERPT_FAILED ? `…${r.outputExcerpt.slice(-EXCERPT_FAILED)}` : r.outputExcerpt)
  }
  let note
  if (status === 'failed') {
    note = recovery.action === 'stop'
      ? `Automatic validation will not continue (${recovery.reason.replace(/_/g, ' ')}). Report the remaining failure accurately.`
      : 'Investigate the failure and fix the cause. The checks run again automatically when you finish; do not claim success until they pass.'
  } else if (status === 'passed') {
    note = 'All planned checks passed for the current code. Summarize what you changed and cite this evidence.'
  }
  lines.push('', buildCompletionEvidence({ state, changedFiles, git, note }))
  return lines.join('\n')
}

export function formatEvidenceOnly({ state, changedFiles, git, reason }) {
  const why = reason === 'validation_round_limit_reached'
    ? 'The automatic validation limit was reached.'
    : 'No code changed since the failing validation, so it will not be rerun automatically. Make a change, or report the remaining failure accurately.'
  return ['Tool: validation', 'Status: not run', `Reason: ${reason}`, '', buildCompletionEvidence({ state, changedFiles, git, note: why })].join('\n')
}

/** Compact observation stored on the tool message for context compaction. */
export function describeValidationCycle({ results, state, evidenceOnly }) {
  const body = evidenceOnly ? 'no checks run' : results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.command} ${r.status}${r.status === 'passed' ? '' : ` [${r.diagnostics?.category ?? '?'}]`}`).join('; ')
  const first = results.find(r => r.status === 'failed')?.diagnostics?.keyMessages?.[0]
  return { ok: !results.some(r => r.status === 'failed' || r.status === 'error'), paths: [], hits: [], changed: [],
    compact: `Validation (${state.currentStatus}): ${body}.${first ? ` ${first}` : ''}`.slice(0, 700) }
}

export { renderValidationState }
