import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import { api } from '../../api/client'
import { findInstrument, pricePrecisionFromTick, tfToPeriod, tfToSeconds } from './instruments'
import {
  ENTRY_EXIT_GROUP,
  SL_TP_LINE_GROUP,
  ZONE_GROUP,
  buildEntryExitOverlays,
  buildSelectedTradeOverlays,
  ensureTradeZoneOverlayRegistered,
} from './tradeOverlays'
import { useThemeStore } from '../../state/themeStore'
import type { Bar, TradeRecord } from '../../api/types'

export interface ChartKLHandle {
  // Re-zoom to a time range without refetching (PART_A_REVISED_klinecharts.md
  // Phase A1's "preserve Fit trade"). KLineCharts has no direct
  // setVisibleRange-by-time like Lightweight Charts -- this derives the
  // bar-space (zoom level) that fits the range into the pane's current
  // pixel width, then scrolls to center it.
  fitRange: (from: number, to: number) => void
  scrollToTrade: (time: number) => void
}

interface ChartKLProps {
  instrument: string | null
  timeframe: string
  from: number | null
  to: number | null
  trades: TradeRecord[]
  selectedTrade: TradeRecord | null
}

function toKLineData(bar: Bar): KLineData {
  // /api/bars' `time` is unix SECONDS (VIZ_SPEC §6); KLineData wants
  // milliseconds -- same seconds->ms conversion the original TradingView
  // datafeed used (PART_A_REVISED_klinecharts.md Phase A0': "reuse the
  // seconds->ms ... mapping already written").
  return { timestamp: bar.time * 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }
}

// Never call into the klinecharts instance before it's initialized AND has
// data -- the exact crash class from the split-view/fast-trade-switch bugs
// fixed on the lightweight-charts engine (PriceChart.tsx's fitRange/
// setVisibleRange guards). One shared helper so every call site here uses
// the same check instead of each reinventing its own ad hoc guard.
function withReadyChart(chart: Chart | null, hasData: boolean, fn: (chart: Chart) => void): void {
  if (!chart || !hasData) return
  fn(chart)
}

