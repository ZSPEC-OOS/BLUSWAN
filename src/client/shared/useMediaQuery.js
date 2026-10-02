import { useSyncExternalStore } from 'react'

/** Subscribes to a CSS media query. Server renders (and tests) report `false`. */
export function useMediaQuery(query) {
  return useSyncExternalStore(
    (cb) => { const m = globalThis.matchMedia?.(query); m?.addEventListener?.('change', cb); return () => m?.removeEventListener?.('change', cb) },
    () => !!globalThis.matchMedia?.(query)?.matches,
    () => false,
  )
}
