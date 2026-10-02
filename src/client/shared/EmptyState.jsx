import './shared.css'

const EXAMPLES = ['Fix the failing parser test', 'Add input validation to the signup form', 'Explain how authentication works here']

/** Minimal empty conversation state. */
export default function EmptyState({ repoName }) {
  return (
    <div className="empty">
      <h2 className="empty__title">What would you like to change?</h2>
      <p className="empty__lede">Ask BLUSWAN to inspect, fix, refactor, test, or explain code{repoName ? <> in <strong>{repoName}</strong></> : ' in this repository'}.</p>
      <ul className="empty__examples" aria-label="Example requests">
        {EXAMPLES.map(e => <li key={e}>{e}</li>)}
      </ul>
    </div>
  )
}
