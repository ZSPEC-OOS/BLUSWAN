import { useRef } from 'react'
import { useFocusTrap } from './useFocusTrap.js'
import './sheet.css'

/** Bottom sheet for small screens: modal, labelled, focus-trapped, Escape closes, focus returns to the opener. */
export default function MobileSheet({ title, onClose, children, onBack, backLabel = 'Back', variant = '' }) {
  const ref = useRef(null)
  useFocusTrap(ref, { onEscape: onClose })
  return (
    <div className={`sheet__scrim${variant ? ` sheet__scrim--${variant}` : ''}`} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className={`sheet${variant ? ` sheet--${variant}` : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="sheet__head">
          {onBack ? <button type="button" className="btn btn--ghost" onClick={onBack}>‹ {backLabel}</button> : null}
          <h2 className="sheet__title">{title}</h2>
          <button type="button" className="btn btn--ghost sheet__close" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
        </header>
        <div className="sheet__body">{children}</div>
      </section>
    </div>
  )
}
