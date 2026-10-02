import { useState } from 'react'
import { signInWithEmail, signInWithGoogle, signUpWithEmail } from './firebaseAuth.js'

/** Sign-in for servers that require authentication. Credentials go to Firebase, never to BLUSWAN. */
export default function SignIn({ onError = null }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('in')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(onError)

  async function run(fn) {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e?.code === 'auth/invalid-credential' ? 'That email or password is not right.' : e?.message || 'Sign-in failed.') } finally { setBusy(false) }
  }
  const field = { font: 'inherit', padding: '.5rem .6rem', borderRadius: 6, border: '1px solid #2a3d5e', background: '#030b18', color: '#e6edf7' }
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#030b18', color: '#e6edf7', padding: '1.5rem' }}>
      <form onSubmit={(e) => { e.preventDefault(); run(() => (mode === 'in' ? signInWithEmail(email, password) : signUpWithEmail(email, password))) }}
        style={{ display: 'grid', gap: '.75rem', width: 'min(22rem, 100%)' }} aria-labelledby="signin-title">
        <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: 40, justifySelf: 'center' }} />
        <h1 id="signin-title" style={{ margin: 0, fontSize: '1.05rem', textAlign: 'center' }}>{mode === 'in' ? 'Sign in to BLUSWAN' : 'Create your account'}</h1>
        <label style={{ display: 'grid', gap: '.2rem', fontSize: '.85rem' }}>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={field} /></label>
        <label style={{ display: 'grid', gap: '.2rem', fontSize: '.85rem' }}>Password<input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} style={field} /></label>
        {error ? <p role="alert" style={{ margin: 0, color: '#fca5a5', fontSize: '.85rem' }}>{error}</p> : null}
        <button type="submit" disabled={busy} style={{ ...field, background: '#60a5fa', color: '#031326', fontWeight: 600, cursor: 'pointer' }}>{mode === 'in' ? 'Sign in' : 'Create account'}</button>
        <button type="button" disabled={busy} onClick={() => run(signInWithGoogle)} style={{ ...field, cursor: 'pointer' }}>Continue with Google</button>
        <button type="button" onClick={() => setMode(mode === 'in' ? 'up' : 'in')} style={{ background: 'none', border: 0, color: '#8a9bb6', cursor: 'pointer', font: 'inherit', fontSize: '.85rem' }}>
          {mode === 'in' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  )
}
