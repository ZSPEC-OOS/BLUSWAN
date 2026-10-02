// Sign-in boundary. Isolated from the agent runtime: children receive only a plain { email, signOut } description.
import { useEffect, useState } from 'react'
import { onAuthStateChange, signOutUser } from '../services/firebaseService'

export function Splash({ msg = 'Loading...' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1.25rem', background: '#030b18' }}>
      <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: '44px', width: 'auto' }} />
      <span style={{ color: '#5d6f8d', fontSize: '0.82rem' }}>{msg}</span>
    </div>
  )
}

export default function AuthBoundary({ children }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState(null)

  useEffect(() => onAuthStateChange((u) => { setUser(u ?? null); setReady(true) }), [])

  if (!ready) return <Splash />
  return children({
    id: user?.uid ?? 'local',
    email: user?.email || null,
    // The ID token is attached to requests to the BLUSWAN server, which verifies it; the browser never holds provider keys.
    getToken: user ? () => user.getIdToken() : async () => null,
    signOut: user ? () => signOutUser().catch(() => {}) : null,
  })
}
