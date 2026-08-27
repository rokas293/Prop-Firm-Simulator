import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import type { DailyRiskPoint, EquityPoint } from '../api/types'
import { MllBandPrimitive } from './MllBandPrimitive'
import { hexToRgba } from './color'
import { useThemeStore } from '../state/themeStore'

export interface RiskChartHandle {
  fitContent: () => void
}

interface RiskChartProps {
  equity: EquityPoint[]
  dailyRisk: DailyRiskPoint[]
}

// Daily-loss/lock stay a fixed amber "caution" -- a third semantic outside
// the theme's up/down/accent model, same scope decision as the drawing
// tool colors in DrawingLayerPrimitive (POLISH_ROADMAP Phase P6).
const DAILY_LOSS_COLOR = '#d29922'
const LOCK_COLOR = '#d29922'

const RiskChart = forwardRef<RiskChartHandle, RiskChartProps>(function RiskChart({ equity, dailyRisk }, ref) {
  // Equity line = accent, MLL floor = down, target = up (POLISH_ROADMAP
  // Phase P6: "chart... follow the theme").
  const colors = useThemeStore((s) => s.colors)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const equitySeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const mllSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const dailyLossSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const bandRef = useRef<MllBandPrimitive | null>(null)
  const targetLineRef = useRef<IPriceLine | null>(null)

  // Create the chart once; data effects below keep it in sync in place.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, {
      layout: { background: { color: '#0d1117' }, textColor: '#c9d1d9' },
      grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      rightPriceScale: { borderColor: '#30363d' },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    })

    const equitySeries = chart.addSeries(LineSeries, { color: colors.accent, lineWidth: 2 }, 0)
    const mllSeries = chart.addSeries(
      LineSeries,
      { color: colors.down, lineWidth: 1, lineStyle: LineStyle.Dashed, lineType: LineType.WithSteps },
      0,
    )
    const dailyLossSeries = chart.addSeries(
      LineSeries,
      { color: DAILY_LOSS_COLOR, lineWidth: 1, lineStyle: LineStyle.Dotted, lineType: LineType.WithSteps },
      0,
    )

    const markers = createSeriesMarkers(equitySeries, [])
    const band = new MllBandPrimitive(equitySeries, [], hexToRgba(colors.down, 0.15))
    chart.panes()[0].attachPrimitive(band)

    chartRef.current = chart
    equitySeriesRef.current = equitySeries
    mllSeriesRef.current = mllSeries
    dailyLossSeriesRef.current = dailyLossSeries
    markersRef.current = markers
    bandRef.current = band

    return () => {
      chart.remove()
      chartRef.current = null
      equitySeriesRef.current = null
      mllSeriesRef.current = null
      dailyLossSeriesRef.current = null
      markersRef.current = null
      bandRef.current = null
      targetLineRef.current = null
    }
  }, [])

  // Equity / MLL floor / daily-loss floor lines + the distance-to-breach
  // band + the target reference line (constant for the whole run --
  // CLAUDE.md section 3 -- so one price line, not a fourth series).
  useEffect(() => {
    const equitySeries = equitySeriesRef.current
    const mllSeries = mllSeriesRef.current
    const dailyLossSeries = dailyLossSeriesRef.current
    const band = bandRef.current
    if (!equitySeries || !mllSeries || !dailyLossSeries || !band) return

    // Re-applied on every theme change too (colors is in this effect's
    // deps) -- these are series-level style options, not touched by the
    // setData() calls below (POLISH_ROADMAP Phase P6).
    equitySeries.applyOptions({ color: colors.accent })
    mllSeries.applyOptions({ color: colors.down })
    band.setColor(hexToRgba(colors.down, 0.15))

    equitySeries.setData(equity.map((e): LineData<Time> => ({ time: e.time as Time, value: e.equity })))
    mllSeries.setData(equity.map((e): LineData<Time> => ({ time: e.time as Time, value: e.mll_floor })))
    dailyLossSeries.setData(
      equity.map((e): LineData<Time> => ({ time: e.time as Time, value: e.daily_loss_floor })),
    )
    band.setPoints(equity.map((e) => ({ time: e.time, equity: e.equity, floor: e.mll_floor })))

    if (targetLineRef.current) {
      equitySeries.removePriceLine(targetLineRef.current)
      targetLineRef.current = null
    }
    if (equity.length > 0) {
      targetLineRef.current = equitySeries.createPriceLine({
        price: equity[0].target_level,
        color: colors.up,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Target',
      })
    }
  }, [equity, colors])

  // Breach + daily-lock markers, from the exact (non-decimated) per-day
  // aggregate rather than the equity series' own (possibly-decimated) rows
  // -- see api/hooks.ts's useDailyRisk comment.
  useEffect(() => {
    if (!markersRef.current) return
    const markers: SeriesMarker<Time>[] = []
    for (const d of dailyRisk) {
      if (d.breached && d.breach_time !== null) {
        markers.push({
          time: d.breach_time as Time,
          position: 'aboveBar',
          shape: 'square',
          color: colors.down,
          text: `BREACH ${d.trading_day}`,
          size: 2,
          id: `breach-${d.trading_day}`,
        })
      }
      if (d.daily_locked && d.daily_lock_time !== null) {
        markers.push({
          time: d.daily_lock_time as Time,
          position: 'belowBar',
          shape: 'circle',
          color: LOCK_COLOR,
          text: `Daily lock ${d.trading_day}`,
          id: `lock-${d.trading_day}`,
        })
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    markersRef.current.setMarkers(markers)
  }, [dailyRisk, colors])

  useImperativeHandle(
    ref,
    () => ({
      fitContent: () => {
        chartRef.current?.timeScale().fitContent()
      },
    }),
    [],
  )

  return <div ref={containerRef} className="h-full w-full" />
})

export default RiskChart
