// The router: (mode, request, bounded context) → a routing decision. Pure orchestration over signals, policy and the
// optional classifier; it owns no global state, so concurrent requests are routed independently. It never touches the
// workspace, tools or credentials — the only outside capability is the injected `complete()` used by the classifier.
import { extractSignals } from './signals.js'
import { scoreSignals, THRESHOLDS } from './policy.js'
import { classify, CLASSIFIER_LIMITS } from './classifier.js'
import { MODES, TIERS } from './profiles.js'
import { createError } from '../protocol/schemas.js'

/** @typedef {{mode:string, tier:'fast'|'advanced', provider:string, model:string, reasoningEffort:string, source:string, reasonCodes:string[], score:number|null, classifier:{used:boolean, outcome:string|null, usage:object|null, durationMs:number}|null}} RouteDecision */

/**
 * @param {{profiles:{fast:object, advanced:object}, tiers?:Record<string,{ok:boolean, reason:string|null}>, complete?:Function, thresholds?:object, classifierLimits?:object, now?:()=>number}} deps
 *   `tiers` is the availability evaluation; a missing tier fails loudly instead of being substituted.
 */
export function createRouter({ profiles, tiers = null, complete = null, thresholds = THRESHOLDS, classifierLimits = CLASSIFIER_LIMITS, now = Date.now }) {
  const decision = (mode, tier, source, reasonCodes, extra = {}) => {
    const p = profiles[tier]
    return { mode, tier, provider: p.provider, model: p.model, reasoningEffort: p.reasoningEffort, source, reasonCodes, score: null, classifier: null, ...extra }
  }

  function assertTier(tier) {
    const t = tiers?.[tier]
    if (t && !t.ok) {
      throw createError({ code: 'configuration_error', provider: profiles[tier]?.provider ?? null, message: t.reason ?? `The ${tier === TIERS.FAST ? 'Flash' : 'Pro'} profile is unavailable.` })
    }
  }

  /** The tier a mode forces; 'auto' resolves later. Manual choice is absolute: no scoring, no classifier, no change. */
  function manual(mode) {
    const tier = mode === MODES.FAST ? TIERS.FAST : TIERS.ADVANCED
    assertTier(tier)
    return decision(mode, tier, 'manual', [mode === MODES.FAST ? 'manual_fast' : 'manual_advanced'])
  }

  /**
   * @param {{mode?:string, message:string, context?:object, signal?:AbortSignal}} input
   * @returns {Promise<RouteDecision>}
   */
  async function route({ mode = MODES.AUTO, message, context = {}, signal } = {}) {
    if (mode === MODES.FAST || mode === MODES.ADVANCED) return manual(mode)
    if (mode !== MODES.AUTO) throw createError({ code: 'configuration_error', message: `Unknown model mode "${mode}".` })
    // Auto needs both tiers: it must never silently run the other one in place of an unavailable tier.
    assertTier(TIERS.FAST); assertTier(TIERS.ADVANCED)

    const signals = extractSignals(message, context)
    const scored = scoreSignals(signals, { thresholds })
    if (scored.band !== 'gray') {
      const tier = scored.band === 'advanced' ? TIERS.ADVANCED : TIERS.FAST
      return decision(mode, tier, 'deterministic', scored.reasonCodes, { score: scored.score })
    }

    // Gray band: ask the bounded classifier, if one is available.
    if (!complete) return decision(mode, TIERS.ADVANCED, 'default', ['default_advanced', ...scored.reasonCodes], { score: scored.score })
    const c = await classify({ message, signals }, { complete, signal, timeoutMs: classifierLimits.timeoutMs, now })
    if (c.reason === 'cancelled') throw createError({ code: 'cancelled', message: 'Session cancelled.' })
    const meta = { used: true, outcome: c.ok ? 'ok' : c.reason, usage: c.usage, durationMs: c.durationMs }
    if (c.ok) {
      const { route: r, confidence, risk } = c.verdict
      const confident = confidence >= classifierLimits.minConfidence
      const tier = !confident || r === 'advanced' || (risk === 'high' && confidence < 0.85) ? TIERS.ADVANCED : TIERS.FAST
      const code = !confident ? 'classifier_low_confidence' : tier === TIERS.FAST ? 'classifier_fast' : 'classifier_advanced'
      return decision(mode, tier, 'classifier', [code], { score: scored.score, classifier: meta })
    }
    // Classifier failed: fall back to the deterministic policy. Its gray band is irreducibly ambiguous → Pro.
    const fallbackCode = c.reason === 'invalid' ? 'classifier_invalid' : 'classifier_unavailable'
    return decision(mode, TIERS.ADVANCED, 'default', [fallbackCode, 'default_advanced'], { score: scored.score, classifier: meta })
  }

  return Object.freeze({ route, profiles })
}
