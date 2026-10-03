import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { POPOVER_MENU_ROW, POPOVER_SHELL } from '../components/popoverStyles'

// REPLICA_ROADMAP.md Batch 4: "timeframe as both quick buttons and a
// dropdown of the full set." This app only ever has FOUR timeframes total
// (ChartPanel.tsx's TIMEFRAMES, mirrored 1:1 in chart/kl/instruments.ts's
// period map -- confirmed no wider set exists anywhere in the frontend or
// the backend contract), so the dropdown necessarily lists the exact same
// four the pills already show. Built anyway, deliberately: it's the
// standard TradingView interval-picker shape (quick pills for speed +
// a canonical, descriptively-labeled list as the fallback/accessible
// path), not a placeholder for timeframes that don't exist yet.
const LABELS: Record<string, string> = {
  '1min': '1 minute',
  '5min': '5 minutes',
  '15min': '15 minutes',
  '1h': '1 hour',
}

export default function TimeframeMenu({
  timeframes,
  value,
  onChange,
}: {
  timeframes: readonly string[]
  value: string
  onChange: (tf: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="flex items-center gap-1">
      {timeframes.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          aria-pressed={value === tf}
          className={`h-7 rounded px-2 text-xs ${
            value === tf ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
          }`}
        >
          {tf}
        </button>
      ))}

      <div ref={containerRef} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="More timeframes"
          title="All timeframes"
          className="flex h-7 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <ChevronDown size={13} />
        </button>
        {open && (
          <div
            role="listbox"
            aria-label="Timeframe"
            className={`${POPOVER_SHELL} absolute right-0 top-full z-30 mt-1 w-40 py-1`}
          >
            {timeframes.map((tf) => (
              <button
                key={tf}
                role="option"
                aria-selected={value === tf}
                onClick={() => {
                  onChange(tf)
                  setOpen(false)
                }}
                className={`${POPOVER_MENU_ROW} justify-between ${value === tf ? '!text-accent-fg' : ''}`}
              >
                {LABELS[tf] ?? tf}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
