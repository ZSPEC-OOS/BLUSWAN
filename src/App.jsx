import React from 'react'
import AuthBoundary from './client/AuthBoundary.jsx'
import AppShell from './client/AppShell.jsx'
import { createSettingsStore } from './client/settings/settingsStore.js'
import { createBrowserRuntime, selectedModel } from './client/runtime/createBrowserRuntime.js'
import { createClientStore } from './client/state/clientStore.js'

// One settings store, runtime and client store for the lifetime of the page.
function createApp() {
  const settings = createSettingsStore()
  const runtime = createBrowserRuntime({ settings })
  const store = createClientStore({ runtime, settings, selectModel: () => selectedModel(settings) })
  return { settings, store }
}
let app = null
const getApp = () => (app ??= createApp())

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
  const { settings, store } = getApp()
  return (
    <AppErrorBoundary>
      <AuthBoundary>
        {({ email, signOut }) => <AppShell store={store} settings={settings} userEmail={email} onLogout={signOut} />}
      </AuthBoundary>
    </AppErrorBoundary>
  )
}
