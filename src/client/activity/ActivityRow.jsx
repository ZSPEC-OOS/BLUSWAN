import { memo, useState } from 'react'
import { looksLikePath } from '../chat/markdown.js'
import './activity.css'

const MARK = { running: '▸', done: '✓', failed: '✕', skipped: '–' }
const WORD = { running: 'In progress', done: 'Done', failed: 'Failed', skipped: 'Not completed' }

function Detail({ line }) {
  return looksLikePath(line) ? <code className="path">{line}</code> : <span>{line}</span>
}

/** One activity line: status mark (shape + text, not color alone), label, and optional expandable details. */
function ActivityRow({ status, label, details = [], subdued = false, defaultOpen = false, kind, links = [] }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasDetails = details.length > 0
  const body = (
    <>
      <span className={`act__mark act__mark--${status}`} aria-hidden="true">{MARK[status]}</span>
      <span className="sr-only">{WORD[status]}: </span>
      <span className="act__label">{label}</span>
      {hasDetails ? <span className="act__chev" aria-hidden="true">{open ? '▾' : '▸'}</span> : null}
    </>
  )
  return (
    <div className={`act act--${status}${subdued ? ' act--subdued' : ''}${kind ? ` act--${kind}` : ''}`}>
      {links.length ? (
        <div className="act__links">
          {links.map(l => <button key={l.key} type="button" className="act__link" onClick={l.onClick} aria-label={l.aria}>{l.text}</button>)}
        </div>
      ) : null}
      {hasDetails
        ? <button type="button" className="act__head" aria-expanded={open} onClick={() => setOpen(o => !o)}>{body}</button>
        : <div className="act__head act__head--static">{body}</div>}
      {hasDetails && open ? (
        <ul className="act__details">
          {details.map((d, i) => (/\n/.test(d) || d.length > 120
            ? <li key={i}><pre className="act__pre">{d}</pre></li>
            : <li key={i}><Detail line={d} /></li>))}
        </ul>
      ) : null}
    </div>
  )
}
export default memo(ActivityRow)
