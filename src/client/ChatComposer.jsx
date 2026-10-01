import { useState } from 'react'

export default function ChatComposer({ disabled, running, onSubmit, onCancel }) {
  const [text, setText] = useState('')

  function submit(e) {
    e.preventDefault()
    const value = text.trim()
    if (!value || disabled) return
    setText('')
    onSubmit(value)
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: '0.5rem', padding: '0.75rem', borderTop: '1px solid #1e293b' }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(e) }}
        placeholder="Describe the change you want…"
        rows={2}
        style={{ flex: 1, resize: 'none', background: '#0f172a', color: '#e2e8f0', border: '1px solid #1e293b', borderRadius: 6, padding: '0.5rem' }}
      />
      {running
        ? <button type="button" onClick={onCancel}>Stop</button>
        : <button type="submit" disabled={disabled || !text.trim()}>Send</button>}
    </form>
  )
}
