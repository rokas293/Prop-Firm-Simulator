import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Shared modal focus behavior (accessibility audit: SettingsPanel and
// ShortcutsOverlay are both hand-rolled `role="dialog"` overlays with no
// focus management at all -- confirmed live that opening one leaves focus
// on the trigger button behind it, and Tab from there walks straight
// through into the underlying workspace's own buttons, since nothing traps
// it). This gives both the three things a real dialog needs: focus moves
// into the dialog on open, Tab/Shift+Tab cycle within it instead of
// leaking to the page behind, and focus returns to whatever opened it on
// close -- the same behavior a native <dialog> gets for free, applied here
// since these overlays predate that being used.
export function useModalFocus(containerRef: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    const first = focusables()[0]
    ;(first ?? container).focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const els = focusables()
      if (els.length === 0) return
      const firstEl = els[0]
      const lastEl = els[els.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [open, containerRef])
}
