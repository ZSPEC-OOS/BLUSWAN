import SaveIndicator from '../status/SaveIndicator.jsx'
import './mobile.css'

/**
 * Phone header: ☰ (workspace) · BLUSWAN + repository/branch context · ⚙ (settings). Presentation only; every action is the
 * shell's existing one. `attention` marks a repository state that needs the user (shown as text, not colour alone).
 */
export default function MobileHeader({ repository = null, branch = null, unavailable = false, working = false, attention = null, saveStatus = null, hasMessages = false, workspaceOpen = false, settingsOpen = false, onOpenWorkspace, onOpenSettings }) {
  return (
    <header className="mhead">
      <button type="button" className="mhead__btn" onClick={onOpenWorkspace} aria-label={attention ? `Open workspace menu — ${attention}` : 'Open workspace menu'} aria-haspopup="dialog" aria-expanded={workspaceOpen}>
        <span aria-hidden="true">☰</span>{attention ? <span className="mhead__dot" aria-hidden="true" /> : null}
      </button>
      <button type="button" className="mhead__center" onClick={onOpenWorkspace} aria-label={repository ? `Repository ${repository}${branch ? `, branch ${branch}` : ''}. Open workspace menu` : 'No repository. Open workspace menu'} tabIndex={-1}>
        <span className="mhead__title">BLUSWAN{working ? <span className="mhead__working" role="status" aria-label="BLUSWAN is working"> ●</span> : null}</span>
        <span className="mhead__context" data-testid="mobile-context">
          {repository ? (
            <><span className="mhead__repo">{repository}</span>{branch ? <><span aria-hidden="true"> · </span><span className="mhead__branch">{branch}</span></> : null}{unavailable ? <span className="mhead__warn"> unavailable</span> : null}</>
          ) : <span className="mhead__none">No repository</span>}
        </span>
        {saveStatus === 'failed' || saveStatus === 'conflict' ? <SaveIndicator status={saveStatus} hasMessages={hasMessages} /> : null}
      </button>
      <button type="button" className="mhead__btn" onClick={onOpenSettings} aria-label="Open settings" aria-haspopup="dialog" aria-expanded={settingsOpen}><span aria-hidden="true">⚙</span></button>
    </header>
  )
}
