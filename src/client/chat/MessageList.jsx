import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import UserMessage from './UserMessage.jsx'
import AssistantMessage from './AssistantMessage.jsx'
import StreamingMessage from './StreamingMessage.jsx'
import ActivityGroup from '../activity/ActivityGroup.jsx'
import PermissionPrompt from '../permissions/PermissionPrompt.jsx'
import ErrorNotice from '../shared/ErrorNotice.jsx'
import OutcomeLine from '../shared/OutcomeLine.jsx'
import './chat.css'

const WINDOW = 300
const NEAR_BOTTOM_PX = 96

export const EntryView = memo(function EntryView({ entry, onApprove, onDeny, onOpenPath, showTechnical }) {
  switch (entry.kind) {
    case 'user': return <UserMessage entry={entry} />
    case 'assistant': return entry.streaming ? <StreamingMessage entry={entry} onOpenPath={onOpenPath} /> : <AssistantMessage entry={entry} onOpenPath={onOpenPath} />
    case 'activity': return <ActivityGroup group={entry} />
    case 'permission': return <PermissionPrompt request={entry.request} status={entry.status} onApprove={onApprove} onDeny={onDeny} />
    case 'notice': return <ErrorNotice tone={entry.tone ?? 'subdued'} text={entry.text} />
    case 'error': return <ErrorNotice tone="error" text={entry.text} details={entry.details} showTechnical={showTechnical} />
    case 'outcome': return <OutcomeLine entry={entry} />
    default: return null
  }
})

/**
 * The transcript in chronological order. Follows new content only while the reader is near the bottom;
 * scrolling up stops the following. Very long runs render the most recent entries, with the rest on demand.
 */
export default function MessageList({ entries, working, onApprove, onDeny, onOpenPath, showTechnical = false, empty = null }) {
  const scroller = useRef(null)
  const stick = useRef(true)
  const [limit, setLimit] = useState(WINDOW)
  const [away, setAway] = useState(false)

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    stick.current = near
    setAway(a => (a === !near ? a : !near))
  }, [])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries, working])

  const isEmpty = entries.length === 0
  useEffect(() => { stick.current = true }, [isEmpty])

  const hidden = Math.max(0, entries.length - limit)
  const shown = hidden ? entries.slice(hidden) : entries
  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      <div className="messages__inner" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
        {entries.length === 0 ? empty : null}
        {hidden ? <button type="button" className="btn btn--ghost messages__earlier" onClick={() => setLimit(l => l + WINDOW)}>Show {Math.min(hidden, WINDOW)} earlier entries</button> : null}
        {shown.map(entry => <EntryView key={entry.id} entry={entry} onApprove={onApprove} onDeny={onDeny} onOpenPath={onOpenPath} showTechnical={showTechnical} />)}
      </div>
      {away ? <button type="button" className="btn messages__latest" onClick={() => { const el = scroller.current; stick.current = true; if (el) el.scrollTop = el.scrollHeight; setAway(false) }}>↓ Latest</button> : null}
    </div>
  )
}
