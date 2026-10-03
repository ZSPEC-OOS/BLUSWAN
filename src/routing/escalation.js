// One-way Fast → Advanced escalation, decided from runtime evidence at a safe agent-turn boundary (never mid-stream).
// Provider outages, rate limits and ordinary single failures are retry/recovery concerns, not escalation evidence.
import { MODES, TIERS } from './profiles.js'

export const ESCALATION_THRESHOLDS = Object.freeze({ recoveryRounds: 2, failedTurns: 3, newChangedFiles: 8 })

/**
 * @param {{mode:string, tier:string}} route the run's current route
 * @param {{recoveryRounds:number, repairSucceeded?:boolean, sawFailure?:boolean, failedTurns:number, newChangedFiles:number}} evidence
 * @returns {{escalate:boolean, reasonCode:string|null}}
 */
export function evaluateEscalation(route, evidence, thresholds = ESCALATION_THRESHOLDS) {
  if (!route || route.mode !== MODES.AUTO || route.tier !== TIERS.FAST || route.escalated) return { escalate: false, reasonCode: null }
  if (evidence.sawFailure && !evidence.repairSucceeded && evidence.recoveryRounds >= thresholds.recoveryRounds) return { escalate: true, reasonCode: 'repeated_validation_failure' }
  if (evidence.failedTurns >= thresholds.failedTurns) return { escalate: true, reasonCode: 'repeated_tool_failures' }
  if (evidence.newChangedFiles >= thresholds.newChangedFiles) return { escalate: true, reasonCode: 'scope_expanded' }
  return { escalate: false, reasonCode: null }
}
