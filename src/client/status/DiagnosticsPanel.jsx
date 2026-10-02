import { useState } from 'react'
import { APP_VERSION, PROTOCOL_VERSION } from '../../protocol/version.js'

const mark = (p) => (p?.skipped ? '—' : p?.ok ? '✓' : '✕')
const line = (label, p, extra) => (
  <tr key={label}>
    <th scope="row">{label}</th>
    <td className={p?.ok ? 'diag__ok' : p?.skipped ? '' : 'diag__bad'}>{mark(p)}</td>
    <td>{p?.skipped ? 'not checked' : p?.ok ? (extra ?? `${p.ms} ms`) : (p?.message ?? 'failed')}{p && !p.ok && p.status ? ` (HTTP ${p.status})` : ''}</td>
  </tr>
)

/** Compact connection report. Contains versions, the runtime address and per-stage results — never credentials. */
export default function DiagnosticsPanel({ connection, apiUrl = '', diagnose }) {
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { setReport(await diagnose()) } finally { setBusy(false) } }
  const requestId = report?.lastRequestId ?? connection?.failure?.requestId ?? connection?.lastRequestId ?? null
  const text = () => JSON.stringify({ client: APP_VERSION, protocol: PROTOCOL_VERSION, apiUrl: apiUrl || '(same origin)', state: connection?.state, failure: connection?.failure ?? null, requestId, report }, null, 2)
  return (
    <section className="diag" aria-label="Connection details">
      <dl className="diag__facts">
        <div><dt>Client</dt><dd>{APP_VERSION} (protocol {PROTOCOL_VERSION})</dd></div>
        <div><dt>Runtime address</dt><dd>{apiUrl || 'same origin as this page'}</dd></div>
        <div><dt>State</dt><dd>{connection?.state ?? 'unknown'}</dd></div>
        {connection?.failure ? <div><dt>Last problem</dt><dd>{connection.failure.kind}{connection.failure.stage ? ` while ${connection.failure.stage.replaceAll('_', ' ')}` : ''}</dd></div> : null}
        {requestId ? <div><dt>Request ID</dt><dd><code>{requestId}</code></dd></div> : null}
      </dl>
      {report ? (
        <table className="diag__table">
          <tbody>
            {line('Runtime reachable', report.health, report.health.ok ? `v${report.health.version}, protocol ${report.health.protocolVersion}` : undefined)}
            {line('Runtime ready', report.readiness, report.readiness.ok && report.readiness.checks ? Object.entries(report.readiness.checks).map(([k, v]) => `${k}: ${v}`).join(', ') : undefined)}
            {line('Signed in', report.authentication)}
            {line('Data loads', report.bootstrap, report.bootstrap.ok ? `${report.bootstrap.sessions} conversations, ${report.bootstrap.providersConfigured} model providers configured` : undefined)}
            <tr><th scope="row">Live updates</th><td>{report.stream.state === 'online' ? '✓' : '•'}</td><td>{report.stream.state}</td></tr>
          </tbody>
        </table>
      ) : null}
      <div className="diag__actions">
        <button type="button" className="btn" onClick={run} disabled={busy}>{busy ? 'Checking…' : report ? 'Check again' : 'Run checks'}</button>
        {typeof navigator !== 'undefined' && navigator.clipboard ? <button type="button" className="btn btn--ghost" onClick={() => navigator.clipboard.writeText(text()).catch(() => {})}>Copy details</button> : null}
      </div>
    </section>
  )
}
