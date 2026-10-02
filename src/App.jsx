import React from 'react'
import { useEffect, useState } from 'react'
import AuthBoundary, { Splash } from './client/AuthBoundary.jsx'
import AppShell from './client/AppShell.jsx'
import { createSettingsStore, scrubLegacySecrets } from './client/settings/settingsStore.js'
import { createRemoteRuntime, createIndexCache } from './client/runtime/createRemoteRuntime.js'
import { createClientStore } from './client/state/clientStore.js'
import { createIndexedDbDocStore, openIndexedDb } from './persistence/adapters/localPersistence.js'

const API_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BLUSWAN_API_URL) || ''

/** IndexedDB cache of the session list (offline display). Absent storage just means no offline list. */
async function openCache() {
  try { return globalThis.indexedDB ? createIndexCache(createIndexedDbDocStore({ db: await openIndexedDb(globalThis.indexedDB) })) : null } catch { return null }
}

/** Talks to the BLUSWAN server: the runtime, provider credentials and storage all live there. */
function Connected({ identity }) {
  const [state, setState] = useState({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let runtime = null
    let store = null
    scrubLegacySecrets() // provider keys left in this browser by earlier versions
    ;(async () => {
      runtime = createRemoteRuntime({ baseUrl: API_URL, getToken: identity.getToken, userKey: identity.id, cache: await openCache() })
      await runtime.init()
      if (cancelled) { runtime.close(); return }
      const settings = createSettingsStore()
      store = createClientStore({
        runtime, settings,
        selectModel: () => ({ provider: 'deepseek', model: settings.get().model || runtime.getProviderStatus().find(p => p.provider === 'deepseek')?.model || '' }),
      })
      setState({ phase: 'ready', store, settings, runtime })
    })().catch((e) => { if (!cancelled) setState({ phase: 'error', message: e?.status === 401 ? 'Your session has expired. Sign in again.' : 'BLUSWAN could not reach its server.' }) })
    return () => { cancelled = true; store?.destroy(); runtime?.close() }
  }, [identity.id, identity.getToken, attempt])

  if (state.phase === 'loading') return <Splash msg="Loading sessions…" />
  if (state.phase === 'error') {
    return (
      <div role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem', background: '#030b18', color: '#e6edf7', textAlign: 'center', padding: '1.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{state.message}</h2>
        <p style={{ color: '#8a9bb6', fontSize: '0.85rem', margin: 0 }}>Your conversations are stored on the server and will be there when it is back.</p>
        <button type="button" onClick={() => { setState({ phase: 'loading' }); setAttempt(a => a + 1) }} style={{ font: 'inherit', padding: '0.4rem 1rem' }}>Try again</button>
      </div>
    )
  }
  const signOut = identity.signOut ? async () => { await state.runtime.logout(); identity.signOut() } : null
  return <AppShell store={state.store} settings={state.settings} userEmail={identity.email} onLogout={signOut} />
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'Unknown error' }
  }

  componentDidCatch(error) {
    console.error('[Bluswan] Unhandled render error:', error)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#030b18', color: '#e6edf7', padding: '1.5rem', textAlign: 'center' }}>
        <div style={{ maxWidth: '38rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>BLUSWAN ran into a problem</h2>
          <p style={{ color: '#8a9bb6', fontSize: '0.85rem' }}>Reload the page to continue. Your repository files were not affected.</p>
        </div>
      </div>
    )
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthBoundary>
        {(identity) => <Connected identity={identity} />}
      </AuthBoundary>
    </AppErrorBoundary>
  )
}
