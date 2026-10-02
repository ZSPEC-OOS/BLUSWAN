import { useRef } from 'react'
import { useFocusTrap } from '../shared/useFocusTrap.js'
import SessionList from '../sessions/SessionList.jsx'
import './mobile.css'

const Row = ({ onClick, label, detail, ...rest }) => (
  <button type="button" className="mrow" onClick={onClick} {...rest}>
    <span className="mrow__label">{label}</span>{detail ? <span className="mrow__detail">{detail}</span> : null}<span className="mrow__chev" aria-hidden="true">›</span>
  </button>
)

/**
 * Mobile Workspace drawer: navigation over capabilities that already exist. Repository choices, Git views and the
 * conversation history are the existing components/actions, passed in — nothing here owns state or Git logic.
 * Sections render only when the capability exists (and, for Git, only with a repository open).
 */
export default function MobileWorkspace({
  repository = null, branch = null, canOpenWorkspaces = false, hasGithub = false, onBrowseGithub, onOpenLocal,
  changedCount = 0, onChanges, onBranches, workflow = null,
  sessions = [], activeId = null, badges = {}, onSelect, onNew, onDelete, onClose,
}) {
  const ref = useRef(null)
  useFocusTrap(ref, { onEscape: onClose })
  const repoRows = hasGithub || canOpenWorkspaces
  return (
    <div className="mdrawer__scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="mdrawer" role="dialog" aria-modal="true" aria-label="Workspace" ref={ref} tabIndex={-1}>
        <header className="mdrawer__head"><h2 className="mdrawer__title">Workspace</h2><button type="button" className="mhead__btn" onClick={onClose} aria-label="Close workspace"><span aria-hidden="true">✕</span></button></header>
        <div className="mdrawer__body">
          <section className="msec" aria-labelledby="mw-current">
            <h3 id="mw-current" className="msec__title">Current</h3>
            {repository ? (
              <div className="mcurrent"><strong className="mcurrent__repo">{repository}</strong>{branch ? <span className="mcurrent__branch">⎇ {branch}</span> : null}</div>
            ) : (
              <div className="mcurrent mcurrent--none"><strong>No repository</strong><span className="mrow__detail">Choose a repository to start coding.</span></div>
            )}
          </section>

          {repoRows ? (
            <section className="msec" aria-labelledby="mw-repos">
              <h3 id="mw-repos" className="msec__title">Repositories</h3>
              {hasGithub ? <Row label="Browse GitHub" onClick={onBrowseGithub} /> : null}
              {canOpenWorkspaces ? <Row label="Open Local Repository" onClick={onOpenLocal} /> : null}
            </section>
          ) : null}

          {repository ? (
            <section className="msec" aria-labelledby="mw-git">
              <h3 id="mw-git" className="msec__title">Git</h3>
              {workflow}
              {onChanges ? <Row label="Changes" detail={changedCount ? `${changedCount} ${changedCount === 1 ? 'file' : 'files'}` : null} onClick={onChanges} /> : null}
              {onBranches ? <Row label="Branches" onClick={onBranches} /> : null}
            </section>
          ) : null}

          <section className="msec" aria-labelledby="mw-conv">
            <h3 id="mw-conv" className="msec__title">Conversations</h3>
            <button type="button" className="btn btn--primary mnew" onClick={onNew}>＋ New chat</button>
            <nav aria-label="Conversation list"><SessionList sessions={sessions} activeId={activeId} onSelect={onSelect} onDelete={onDelete} badges={badges} /></nav>
          </section>
        </div>
      </div>
    </div>
  )
}
