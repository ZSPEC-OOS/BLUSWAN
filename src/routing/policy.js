// Deterministic routing policy: signals → score (0–100), reason codes and safety gates. Thresholds and weights are
// centralised here and never exposed to the browser. Score bands: ≤fastMax → Flash, ≥advancedMin → Pro, between → ambiguous.
export const THRESHOLDS = Object.freeze({ fastMax: 35, advancedMin: 65 })

export const WEIGHTS = Object.freeze({
  base: { question: 5, trivial_edit: 8, change: 30, debug: 40, refactor: 45, unknown: 35, follow_up: 30 },
  broadScope: 20, multiFile: 10, fewFiles: 3, narrowSingle: -8, multiStep: 15, ambiguous: 8,
  domainChange: 15, rootCauseDebug: 12, tracesDebug: 5,
  priorFailures: 25, unresolvedFailures: 20, widenedChanges: 10,
})

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))

/**
 * @returns {{score:number, band:'fast'|'gray'|'advanced', reasonCodes:string[], gate:string|null}}
 */
export function scoreSignals(s, { thresholds = THRESHOLDS, weights = WEIGHTS } = {}) {
  const w = weights
  const reasons = []
  let score = w.base[s.kind] ?? w.base.unknown
  const changeIntent = s.wantsChange && !s.question
  const d = s.domains

  if (s.broad) { score += w.broadScope; reasons.push('broad_scope') }
  else if (s.files >= 3) { score += w.multiFile; reasons.push('broad_scope') }
  else if (s.files === 2) score += w.fewFiles
  else if (s.files === 1 && ['change', 'trivial_edit'].includes(s.kind)) score += w.narrowSingle
  if (s.steps >= 3) { score += w.multiStep; reasons.push('multi_step') }
  if (s.ambiguous) score += w.ambiguous
  if (changeIntent) {
    // Risk domains add weight only together with a change; mentioning a topic is not risk.
    for (const [domain, code] of [['security', 'safety_critical'], ['persistence', 'persistence_change'], ['concurrency', 'concurrency_state'], ['architecture', 'repo_wide_refactor']]) {
      if (d[domain]) { score += w.domainChange; if (domain !== 'architecture' || s.kind === 'refactor') reasons.push(code) }
    }
  }
  if (s.debug && s.rootCause) { score += w.rootCauseDebug; reasons.push('root_cause_debugging') }
  if (s.debug && s.traces) score += w.tracesDebug

  // Runtime evidence from the session.
  if (s.prior?.failedValidation || s.unresolvedFailures > 0) { score += s.unresolvedFailures > 0 ? w.unresolvedFailures : w.priorFailures; reasons.push('prior_failures') }
  if (s.followUp && s.prior) {
    reasons.push('follow_up_inherited')
    score = Math.max(score, (s.prior.score ?? 0) - 10)
  }
  if (s.changedFiles >= 6 && changeIntent) score += w.widenedChanges

  const gate = safetyGate(s, changeIntent)
  if (gate) {
    score = Math.max(score, thresholds.advancedMin)
    reasons.push(gate)
  }
  if (!reasons.length) reasons.push(s.question ? 'question_only' : s.trivial || score <= thresholds.fastMax ? 'small_change' : 'routine_request')
  score = clamp(score)
  const band = score >= thresholds.advancedMin ? 'advanced' : score <= thresholds.fastMax ? 'fast' : 'gray'
  return { score, band, reasonCodes: [...new Set(reasons)], gate }
}

/** Combinations that always warrant Pro; a single topic word never does. */
export function safetyGate(s, changeIntent = s.wantsChange && !s.question) {
  if (s.unresolvedFailures >= 2 || (s.prior?.failedValidation && s.followUp)) return 'prior_failures'
  if (!changeIntent) return null
  const d = s.domains
  const multi = s.broad || s.files >= 3 || s.steps >= 3
  if (d.security && (d.architecture || multi)) return 'safety_critical'
  if (d.persistence && (s.migration || d.architecture || multi)) return 'persistence_change'
  if (d.concurrency && s.debug) return 'concurrency_state'
  if (s.debug && s.rootCause && (multi || s.traces)) return 'root_cause_debugging'
  if (s.broad && (s.kind === 'refactor' || d.architecture)) return 'repo_wide_refactor'
  return null
}
