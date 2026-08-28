import { useEffect, useRef } from 'react'
import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import { api } from '../../api/client'
import { findInstrument, pricePrecisionFromTick, tfToPeriod } from './instruments'
import type { Bar } from '../../api/types'

interface ChartKLProps {
  instrument: string | null
  timeframe: string
  from: number | null
  to: number | null
}

function toKLineData(bar: Bar): KLineData {
  // /api/bars' `time` is unix SECONDS (VIZ_SPEC §6); KLineData wants
  // milliseconds -- same seconds->ms conversion the original TradingView
  // datafeed used (PART_A_REVISED_klinecharts.md Phase A0': "reuse the
  // seconds->ms ... mapping already written").
  return { timestamp: bar.time * 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }
}

// The KLineCharts-engine counterpart to PriceChart.tsx (REDESIGN_APPROACH.md
// Phase A0', PART_A_REVISED_klinecharts.md) -- mounted side-by-side with
// the old lightweight-charts engine behind chartEngineStore's feature
// flag, not yet at parity (no trades, drawings, indicators, or replay --
// those land in later KL phases). Its only job right now is proving real
// bars render correctly for all three instruments, so the two engines can
// be visually compared before anything old gets deleted.
//
// Deliberately a FIXED window, not real forward/backward pan-triggered
// pagination: ChartPanel already computes `from`/`to` (trade- or
// day-centered, with margin -- see windowMargin.ts) for the lightweight-
// charts engine, and lightweight-charts itself doesn't do infinite pan-
// fetch either (see ChartPanel.tsx's withMargin comment). Matching that
// exact behavior keeps the two engines comparable; genuine pagination is
// future work once KL has its own trade/day navigation UI.
export default function ChartKL({ instrument, timeframe, from, to }: ChartKLProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)

  // The DataLoader's getBars closure is registered once at mount and must
  // always see the LATEST request params, not the ones captured at mount
  // time -- a ref, updated every render, is how it reads "current" without
  // needing to re-register a new loader on every prop change.
  const requestRef = useRef({ instrument, timeframe, from, to })
  requestRef.current = { instrument, timeframe, from, to }

  // Mount/unmount the underlying klinecharts instance exactly once. Kept
  // separate from the reactive effect below (and NOT gated behind
  // `instrument`/`from`/`to` being ready) so the container div always
  // exists and the chart always initializes on first render, even if the
  // run's instrument/window are still loading -- the same "guard inside
  // the effect, never skip the mount" discipline as the split-view/
  // fast-trade-switch crash fixes (see PriceChart.tsx).
  useEffect(() => {
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
          .then((bars) => callback(bars.map(toKLineData), { forward: false, backward: false }))
          .catch(() => callback([], { forward: false, backward: false }))
      },
    })

    return () => {
      dispose(chart)
      chartRef.current = null
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

  return <div ref={containerRef} className="h-full w-full" />
}
