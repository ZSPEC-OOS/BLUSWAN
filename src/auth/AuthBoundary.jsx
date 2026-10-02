// Decides who the user is. The server states whether it requires authentication (`/api/health`):
//   none     → one local user, no sign-in, Firebase never loads;
//   firebase → sign-in is shown until a Firebase user exists, and its ID token accompanies every request.
// Children receive a plain { id, email, getToken, signOut }.
import { useEffect, useState } from 'react'
import SignIn from './SignIn.jsx'
import { isFirebaseConfigured, onAuthStateChange, signOutUser } from './firebaseAuth.js'

const API_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BLUSWAN_API_URL) || ''

export function Splash({ msg = 'Loading...' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1.25rem', background: '#030b18' }}>
      <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: '44px', width: 'auto' }} />
      <span style={{ color: '#5d6f8d', fontSize: '0.82rem' }}>{msg}</span>
    </div>
  )
}

const LOCAL = Object.freeze({ id: 'local', email: null, getToken: async () => null, signOut: null })

export default function AuthBoundary({ children }) {
  const [mode, setMode] = useState(null) // null (asking) | 'none' | 'firebase'
  const [user, setUser] = useState(undefined) // undefined (not yet known) | null | Firebase user

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/api/health`).then(r => r.json()).then(h => { if (!cancelled) setMode(h?.auth === 'firebase' ? 'firebase' : 'none') }).catch(() => { if (!cancelled) setMode('none') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (mode !== 'firebase' || !isFirebaseConfigured()) return undefined
    return onAuthStateChange((u) => setUser(u ?? null))
  }, [mode])

  if (mode === null) return <Splash />
  if (mode === 'none') return children(LOCAL)
  if (!isFirebaseConfigured()) return <Splash msg="This server requires sign-in, but Firebase is not configured for the web app." />
  if (user === undefined) return <Splash />
  if (!user) return <SignIn />
  return children({ id: user.uid, email: user.email || null, getToken: () => user.getIdToken(), signOut: () => signOutUser().catch(() => {}) })
}

