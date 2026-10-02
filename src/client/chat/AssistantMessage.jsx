import { memo } from 'react'
import Markdown from './Markdown.jsx'
import './chat.css'

/** Final assistant text (Markdown). Hidden reasoning is never part of the entry. */
function AssistantMessage({ entry, onOpenPath }) {
  return (
    <article className="msg msg--assistant" aria-label="BLUSWAN" aria-busy={entry.streaming ? 'true' : undefined}>
      <Markdown text={entry.text} onOpenPath={onOpenPath} />
      {entry.streaming ? <span className="cursor" aria-hidden="true" /> : null}
    </article>
  )
}
export default memo(AssistantMessage)
