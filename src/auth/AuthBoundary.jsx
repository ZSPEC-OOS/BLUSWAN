// Decides who the user is. The runtime states whether it requires authentication (`/api/health`):
//   none     → one local user, no sign-in, Firebase never loads;
//   firebase → sign-in is shown until a Firebase user exists, and its ID token accompanies every request.
// Children receive a plain { id, email, getToken, signOut }. While the runtime cannot be reached (and its auth mode
// is not already known from an earlier visit) a connection screen explains why and keeps retrying.
import { useCallback, useEffect, useMemo, useState } from 'react'
import SignIn from './SignIn.jsx'
import { isFirebaseConfigured, missingFirebaseSettings, onAuthStateChange, signOutUser } from './firebaseAuth.js'
import ConnectionScreen from '../client/status/ConnectionScreen.jsx'
import { probeHealth } from '../client/runtime/connectivity.js'
import { resolveApiUrl, rememberedAuthMode, rememberAuthMode } from '../client/runtime/apiUrl.js'

const BASE = [500, 1000, 2000, 4000, 8000, 15000]
const LOCAL = Object.freeze({ id: 'local', email: null, getToken: async () => null, signOut: null })

export default function AuthBoundary({ children }) {
  const api = useMemo(() => resolveApiUrl(), [])
  const [mode, setMode] = useState(null) // null (asking) | 'none' | 'firebase'
  const [failure, setFailure] = useState(null)
  const [tries, setTries] = useState(0)
  const [nextRetryAt, setNextRetryAt] = useState(null)
  const [user, setUser] = useState(undefined) // undefined (not yet known) | null | Firebase user
  const remembered = useMemo(() => rememberedAuthMode(), [])

  const check = useCallback(() => { setFailure(null); setTries(t => t + 1) }, [])

  useEffect(() => {
    if (!api.ok) return undefined
    let cancelled = false; let timer = null
    probeHealth({ baseUrl: api.url }).then((h) => {
      if (cancelled) return
      const m = h.auth === 'firebase' ? 'firebase' : 'none'
      rememberAuthMode(m); setMode(m); setFailure(null); setNextRetryAt(null)
    }).catch((f) => {
      if (cancelled) return
      setFailure(f)
      if (f.retryable) { const wait = BASE[Math.min(tries, BASE.length - 1)]; setNextRetryAt(Date.now() + wait); timer = setTimeout(() => setTries(t => t + 1), wait) }
    })
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, tries])

  const effectiveMode = mode ?? (failure ? remembered : null) // an unreachable runtime does not hide a cached session list
  useEffect(() => {
    if (effectiveMode !== 'firebase' || !isFirebaseConfigured()) return undefined
    return onAuthStateChange((u) => setUser(u ?? null))
  }, [effectiveMode])

  if (!api.ok) return <ConnectionScreen kind="configuration_error" message={api.error} />
  if (!effectiveMode) {
    return failure
      ? <ConnectionScreen connection={{ state: 'checking_server', failure: { kind: failure.kind, retryable: failure.retryable, status: failure.status, requestId: failure.requestId }, nextRetryAt }} onRetry={check} apiUrl={api.url} warnings={api.warnings} mobile={api.mobile} />
      : <ConnectionScreen connection={{ state: 'checking_server' }} />
  }
  if (effectiveMode === 'none') return children(LOCAL)
  if (!isFirebaseConfigured()) return <ConnectionScreen kind="configuration_error" message={`This runtime requires sign-in, but this build of the app is missing its Firebase web settings: ${missingFirebaseSettings().join(', ')}. Rebuild with them set (see docs/DEPLOYMENT.md).`} />
  if (user === undefined) return <ConnectionScreen connection={{ state: 'authenticating' }} />
  if (!user) return <SignIn />
  return children({ id: user.uid, email: user.email || null, getToken: () => user.getIdToken(), signOut: () => signOutUser().catch(() => {}) })
}
