import React from 'react'
import AuthBoundary from './client/AuthBoundary.jsx'
import AppShell from './client/AppShell.jsx'

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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#020817', color: '#bfdbfe', padding: '1.5rem', textAlign: 'center' }}>
        <div style={{ maxWidth: '38rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>BLUSWAN hit a runtime error</h2>
          <p style={{ color: '#60a5fa', fontSize: '0.85rem' }}>Error: {this.state.message}</p>
        </div>
      </div>
    )
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthBoundary>
        {({ email, signOut }) => <AppShell userEmail={email} onLogout={signOut} />}
      </AuthBoundary>
    </AppErrorBoundary>
  )
}
