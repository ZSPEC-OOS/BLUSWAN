// Local, user-level settings (permission mode, model, credentials). Credentials live in this browser only;
// anything with `VITE_` in the environment is exposed to the client bundle, so a production deployment
// should keep the key on a server (see README). Storage failures degrade to in-memory settings.
import { isPermissionMode, DEFAULT_PERMISSION_MODE } from '../../tools/permissionModes.js'

const KEY = 'bluswan.settings'
const DEFAULTS = Object.freeze({ permissionMode: DEFAULT_PERMISSION_MODE, provider: 'deepseek', model: '', apiKey: '', baseUrl: '' })

function readStorage(storage) {
  try { return JSON.parse(storage?.getItem(KEY) ?? 'null') ?? {} } catch { return {} }
}

/** @param {{storage?:Storage|null, defaults?:object}} [options] */
export function createSettingsStore({ storage = globalThis.localStorage ?? null, defaults = {} } = {}) {
  const listeners = new Set()
  const sanitize = (v) => ({
    permissionMode: isPermissionMode(v.permissionMode) ? v.permissionMode : DEFAULTS.permissionMode,
    provider: typeof v.provider === 'string' && v.provider ? v.provider : DEFAULTS.provider,
    model: typeof v.model === 'string' ? v.model.trim() : '',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey.trim() : '',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '',
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
    /** Effective DeepSeek connection settings: user overrides on top of the environment configuration. */
    resolveProviderConfig(base = {}) {
      return { ...base, ...(value.apiKey ? { apiKey: value.apiKey } : {}), ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}), ...(value.model ? { model: value.model } : {}) }
    },
    /** Never includes the key. */
    redacted: () => ({ ...value, apiKey: value.apiKey ? '[set]' : '' }),
  }
}
