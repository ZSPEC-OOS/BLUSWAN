import '../activity/activity.css'

const MARK = { success: '✓', warning: '⚠', failed: '✕', cancelled: '■' }

/** Compact end-of-run indicator attached to that run (not to the whole conversation). */
export default function OutcomeLine({ entry }) {
  return (
    <div className={`outcome outcome--${entry.outcome}`}>
      <span aria-hidden="true">{MARK[entry.outcome] ?? '•'}</span>
      <span>{entry.text}</span>
      {entry.detail ? <span className="outcome__detail">{entry.detail}</span> : null}
    </div>
  )
}
