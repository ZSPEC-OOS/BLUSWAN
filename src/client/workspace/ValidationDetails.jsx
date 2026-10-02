import { formatDuration } from './format.js'

const STATUS_TEXT = { passed: 'Passed', failed: 'Failed', error: 'Failed', skipped: 'Skipped', unavailable: 'Unavailable', stale: 'Stale', cancelled: 'Cancelled' }

/** Compact overview: only checks that ran. A pass from before the latest change reads "Stale", never "Passed". */
export function ValidationSummary({ validation, selectedId, onSelect }) {
  if (validation.state === 'none') return <div className="wp__empty"><p>No validation has run for this request.</p></div>
  return (
    <div className="val">
      {validation.state === 'stale' ? <p className="wp__warn" role="status">Code changed after these checks ran. Revalidation needed.</p> : null}
      <ul className="val__list" aria-label="Validation checks">
        {validation.rows.map(r => (
          <li key={r.id}>
            <button type="button" className={`val__row${r.id === selectedId ? ' is-selected' : ''}`} onClick={() => onSelect(r.id)}>
              <span className="val__name">{r.name}</span>
              <span className={`val__status val__status--${r.status}`}>{STATUS_TEXT[r.status] ?? r.status}</span>
              <span className="val__sum">{r.stale ? `${STATUS_TEXT[r.ranStatus] ?? r.ranStatus} earlier${r.summary ? ` — ${r.summary}` : ''}` : r.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Everything known about one validation result. `onOpenFile` links diagnostics to changed files. */
export function ValidationDetails({ row, changedPaths, onOpenFile, onOpenOutput, onBack }) {
  if (!row) return <div className="wp__empty"><p>Select a check to see its details.</p></div>
  const diag = row.diagnostics
  const locations = diag?.locations ?? []
  const related = row.relatedFiles ?? []
  const canOpen = (p) => changedPaths.includes(p)
  return (
    <div className="vald">
      {onBack ? <button type="button" className="btn btn--ghost cmd__back" onClick={onBack}>‹ All checks</button> : null}
      <h3 className="vald__title">{row.name} <span className={`val__status val__status--${row.status}`}>{STATUS_TEXT[row.status] ?? row.status}</span></h3>
      {row.stale ? <p className="wp__warn" role="status">{STATUS_TEXT[row.ranStatus] ?? row.ranStatus} earlier. Code changed afterward — revalidation needed.</p> : null}
      <p className="vald__sum">{row.summary}</p>
      <pre className="cmd__line"><span aria-hidden="true">$ </span>{row.command}</pre>
      <dl className="cmd__meta">
        <div><dt>Duration</dt><dd>{formatDuration(row.durationMs) || '—'}</dd></div>
        <div><dt>Scope</dt><dd>{row.scope ?? '—'}</dd></div>
      </dl>
      {diag?.summary && row.ranStatus !== 'passed' ? <p className="vald__diag">{diag.summary}</p> : null}
      {diag?.keyMessages?.length ? <ul className="vald__msgs">{diag.keyMessages.slice(0, 5).map((m, i) => <li key={i}><code>{m}</code></li>)}</ul> : null}
      {locations.length ? (
        <section aria-label="Locations"><h4 className="cmd__title">Locations</h4>
          <ul className="vald__locs">{locations.slice(0, 8).map((l, i) => {
            const path = typeof l === 'string' ? l.replace(/:\d+(?::\d+)?$/, '') : l.path
            const text = typeof l === 'string' ? l : `${l.path}${l.line ? `:${l.line}` : ''}`
            return <li key={i}>{canOpen(path) ? <button type="button" className="path" onClick={() => onOpenFile(path)}>{text}</button> : <code>{text}</code>}</li>
          })}</ul>
        </section>
      ) : null}
      {related.length ? <section aria-label="Related files"><h4 className="cmd__title">Related files</h4><ul className="vald__locs">{related.slice(0, 8).map(p => <li key={p}>{canOpen(p) ? <button type="button" className="path" onClick={() => onOpenFile(p)}>{p}</button> : <code>{p}</code>}</li>)}</ul></section> : null}
      <button type="button" className="btn" onClick={() => onOpenOutput(row.id)}>View output</button>
    </div>
  )
}
