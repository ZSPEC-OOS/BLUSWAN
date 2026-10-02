import { describeFailure } from '../runtime/connectivity.js'
import { useCountdown } from './useCountdown.js'
import '../theme.css'
import '../shared/shared.css'
import './connection.css'

/** A compact status line above the conversation. Renders nothing while the connection is healthy. */
export default function ConnectionBanner({ connection, onRetry, onSignIn, onReload, onDetails }) {
  const seconds = useCountdown(connection?.nextRetryAt ?? null)
  if (!connection || connection.state === 'online' || connection.state === 'connecting_stream') return null
  const f = connection.failure
  let tone = 'warning'; let text; let primary = null
  if (connection.state === 'reconnecting') text = 'Connection lost — reconnecting…'
  else if (connection.state === 'offline_cached') {
    text = `Offline — showing your saved conversations. Sending and changes are paused.${seconds !== null ? ` Retrying in ${seconds}s.` : ''}`
    primary = onRetry && <button type="button" className="btn btn--small" onClick={onRetry}>Try now</button>
  } else if (connection.state === 'auth_error') {
    tone = 'error'; text = 'Your session has expired. Sign in again to continue.'
    primary = onSignIn && <button type="button" className="btn btn--small" onClick={onSignIn}>Sign in again</button>
  } else if (f?.kind === 'client_server_version_mismatch') {
    tone = 'error'; text = 'This page and the runtime no longer match.'
    primary = <button type="button" className="btn btn--small" onClick={onReload ?? (() => globalThis.location?.reload())}>Reload</button>
  } else {
    tone = 'error'; text = describeFailure(f?.kind ?? 'unknown_server_error').title
    primary = onRetry && <button type="button" className="btn btn--small" onClick={onRetry}>Try again</button>
  }
  return (
    <div className={`conn-banner conn-banner--${tone}`} role="status" data-testid="connection-banner" data-state={connection.state}>
      <span className="conn-banner__text">{text}</span>
      <span className="conn-banner__actions">
        {primary}
        {onDetails ? <button type="button" className="btn btn--ghost btn--small" onClick={onDetails}>Details</button> : null}
      </span>
    </div>
  )
}
