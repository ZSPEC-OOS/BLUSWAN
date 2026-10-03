// Connects the provider-neutral routing layer to the provider registry: availability of each profile, and the
// bounded `complete()` the classifier uses. Routing itself (src/routing) never imports a provider.
import { createRouter } from '../routing/router.js'
import { evaluateProfiles, publicRouting } from '../routing/profiles.js'

/**
 * Runs one short, tool-less completion on a profile and returns its text and usage. Single attempt (no retry):
 * a slow or failing classifier must fall back quickly rather than delay the user's request.
 */
export function createClassifierComplete({ providers, profile }) {
  return async function complete({ system, prompt, maxOutputTokens, signal }) {
    const provider = providers.getProvider(profile.provider)
    provider.validate?.(profile.model)
    let text = ''
    let usage = null
    await provider.stream({
      model: profile.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], tools: [], signal,
      temperature: 0, maxOutputTokens, reasoningEffort: 'off', metadata: { purpose: 'routing' },
    }, {
      onEvent: (e) => {
        if (e.type === 'text_delta') text += e.text
        else if (e.type === 'usage') usage = { input: e.input ?? 0, output: e.output ?? 0, reasoning: e.reasoning ?? 0, ...(e.cachedInput != null ? { cachedInput: e.cachedInput } : {}) }
      },
    })
    return { text, usage }
  }
}

/**
 * @param {{routing:object|null, providers:object, isConfigured:(provider:string)=>boolean, now?:()=>number}} deps
 *   routing: the parsed routing configuration (config/routingConfig.js). Returns null when routing is not configured.
 * @returns {null|{configured:true, available:boolean, profiles:object, evaluation:object, router:object, public:object, defaultMode:string}}
 */
export function createRouting({ routing, providers, isConfigured, now }) {
  if (!routing?.configured) return null
  const capabilitiesFor = (provider, model) => {
    try { return providers.getProvider(provider).capabilities(model) } catch { return null }
  }
  const evaluation = evaluateProfiles(routing, { isConfigured, capabilitiesFor })
  const complete = evaluation.tiers.fast?.ok ? createClassifierComplete({ providers, profile: routing.profiles.fast }) : null
  const router = createRouter({ profiles: routing.profiles, tiers: evaluation.tiers, complete, now })
  return { configured: true, available: evaluation.available, profiles: routing.profiles, evaluation, router, public: publicRouting(routing, evaluation), defaultMode: routing.defaultMode }
}
