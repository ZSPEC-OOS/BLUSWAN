// Renders a session: messages, live streaming text, runtime activity, status, errors.

const ACTIVITY_TYPES = new Set([
  'tool.started', 'tool.completed', 'tool.failed', 'file.changed',
  'command.started', 'command.completed', 'validation.started', 'validation.completed',
])

// Streaming text that has not yet been committed as an assistant message.
function liveText(events) {
  let text = ''
  for (const e of events) {
    if (e.type === 'user.message' || e.type === 'assistant.text.completed') text = ''
    else if (e.type === 'assistant.text.delta') text += e.data.text ?? ''
  }
  return text
}

function lastError(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'session.failed') return events[i].data.error
    if (events[i].type === 'user.message') return null
  }
  return null
}

const bubble = (role) => ({
  alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  maxWidth: '80%',
  whiteSpace: 'pre-wrap',
  padding: '0.5rem 0.75rem',
  borderRadius: 8,
  background: role === 'user' ? '#1e3a5f' : '#0f172a',
  color: '#e2e8f0',
})

export default function SessionView({ session }) {
  if (!session) return null
  const streaming = session.status === 'running' ? liveText(session.events) : ''
  const error = session.status === 'error' ? lastError(session.events) : null
  const activity = session.events.filter(e => ACTIVITY_TYPES.has(e.type))

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
      {session.messages.length === 0 && (
        <div style={{ color: '#64748b' }}>Describe a coding task to begin.</div>
      )}
      {session.messages.map(m => <div key={m.id} style={bubble(m.role)}>{m.content}</div>)}
      {streaming && <div style={bubble('assistant')}>{streaming}</div>}
      {activity.map(e => (
        <div key={e.id} style={{ color: '#64748b', fontSize: '0.8rem' }}>▸ {e.type} {e.data.name ?? e.data.path ?? ''}</div>
      ))}
      {session.status === 'cancelled' && <div style={{ color: '#fcd34d' }}>Session cancelled.</div>}
      {error && (
        <div role="alert" style={{ color: '#fca5a5' }}>
          {error.message} <span style={{ opacity: 0.6 }}>({error.code})</span>
        </div>
      )}
    </div>
  )
}
