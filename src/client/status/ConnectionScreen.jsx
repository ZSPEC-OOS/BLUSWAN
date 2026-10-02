import { useState } from 'react'
import { describeFailure } from '../runtime/connectivity.js'
import DiagnosticsPanel from './DiagnosticsPanel.jsx'
import { useCountdown } from './useCountdown.js'
import '../theme.css'
import '../shared/shared.css'
import './connection.css'

const PROGRESS = {
  starting: 'Starting…',
  checking_server: 'Checking BLUSWAN\'s runtime…',
  authenticating: 'Confirming your sign-in…',
  loading_bootstrap: 'Loading your conversations…',
  connecting_stream: 'Connecting live updates…',
}

/**
 * The full-page state shown while the app cannot render: progress during boot, and a specific explanation with the
 * right actions when it fails. Never blank. `connection` is runtime.getConnection(); `kind` overrides the failure kind
 * (used before a runtime exists, e.g. the health probe in the auth boundary).
 */
export default function ConnectionScreen({ connection, kind = null, message = null, onRetry, onSignIn, onReload, diagnose, apiUrl = '', warnings = [], mobile = false }) {
  const [showDetails, setShowDetails] = useState(false)
  const failureKind = kind ?? connection?.failure?.kind ?? null
  const seconds = useCountdown(connection?.nextRetryAt ?? null)
  const info = failureKind ? describeFailure(failureKind) : null
  const act = (name) => ({
    retry: onRetry ? <button key="retry" type="button" className="btn btn--primary" onClick={onRetry}>Try again</button> : null,
    signin: onSignIn ? <button key="signin" type="button" className="btn btn--primary" onClick={onSignIn}>Sign in again</button> : null,
    reload: <button key="reload" type="button" className="btn btn--primary" onClick={onReload ?? (() => globalThis.location?.reload())}>Reload</button>,
    details: <button key="details" type="button" className="btn btn--ghost" aria-expanded={showDetails} onClick={() => setShowDetails(v => !v)}>Connection details</button>,
  })[name]
  return (
    <div className="conn-screen" role={info ? 'alert' : 'status'} aria-live={info ? 'assertive' : 'polite'}>
      <div className="conn-card">
        <img className="conn-card__logo" src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" />
        {info ? (
          <>
            <h1 className="conn-card__title">{info.title}</h1>
            <p className="conn-card__detail">{message ?? info.detail}</p>
            {connection?.failure?.status && !kind ? <p className="conn-card__meta">HTTP {connection.failure.status}{connection.failure.requestId ? ` · request ${connection.failure.requestId}` : ''}</p> : null}
            {warnings.map(w => <p key={w.code} className="conn-card__warn" role="note">{w.message}</p>)}
            {mobile && failureKind === 'server_unreachable' ? <p className="conn-card__hint">On a phone or tablet the runtime must be reachable over the network (not “localhost”) and served over HTTPS.</p> : null}
            {seconds !== null && connection?.failure?.retryable ? <p className="conn-card__meta" aria-live="off">Trying again in {seconds}s…</p> : null}
            <div className="conn-card__actions">{info.actions.filter(a => !(a === 'retry' && failureKind.startsWith('authentication') && onSignIn)).map(act)}</div>
            {showDetails ? <DiagnosticsPanel connection={connection} apiUrl={apiUrl} diagnose={diagnose ?? (async () => { throw new Error('unavailable') })} /> : null}
          </>
        ) : (
          <>
            <div className="conn-card__spinner" aria-hidden="true" />
            <p className="conn-card__detail">{message ?? PROGRESS[connection?.state] ?? 'Loading…'}</p>
          </>
        )}
      </div>
    </div>
  )
}
