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

// DESIGN_AUDIT.md P2: equity/MLL-floor/daily-loss-floor all defaulted to
// lightweight-charts' own lastValueVisible+priceLineVisible, so up to three
// axis labels plus the Target price-line's own label all competed for the
// same corner whenever their values were close together -- confirmed live
// in the original audit as an illegible stacked cluster. Fixed decimals +
// a thousands separator, chart-wide (all three series carry $ values), so
// individual digits don't drift between labels of different magnitude --
// this is the canvas-rendered equivalent of tabular-nums: font-variant-
// numeric doesn't apply to canvas text at all, so number FORMATTING is the
// lever that's actually available here.
function fmtAxisPrice(price: number): string {
  return `$${price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

interface RiskChartProps {
  equity: EquityPoint[]
  dailyRisk: DailyRiskPoint[]
  // Fit the whole series into view whenever a new equity array arrives.
  // Lightweight Charts spaces points by index (~6px each), so an automated
  // run's thousands of bars fill the pane on their own -- but a manual
  // session's trade-resolution timeline is a few dozen points and would sit
  // squeezed against the right edge. Off by default so engine runs keep the
  // behavior they already had.
  fitOnData?: boolean
}

const RiskChart = forwardRef<RiskChartHandle, RiskChartProps>(function RiskChart({ equity, dailyRisk, fitOnData = false }, ref) {
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
  // Set when a fit is wanted but the pane has no width yet (see fitOnData).
  const pendingFitRef = useRef(false)

  // Create the chart once; data effects below keep it in sync in place.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const b = baseRef.current
    const chart = createChart(container, {
      // REPLICA_AUDIT.md Top 10 #1 -- what looked like a broken/oversized
      // clipped text fragment in the bottom-left corner turned out to be
      // lightweight-charts' own default "Charting by TradingView"
      // attribution logo (id="tv-attr-logo"): a real, correctly-sized
      // (35x19px) SVG link the library injects unless told not to --
      // confirmed live via `document.querySelectorAll('a')` on this pane,
      // not an actual rendering bug in any of our own drawing code (markers,
      // MllBandPrimitive, price scales, and crosshair were each ruled out
      // by ablation first). It read as a glitch here because this app never
      // opted into it and doesn't otherwise attribute TradingView anywhere,
      // so an unstyled third-party mark sat directly on top of the chart
      // it's least supposed to draw attention to. Disabled per its own
      // documented `attributionLogo` option.
      layout: { background: { color: b.bg }, textColor: b.text, attributionLogo: false },
      grid: { vertLines: { color: b.grid }, horzLines: { color: b.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: b.border },
      rightPriceScale: { borderColor: b.border },
      localization: { priceFormatter: fmtAxisPrice },
      // Part C3 audit gap: only `mode` was ever set here, leaving both
      // crosshair lines and their axis-label backgrounds at lightweight-
      // charts' own fixed default colors (see CrosshairLineOptions in its
      // own typings) in every theme -- matches ChartKL.tsx's own crosshair
      // theming (textMuted line, surface label background) for cross-
      // engine consistency.
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: b.textMuted, labelBackgroundColor: b.surface },
        horzLine: { color: b.textMuted, labelBackgroundColor: b.surface },
      },
      autoSize: true,
    })

    // Only the equity series keeps its axis label + price line -- it's the
    // one "where are we right now" readout that matters (DESIGN_AUDIT.md
    // P2). MLL/daily-loss floors are threshold references already
    // identified by color + the legend above and by the Target price
    // line's own always-on label; giving each of them a THIRD competing
    // last-value label was the actual cause of the overlap, not a display
    // this chart needs.
    const equitySeries = chart.addSeries(LineSeries, { color: colorsRef.current.accent, lineWidth: 2, priceLineVisible: false }, 0)
    const mllSeries = chart.addSeries(
      LineSeries,
      {
        color: colorsRef.current.negative,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineType: LineType.WithSteps,
        lastValueVisible: false,
        priceLineVisible: false,
      },
      0,
    )
    const dailyLossSeries = chart.addSeries(
      LineSeries,
      {
        color: b.warning,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        lineType: LineType.WithSteps,
        lastValueVisible: false,
        priceLineVisible: false,
      },
      0,
    )

    const markers = createSeriesMarkers(equitySeries, [])
    const band = new MllBandPrimitive(equitySeries, [], hexToRgba(colorsRef.current.negative, 0.15))
    chart.panes()[0].attachPrimitive(band)

    // A fit requested while this pane was hidden (a background dock tab has
    // zero width, and fitContent() against zero width collapses the bar
    // spacing to nothing) runs the first time the pane gets a real size.
    const onSizeChange = () => {
      if (pendingFitRef.current && chart.timeScale().width() > 0) {
        pendingFitRef.current = false
        chart.timeScale().fitContent()
      }
    }
    chart.timeScale().subscribeSizeChange(onSizeChange)

    chartRef.current = chart
    equitySeriesRef.current = equitySeries
    mllSeriesRef.current = mllSeries
    dailyLossSeriesRef.current = dailyLossSeries
    markersRef.current = markers
    bandRef.current = band

    return () => {
      chart.timeScale().unsubscribeSizeChange(onSizeChange)
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
      crosshair: {
        vertLine: { color: base.textMuted, labelBackgroundColor: base.surface },
        horzLine: { color: base.textMuted, labelBackgroundColor: base.surface },
      },
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

    // Floors are null only on a manual run with no prop ruleset (F6) -- the
    // Prop Risk panel doesn't mount this chart for those, but the type is
    // honest about it, so rows without a floor are simply skipped.
    equitySeries.setData(equity.map((e): LineData<Time> => ({ time: e.time as Time, value: e.equity })))
    mllSeries.setData(
      equity.flatMap((e): LineData<Time>[] => (e.mll_floor === null ? [] : [{ time: e.time as Time, value: e.mll_floor }])),
    )
    dailyLossSeries.setData(
      equity.flatMap((e): LineData<Time>[] =>
        e.daily_loss_floor === null ? [] : [{ time: e.time as Time, value: e.daily_loss_floor }],
      ),
    )
    band.setPoints(equity.flatMap((e) => (e.mll_floor === null ? [] : [{ time: e.time, equity: e.equity, floor: e.mll_floor }])))

    if (targetLineRef.current) {
      equitySeries.removePriceLine(targetLineRef.current)
      targetLineRef.current = null
    }
    if (equity.length > 0 && equity[0].target_level !== null) {
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

  // Separate from the data effect above so a theme change (which re-runs
  // that one) never throws away a zoom/pan the user made -- this only fires
  // when the equity array itself is new.
  useEffect(() => {
    const chart = chartRef.current
    if (!fitOnData || equity.length === 0 || !chart) return
    if (chart.timeScale().width() > 0) {
      pendingFitRef.current = false
      chart.timeScale().fitContent()
    } else {
      pendingFitRef.current = true
    }
  }, [equity, fitOnData])

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
