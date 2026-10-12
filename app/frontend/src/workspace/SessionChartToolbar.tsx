// FXR_V2_SPEC.md section 2: the session workspace's chart toolbar row -- the
// session's symbol(s), timeframes, chart type, Indicators, undo/redo and a
// screenshot. One quiet 36px row of ghost controls (DESIGN_LANGUAGE.md section
// 6); the existing IndicatorDialog and KLDrawingToolbar are reused as-is.
import { useEffect, useRef, useState } from 'react'
import { CalendarSearch, Camera, ChevronDown, Redo2, Undo2 } from 'lucide-react'
import type { KLCandleType } from '../chart/kl/ChartKL'
import { SESSION_TIMEFRAMES } from '../chart/replayBars'
import { POPOVER_FORM_PADDING, POPOVER_MENU_ROW, POPOVER_SHELL } from '../components/popoverStyles'
import { etWallTimeToUnix, fmtEtInput } from '../timeFormat'
import NewsCalendarMenu, { type NewsCalendarProps } from './NewsCalendarMenu'
import { IconButton } from './SessionTopBar'

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

// A view-only Go To (FXR_V2_SPEC.md section 5, G5): pick an ET date and time and the chart
// centres there. The replay cursor, the broker and the saved session do not move -- and
// nothing past the cursor can be shown, so the picker stops at it.
export interface GoToProps {
  // The replay cursor (unix seconds); the picker's latest allowed time.
  max: number | null
  onGoTo: (time: number) => void
  onBackToCursor: () => void
}

function GoToMenu({ goTo }: { goTo: GoToProps }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        // Focus goes back to the control that opened it, not to the page.
        ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const unix = value ? etWallTimeToUnix(value) : null
  const submit = () => {
    if (unix === null) return
    goTo.onGoTo(unix)
    setOpen(false)
  }
  return (
    <div ref={ref} className="relative">
      <IconButton
        label="Go to a date"
        onClick={() => {
          if (!open && !value && goTo.max !== null) setValue(fmtEtInput(goTo.max))
          setOpen((v) => !v)
        }}
        pressed={open}
        expanded={open}
        haspopup="dialog"
      >
        <CalendarSearch size={16} aria-hidden />
      </IconButton>
      {open && (
        <div role="dialog" aria-label="Go to a date" className={`${POPOVER_SHELL} ${POPOVER_FORM_PADDING} absolute right-0 top-9 z-30 w-64`}>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted" htmlFor="goto-input">
            Go to (ET)
          </label>
          <input
            id="goto-input"
            autoFocus
            type="datetime-local"
            value={value}
            max={goTo.max !== null ? fmtEtInput(goTo.max) : undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            className="propbt-input propbt-input--well w-full"
          />
          <p className="mt-2 text-text-muted">View only. The replay stays where it is.</p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                goTo.onBackToCursor()
                setOpen(false)
              }}
              className="h-7 rounded px-2 text-text-muted transition-colors hover:bg-surface-2-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Back to cursor
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={unix === null}
              className="h-7 rounded bg-accent px-3 text-on-accent transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
            >
              Go
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function SessionChartToolbar({
  assets,
  instrument,
  onInstrumentChange,
  holding = [],
  chartTimeframe,
  onChartTimeframeChange,
  goTo,
  calendar,
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
  // The charted instrument. With more than one asset the buttons below switch it
  // (G7); the replay cursor, the account and every position are untouched by it.
  instrument: string
  onInstrumentChange?: (symbol: string) => void
  // Assets that hold an open position or a working order, marked on their button.
  holding?: string[]
  // The chart's own timeframe (G5): independent of the step size, any of them can be chosen.
  chartTimeframe: string
  onChartTimeframeChange: (id: string) => void
  goTo: GoToProps
  calendar: NewsCalendarProps
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
      {/* The session's assets: one cursor and one account, one chart at a time.
          A dot marks an instrument with an open position or a working order. */}
      <div className="flex items-center gap-1" role="group" aria-label="Symbol">
        {(assets.length > 0 ? assets : [instrument]).map((a) => {
          const on = a === instrument
          const switchable = !on && !!onInstrumentChange
          return (
            <button
              key={a}
              type="button"
              aria-pressed={on}
              disabled={!on && !switchable}
              onClick={switchable ? () => onInstrumentChange?.(a) : undefined}
              aria-label={holding.includes(a) ? `${a}, has an open position or order` : a}
              title={on ? `${a} (on the chart)` : `Chart ${a} (the replay does not move)`}
              className={`flex h-7 items-center gap-1 rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default ${
                on ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2/50 hover:text-text'
              }`}
            >
              {a}
              {/* A fixed slot, so a position opening never moves the buttons beside it;
                  neutral, as the accent is reserved for the active control. */}
              <span aria-hidden className={`h-2 w-2 rounded-full ${holding.includes(a) ? 'bg-text-muted' : 'bg-transparent'}`} />
            </button>
          )
        })}
      </div>

      <div className="mx-2" aria-hidden />

      {/* The chart's timeframe, any of them at any time: the candles above 1m are built
          from the revealed 1-minute bars, so switching never moves the replay cursor. */}
      <div className="flex items-center gap-1" role="group" aria-label="Timeframe">
        {SESSION_TIMEFRAMES.map((tf) => (
          <button
            key={tf.id}
            type="button"
            aria-pressed={tf.id === chartTimeframe}
            onClick={() => onChartTimeframeChange(tf.id)}
            title={tf.id === chartTimeframe ? `${tf.label} chart` : `Switch the chart to ${tf.label} (the replay does not move)`}
            className={`h-7 rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              tf.id === chartTimeframe ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2/50 hover:text-text'
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

      <div className="ml-auto flex items-center gap-1">
        <NewsCalendarMenu {...calendar} />
        <GoToMenu goTo={goTo} />
        <IconButton label="Download a screenshot of the chart" onClick={onScreenshot}>
          <Camera size={16} aria-hidden />
        </IconButton>
      </div>
    </div>
  )
}
