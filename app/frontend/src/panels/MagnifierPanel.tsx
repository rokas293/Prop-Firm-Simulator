// FXR_SPEC.md section A, phase F7b: the bar magnifier's strip -- the 1-minute
// bars inside one revealed bar of a >1-minute session. A second, small
// KLineCharts instance (the price engine is KLineCharts everywhere; no other
// candle renderer). What it may show is decided entirely by
// chart/magnifier.ts: the fetch window comes from magnifierRange and the
// response is passed through clampMagnifierBars, so a bar the cursor hasn't
// reached renders nothing, and nothing past the cursor bar can appear.
import { useEffect, useMemo, useRef } from 'react'
import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import { useBars } from '../api/hooks'
import { clampMagnifierBars, MAGNIFIER_SOURCE_TF, magnifierRange } from '../chart/magnifier'
import { findInstrument, pricePrecisionFromTick, tfToPeriod } from '../chart/kl/instruments'
import { themeStyles } from '../chart/kl/ChartKL'
import { useThemeBase, useThemeStore } from '../state/themeStore'
import { fmtEtDateTime } from '../timeFormat'
import type { Bar } from '../api/types'

interface MagnifierPanelProps {
  instrument: string
  timeframe: string
  tfSeconds: number
  barTime: number
  cursorTime: number | null
  onClose: () => void
}

const AXIS_WIDTH = 72 // the price axis klinecharts reserves on the right
const MIN_BAR_SPACE = 6
const MAX_BAR_SPACE = 40

const toKLineData = (b: Bar): KLineData => ({
  timestamp: b.time * 1000,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume,
})

export default function MagnifierPanel({ instrument, timeframe, tfSeconds, barTime, cursorTime, onClose }: MagnifierPanelProps) {
  const range = magnifierRange(barTime, tfSeconds, cursorTime)
  const { data, isFetching } = useBars(range ? instrument : null, MAGNIFIER_SOURCE_TF, range?.from ?? null, range?.to ?? null, 200)
  const shown = useMemo(() => clampMagnifierBars(data ?? [], barTime, tfSeconds, cursorTime), [data, barTime, tfSeconds, cursorTime])

  const colors = useThemeStore((s) => s.colors)
  const base = useThemeBase()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const dataRef = useRef<KLineData[]>([])
  const colorsRef = useRef(colors)
  const baseRef = useRef(base)
  colorsRef.current = colors
  baseRef.current = base

  useEffect(() => {
    if (!containerRef.current) return
    const chart = init(containerRef.current, { timezone: 'America/New_York' })
    if (!chart) return
    chartRef.current = chart
    chart.setStyles(themeStyles(colorsRef.current, baseRef.current))
    chart.setDataLoader({
      getBars: ({ type, callback }) => {
        const data = type === 'init' ? dataRef.current : []
        callback(data, { forward: false, backward: false })
        // A handful of bars would otherwise sit as slivers at the right edge:
        // widen them to fill the pane and centre the run.
        if (data.length > 0 && containerRef.current) {
          const plotWidth = Math.max(0, containerRef.current.clientWidth - AXIS_WIDTH)
          const space = Math.max(MIN_BAR_SPACE, Math.min(MAX_BAR_SPACE, Math.floor(plotWidth / (data.length + 2))))
          chart.setBarSpace(space)
          chart.setOffsetRightDistance(Math.max(0, (plotWidth - data.length * space) / 2))
        }
      },
    })
    return () => {
      dispose(chart)
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setStyles(themeStyles(colors, base))
  }, [colors, base])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const spec = findInstrument(instrument)
    chart.setSymbol({
      ticker: instrument,
      pricePrecision: spec ? pricePrecisionFromTick(spec.minmov, spec.pricescale) : 2,
      volumePrecision: 0,
    })
    const period = tfToPeriod(MAGNIFIER_SOURCE_TF)
    if (period) chart.setPeriod(period)
    dataRef.current = shown.map(toKLineData)
    chart.resetData()
  }, [instrument, shown])

  return (
    <div className="bg-surface px-4 py-3" aria-label="Bar magnifier">
      <div className="mb-2 flex h-7 items-center gap-3 text-xs">
        <span className="micro-label">1-minute bars inside</span>
        <span className="tabular-nums text-text">
          {fmtEtDateTime(barTime)} <span className="text-text-muted">({timeframe})</span>
        </span>
        <span className="text-text-muted">
          {isFetching && shown.length === 0 ? 'Loading…' : `${shown.length} bar${shown.length === 1 ? '' : 's'}`}
        </span>
        <button
          onClick={onClose}
          aria-label="Close magnifier"
          className="ml-auto h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Close
        </button>
      </div>
      <div ref={containerRef} className="h-48 w-full" />
    </div>
  )
}
