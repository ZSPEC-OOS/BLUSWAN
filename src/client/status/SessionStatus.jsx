import { STATUS_LABEL } from '../activity/projectEvents.js'
import '../activity/activity.css'

/** User-facing run state (Ready / Working / Waiting for approval / Completed / Stopped / Error), never internal terms. */
export default function SessionStatus({ status, workingLabel }) {
  const busy = status === 'working' || status === 'waiting'
  return (
    <div className={`status status--${status}`} role="status" aria-live="polite">
      <span className="status__dot" aria-hidden="true" />
      <span>{status === 'working' && workingLabel ? workingLabel : STATUS_LABEL[status]}</span>
      {busy ? <span className="sr-only"> — you can stop BLUSWAN at any time</span> : null}
    </div>
  )
}
