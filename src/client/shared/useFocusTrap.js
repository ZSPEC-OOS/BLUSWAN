import { useEffect } from 'react'

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Moves focus into `ref` on mount, keeps Tab inside it, closes on Escape, and restores the previous focus on unmount. */
export function useFocusTrap(ref, { onEscape, active = true } = {}) {
  useEffect(() => {
    if (!active) return undefined
    const root = ref.current
    const previous = typeof document !== 'undefined' ? document.activeElement : null
    root?.querySelector('[data-autofocus]')?.focus?.() ?? (root?.querySelector(FOCUSABLE) ?? root)?.focus?.()
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onEscape?.(); return }
      if (e.key !== 'Tab' || !root) return
      const items = [...root.querySelectorAll(FOCUSABLE)]
      if (!items.length) { e.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); previous?.focus?.() }
  }, [ref, onEscape, active])
}
