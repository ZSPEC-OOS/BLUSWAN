import { useEffect, useRef } from 'react'
import '../activity/activity.css'

const VERB = { run: 'run', delete: 'delete', write: 'write', modify: 'modify' }
const BADGE = { destructive: 'Delete', dependency_change: 'Dependency change', external_effect: 'External effect' }
const RESOLVED = { approved: '✓ Allowed once', denied: '✕ Denied', cancelled: '– Cancelled' }

/**
 * Compact approval prompt: says exactly what BLUSWAN wants to do and why it needs approval.
 * Only "Allow once" and "Deny" exist. Decisions go to the runtime, which pauses the agent until then.
 */
export default function PermissionPrompt({ request, status = 'pending', onApprove, onDeny }) {
  const ref = useRef(null)
  useEffect(() => { if (status === 'pending') ref.current?.focus() }, [status])

  const verb = VERB[request.action] ?? request.action
  const targets = request.command ? [request.command] : (request.paths ?? [])
  const summary = `${request.action === 'run' ? 'Run' : request.action === 'delete' ? 'Delete' : request.action === 'write' ? 'Write' : 'Modify'} ${targets.join(', ')}`.trim()

  if (status !== 'pending') {
    return <div className="perm perm--resolved" role="status"><span>{RESOLVED[status] ?? status}</span>: {summary}</div>
  }
  const titleId = `perm-${request.id}`
  return (
    <div ref={ref} tabIndex={-1} role="group" aria-labelledby={titleId} className={`perm${BADGE[request.effect] && request.effect !== 'workspace_write' ? ' perm--danger' : ''}`}>
      <p id={titleId} className="perm__title">
        BLUSWAN wants to {verb}:
        {BADGE[request.effect] ? <span className="perm__badge">{BADGE[request.effect]}</span> : null}
      </p>
      {targets.map(t => <code key={t} className="perm__target">{t}</code>)}
      {request.description ? <p className="perm__why">{request.description}</p> : null}
      <div className="perm__actions">
        <button type="button" className="btn btn--primary" onClick={() => onApprove(request.id)}>Allow once</button>
        <button type="button" className="btn" onClick={() => onDeny(request.id)}>Deny</button>
      </div>
    </div>
  )
}
