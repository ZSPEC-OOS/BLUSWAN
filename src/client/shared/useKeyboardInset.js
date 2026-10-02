import { useEffect } from 'react'

/**
 * Keeps the layout above the on-screen keyboard. Browsers that resize the layout viewport (Chrome on Android) need
 * nothing; iOS Safari overlays the keyboard, so the gap between the window and the visual viewport is published as
 * `--kb-inset` and the shell shrinks by it. A no-op where `visualViewport` does not exist.
 */
export function useKeyboardInset(active) {
  useEffect(() => {
    const vv = globalThis.visualViewport
    if (!active || !vv) return undefined
    const root = document.documentElement
    const update = () => {
      const inset = Math.max(0, Math.round(globalThis.innerHeight - vv.height - vv.offsetTop))
      root.style.setProperty('--kb-inset', inset > 80 ? `${inset}px` : '0px') // small differences are browser chrome, not a keyboard
      if (inset > 80) document.activeElement?.scrollIntoView?.({ block: 'nearest' })
    }
    update()
    vv.addEventListener('resize', update); vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); root.style.removeProperty('--kb-inset') }
  }, [active])
}
