import { forwardRef, useEffect, useImperativeHandle, useRef, type MutableRefObject } from 'react'
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import type { IndicatorPoint, TradeRecord, Bar } from '../api/types'
import type { IndicatorPrefs } from '../state/indicatorStore'
import { useDrawingStore, POINTS_REQUIRED, type Drawing, type DrawingPoint } from '../state/drawingStore'
import { TimeSpanPrimitive } from './TimeSpanPrimitive'
import { SessionBandsPrimitive, type SessionBand } from './SessionBandsPrimitive'
import { DrawingLayerPrimitive } from './DrawingLayerPrimitive'
import { TradeBracketPrimitive } from './TradeBracketPrimitive'
import { filterBarsForReplay, filterTradesForReplay, type ReplayTradeView } from './replay'
import { diffBars } from './barDiff'
import { findBarAtOrBefore, findBarAtTime, snapPrice } from './snap'
import { findBracketAt, formatBracketTooltip, type BracketDensity } from './tradeBracket'
import { interpolateRange } from './animateRange'
import { hexToRgba } from './color'
import LoadingBar from '../components/LoadingBar'
import { useThemeStore } from '../state/themeStore'

export interface PriceChartHandle {
  fitRange: (from: number, to: number) => void
  fitContent: () => void
  // Multi-chart sync (POLISH_ROADMAP Phase P2). The parent (ChartPanel)
  // owns the sync wiring and its own re-entrancy guard -- see that file's
  // comment -- these are just the imperative levers it pulls.
  setVisibleRange: (from: number, to: number) => void
  setCrosshairAt: (time: number) => void
  clearCrosshair: () => void
}

interface IndicatorData {
  vwap: IndicatorPoint[]
  ema20: IndicatorPoint[]
  ema50: IndicatorPoint[]
  atr14: IndicatorPoint[]
}

interface PriceChartProps {
  instrument: string | null
  bars: Bar[]
  trades: TradeRecord[]
  selectedTrade: TradeRecord | null
  sessionBands: SessionBand[]
  indicators: IndicatorData
  prefs: IndicatorPrefs
  // On-chart trade brackets (POLISH_ROADMAP Phase P3): 'auto' collapses
  // narrow brackets to markers, 'full' always draws the whole box, and
  // 'markers' always collapses -- see chart/tradeBracket.ts.
  bracketDensity: BracketDensity
  // True while bars for the current window are in flight (POLISH_ROADMAP
  // Phase P4) -- drives a subtle top-edge shimmer instead of the chart
  // just sitting frozen with no feedback during a fetch.
  loading?: boolean
  // Replay cursor (VIZ_SPEC section 0/8: no look-ahead). null = normal mode,
  // everything visible. When set, nothing with a time after the cursor is
  // drawn -- bars, indicator points, session shading, and trade
  // markers/SL/TP/shading are all clipped to it (see chart/replay.ts).
  cursorTime?: number | null
  // Multi-chart sync outputs -- fired on every user pan/zoom or crosshair
  // move so a sibling chart can mirror it. Both undefined in single-chart
  // mode (the default).
  onVisibleRangeChange?: (range: { from: number; to: number } | null) => void
  onCrosshairMove?: (time: number | null) => void
}

function clipToCursor(points: IndicatorPoint[], cursorTime: number | null | undefined): IndicatorPoint[] {
  if (cursorTime === null || cursorTime === undefined) return points
  return points.filter((p) => p.time <= cursorTime)
}

function barToCandle(b: Bar): CandlestickData<Time> {
  return { time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close }
}
// Up/down are theme colors (POLISH_ROADMAP Phase P6), passed in rather than
// module constants -- see the bars effect and the dedicated theme-recolor
// effect below, both of which need this same conversion.
function barToVolume(b: Bar, upColor: string, downColor: string): HistogramData<Time> {
  return {
    time: b.time as Time,
    value: b.volume,
    color: b.close >= b.open ? hexToRgba(upColor, 0.5) : hexToRgba(downColor, 0.5),
  }
}

const VWAP_COLOR = '#e3b341'
const EMA20_COLOR = '#79c0ff'
const EMA50_COLOR = '#d2a8ff'
const ATR_COLOR = '#8b949e'
const ATR_PANE_HEIGHT = 90

function fmtPrice(v: number): string {
  return v.toFixed(2)
}

