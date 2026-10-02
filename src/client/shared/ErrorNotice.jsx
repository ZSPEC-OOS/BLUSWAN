import './shared.css'

/** A concise, readable error. Technical details (code/message) are only offered in development builds. */
export default function ErrorNotice({ text, details, tone = 'error', action, showTechnical = false }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice__icon" aria-hidden="true">{tone === 'error' ? '✕' : tone === 'warning' ? '⚠' : '•'}</span>
      <div className="notice__body">
        <p className="notice__text">{text}</p>
        {showTechnical && details ? (
          <details className="notice__details"><summary>Technical details</summary><code>{details}</code></details>
        ) : null}
        {action ? <div className="notice__action">{action}</div> : null}
      </div>
    </div>
  )
}
