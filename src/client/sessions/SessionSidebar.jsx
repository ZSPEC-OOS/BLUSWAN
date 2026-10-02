import NewSessionButton from './NewSessionButton.jsx'
import SessionList from './SessionList.jsx'
import './sessions.css'

export default function SessionSidebar({ sessions, activeId, onNew, onSelect, onDelete, open = true, onClose, onRepositories }) {
  return (
    <aside className={`sidebar${open ? ' is-open' : ''}`} aria-label="Conversations sidebar">
      <div className="sidebar__head">
        <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" className="sidebar__logo" />
        {onClose ? <button type="button" className="sidebar__close btn btn--ghost" onClick={onClose} aria-label="Close sidebar">✕</button> : null}
      </div>
      <NewSessionButton onClick={onNew} />
      {onRepositories ? <button type="button" className="btn sidebar__repos" onClick={onRepositories}>Repositories</button> : null}
      <nav className="sidebar__nav" aria-label="Conversation list">
        <SessionList sessions={sessions} activeId={activeId} onSelect={onSelect} onDelete={onDelete} />
      </nav>
    </aside>
  )
}
