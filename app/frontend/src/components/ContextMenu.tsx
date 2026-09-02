import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { POPOVER_MENU_ROW, POPOVER_SHELL } from './popoverStyles'

// A single reusable right-click menu (REPLICA_ROADMAP.md Batch 1: "one
// reusable ContextMenu component"), styled to DESIGN_LANGUAGE.md §6's
// tooltip/menu spec (surface-2 bg, soft shadow, 12px text, tight padding) --
// the same visual family as KLDrawingToolbar's group flyouts, just fixed-
// positioned at a click point instead of anchored to a button. Currently
// used for the chart's right-click menus (empty area / a drawing); written
// generically so any future right-click surface (RunsListPage rows, Trade
// List, ...) can reuse it rather than hand-rolling another popover.
export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  // Delete-style actions -- text-negative, same convention as the
  // drawings-manage list's own Delete link (KLDrawingToolbar.tsx).
  destructive?: boolean
}
export type ContextMenuEntry = ContextMenuItem | { separator: true }

function isSeparator(entry: ContextMenuEntry): entry is { separator: true } {
  return 'separator' in entry
}

const VIEWPORT_MARGIN = 8

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  label,
}: {
  // Page/viewport coordinates of the triggering right-click (clientX/clientY
  // or klinecharts' own pageX/pageY -- both are viewport-relative here since
  // this renders `fixed`, not inside a scrolling ancestor).
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
  // Accessible name (role="menu" has no visible title of its own).
  label: string
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  // Clamped position, computed after mount once the menu's real size is
  // known -- avoids it rendering off the right/bottom edge near a chart
  // corner (same "measure then clamp" approach as ChartKL's own tooltip).
  // `measured` gates visibility so the unclamped first-paint position never
  // flashes -- flips true inside the SAME layout effect that clamps, so
  // both land in one pre-paint commit.
  const [pos, setPos] = useState({ x, y })
  const [measured, setMeasured] = useState(false)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clampedX = Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    const clampedY = Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    setPos({ x: Math.max(VIEWPORT_MARGIN, clampedX), y: Math.max(VIEWPORT_MARGIN, clampedY) })
    setMeasured(true)
    // Immediate keyboard access, same as a native context menu -- no extra
    // Tab needed to reach the first item.
    const firstEnabled = el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    firstEnabled?.focus()
    // Only re-measure for a genuinely new menu (new trigger point); items
    // changing identity shouldn't re-run the clamp/focus dance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = menuRef.current
      if (!el) return
      const entries = Array.from(el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
      const currentIndex = entries.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        entries[(currentIndex + 1) % entries.length]?.focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        entries[(currentIndex - 1 + entries.length) % entries.length]?.focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        entries[0]?.focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        entries[entries.length - 1]?.focus()
      }
    }
    // Attaching on the NEXT tick, not synchronously: verified live that
    // opening this menu closes itself instantly otherwise. The click that
    // opens it (a right-click on empty chart area, OR a right-click that
    // hits a drawing -- klinecharts fires that one's onRightClick from ITS
    // OWN mousedown handling) is still bubbling toward `document` at the
    // moment React mounts this component and runs this effect; a listener
    // attached synchronously here catches the tail of that SAME bubble and
    // reads it as an "outside click," undoing the open before it's ever
    // visible. Deferring past the current task lets that one event finish
    // first, same fix used for this exact class of bug in most menu/
    // popover libraries.
    const attachTimer = window.setTimeout(() => {
      document.addEventListener('mousedown', handlePointerDown)
      document.addEventListener('keydown', handleKeyDown)
    }, 0)
    return () => {
      window.clearTimeout(attachTimer)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      // Rendered off-screen until the post-mount clamp above places it --
      // avoids a one-frame flash at the wrong (unclamped) spot.
      style={{ position: 'fixed', left: pos.x, top: pos.y, visibility: measured ? 'visible' : 'hidden' }}
      className={`${POPOVER_SHELL} z-40 w-48 py-1`}
    >
      {items.map((entry, i) =>
        isSeparator(entry) ? (
          <div key={`sep-${i}`} className="my-1 border-t border-border" />
        ) : (
          <button
            key={entry.label}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect()
              onClose()
            }}
            className={`${POPOVER_MENU_ROW} ${entry.destructive ? '!text-negative' : ''}`}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  )
}
