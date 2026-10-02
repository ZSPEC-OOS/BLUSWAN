import { MODE_INFO, PERMISSION_MODES } from '../../tools/permissionModes.js'
import SessionStatus from './SessionStatus.jsx'
import SaveIndicator from './SaveIndicator.jsx'
import './status.css'

/** Repository identity, state, changed-file count, model and permission mode, always visible above the conversation. */
export default function ChatHeader({ active, workspace, model, permissionMode, onPermissionMode, onOpenSettings, onToggleSidebar, onToggleChanges, panelOpen = false }) {
  const changed = active?.changedCount ?? 0
  const status = active?.view.status ?? 'ready'
  return (
    <header className="topbar">
      <button type="button" className="btn btn--ghost topbar__menu" onClick={onToggleSidebar} aria-label="Toggle conversations sidebar">☰</button>
      <div className="topbar__repo" title={workspace?.name ?? ''}>
        {workspace ? (
          <>
            <strong>{workspace.name}</strong>
            {workspace.branch ? <span className="topbar__branch">⎇ {workspace.branch}</span> : null}
            {!workspace.available ? <span className="topbar__warn">unavailable</span> : null}
          </>
        ) : <span className="topbar__muted">No repository connected</span>}
      </div>
      <SessionStatus status={status} workingLabel={active?.view.workingLabel} />
      <SaveIndicator status={active?.persistence} hasMessages={!!active?.view.entries.some(e => e.kind === 'user')} />
      <span className="topbar__spacer" />
      {onToggleChanges ? (
        <button type="button" className="btn topbar__changes" onClick={onToggleChanges} aria-pressed={panelOpen} aria-label={changed ? `${changed} ${changed === 1 ? 'file' : 'files'} changed — toggle workspace panel` : 'Toggle workspace panel'} title="Changes, validation and commands (Ctrl+Shift+D)">
          {changed ? `${changed} ${changed === 1 ? 'file' : 'files'} changed` : 'Workspace'}
        </button>
      ) : null}
      <button type="button" className="btn btn--ghost topbar__model" onClick={onOpenSettings} title="Model settings">{model?.model || 'Choose model'}</button>
      <label className="topbar__mode">
        <span className="sr-only">Permission mode</span>
        <select value={permissionMode} onChange={(e) => onPermissionMode(e.target.value)} aria-label="Permission mode" title={MODE_INFO[permissionMode]?.description}>
          {PERMISSION_MODES.map(m => <option key={m} value={m}>{MODE_INFO[m].label}</option>)}
        </select>
      </label>
      <button type="button" className="btn btn--ghost" onClick={onOpenSettings} aria-label="Open settings">⚙</button>
    </header>
  )
}
