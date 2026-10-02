import { memo } from 'react'
import Markdown from './Markdown.jsx'
import './chat.css'

function UserMessage({ entry }) {
  return (
    <article className="msg msg--user" aria-label="Your message">
      <Markdown text={entry.text} />
    </article>
  )
}
export default memo(UserMessage)
