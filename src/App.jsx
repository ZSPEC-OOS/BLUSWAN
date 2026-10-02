import React from 'react'
import AuthBoundary from './auth/AuthBoundary.jsx'
import ConnectedApplication from './ConnectedApplication.jsx'

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
      <div role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#030b18', color: '#e6edf7', padding: '1.5rem', textAlign: 'center' }}>
        <div style={{ maxWidth: '38rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>BLUSWAN ran into a problem</h2>
          <p style={{ color: '#8a9bb6', fontSize: '0.85rem' }}>Reload the page to continue. Your repository files were not affected.</p>
          <button type="button" onClick={() => globalThis.location.reload()} style={{ font: 'inherit', padding: '0.4rem 1rem' }}>Reload</button>
        </div>
      </div>
    )
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthBoundary>
        {(identity) => <ConnectedApplication identity={identity} />}
      </AuthBoundary>
    </AppErrorBoundary>
  )
}
