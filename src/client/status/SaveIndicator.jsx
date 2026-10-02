import './status.css'

const TEXT = {
  saving: ['Saving…', 'saving'],
  saved: ['Saved', 'saved'],
  failed: ["Session isn't synced yet. Retrying…", 'failed'],
  conflict: ['Changed elsewhere — reload to see the latest.', 'failed'],
}

/** Quiet save state. Nothing is shown for a draft that has not been stored (no message yet). */
export default function SaveIndicator({ status, hasMessages }) {
  if (!hasMessages || !TEXT[status]) return null
  const [text, tone] = TEXT[status]
  return <span className={`save save--${tone}`} role="status" aria-live="polite">{text}</span>
}
