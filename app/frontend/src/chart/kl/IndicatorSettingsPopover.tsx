import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ThemeColors } from '../../state/themeStore'
import { POPOVER_FORM_PADDING, POPOVER_SHELL } from '../../components/popoverStyles'

// The on-chart legend's "settings" icon (REPLICA_ROADMAP.md Batch 3) --
// just a line-color swatch picker, the one genuinely tunable per-indicator
// display setting these backend pass-through indicators have (no calc
// params to expose -- see indicators.ts's own header comment on why).
// Same fixed-position/clamp/outside-click/Escape contract as
// DrawingStylePopover, which this deliberately mirrors rather than
// reuses directly -- that one also renders a "Line width" section that
// has no meaning for an indicator line, so a plain reuse would show a
// control that does nothing (DESIGN_LANGUAGE.md §10: no dead controls).
const VIEWPORT_MARGIN = 8

export default function IndicatorSettingsPopover({
  x,
  y,
  label,
  colors,
  onPickColor,
  onReset,
  onClose,
}: {
  x: number
  y: number
  label: string
  colors: ThemeColors
  onPickColor: (hex: string) => void
  onReset: () => void
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
    // opens this (the legend's settings icon) can still be bubbling when
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

  const swatches = Array.from(new Set([colors.accent, colors.positive, colors.negative]))

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`${label} settings`}
      style={{ position: 'fixed', left: pos.x, top: pos.y, visibility: measured ? 'visible' : 'hidden' }}
      className={`${POPOVER_SHELL} z-40 w-48 ${POPOVER_FORM_PADDING}`}
    >
      <div className="micro-label mb-2">{label}</div>
      <div className="mb-2 text-text-muted">Color</div>
      <div className="flex items-center gap-2">
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
      <button onClick={onReset} className="mt-3 text-text-muted underline hover:text-text">
        Reset to theme default
      </button>
    </div>
  )
}