// The KLineCharts-engine counterpart to PriceChart.tsx (PART_A_REVISED_
// klinecharts.md Phase A1) -- now at trade-visual parity: entry/exit
// markers, SL/TP lines + zones, and an open-position/PnL zone, all sourced
// straight off TradeRecord (VIZ_SPEC section 0: no recomputation). Still
// mounted behind chartEngineStore's feature flag alongside
// lightweight-charts; indicators, drawings, and replay remain LWC-only
// until later phases.
//
// Deliberately a FIXED window, not real forward/backward pan-triggered
// pagination: ChartPanel already computes `from`/`to` (trade- or
// day-centered, with margin -- see windowMargin.ts) for the lightweight-
// charts engine, and lightweight-charts itself doesn't do infinite pan-
// fetch either (see ChartPanel.tsx's withMargin comment). Matching that
// exact behavior keeps the two engines comparable.
const ChartKL = forwardRef<ChartKLHandle, ChartKLProps>(function ChartKL(
  { instrument, timeframe, from, to, trades, selectedTrade },
  ref,
) {
  const colors = useThemeStore((s) => s.colors)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const loadedBarsRef = useRef<Bar[]>([])

  // The DataLoader's getBars closure and the overlay-rebuild logic are both
  // registered/defined once and must always see the LATEST values, not
  // what was captured at that time -- refs, updated every render, same
  // pattern as ChartTV/PriceChart use for their own event-subscription
  // closures.
  const requestRef = useRef({ instrument, timeframe, from, to })
  requestRef.current = { instrument, timeframe, from, to }
  const tradesRef = useRef(trades)
  tradesRef.current = trades
  const selectedTradeRef = useRef(selectedTrade)
  selectedTradeRef.current = selectedTrade
  const colorsRef = useRef(colors)
  colorsRef.current = colors

  const rebuildOverlaysRef = useRef<() => void>(() => {})
  rebuildOverlaysRef.current = () => {
    const chart = chartRef.current
    withReadyChart(chart, loadedBarsRef.current.length > 0, (chart) => {
      chart.removeOverlay({ groupId: ENTRY_EXIT_GROUP })
      chart.removeOverlay({ groupId: SL_TP_LINE_GROUP })
      chart.removeOverlay({ groupId: ZONE_GROUP })
      const entryExit = buildEntryExitOverlays(
        tradesRef.current,
        loadedBarsRef.current,
        selectedTradeRef.current?.trade_id ?? null,
        colorsRef.current,
      )
      const selected = buildSelectedTradeOverlays(
        selectedTradeRef.current,
        loadedBarsRef.current[0]?.time ?? null,
        colorsRef.current,
      )
      if (entryExit.length > 0 || selected.length > 0) chart.createOverlay([...entryExit, ...selected])
    })
  }

  // Mount/unmount the underlying klinecharts instance exactly once. Kept
  // separate from the reactive effect below (and NOT gated behind
  // `instrument`/`from`/`to` being ready) so the container div always
  // exists and the chart always initializes on first render, even if the
  // run's instrument/window are still loading -- the same "guard inside
  // the effect, never skip the mount" discipline as the split-view/
  // fast-trade-switch crash fixes (see PriceChart.tsx).
  useEffect(() => {
    ensureTradeZoneOverlayRegistered()
    if (!containerRef.current) return
    const chart = init(containerRef.current, { timezone: 'America/New_York' })
    if (!chart) return
    chartRef.current = chart

    chart.setDataLoader({
      getBars: ({ type, callback }) => {
        const req = requestRef.current
        if (type !== 'init' || !req.instrument || req.from == null || req.to == null) {
          callback([], { forward: false, backward: false })
          return
        }
        api
          .getBars({ instrument: req.instrument, tf: req.timeframe, from: req.from, to: req.to, max_points: 5000 })
          .then((bars) => {
            loadedBarsRef.current = bars
            callback(bars.map(toKLineData), { forward: false, backward: false })
            rebuildOverlaysRef.current()
          })
          .catch(() => {
            loadedBarsRef.current = []
            callback([], { forward: false, backward: false })
          })
      },
    })

    return () => {
      dispose(chart)
      chartRef.current = null
      loadedBarsRef.current = []
    }
  }, [])

  // Symbol + period + data reload, all together whenever any of them
  // change -- avoids reasoning about whether setSymbol/setPeriod alone
  // already trigger a reload internally; resetData() is the one explicit,
  // unambiguous "reload now" signal.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !instrument || from == null || to == null) return

    const spec = findInstrument(instrument)
    chart.setSymbol({
      ticker: instrument,
      pricePrecision: spec ? pricePrecisionFromTick(spec.minmov, spec.pricescale) : 2,
      volumePrecision: 0,
    })

    const period = tfToPeriod(timeframe)
    if (period) chart.setPeriod(period)

    chart.resetData()
  }, [instrument, timeframe, from, to])

  // Trades/selection/theme changed but the window didn't (e.g. picking a
  // different already-visible trade, or a theme switch) -- no refetch
  // needed, just redraw the overlays against the bars already loaded.
  useEffect(() => {
    rebuildOverlaysRef.current()
  }, [trades, selectedTrade, colors])

  useImperativeHandle(
    ref,
    () => ({
      fitRange: (from, to) => {
        withReadyChart(chartRef.current, loadedBarsRef.current.length > 0, (chart) => {
          const seconds = tfToSeconds(requestRef.current.timeframe)
          const width = chart.getSize()?.width
          if (!seconds || !width) return
          const barCount = Math.max(1, (to - from) / seconds)
          chart.setBarSpace(width / barCount)
          chart.scrollToTimestamp(((from + to) / 2) * 1000, 0)
        })
      },
      scrollToTrade: (time) => {
        withReadyChart(chartRef.current, loadedBarsRef.current.length > 0, (chart) => {
          chart.scrollToTimestamp(time * 1000, 200)
        })
      },
    }),
    [],
  )

  return <div ref={containerRef} className="h-full w-full" />
})

export default ChartKL
