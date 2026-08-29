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
import { useThemeStore, useThemeBase } from '../state/themeStore'

export interface RiskChartHandle {
  fitContent: () => void
}

interface RiskChartProps {
  equity: EquityPoint[]
  dailyRisk: DailyRiskPoint[]
}

const RiskChart = forwardRef<RiskChartHandle, RiskChartProps>(function RiskChart({ equity, dailyRisk }, ref) {
  // Equity line = accent, MLL floor = negative, target = positive
  // (REDESIGN_APPROACH.md Part C1: "chart... follow the theme"). Daily-loss/
  // lock stay the theme's fixed `warning` base token -- a caution outside
  // the tunable accent/positive/negative model (Part C1 audit risk #2).
  const colors = useThemeStore((s) => s.colors)
  const base = useThemeBase()
  // Read inside the mount-only effect below (empty deps -- the initial
  // chart-creation options only need a starting value, since the
  // colors/base-reactive effect right after it re-applies the live value on
  // every subsequent change anyway), same "ref for a value a one-time
  // effect still needs fresh" pattern ChartKL.tsx uses throughout.
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const baseRef = useRef(base)
  baseRef.current = base

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

    const b = baseRef.current
    const chart = createChart(container, {
      layout: { background: { color: b.bg }, textColor: b.text },
      grid: { vertLines: { color: b.grid }, horzLines: { color: b.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: b.border },
      rightPriceScale: { borderColor: b.border },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    })

    const equitySeries = chart.addSeries(LineSeries, { color: colorsRef.current.accent, lineWidth: 2 }, 0)
    const mllSeries = chart.addSeries(
      LineSeries,
      { color: colorsRef.current.negative, lineWidth: 1, lineStyle: LineStyle.Dashed, lineType: LineType.WithSteps },
      0,
    )
    const dailyLossSeries = chart.addSeries(
      LineSeries,
      { color: b.warning, lineWidth: 1, lineStyle: LineStyle.Dotted, lineType: LineType.WithSteps },
      0,
    )

    const markers = createSeriesMarkers(equitySeries, [])
    const band = new MllBandPrimitive(equitySeries, [], hexToRgba(colorsRef.current.negative, 0.15))
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

  // Chart-level chrome re-applied on every mode change (REDESIGN_APPROACH.md
  // Part C1) -- the mount effect above only sets these once at creation;
  // lightweight-charts needs an explicit applyOptions() to pick up a later
  // change, same reason the series/band colors below are re-applied on
  // every `colors` change rather than trusted to survive from mount.
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { background: { color: base.bg }, textColor: base.text },
      grid: { vertLines: { color: base.grid }, horzLines: { color: base.grid } },
      timeScale: { borderColor: base.border },
      rightPriceScale: { borderColor: base.border },
    })
    dailyLossSeriesRef.current?.applyOptions({ color: base.warning })
  }, [base])

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
    mllSeries.applyOptions({ color: colors.negative })
    band.setColor(hexToRgba(colors.negative, 0.15))

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
        color: colors.positive,
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
          color: colors.negative,
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
          color: base.warning,
          text: `Daily lock ${d.trading_day}`,
          id: `lock-${d.trading_day}`,
        })
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    markersRef.current.setMarkers(markers)
  }, [dailyRisk, colors, base])

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
