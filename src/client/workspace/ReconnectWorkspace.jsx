import { useState } from 'react'

/** Shown when a conversation's repository is not available here. The transcript is intact; this re-attaches the folder. */
export default function ReconnectWorkspace({ name, reason, onReconnect }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form className="reconnect" onSubmit={async (e) => { e.preventDefault(); if (!path.trim()) return; setBusy(true); await onReconnect(path.trim()); setBusy(false) }}>
      <p className="reconnect__text"><strong>Workspace unavailable{name ? `: ${name}` : ''}.</strong> Conversation restored. Reconnect this repository to continue coding.{reason ? ` ${reason}` : ''}</p>
      <div className="settings__row">
        <label className="sr-only" htmlFor="reconnect-path">Repository folder</label>
        <input id="reconnect-path" className="reconnect__input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/repository" disabled={busy} />
        <button type="submit" className="btn" disabled={busy || !path.trim()}>{busy ? 'Reconnecting…' : 'Reconnect workspace'}</button>
      </div>
    </form>
  )
}
