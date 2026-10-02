// Local, non-secret preferences: permission mode and model name. Provider credentials do not live here — or
// anywhere in the browser: the BLUSWAN server holds them (see src/providers/credentials). Storage failures
// degrade to in-memory settings.
import { isPermissionMode, DEFAULT_PERMISSION_MODE } from '../../tools/permissionModes.js'

const KEY = 'bluswan.settings'
const DEFAULTS = Object.freeze({ permissionMode: DEFAULT_PERMISSION_MODE, provider: 'deepseek', model: '' })

function readStorage(storage) {
  try { return JSON.parse(storage?.getItem(KEY) ?? 'null') ?? {} } catch { return {} }
}

/** @param {{storage?:Storage|null, defaults?:object}} [options] */
export function createSettingsStore({ storage = globalThis.localStorage ?? null, defaults = {} } = {}) {
  const listeners = new Set()
  // Only known, non-secret fields survive: anything else found in storage (an old `apiKey`, say) is dropped on the next write.
  const sanitize = (v) => ({
    permissionMode: isPermissionMode(v.permissionMode) ? v.permissionMode : DEFAULTS.permissionMode,
    provider: typeof v.provider === 'string' && v.provider ? v.provider : DEFAULTS.provider,
    model: typeof v.model === 'string' ? v.model.trim().slice(0, 100) : '',
  })
  let value = Object.freeze(sanitize({ ...DEFAULTS, ...defaults, ...readStorage(storage) }))

  return {
    get: () => value,
    update(patch) {
      value = Object.freeze(sanitize({ ...value, ...patch }))
      try { storage?.setItem(KEY, JSON.stringify(value)) } catch { /* private mode / quota: keep in memory */ }
      for (const fn of [...listeners]) fn(value)
      return value
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

/**
 * Removes provider API keys that earlier versions left in the browser. Called once at startup; unrelated
 * storage (sign-in state, UI preferences) is left alone.
 * @returns {string[]} what was removed (names only)
 */
export function scrubLegacySecrets({ local = globalThis.localStorage ?? null, session = globalThis.sessionStorage ?? null } = {}) {
  const removed = []
  const safe = (fn) => { try { fn() } catch { /* storage unavailable */ } }
  for (const key of ['wrkflow:keysbak']) safe(() => { if (local?.getItem(key) != null) { local.removeItem(key); removed.push(`localStorage:${key}`) } })
  for (const key of ['wrkflow:keys', 'wrkflow:sk']) safe(() => { if (session?.getItem(key) != null) { session.removeItem(key); removed.push(`sessionStorage:${key}`) } })
  safe(() => { // own earlier settings blob and the legacy model list may carry an `apiKey` field
    const own = JSON.parse(local?.getItem(KEY) ?? 'null')
    if (own && 'apiKey' in own) { delete own.apiKey; delete own.baseUrl; local.setItem(KEY, JSON.stringify(own)); removed.push(`localStorage:${KEY}.apiKey`) }
  })
  safe(() => {
    const models = JSON.parse(local?.getItem('wrkflow:models') ?? 'null')
    if (Array.isArray(models) && models.some(m => m && m.apiKey)) {
      local.setItem('wrkflow:models', JSON.stringify(models.map(m => (m && m.apiKey ? { ...m, apiKey: '' } : m))))
      removed.push('localStorage:wrkflow:models.apiKey')
    }
  })
  return removed
}