const PriceChart = forwardRef<PriceChartHandle, PriceChartProps>(function PriceChart(
  {
    instrument,
    bars,
    trades,
    selectedTrade,
    sessionBands,
    indicators,
    prefs,
    bracketDensity,
    loading = false,
    cursorTime = null,
    onVisibleRangeChange,
    onCrosshairMove,
  },
  ref,
) {
  // Candle up/down + accent (POLISH_ROADMAP Phase P6: "ensure... the chart
  // follow[s] the theme"). Read once per render and threaded through every
  // color-consuming effect below; the chart-creation effect only uses this
  // for the very first paint (its own deps are `[]`), so the dedicated
  // "theme changed" effect further down is what keeps an already-open
  // chart in sync after that.
  const colors = useThemeStore((s) => s.colors)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const atr14SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const spanPrimitiveRef = useRef<TimeSpanPrimitive | null>(null)
  const sessionBandsRef = useRef<SessionBandsPrimitive | null>(null)
  const drawingLayerRef = useRef<DrawingLayerPrimitive | null>(null)
  const bracketPrimitiveRef = useRef<TradeBracketPrimitive | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const prevVisibleBarsRef = useRef<Bar[]>([])
  // Trade brackets currently on the primitive -- mirrored here so the
  // crosshair-hover handler (set up once, see below) can hit-test the
  // *latest* set without needing to resubscribe on every trades/cursor
  // change, same pattern as barsRef/instrumentRef/etc below.
  const bracketViewsRef = useRef<ReplayTradeView[]>([])
  // In-flight "ease to trade" animation frame, so a new fit request (e.g.
  // rapidly clicking "next trade") cancels the previous one instead of the
  // two fighting over the viewport.
  const fitAnimationRef = useRef<number | null>(null)

  // Mirrors of props/derived state, read from inside event-subscription
  // closures that are set up once (chart-creation effect) so they never go
  // stale without needing to resubscribe on every render.
  const barsRef = useRef<Bar[]>(bars)
  const instrumentRef = useRef<string | null>(instrument)
  const indicatorsRef = useRef<IndicatorData>(indicators)
  const prefsRef = useRef<IndicatorPrefs>(prefs)
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange)
  const onCrosshairMoveRef = useRef(onCrosshairMove)
  barsRef.current = bars
  instrumentRef.current = instrument
  indicatorsRef.current = indicators
  prefsRef.current = prefs
  onVisibleRangeChangeRef.current = onVisibleRangeChange
  onCrosshairMoveRef.current = onCrosshairMove

  const drawings = useDrawingStore((s) => s.drawings)
  // Only used for the cursor-style hint below; the click/crosshair
  // handlers read the live values imperatively via getState() instead of
  // closing over these (see the chart-creation effect's comment).
  const activeTool = useDrawingStore((s) => s.activeTool)

  // Legend value nodes, written to directly on crosshair move -- never
  // through React state, so hovering the chart never re-renders React
  // (POLISH_ROADMAP Phase P2: "confirm no full re-renders on interaction").
  const legendRef = useRef<HTMLDivElement>(null)
  const legendFieldRefs = useRef<Record<string, HTMLSpanElement | null>>({})

  // Trade bracket hover tooltip (POLISH_ROADMAP Phase P3) -- same
  // DOM-ref-direct-write pattern as the legend above, positioned next to
  // the cursor on every crosshair move.
  const bracketTooltipRef = useRef<HTMLDivElement>(null)

  // Create the chart once. Everything else (data, markers, price lines)
  // updates in place via refs -- recreating the chart on every prop change
  // would fight the user's zoom/pan state.
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

    const candles = chart.addSeries(
      CandlestickSeries,
      {
        upColor: colors.up,
        downColor: colors.down,
        borderVisible: false,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
      },
      0,
    )

    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: 'volume' },
      1,
    )
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } })
    chart.panes()[1]?.setHeight(100)

    const vwap = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, visible: false }, 0)
    const ema20 = chart.addSeries(LineSeries, { color: EMA20_COLOR, lineWidth: 1, visible: false }, 0)
    const ema50 = chart.addSeries(LineSeries, { color: EMA50_COLOR, lineWidth: 1, visible: false }, 0)
    const atr14 = chart.addSeries(LineSeries, { color: ATR_COLOR, lineWidth: 1, visible: false }, 2)
    chart.panes()[2]?.setHeight(0)

    const markers = createSeriesMarkers(candles, [])
    const spanPrimitive = new TimeSpanPrimitive(null, null)
    chart.panes()[0].attachPrimitive(spanPrimitive)
    const sessionBandsPrimitive = new SessionBandsPrimitive(candles, [], true, true)
    chart.panes()[0].attachPrimitive(sessionBandsPrimitive)
    const bracketPrimitive = new TradeBracketPrimitive(candles, [], null, 'auto')
    chart.panes()[0].attachPrimitive(bracketPrimitive)
    const drawingLayer = new DrawingLayerPrimitive(candles, [], null, [])
    chart.panes()[0].attachPrimitive(drawingLayer)

    chartRef.current = chart
    candleSeriesRef.current = candles
    volumeSeriesRef.current = volume
    vwapSeriesRef.current = vwap
    ema20SeriesRef.current = ema20
    ema50SeriesRef.current = ema50
    atr14SeriesRef.current = atr14
    markersRef.current = markers
    spanPrimitiveRef.current = spanPrimitive
    sessionBandsRef.current = sessionBandsPrimitive
    bracketPrimitiveRef.current = bracketPrimitive
    drawingLayerRef.current = drawingLayer

    // Pan/zoom -> sibling chart sync (multi-chart split view). No data
    // fetching happens here (that was the earlier, reverted approach) --
    // this only mirrors the visible range to another already-loaded chart
    // instance via the parent's guarded callback.
    const handleVisibleTimeRangeChange = (range: { from: Time; to: Time } | null) => {
      onVisibleRangeChangeRef.current?.(range ? { from: range.from as number, to: range.to as number } : null)
    }
    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleTimeRangeChange)

    const handleClick = (param: MouseEventParams<Time>) => {
      const store = useDrawingStore.getState()
      const tool = store.activeTool
      const inst = instrumentRef.current
      if (!tool || !inst || param.time === undefined || !param.point) return
      const rawPrice = candles.coordinateToPrice(param.point.y)
      if (rawPrice === null) return
      const bar = findBarAtTime(barsRef.current, param.time as number)
      const price = snapPrice(rawPrice, bar)
      const point: DrawingPoint = { time: param.time as number, price }

      if (POINTS_REQUIRED[tool] === 1) {
        store.addDrawing({ id: crypto.randomUUID(), type: tool, instrument: inst, points: [point] })
        store.setActiveTool(null)
      } else if (!store.pendingPoint) {
        store.setPendingPoint(point)
      } else {
        store.addDrawing({ id: crypto.randomUUID(), type: tool, instrument: inst, points: [store.pendingPoint, point] })
        store.cancelDrawing()
      }
    }
    chart.subscribeClick(handleClick)

    const setLegendField = (key: string, text: string) => {
      const el = legendFieldRefs.current[key]
      if (el) el.textContent = text
    }

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      // 1. OHLCV + indicator legend, written directly to the DOM.
      if (param.time === undefined) {
        if (legendRef.current) legendRef.current.style.visibility = 'hidden'
      } else {
        const bar = findBarAtTime(barsRef.current, param.time as number)
        if (legendRef.current) legendRef.current.style.visibility = bar ? 'visible' : 'hidden'
        if (bar) {
          setLegendField('o', fmtPrice(bar.open))
          setLegendField('h', fmtPrice(bar.high))
          setLegendField('l', fmtPrice(bar.low))
          setLegendField('c', fmtPrice(bar.close))
          setLegendField('vol', bar.volume.toLocaleString())
          const ind = indicatorsRef.current
          const p = prefsRef.current
          if (p.vwap) setLegendField('vwap', fmtPrice(findValueAt(ind.vwap, bar.time)))
          if (p.ema20) setLegendField('ema20', fmtPrice(findValueAt(ind.ema20, bar.time)))
          if (p.ema50) setLegendField('ema50', fmtPrice(findValueAt(ind.ema50, bar.time)))
          if (p.atr14) setLegendField('atr14', fmtPrice(findValueAt(ind.atr14, bar.time)))
        }
      }

      // 2. Trade bracket hover tooltip -- suppressed while a drawing tool
      // is armed so the two overlays never fight for the same cursor.
      const store = useDrawingStore.getState()
      const tooltip = bracketTooltipRef.current
      if (tooltip) {
        const hoverPrice = !store.activeTool && param.point ? candles.coordinateToPrice(param.point.y) : null
        const hit =
          hoverPrice !== null && param.time !== undefined
            ? findBracketAt(bracketViewsRef.current, param.time as number, hoverPrice)
            : null
        if (hit && param.point) {
          tooltip.textContent = formatBracketTooltip(hit)
          tooltip.style.visibility = 'visible'
          const maxLeft = Math.max(0, container.clientWidth - 220)
          const maxTop = Math.max(0, container.clientHeight - 140)
          tooltip.style.left = `${Math.min(param.point.x + 14, maxLeft)}px`
          tooltip.style.top = `${Math.min(param.point.y + 14, maxTop)}px`
        } else {
          tooltip.style.visibility = 'hidden'
        }
      }

      // 3. Live preview of an in-progress 2-click drawing.
      if (store.activeTool && store.pendingPoint && param.time !== undefined && param.point) {
        const rawPrice = candles.coordinateToPrice(param.point.y)
        if (rawPrice !== null) {
          const bar = findBarAtTime(barsRef.current, param.time as number)
          const price = snapPrice(rawPrice, bar)
          const preview: Drawing = {
            id: '__preview__',
            type: store.activeTool,
            instrument: instrumentRef.current ?? '',
            points: [store.pendingPoint, { time: param.time as number, price }],
          }
          drawingLayerRef.current?.update(store.drawings, preview, barsRef.current)
        }
      } else {
        drawingLayerRef.current?.update(store.drawings, null, barsRef.current)
      }

      // 4. Multi-chart crosshair sync.
      onCrosshairMoveRef.current?.(param.time !== undefined ? (param.time as number) : null)
    }
    chart.subscribeCrosshairMove(handleCrosshairMove)

    return () => {
      if (fitAnimationRef.current !== null) {
        cancelAnimationFrame(fitAnimationRef.current)
        fitAnimationRef.current = null
      }
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      vwapSeriesRef.current = null
      ema20SeriesRef.current = null
      ema50SeriesRef.current = null
      atr14SeriesRef.current = null
      markersRef.current = null
      spanPrimitiveRef.current = null
      sessionBandsRef.current = null
      bracketPrimitiveRef.current = null
      drawingLayerRef.current = null
      priceLinesRef.current = []
      prevVisibleBarsRef.current = []
      bracketViewsRef.current = []
    }
  }, [])

  // Bars -> candlestick + volume series data. Clipped to the replay cursor
  // when set -- no look-ahead (VIZ_SPEC section 0/8). Diffed against what
  // was last drawn: a pure trailing append (replay stepping forward, or a
  // freshly-fetched window that just extends the old one) uses series.
  // update() per new bar instead of a full setData() (POLISH_ROADMAP
  // Phase P2 smoothness) -- anything else (prepend, gap, different window)
  // safely falls back to setData(), which is all update() supports anyway.
  useEffect(() => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!candleSeries || !volumeSeries) return
    const visibleBars = filterBarsForReplay(bars, cursorTime)
    const diff = diffBars(prevVisibleBarsRef.current, visibleBars)

    if (diff.kind === 'append') {
      for (const b of diff.newBars) {
        candleSeries.update(barToCandle(b))
        volumeSeries.update(barToVolume(b, colors.up, colors.down))
      }
    } else {
      candleSeries.setData(visibleBars.map(barToCandle))
      volumeSeries.setData(visibleBars.map((b) => barToVolume(b, colors.up, colors.down)))
    }
    prevVisibleBarsRef.current = visibleBars
  }, [bars, cursorTime])

  // Session background shading + fair-value segments. A session window
  // extending past the cursor gets its right edge clipped to the cursor too.
  useEffect(() => {
    const clippedBands =
      cursorTime === null
        ? sessionBands
        : sessionBands
            .filter((b) => b.start <= cursorTime)
            .map((b) => ({ ...b, end: Math.min(b.end, cursorTime) }))
    sessionBandsRef.current?.update(clippedBands, prefs.sessionShading, prefs.fairValue)
  }, [sessionBands, prefs.sessionShading, prefs.fairValue, cursorTime])

  // Indicator overlay lines -- data always set, visibility toggled
  // independently so switching a toggle never needs a refetch/flicker.
  useEffect(() => {
    if (!vwapSeriesRef.current) return
    const data = clipToCursor(indicators.vwap, cursorTime)
    vwapSeriesRef.current.setData(data.map((p): LineData<Time> => ({ time: p.time as Time, value: p.value })))
    vwapSeriesRef.current.applyOptions({ visible: prefs.vwap })
  }, [indicators.vwap, prefs.vwap, cursorTime])

  useEffect(() => {
    if (!ema20SeriesRef.current) return
    const data = clipToCursor(indicators.ema20, cursorTime)
    ema20SeriesRef.current.setData(data.map((p): LineData<Time> => ({ time: p.time as Time, value: p.value })))
    ema20SeriesRef.current.applyOptions({ visible: prefs.ema20 })
  }, [indicators.ema20, prefs.ema20, cursorTime])

  useEffect(() => {
    if (!ema50SeriesRef.current) return
    const data = clipToCursor(indicators.ema50, cursorTime)
    ema50SeriesRef.current.setData(data.map((p): LineData<Time> => ({ time: p.time as Time, value: p.value })))
    ema50SeriesRef.current.applyOptions({ visible: prefs.ema50 })
  }, [indicators.ema50, prefs.ema50, cursorTime])

  // ATR(14) lives in its own pane, collapsed to zero height when hidden so
  // it doesn't waste vertical space.
  useEffect(() => {
    if (!atr14SeriesRef.current || !chartRef.current) return
    const data = clipToCursor(indicators.atr14, cursorTime)
    atr14SeriesRef.current.setData(data.map((p): LineData<Time> => ({ time: p.time as Time, value: p.value })))
    atr14SeriesRef.current.applyOptions({ visible: prefs.atr14 })
    chartRef.current.panes()[2]?.setHeight(prefs.atr14 ? ATR_PANE_HEIGHT : 0)
  }, [indicators.atr14, prefs.atr14, cursorTime])

  // Trades -> entry/exit markers. All trades passed in get a marker (the
  // caller is responsible for only passing trades within the loaded window).
  // The selected trade's markers are drawn larger so it stands out among
  // whatever else is visible. In replay mode, a trade whose entry hasn't
  // happened yet as of the cursor is omitted entirely, and one that's
  // entered but not yet exited only gets its entry marker (chart/replay.ts
  // -- no look-ahead).
  useEffect(() => {
    if (!markersRef.current) return
    const markers: SeriesMarker<Time>[] = []
    for (const { trade: t, showExit } of filterTradesForReplay(trades, cursorTime)) {
      const isLong = t.side === 'long'
      const win = t.pnl_usd > 0
      const isSelected = selectedTrade?.trade_id === t.trade_id
      const size = isSelected ? 2 : 1
      markers.push({
        time: t.entry_time as Time,
        position: isLong ? 'belowBar' : 'aboveBar',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        color: colors.accent,
        text: `${t.side} entry`,
        id: `entry-${t.trade_id}`,
        size,
      })
      if (showExit) {
        markers.push({
          time: t.exit_time as Time,
          position: isLong ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: win ? colors.up : colors.down,
          text: `${t.exit_type} ${win ? 'win' : 'loss'}`,
          id: `exit-${t.trade_id}`,
          size,
        })
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    markersRef.current.setMarkers(markers)
  }, [trades, selectedTrade, cursorTime, colors])

  // Trades -> on-chart brackets (POLISH_ROADMAP Phase P3). Same
  // replay-filtered view as the markers above (a trade whose entry hasn't
  // happened yet as of the cursor doesn't exist yet; one that's open but
  // not yet exited only shows its known-at-entry SL/TP corridors, not an
  // outcome it doesn't have yet). `bracketViewsRef` mirrors this for the
  // crosshair-hover tooltip's hit test, which runs from a handler set up
  // once at chart-creation time and so can't close over fresh props.
  useEffect(() => {
    const views = filterTradesForReplay(trades, cursorTime)
    bracketViewsRef.current = views
    bracketPrimitiveRef.current?.update(views, selectedTrade?.trade_id ?? null, bracketDensity)
  }, [trades, selectedTrade, cursorTime, bracketDensity])

  // Theme changed (POLISH_ROADMAP Phase P6) -- recolors everything that
  // isn't already covered by the effects above re-running with `colors` in
  // their own deps (markers, price lines): the candle/volume series
  // options+data (volume bakes its color into each bar's own data, so it
  // needs a real setData(), not just applyOptions()), the trade bracket
  // primitive's derived fill/stroke set, and the open-position span tint.
  useEffect(() => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (candleSeries) {
      candleSeries.applyOptions({
        upColor: colors.up,
        downColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
      })
    }
    if (volumeSeries) {
      const visibleBars = filterBarsForReplay(bars, cursorTime)
      volumeSeries.setData(visibleBars.map((b) => barToVolume(b, colors.up, colors.down)))
    }
    bracketPrimitiveRef.current?.setTradeColors(colors.up, colors.down, colors.accent)
    spanPrimitiveRef.current?.setColor(hexToRgba(colors.accent, 0.08))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors])

  // Selected trade -> SL/TP price lines + open-position shading. In replay
  // mode, hidden entirely until the cursor reaches its entry; the shading
  // span's end is clamped to the cursor while the trade is still "open"
  // from the replay's point of view (chart/replay.ts).
  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return

    priceLinesRef.current.forEach((pl) => series.removePriceLine(pl))
    priceLinesRef.current = []

    const [replayView] = selectedTrade ? filterTradesForReplay([selectedTrade], cursorTime) : []
    const visibleTrade = replayView?.trade ?? null

    if (visibleTrade) {
      if (visibleTrade.sl_price !== null) {
        priceLinesRef.current.push(
          series.createPriceLine({
            price: visibleTrade.sl_price,
            color: colors.down,
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'SL',
          }),
        )
      }
      if (visibleTrade.tp_price !== null) {
        priceLinesRef.current.push(
          series.createPriceLine({
            price: visibleTrade.tp_price,
            color: colors.up,
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'TP',
          }),
        )
      }
    }

    spanPrimitiveRef.current?.setRange(
      visibleTrade ? visibleTrade.entry_time : null,
      replayView ? replayView.openSpanEnd : null,
    )
  }, [selectedTrade, cursorTime, colors])

  // Committed drawings changed (added/removed) -- refresh the layer. The
  // live in-progress preview is driven separately, directly from the
  // crosshair-move handler above (bypassing React for that high-frequency
  // path); this effect always passes preview=null, which is correct any
  // time drawings/bars change through React rather than a mouse move.
  useEffect(() => {
    drawingLayerRef.current?.update(drawings, null, bars)
  }, [drawings, bars])

  // Cursor hint: crosshair while a drawing tool is armed, so it's visually
  // obvious the next click places a point rather than just panning.
  useEffect(() => {
    if (containerRef.current) containerRef.current.style.cursor = activeTool ? 'crosshair' : 'default'
  }, [activeTool])

  useImperativeHandle(
    ref,
    () => ({
      // Eases the viewport to a trade rather than snapping to it
      // (POLISH_ROADMAP Phase P3). If there's no current visible range yet
      // (first paint) there's nothing to ease from, so it snaps -- that
      // avoids an odd animation-from-nowhere on initial load.
      //
      // Guarded on real data for the same reason as setVisibleRange above:
      // ChartPanel's own auto-fit effect already waits for bars to load,
      // but the 'f' keyboard shortcut calls fitTrade() straight from a
      // keydown handler gated only on `selectedTrade` existing -- if a
      // trade is selected before its bars have finished fetching (e.g.
      // switching trades quickly), that path reaches here with an empty
      // chart and LWC throws instead of no-op-ing, same white-screen
      // crash as the split-view case, confirmed live.
      fitRange: (from, to) => {
        const chart = chartRef.current
        if (!chart || barsRef.current.length === 0) return
        if (fitAnimationRef.current !== null) {
          cancelAnimationFrame(fitAnimationRef.current)
          fitAnimationRef.current = null
        }
        const current = chart.timeScale().getVisibleRange()
        if (!current) {
          chart.timeScale().setVisibleRange({ from: from as Time, to: to as Time })
          return
        }
        const start = { from: current.from as number, to: current.to as number }
        const target = { from, to }
        const durationMs = 400
        const startTs = performance.now()
        const step = (now: number) => {
          const t = Math.min(1, (now - startTs) / durationMs)
          const range = interpolateRange(start, target, t)
          chart.timeScale().setVisibleRange({ from: range.from as Time, to: range.to as Time })
          fitAnimationRef.current = t < 1 ? requestAnimationFrame(step) : null
        }
        fitAnimationRef.current = requestAnimationFrame(step)
      },
      fitContent: () => {
        chartRef.current?.timeScale().fitContent()
      },
      // Guarded on having real data: a chart with zero bars has no logical
      // (bar-index) range for LWC to map a time-based range onto, and
      // setVisibleRange() throws in that state (ensureNotNull inside its
      // own timeToLogicalRange) rather than no-op-ing. This is reachable in
      // practice, not just in theory -- split view's sync (ChartPanel.tsx)
      // mirrors the primary's very first auto-range onto the secondary
      // chart the instant it mounts, before its own bars fetch has
      // resolved, and an uncaught throw here took down the whole tree
      // (no error boundary) with a real, 100%-reproducible white screen.
      setVisibleRange: (from, to) => {
        if (barsRef.current.length === 0) return
        chartRef.current?.timeScale().setVisibleRange({ from: from as Time, to: to as Time })
      },
      setCrosshairAt: (time) => {
        const chart = chartRef.current
        const series = candleSeriesRef.current
        if (!chart || !series) return
        // A time from a sibling chart at a different timeframe rarely
        // lands exactly on one of this chart's own bars -- use the
        // closest bar at or before it, and position at THAT bar's own
        // time (the only values setCrosshairPosition accepts as valid).
        const bar = findBarAtOrBefore(barsRef.current, time)
        if (!bar) return
        chart.setCrosshairPosition(bar.close, bar.time as Time, series)
      },
      clearCrosshair: () => {
        chartRef.current?.clearCrosshairPosition()
      },
    }),
    [],
  )

  return (
    <div className="relative h-full w-full">
      <LoadingBar active={loading} />
      <div
        ref={legendRef}
        className="pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap gap-x-3 rounded bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-300"
        style={{ visibility: 'hidden' }}
      >
        <LegendField label="O" fieldKey="o" fieldRefs={legendFieldRefs} />
        <LegendField label="H" fieldKey="h" fieldRefs={legendFieldRefs} />
        <LegendField label="L" fieldKey="l" fieldRefs={legendFieldRefs} />
        <LegendField label="C" fieldKey="c" fieldRefs={legendFieldRefs} />
        <LegendField label="Vol" fieldKey="vol" fieldRefs={legendFieldRefs} />
        {prefs.vwap && <LegendField label="VWAP" fieldKey="vwap" color={VWAP_COLOR} fieldRefs={legendFieldRefs} />}
        {prefs.ema20 && <LegendField label="EMA20" fieldKey="ema20" color={EMA20_COLOR} fieldRefs={legendFieldRefs} />}
        {prefs.ema50 && <LegendField label="EMA50" fieldKey="ema50" color={EMA50_COLOR} fieldRefs={legendFieldRefs} />}
        {prefs.atr14 && <LegendField label="ATR14" fieldKey="atr14" color={ATR_COLOR} fieldRefs={legendFieldRefs} />}
      </div>
      <div
        ref={bracketTooltipRef}
        className="pointer-events-none absolute z-20 whitespace-pre-line rounded border border-neutral-700 bg-neutral-950/95 px-2 py-1.5 text-[11px] leading-snug text-neutral-300 shadow-lg"
        style={{ visibility: 'hidden' }}
      />
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
})

function LegendField({
  label,
  fieldKey,
  color,
  fieldRefs,
}: {
  label: string
  fieldKey: string
  color?: string
  fieldRefs: MutableRefObject<Record<string, HTMLSpanElement | null>>
}) {
  return (
    <span>
      <span className="text-neutral-500">{label} </span>
      <span ref={(el) => (fieldRefs.current[fieldKey] = el)} style={color ? { color } : undefined}>
        -
      </span>
    </span>
  )
}

function findValueAt(points: IndicatorPoint[], time: number): number {
  // Indicator series are sparse relative to bars (e.g. ATR/EMA warm-up), so
  // an exact-time match isn't guaranteed -- fall back to the latest point
  // at or before the hovered bar, same "most recent known value" concept
  // used for the replay equity readout (chart/replay.ts's equityAtCursor).
  let result = NaN
  for (const p of points) {
    if (p.time > time) break
    result = p.value
  }
  return result
}

export default PriceChart
