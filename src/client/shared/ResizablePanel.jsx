import { useCallback, useRef } from 'react'
import './resizable.css'

/**
 * Right-docked panel whose width can be dragged (or adjusted with the arrow keys on the handle).
 * Width is clamped to [min, max]; resizing is a convenience, never required.
 */
export default function ResizablePanel({ width, min = 320, max = 900, onWidthChange, label = 'Workspace panel', children }) {
  const drag = useRef(null)
  const clamp = useCallback((w) => Math.min(max, Math.max(min, w)), [min, max])

  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, w: width }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e) => { if (drag.current) onWidthChange(clamp(drag.current.w + (drag.current.x - e.clientX))) }
  const end = () => { drag.current = null }
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 80 : 20
    if (e.key === 'ArrowLeft') { e.preventDefault(); onWidthChange(clamp(width + step)) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onWidthChange(clamp(width - step)) }
  }
  return (
    <aside className="rpanel" style={{ width }} aria-label={label}>
      <div className="rpanel__handle" role="separator" aria-orientation="vertical" aria-label="Resize workspace panel" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
        tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onKeyDown={onKeyDown} />
      <div className="rpanel__body">{children}</div>
    </aside>
  )
}
