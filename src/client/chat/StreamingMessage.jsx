import AssistantMessage from './AssistantMessage.jsx'

/** The in-progress assistant message: the same entry that later becomes the final message (never duplicated). */
export default function StreamingMessage({ entry, onOpenPath }) {
  return <AssistantMessage entry={{ ...entry, streaming: true }} onOpenPath={onOpenPath} />
}
