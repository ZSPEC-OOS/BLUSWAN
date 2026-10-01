// Firebase authentication and cloud-settings hydration. Isolated from the agent runtime:
// children receive only a plain { email, signOut } description.
import { useEffect, useState } from 'react'
import { saveModels, saveSearchKey } from '../services/aiService'
import { onAuthStateChange, signOutUser, loadUserSettings } from '../services/firebaseService'
import { KEYS } from '../shared/storageKeys.js'

// Writes cloud settings to the same storage paths the settings layer reads from.
async function injectCloudSettings(settings) {
  if (!settings) return
  try {
    const { githubToken, repo2Token, webSearchApiKey, models, permissionMode, _v, _ts, ...rest } = settings
    localStorage.setItem(KEYS.LS.SETTINGS, JSON.stringify(rest))
    if (permissionMode) localStorage.setItem(KEYS.LS.PERM_MODE, permissionMode)
    if (githubToken !== undefined) sessionStorage.setItem(KEYS.SS.GH_TOKEN, githubToken || '')
    if (repo2Token !== undefined) sessionStorage.setItem(KEYS.SS.GH_TOKEN_2, repo2Token || '')
    if (webSearchApiKey !== undefined) await saveSearchKey(webSearchApiKey || '')
    if (Array.isArray(models) && models.length > 0) await saveModels(models)
  } catch (err) {
    console.warn('[Bluswan] injectCloudSettings failed:', err.message)
  }
}

export function Splash({ msg = 'Loading...' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh',
      background: 'url(/bluswan-bg.jpg) center/cover no-repeat, #030b18',
      flexDirection: 'column', gap: '1.25rem',
    }}>
      <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: '44px', width: 'auto' }} />
      <span style={{ color: '#3d5a7a', fontSize: '0.82rem' }}>{msg}</span>
    </div>
  )
}

export default function AuthBoundary({ children }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState(null)
  const [cloudError, setCloudError] = useState('')

  useEffect(() => {
    return onAuthStateChange(async (u) => {
      if (u) {
        try {
          await injectCloudSettings(await loadUserSettings(u.uid))
          setCloudError('')
        } catch (err) {
          console.warn('[Bluswan] Could not load cloud settings:', err.message)
          setCloudError('Could not load cloud settings - using local data.')
        }
      }
      setUser(u ?? null)
      setReady(true)
    })
  }, [])

  if (!ready) return <Splash />

  const identity = {
    email: user?.email || 'local-user@bluswan.local',
    signOut: user ? () => signOutUser().catch(() => {}) : null,
  }
  return (
    <>
      {cloudError && <div role="alert" style={{ background: '#7f1d1d', color: '#fca5a5', padding: '0.4rem', textAlign: 'center', fontSize: '0.8rem' }}>{cloudError}</div>}
      {children(identity)}
    </>
  )
}
