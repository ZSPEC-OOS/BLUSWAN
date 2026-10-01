// Chat-first application surface. Renders runtime state and forwards user intent;
// all execution happens in the agent runtime.
import { useEffect, useState } from 'react'
import { createAgentRuntime } from '../agent/runtime.js'
import { getDefaultModelRef } from '../config/runtimeConfig.js'
import SessionView from './SessionView.jsx'
import ChatComposer from './ChatComposer.jsx'

// `workspaceId` connects the session to a workspace owned by the host (the browser has no
// filesystem access; a Node host injects a runtime and workspace). Without one the agent can chat
// but its repository tools are unavailable.
export default function AppShell({ userEmail, onLogout, runtime: injected, workspaceId = null }) {
  const [runtime] = useState(() => injected ?? createAgentRuntime())
  const [sessionId] = useState(() => runtime.startSession({ workspaceId, model: getDefaultModelRef() }).id)
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
      {!workspaceId && (
        <div role="status" style={{ background: '#1e293b', color: '#fcd34d', padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
          No workspace connected — repository tools are unavailable in the browser. Run the agent against a local repository with <code>npm run agent -- --workspace &lt;dir&gt; &quot;your request&quot;</code>.
        </div>
      )}
      <SessionView session={session} />
      <ChatComposer
        disabled={!sessionId || running}
        running={running}
        onSubmit={(text) => { runtime.sendMessage(sessionId, text).catch(() => {}) /* session_busy etc. surface via session state */ }}
        onCancel={() => runtime.cancelSession(sessionId)}
      />
    </div>
  )
}
