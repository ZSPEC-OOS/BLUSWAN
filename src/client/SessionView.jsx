// Renders a session: messages, live streaming text, tool activity, notices and errors,
// all derived from normalized runtime events.
import { buildTimeline, liveText } from './activity.js'

const bubble = (role) => ({
  alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  maxWidth: '80%',
  whiteSpace: 'pre-wrap',
  padding: '0.5rem 0.75rem',
  borderRadius: 8,
  background: role === 'user' ? '#1e3a5f' : '#0f172a',
  color: '#e2e8f0',
})

const MARK = { running: '▸', done: '✓', failed: '✗', skipped: '–' }

export default function SessionView({ session }) {
  if (!session) return null
  const timeline = buildTimeline(session.events)
  const streaming = session.status === 'running' ? liveText(session.events) : ''

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
      {timeline.length === 0 && <div style={{ color: '#64748b' }}>Describe a coding task to begin.</div>}
      {timeline.map(item => {
        if (item.kind === 'user' || item.kind === 'assistant') return <div key={item.id} style={bubble(item.kind)}>{item.text}</div>
        if (item.kind === 'tool') {
          return (
            <div key={item.id} style={{ color: item.status === 'failed' ? '#fca5a5' : '#64748b', fontSize: '0.8rem' }}>
              {MARK[item.status]} {item.label}{item.status === 'failed' && item.error ? ` — ${item.error}` : ''}
              {item.changed.map(c => <div key={c} style={{ paddingLeft: '1rem', color: '#86efac' }}>{c}</div>)}
            </div>
          )
        }
        if (item.kind === 'error') {
          return <div key={item.id} role="alert" style={{ color: '#fca5a5' }}>{item.text} <span style={{ opacity: 0.6 }}>({item.code})</span></div>
        }
        return <div key={item.id} style={{ color: '#fcd34d', fontSize: '0.85rem' }}>{item.text}</div>
      })}
      {streaming && <div style={bubble('assistant')}>{streaming}</div>}
    </div>
  )
}
