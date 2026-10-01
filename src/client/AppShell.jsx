// Chat-first application surface. Renders runtime state and forwards user intent;
// all execution happens in the agent runtime.
import { useEffect, useState } from 'react'
import { createAgentRuntime } from '../agent/runtime.js'
import { getDefaultModelRef } from '../config/runtimeConfig.js'
import SessionView from './SessionView.jsx'
import ChatComposer from './ChatComposer.jsx'

export default function AppShell({ userEmail, onLogout, runtime: injected }) {
  const [runtime] = useState(() => injected ?? createAgentRuntime())
  const [sessionId] = useState(() => runtime.startSession({ model: getDefaultModelRef() }).id)
  const [session, setSession] = useState(() => runtime.getSession(sessionId))

  useEffect(() => {
    setSession(runtime.getSession(sessionId)) // eslint-disable-line react-hooks/set-state-in-effect
    return runtime.subscribe((_event, snapshot) => {
      if (snapshot.id === sessionId) setSession(snapshot)
    })
  }, [runtime, sessionId])

  const running = session?.status === 'running'
  const model = session?.model

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#030b18', color: '#e2e8f0', fontFamily: "-apple-system, 'Segoe UI', sans-serif" }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.5rem 1rem', borderBottom: '1px solid #1e293b' }}>
        <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: 28 }} />
        <span style={{ color: '#64748b', fontSize: '0.8rem' }}>
          {model ? `${model.provider} / ${model.model || 'no model configured'}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: '0.8rem' }}>
          {session?.status ?? ''} {userEmail ? `· ${userEmail}` : ''}
        </span>
        {onLogout && <button onClick={onLogout}>Sign out</button>}
      </header>
      <SessionView session={session} />
      <ChatComposer
        disabled={!sessionId || running || session?.status === 'cancelled'}
        running={running}
        onSubmit={(text) => { runtime.sendMessage(sessionId, text).catch(() => {}) }}
        onCancel={() => runtime.cancelSession(sessionId)}
      />
    </div>
  )
}
