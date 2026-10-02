// Where the browser should find the BLUSWAN runtime, resolved once from the build's public configuration.
import { validateApiUrl, isMobileClient } from './connectivity.js'

/** @returns {{url:string, ok:boolean, error?:string, warnings:{code:string,message:string}[], mobile:boolean}} */
export function resolveApiUrl({ raw, location = globalThis.location, navigator: nav = globalThis.navigator } = {}) {
  let configured = raw
  // direct property access: Vite replaces exactly this value, never the whole env object (which would inline every VITE_ variable)
  if (configured === undefined) { try { configured = import.meta.env.VITE_BLUSWAN_API_URL } catch { configured = '' } }
  const mobile = isMobileClient(nav)
  const v = validateApiUrl(configured ?? '', { page: location ? { hostname: location.hostname, protocol: location.protocol } : null, mobile })
  return { ...v, mobile }
}

const MODE_KEY = 'bluswan.authMode'
/** The auth mode the runtime last reported, so a page opened while the runtime is down can still sign in and show cached data. */
export const rememberedAuthMode = () => { try { const m = globalThis.localStorage?.getItem(MODE_KEY); return m === 'firebase' || m === 'none' ? m : null } catch { return null } }
export const rememberAuthMode = (mode) => { try { globalThis.localStorage?.setItem(MODE_KEY, mode) } catch { /* private mode: nothing is remembered */ } }
