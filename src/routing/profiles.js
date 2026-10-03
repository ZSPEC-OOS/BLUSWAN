// Profile availability and the browser-safe projection. Parsing lives in config/routingConfig.js.
import { TIER_LABELS, MODES, MODE_LABELS, MODE_LIST } from '../config/routingConfig.js'

export * from '../config/routingConfig.js'

const isCodingCapable = (caps) => !!caps?.toolCalling && !!caps?.streaming

/**
 * Resolves which profiles can actually run right now.
 * @param {{configured:boolean, profiles:object, problems?:string[]}} routing
 * @param {{isConfigured:(provider:string)=>boolean, capabilitiesFor:(provider:string, model:string)=>object|null}} deps
 * @returns {{available:boolean, tiers:Record<string,{ok:boolean, reason:string|null}>, problems:string[]}}
 *   Auto is available only when BOTH profiles are usable — there is no silent substitution of one tier for the other.
 */
export function evaluateProfiles(routing, { isConfigured, capabilitiesFor }) {
  const tiers = {}
  const problems = [...(routing.problems ?? [])]
  for (const tier of Object.keys(routing.profiles ?? {})) {
    const p = routing.profiles[tier]
    let reason = null
    if (!isConfigured(p.provider)) reason = `${p.provider} has no server credentials, so the ${TIER_LABELS[tier]} profile cannot run.`
    else {
      const caps = capabilitiesFor(p.provider, p.model)
      if (!caps) reason = `Model ${p.model} is unknown for ${p.provider}.`
      else if (!isCodingCapable(caps)) reason = `Model ${p.model} cannot act as the coding agent (it needs streaming and tool calling).`
    }
    tiers[tier] = { ok: !reason, reason }
    if (reason) problems.push(reason)
  }
  const available = !!routing.configured && !routing.problems?.length && Object.values(tiers).every(t => t.ok)
  return { available, tiers, problems }
}

/** Browser-safe projection: ids and labels only — no keys, thresholds, weights or classifier prompt. */
export function publicRouting(routing, evaluation) {
  const profiles = Object.entries(routing.profiles ?? {}).map(([id, p]) => ({
    id, label: TIER_LABELS[id], provider: p.provider, model: p.model, available: !!evaluation?.tiers?.[id]?.ok,
  }))
  return {
    available: !!evaluation?.available,
    configured: !!routing.configured,
    defaultMode: evaluation?.available ? routing.defaultMode : null,
    modes: MODE_LIST.map(id => ({ id, label: MODE_LABELS[id], available: id === MODES.AUTO ? !!evaluation?.available : !!evaluation?.tiers?.[id]?.ok })),
    profiles,
  }
}
