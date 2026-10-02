import { useRef } from 'react'
import { useFocusTrap } from '../shared/useFocusTrap.js'

/** Explicit confirmation before discarding a file's uncommitted changes. Nothing happens until "Revert file". */
export default function RevertFileDialog({ revert, isNewFile, onConfirm, onCancel }) {
  const ref = useRef(null)
  useFocusTrap(ref, { onEscape: revert.phase === 'busy' ? undefined : onCancel })
  const busy = revert.phase === 'busy'
  return (
    <div className="modal" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="modal__card revert" role="alertdialog" aria-modal="true" aria-labelledby="revert-title" aria-describedby="revert-desc" ref={ref} tabIndex={-1}>
        <h2 id="revert-title" className="revert__title">Revert <code>{revert.path}</code>?</h2>
        <p id="revert-desc">{isNewFile ? 'This new file will be deleted. Other files are not affected.' : 'This will discard the current uncommitted changes to this file. Other files are not affected.'}</p>
        {revert.phase === 'error' ? <p className="wp__warn" role="alert">{revert.message}</p> : null}
        <div className="settings__row revert__actions">
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>{busy ? 'Reverting…' : 'Revert file'}</button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy} data-autofocus>Cancel</button>
        </div>
      </div>
    </div>
  )
}
