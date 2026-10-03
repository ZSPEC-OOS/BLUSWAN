// Routing configuration (pure; lives in config so the runtime configuration can read it without cycles).
// Execution profiles for adaptive routing. A profile names the provider, model and reasoning effort BLUSWAN uses for
// one capability tier. Profiles are server configuration: nothing here reads secrets, and the browser only ever sees
// the safe projection from `publicRouting()`.
export const TIERS = Object.freeze({ FAST: 'fast', ADVANCED: 'advanced' })
export const MODES = Object.freeze({ AUTO: 'auto', FAST: 'fast', ADVANCED: 'advanced' })
export const MODE_LIST = Object.freeze([MODES.AUTO, MODES.FAST, MODES.ADVANCED])
export const REASONING_EFFORTS = Object.freeze(['high', 'max'])
export const TIER_LABELS = Object.freeze({ fast: 'Flash', advanced: 'Pro' })
export const MODE_LABELS = Object.freeze({ auto: 'Auto', fast: 'Flash', advanced: 'Pro' })

const DEFAULT_PROFILES = Object.freeze({
  fast: Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' }),
  advanced: Object.freeze({ provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' }),
})
const MODE_ALIASES = Object.freeze({ auto: 'auto', fast: 'fast', flash: 'fast', advanced: 'advanced', pro: 'advanced' })

/** Normalises a user-facing mode string (auto | flash | pro | fast | advanced); null when unrecognised. */
export const normalizeMode = (value) => MODE_ALIASES[String(value ?? '').trim().toLowerCase()] ?? null
export const isMode = (value) => MODE_LIST.includes(value)

/**
 * Parses routing configuration from the environment. Pure; never throws.
 * Routing is "configured" when any BLUSWAN_MODEL_MODE / BLUSWAN_FAST_* / BLUSWAN_ADVANCED_* variable is set; without
 * them BLUSWAN keeps its manual-only behaviour. Missing profile fields fall back to the documented DeepSeek defaults.
 * @param {Record<string,string|undefined>} env
 * @param {{knownProviders?:string[]}} [opts]
 * @returns {{configured:boolean, defaultMode:string, profiles:{fast:object,advanced:object}, problems:string[]}}
 */
export function parseRoutingEnv(env = {}, { knownProviders = ['deepseek', 'kimi', 'openai', 'anthropic'] } = {}) {
  const get = (k) => (env[k] === undefined ? '' : String(env[k]).trim())
  const keys = ['BLUSWAN_MODEL_MODE', 'BLUSWAN_FAST_PROVIDER', 'BLUSWAN_FAST_MODEL', 'BLUSWAN_FAST_REASONING_EFFORT', 'BLUSWAN_ADVANCED_PROVIDER', 'BLUSWAN_ADVANCED_MODEL', 'BLUSWAN_ADVANCED_REASONING_EFFORT']
  const configured = keys.some(k => get(k) !== '')
  const problems = []

  let defaultMode = MODES.AUTO
  if (get('BLUSWAN_MODEL_MODE')) {
    const m = normalizeMode(get('BLUSWAN_MODEL_MODE'))
    if (m) defaultMode = m
    else problems.push('BLUSWAN_MODEL_MODE must be one of: auto, flash, pro.')
  }

  const profiles = {}
  for (const [tier, prefix] of [['fast', 'BLUSWAN_FAST'], ['advanced', 'BLUSWAN_ADVANCED']]) {
    const d = DEFAULT_PROFILES[tier]
    const provider = get(`${prefix}_PROVIDER`) || d.provider
    const model = get(`${prefix}_MODEL`) || d.model
    const effort = get(`${prefix}_REASONING_EFFORT`) || d.reasoningEffort
    if (!knownProviders.includes(provider)) problems.push(`${prefix}_PROVIDER "${provider}" is not a known provider (${knownProviders.join(', ')}).`)
    if (!REASONING_EFFORTS.includes(effort)) problems.push(`${prefix}_REASONING_EFFORT must be one of: ${REASONING_EFFORTS.join(', ')}.`)
    profiles[tier] = Object.freeze({ provider, model, reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : d.reasoningEffort })
  }
  if (configured && !!get('BLUSWAN_FAST_MODEL') !== !!get('BLUSWAN_ADVANCED_MODEL') && !get('BLUSWAN_MODEL_MODE')) {
    problems.push('Only one of BLUSWAN_FAST_MODEL / BLUSWAN_ADVANCED_MODEL is set; set both so Auto can use two tiers.')
  }
  return { configured, defaultMode, profiles: Object.freeze(profiles), problems }
}

