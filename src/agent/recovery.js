// Small recovery policy: after validation evidence arrives, should the runtime give the model
// another turn to repair, or stop automatic continuation? Contains no repair logic.
//
// Retry (same operation, transient infrastructure failure) lives in providerTurn/retry.js.
// Repair (change the code because a check found a real problem) is decided here, and only
// continues while the model keeps making meaningful progress.

export function createRunCounters() {
  return {
    validationRounds: 0, recoveryRounds: 0, evidencePresented: false,
    lastFailureSeq: null, // mutation counter when the latest failure was seen
    staleValidationPrevented: 0, firstRoundPassed: null, sawFailure: false, repairSucceeded: false,
    commandsRun: 0, passes: 0, failures: 0, durationMs: 0, warnings: [],
  }
}

// Failures no code edit can fix without permissions the agent does not have (installing packages)
// or a working environment.
const NOT_REPAIRABLE = new Set(['dependency_missing', 'command_not_found', 'environment_error'])

/**
 * @param {{results:object[], counters:object, config:object, mutationSeq:number}} input
 * @returns {{action:'continue'|'stop', reason:string}}
 */
export function decideRecovery({ results, counters, config, mutationSeq }) {
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error')
  if (!failed.length) return { action: 'continue', reason: 'no_failure' }
  const categories = failed.map(r => r.diagnostics?.category ?? 'unknown')
  if (categories.every(c => NOT_REPAIRABLE.has(c))) return { action: 'stop', reason: `not_repairable_${categories[0]}` }
  if (counters.validationRounds >= config.maxAutomaticValidationRounds) return { action: 'stop', reason: 'validation_round_limit_reached' }
  if (counters.recoveryRounds >= config.maxRecoveryRounds) return { action: 'stop', reason: 'recovery_limit_reached' }
  if (counters.lastFailureSeq === mutationSeq && counters.sawFailure) return { action: 'stop', reason: 'no_progress_since_last_failure' }
  return { action: 'continue', reason: 'repairable_failure' }
}

/** A repair needs new code: validation only reruns after a mutation since the last failure. */
export const hasProgressSince = (counters, mutationSeq) => counters.lastFailureSeq == null || mutationSeq > counters.lastFailureSeq
