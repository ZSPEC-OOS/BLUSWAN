import { useEffect, useState } from 'react'

/** Whole seconds until `at` (a timestamp), ticking once a second; null when there is nothing to wait for. */
export function useCountdown(at) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}
