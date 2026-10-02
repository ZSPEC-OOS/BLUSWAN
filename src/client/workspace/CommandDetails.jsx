import { formatDuration } from './format.js'

const STATUS_TEXT = { passed: 'Succeeded', failed: 'Failed', timeout: 'Timed out', cancelled: 'Cancelled', error: 'Could not run', running: 'Running', skipped: 'Skipped', unavailable: 'Unavailable' }

/** Terminal-style, read-only view of one command's recorded result. Output arrives already sanitized as text. */
export function CommandDetails({ command, onBack }) {
  if (!command) return <div className="wp__empty"><p>Output for this command is not available.</p></div>
  const status = command.status
  return (
    <div className="cmd">
      {onBack ? <button type="button" className="btn btn--ghost cmd__back" onClick={onBack}>‹ All commands</button> : null}
      <pre className="cmd__line"><span aria-hidden="true">$ </span>{command.command}</pre>
      <dl className="cmd__meta">
        <div><dt>Result</dt><dd className={`cmd__status cmd__status--${status}`}>{STATUS_TEXT[status] ?? status}</dd></div>
        <div><dt>Exit code</dt><dd>{command.exitCode ?? (command.timedOut || command.cancelled ? 'none' : '—')}</dd></div>
        <div><dt>Duration</dt><dd>{formatDuration(command.durationMs) || '—'}</dd></div>
      </dl>
      {command.timedOut ? <p className="wp__warn" role="status">The command timed out and was stopped.</p> : null}
      {command.cancelled ? <p className="wp__warn" role="status">The command was cancelled before it finished.</p> : null}
      {command.error ? <p className="wp__warn" role="alert">{command.error}</p> : null}
      {command.combined
        ? <Stream title="Output" text={command.stdout} />
        : <><Stream title="STDOUT" text={command.stdout} /><Stream title="STDERR" text={command.stderr} tone="err" /></>}
      {command.truncated ? <p className="wp__warn" role="status">Output truncated. This is not the complete output.</p> : null}
    </div>
  )
}

function Stream({ title, text, tone }) {
  return (
    <section className="cmd__stream" aria-label={title}>
      <h4 className="cmd__title">{title}</h4>
      {text ? <pre className={`cmd__out${tone ? ` cmd__out--${tone}` : ''}`} tabIndex={0}>{text}</pre> : <p className="cmd__none">(empty)</p>}
    </section>
  )
}

/** Commands of this conversation, grouped by the request that ran them. */
export function CommandsList({ groups, selectedId, onSelect }) {
  if (!groups.length) return <div className="wp__empty"><p>No commands run in this request.</p></div>
  return (
    <div className="cmdl">
      {groups.map(g => (
        <section key={g.id} className="cmdl__group" aria-label={g.title}>
          <h4 className="cmdl__title">{g.title}</h4>
          <ul className="cmdl__list">
            {g.commands.map(c => (
              <li key={c.id}>
                <button type="button" className={`cmdl__item${c.id === selectedId ? ' is-selected' : ''}`} onClick={() => onSelect(c.id)}>
                  <span className={`cmdl__dot cmdl__dot--${c.status}`} aria-hidden="true" />
                  <code className="cmdl__cmd">{c.command || c.label}</code>
                  <span className="cmdl__meta">{STATUS_TEXT[c.status] ?? c.status}{c.durationMs != null ? ` · ${formatDuration(c.durationMs)}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
