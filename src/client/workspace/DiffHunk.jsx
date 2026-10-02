import { memo } from 'react'

const SIGN = { add: '+', del: '−', context: ' ', meta: '\\' }
const WORD = { add: 'Added', del: 'Removed' }

/** One hunk: header row, then numbered lines. Added/removed lines carry a sign and a screen-reader label, not just color. */
function DiffHunk({ hunk, limit = Infinity }) {
  const lines = hunk.lines.length > limit ? hunk.lines.slice(0, limit) : hunk.lines
  return (
    <div className="dh" role="group" aria-label={`Hunk ${hunk.header}`}>
      <div className="dh__head"><code>{hunk.header}</code>{hunk.section ? <span className="dh__section">{hunk.section}</span> : null}</div>
      {lines.map((l, i) => (
        <div key={i} className={`dl dl--${l.type}`}>
          <span className="dl__no" aria-hidden="true">{l.oldNo ?? ''}</span>
          <span className="dl__no" aria-hidden="true">{l.newNo ?? ''}</span>
          <span className="dl__sign" aria-hidden="true">{SIGN[l.type]}</span>
          {WORD[l.type] ? <span className="sr-only">{WORD[l.type]}: </span> : null}
          <code className="dl__text">{l.text === '' ? ' ' : l.text}</code>
        </div>
      ))}
    </div>
  )
}
export default memo(DiffHunk)
