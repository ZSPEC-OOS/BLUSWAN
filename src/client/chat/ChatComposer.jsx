import { useEffect, useRef, useState } from 'react'
import './chat.css'

/**
 * Multiline composer. Enter sends, Shift+Enter inserts a newline. While BLUSWAN is working it is disabled
 * (typed text is preserved) and Stop is offered. `onSend` returns false when the message was not accepted,
 * in which case the text is kept.
 */
export default function ChatComposer({ disabled = false, canStop = false, reason = null, onSend, onStop, initialText = '' }) {
  const [text, setText] = useState(initialText)
  const ref = useRef(null)
  const wasDisabled = useRef(disabled)

  useEffect(() => { // hand focus back when a run finishes
    if (wasDisabled.current && !disabled) ref.current?.focus()
    wasDisabled.current = disabled
  }, [disabled])

  function submit() {
    const value = text.trim()
    if (!value || disabled) return
    if (onSend(value) !== false) setText('')
  }

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit() }} aria-label="Message composer">
      <label htmlFor="composer-input" className="sr-only">Message BLUSWAN</label>
      <textarea
        id="composer-input" ref={ref} data-composer className="composer__input" rows={2} value={text} disabled={disabled}
        placeholder={disabled ? (reason ?? 'BLUSWAN is working…') : 'Ask BLUSWAN…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); submit() }
        }}
      />
      <div className="composer__actions">
        {canStop ? <button type="button" className="btn btn--danger composer__stop" onClick={onStop} aria-label="Stop BLUSWAN">■ Stop</button> : null}
        <button type="submit" className="btn btn--primary composer__send" disabled={disabled || !text.trim()}>Send</button>
      </div>
    </form>
  )
}
