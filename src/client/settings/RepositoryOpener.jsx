import { useState } from 'react'

/** Open a local repository by path (shared by the settings dialog and the mobile Workspace). Behavior is the server's: `onOpen({ root })`. */
export default function RepositoryOpener({ canOpenWorkspaces, onOpen }) {
  const [path, setPath] = useState('')
  if (!canOpenWorkspaces) {
    return <p className="settings__hint">This browser session cannot open local folders. Run BLUSWAN against a local repository with <code>npm run agent -- --workspace &lt;dir&gt; &quot;your request&quot;</code>.</p>
  }
  return (
    <div className="settings__row">
      <input aria-label="Repository path" value={path} placeholder="/path/to/repository" onChange={(e) => setPath(e.target.value)} />
      <button type="button" className="btn" disabled={!path.trim()} onClick={() => onOpen({ root: path.trim() })}>Open</button>
    </div>
  )
}
