// FXR_V2_SPEC.md section 2: the session workspace's chart toolbar row -- the
// session's symbol(s), timeframes, chart type, Indicators, undo/redo and a
// screenshot. One quiet 36px row of ghost controls (DESIGN_LANGUAGE.md section
// 6); the existing IndicatorDialog and KLDrawingToolbar are reused as-is.
import { useEffect, useRef, useState } from 'react'
import { Camera, ChevronDown, Redo2, Undo2 } from 'lucide-react'
import type { KLCandleType } from '../chart/kl/ChartKL'
import { POPOVER_MENU_ROW, POPOVER_SHELL } from '../components/popoverStyles'
import { IconButton } from './SessionTopBar'

const TIMEFRAMES = [
  { id: '1min', label: '1m' },
  { id: '5min', label: '5m' },
  { id: '15min', label: '15m' },
  { id: '1h', label: '1h' },
] as const

export const CHART_TYPES: { id: KLCandleType; label: string }[] = [
  { id: 'candle_solid', label: 'Candles' },
  { id: 'candle_stroke', label: 'Hollow candles' },
  { id: 'ohlc', label: 'Bars' },
  { id: 'area', label: 'Line' },
]

const GHOST =
  'flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

function ChartTypeMenu({ value, onChange }: { value: KLCandleType; onChange: (t: KLCandleType) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const current = CHART_TYPES.find((t) => t.id === value) ?? CHART_TYPES[0]
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chart type"
        aria-label={`Chart type: ${current.label}`}
        className={`${GHOST} ${open ? 'bg-surface-2 text-text' : ''}`}
      >
        {current.label}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div role="menu" className={`${POPOVER_SHELL} absolute left-0 top-9 z-30 w-44 py-1`}>
          {CHART_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === value}
              onClick={() => {
                onChange(t.id)
                setOpen(false)
              }}
              className={`${POPOVER_MENU_ROW} ${t.id === value ? 'text-text' : 'text-text-muted'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SessionChartToolbar({
  assets,
  instrument,
  baseTimeframe,
  indicatorCount,
  onOpenIndicators,
  candleType,
  onCandleTypeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onScreenshot,
}: {
  assets: string[]
  instrument: string
  baseTimeframe: string
  indicatorCount: number
  onOpenIndicators: () => void
  candleType: KLCandleType
  onCandleTypeChange: (t: KLCandleType) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onScreenshot: () => void
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 bg-bg px-2" role="toolbar" aria-label="Chart">
      {/* The session's assets. Only the primary can be charted until MNQ and
          MES share one cursor (phase G7), so the others show but are disabled. */}
      <div className="flex items-center gap-1" role="group" aria-label="Symbol">
        {(assets.length > 0 ? assets : [instrument]).map((a) => (
          <button
            key={a}
            type="button"
            aria-pressed={a === instrument}
            disabled={a !== instrument}
            title={a === instrument ? `${a} (this session's chart)` : `${a}: multi-asset replay arrives in a later phase`}
            className={`h-7 rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
              a === instrument ? 'text-text' : 'text-text-muted opacity-40'
            }`}
          >
            {a}
          </button>
        ))}
      </div>

      <div className="mx-2" aria-hidden />

      {/* The replay runs at the session's base timeframe; viewing a coarser one
          needs the forming candle built from 1m data (phase G5). */}
      <div className="flex items-center gap-1" role="group" aria-label="Timeframe">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.id}
            type="button"
            aria-pressed={tf.id === baseTimeframe}
            disabled={tf.id !== baseTimeframe}
            title={
              tf.id === baseTimeframe
                ? `${tf.label}: this session's replay timeframe`
                : `${tf.label}: switching the chart timeframe arrives with the 1-minute replay`
            }
            className={`h-7 rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
              tf.id === baseTimeframe ? 'bg-surface-2 text-text' : 'text-text-muted opacity-40'
            }`}
          >
            {tf.label}
          </button>
        ))}
      </div>

      <div className="mx-2" aria-hidden />

      <ChartTypeMenu value={candleType} onChange={onCandleTypeChange} />
      <button type="button" onClick={onOpenIndicators} title="Indicators" aria-label={`Indicators, ${indicatorCount} active`} className={GHOST}>
        Indicators
        <span className="tabular-nums text-text-muted">{indicatorCount}</span>
      </button>

      <div className="mx-2" aria-hidden />

      <IconButton label="Undo drawing change" onClick={onUndo} disabled={!canUndo}>
        <Undo2 size={16} aria-hidden />
      </IconButton>
      <IconButton label="Redo drawing change" onClick={onRedo} disabled={!canRedo}>
        <Redo2 size={16} aria-hidden />
      </IconButton>

      <div className="ml-auto flex items-center">
        <IconButton label="Download a screenshot of the chart" onClick={onScreenshot}>
          <Camera size={16} aria-hidden />
        </IconButton>
      </div>
    </div>
  )
}
