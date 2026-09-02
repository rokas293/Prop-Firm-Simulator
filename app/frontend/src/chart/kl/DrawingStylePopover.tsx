import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ThemeColors } from '../../state/themeStore'
import { POPOVER_FORM_PADDING, POPOVER_SHELL } from '../../components/popoverStyles'

// The context menu's "Edit style" action (REPLICA_ROADMAP.md Batch 1) --
// a compact swatch + line-width picker, not a full properties dialog
// (DESIGN_LANGUAGE.md §1: restraint). Same fixed-position/clamp/outside-
// click/Escape contract as ContextMenu, but visually a small popover
// (surface-2, shadow) rather than a menu list, since it's picking values,
// not choosing an action.
const VIEWPORT_MARGIN = 8
const WIDTHS = [1, 2, 3, 4] as const

export default function DrawingStylePopover({
  x,
  y,
  colors,
  onPickColor,
  onPickWidth,
  onClose,
}: {
  x: number
  y: number
  colors: ThemeColors
  onPickColor: (hex: string) => void
  onPickWidth: (size: number) => void
  onClose: () => void
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [measured, setMeasured] = useState(false)

  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clampedX = Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    const clampedY = Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    setPos({ x: Math.max(VIEWPORT_MARGIN, clampedX), y: Math.max(VIEWPORT_MARGIN, clampedY) })
    setMeasured(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Deferred attach -- see ContextMenu.tsx's own comment: the click that
    // opens this (its "Edit style" menu item) can still be bubbling when
    // this effect runs, and a synchronous listener here would read that
    // same click as "outside" and close before ever painting.
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

  // A small, fixed palette drawn from the live theme (not arbitrary hues) --
  // DESIGN_LANGUAGE.md §2: "no decorative color." A native color input
  // still covers anything outside it. Deduped: candle colors default to
  // the SAME hex as positive/negative, and showing a color twice is both
  // visual noise and (since these render as a list keyed by the hex
  // itself) a literal duplicate-key React would warn about.
  const swatches = Array.from(new Set([colors.accent, colors.positive, colors.negative, colors.upCandle, colors.downCandle]))

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Edit drawing style"
      style={{ position: 'fixed', left: pos.x, top: pos.y, visibility: measured ? 'visible' : 'hidden' }}
      className={`${POPOVER_SHELL} z-40 w-48 ${POPOVER_FORM_PADDING}`}
    >
      <div className="micro-label mb-2">Color</div>
      <div className="mb-3 flex items-center gap-2">
        {swatches.map((hex) => (
          <button
            key={hex}
            aria-label={`Set color ${hex}`}
            onClick={() => onPickColor(hex)}
            style={{ background: hex }}
            className="h-5 w-5 rounded-full border border-border hover:opacity-80"
          />
        ))}
        <label className="relative h-5 w-5 cursor-pointer overflow-hidden rounded-full border border-border">
          <input
            type="color"
            aria-label="Custom color"
            onChange={(e) => onPickColor(e.target.value)}
            className="absolute -left-1 -top-1 h-7 w-7 cursor-pointer"
          />
        </label>
      </div>
      <div className="micro-label mb-2">Line width</div>
      <div className="flex items-center gap-1">
        {WIDTHS.map((w) => (
          <button
            key={w}
            aria-label={`${w}px`}
            onClick={() => onPickWidth(w)}
            className="flex h-6 flex-1 items-center justify-center rounded bg-surface hover:bg-surface-2-hover"
          >
            <span className="w-4 rounded-full bg-text-muted" style={{ height: w }} />
          </button>
        ))}
      </div>
    </div>
  )
}
