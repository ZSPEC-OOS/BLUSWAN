import { useState } from 'react'
import { STATUS_LABEL } from '../activity/projectEvents.js'

function relativeTime(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** One conversation in the sidebar: title, relative time, running indicator, delete with inline confirmation. */
export default function SessionListItem({ item, active, onSelect, onDelete, badge = null }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className={`sessions__item${active ? ' is-active' : ''}${item.running ? ' is-running' : ''}`}>
      <button type="button" className="sessions__select" aria-current={active ? 'true' : undefined} onClick={() => onSelect(item.id)}>
        <span className="sessions__title">{item.title}</span>
        <span className="sessions__meta">
          {item.running ? <span className="sessions__spinner" aria-hidden="true" /> : null}
          <span>{item.running ? STATUS_LABEL[item.status] : relativeTime(item.lastActivityAt)}</span>
          {item.workspaceName ? <span className="sessions__repo">{item.workspaceName}</span> : null}
        </span>
        {badge ? <span className="sessions__badge" aria-label={`Pull request: ${badge}`}>{badge}</span> : null}
      </button>
      {confirming ? (
        <span className="sessions__confirm" role="group" aria-label={`Delete ${item.title}?`}>
          <button type="button" className="btn btn--danger" onClick={() => { setConfirming(false); onDelete(item.id, { force: item.running }) }}>{item.running ? 'Stop & delete' : 'Delete'}</button>
          <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <button type="button" className="sessions__delete" aria-label={`Delete conversation: ${item.title}`} onClick={() => setConfirming(true)}>🗑</button>
      )}
    </li>
  )
}
