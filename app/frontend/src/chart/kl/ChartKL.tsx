import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { dispose, init, type Chart, type KLineData, type OverlayCreate } from 'klinecharts'
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
import {
  DRAWING_GROUP_ID,
  ensureDrawingOverlaysRegistered,
  hydrateOverlay,
  serializeOverlay,
  setMeasureBarsContext,
  toolByName,
  type PersistedOverlay,
} from './drawingOverlays'
import {
  KL_ATR14,
  KL_EMA20,
  KL_EMA50,
  KL_VWAP,
  ensureIndicatorsRegistered,
  setIndicatorContext,
} from './indicators'
import {
  FAIR_VALUE_GROUP,
  SESSION_BAND_GROUP,
  buildFairValueOverlay,
  buildSessionBandOverlay,
  ensureSessionBandOverlayRegistered,
} from './sessionOverlay'
import { useKLDrawingStore, overlaysForInstrument } from '../../state/klDrawingStore'
import { useThemeStore } from '../../state/themeStore'
import type { IndicatorPrefs } from '../../state/indicatorStore'
import type { Bar, IndicatorPoint, TradeRecord } from '../../api/types'
import type { SessionBand } from '../SessionBandsPrimitive'
import { filterBarsForReplay, filterTradesForReplay } from '../replay'

interface IndicatorData {
  vwap: IndicatorPoint[]
  ema20: IndicatorPoint[]
  ema50: IndicatorPoint[]
  atr14: IndicatorPoint[]
}

export interface ChartKLHandle {
  // Re-zoom to a time range without refetching (PART_A_REVISED_klinecharts.md
  // Phase A1's "preserve Fit trade"). KLineCharts has no direct
  // setVisibleRange-by-time like Lightweight Charts -- this derives the
  // bar-space (zoom level) that fits the range into the pane's current
  // pixel width, then scrolls to center it.
  fitRange: (from: number, to: number) => void
  scrollToTrade: (time: number) => void
  // Phase A2's drawing toolbar levers.
  startDrawing: (toolName: string) => void
  cancelActiveDrawing: () => void
  removeDrawing: (id: string) => void
  clearDrawings: () => void
}

interface ChartKLProps {
  instrument: string | null
  timeframe: string
  from: number | null
  to: number | null
  trades: TradeRecord[]
  selectedTrade: TradeRecord | null
  indicators: IndicatorData
  sessionBands: SessionBand[]
  prefs: IndicatorPrefs
  // Replay cursor (PART_A_REVISED_klinecharts.md Phase A4, VIZ_SPEC §0: no
  // look-ahead). null = normal mode, everything visible. When set, bars
  // and trade overlays are clipped to time <= cursorTime -- same contract
  // as PriceChart.tsx's own cursorTime prop, same source value (ChartPanel
  // computes it once, feeds both engines).
  cursorTime?: number | null
  // Fires whenever the set of user drawings changes (placed, dragged,
  // removed, or restored on load) so the toolbar's manage dropdown can
  // show an up-to-date list without polling the chart instance itself.
  onDrawingsChange?: (overlays: PersistedOverlay[]) => void
  // Multi-chart sync output (Phase A5), fired on every user pan/zoom --
  // undefined in single-chart mode. klinecharts' own onVisibleRangeChange
  // action reports DATA-INDEX bounds (confirmed against the v10.0.3
  // source), not timestamps -- meaningless to hand to a sibling chart at a
  // DIFFERENT timeframe (index 50 on a 1min chart is a different moment
  // than index 50 on a 15min chart), so this resolves the indices to this
  // chart's own loaded bar timestamps first and reports THOSE.
  onVisibleRangeChange?: (range: { from: number; to: number } | null) => void
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
// klinecharts.md Phases A1-A5) -- trade-visual parity (A1), a full drawing
// toolbar on klinecharts' own overlay system (A2, replacing the old
// hand-built drawing engine entirely), backend-sourced indicators/session
// shading (A3), replay (A4), and multi-chart sync (A5). Still mounted
// behind chartEngineStore's feature flag alongside lightweight-charts.
//
// Deliberately a FIXED window, not real forward/backward pan-triggered
// pagination: ChartPanel already computes `from`/`to` (trade- or
// day-centered, with margin -- see windowMargin.ts) for the lightweight-
// charts engine, and lightweight-charts itself doesn't do infinite pan-
// fetch either (see ChartPanel.tsx's withMargin comment). Matching that
// exact behavior keeps the two engines comparable.
//
// Crosshair sync (Phase A5) is NOT implemented, unlike Lightweight
// Charts' setCrosshairPosition: klinecharts' internal StoreImp does have a
// setCrosshair method (confirmed from source), but it is not part of the
// public Chart/Store interface init() returns (absent from the published
// index.d.ts) -- there is no supported way from outside the library to
// move a chart's crosshair programmatically. Documented limitation per
// PART_A_REVISED_klinecharts.md's own "sync crosshair if feasible."
const ChartKL = forwardRef<ChartKLHandle, ChartKLProps>(function ChartKL(
  {
    instrument,
    timeframe,
    from,
    to,
    trades,
    selectedTrade,
    indicators,
    sessionBands,
    prefs,
    cursorTime = null,
    onDrawingsChange,
    onVisibleRangeChange,
  },
  ref,
) {
  const colors = useThemeStore((s) => s.colors)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  // The full, unclipped bars for the current window -- the ground-truth
  // cache a cursor-triggered reslice reads from instead of hitting the
  // backend again (see the DataLoader below). `loadedBarsRef` is what's
  // actually ON the chart right now (replay-clipped when a cursor is
  // active) -- everything downstream that positions things relative to
  // "the currently visible bars" (SL/TP price-line left edge, trade-marker
  // anchor lookups, the measure tool's bar context) reads this one, which
  // is deliberately also correct no-look-ahead behavior: none of those
  // should reach past the cursor either.
  const fullBarsRef = useRef<Bar[]>([])
  const lastFetchKeyRef = useRef<string | null>(null)
  const loadedBarsRef = useRef<Bar[]>([])
  const cursorTimeRef = useRef(cursorTime)
  cursorTimeRef.current = cursorTime
  // The one overlay currently mid-placement (createOverlay was called but
  // the user hasn't finished clicking all its points yet), so Escape can
  // cancel it -- see cancelActiveDrawing below.
  const activeDrawingIdRef = useRef<string | null>(null)
  const onDrawingsChangeRef = useRef(onDrawingsChange)
  onDrawingsChangeRef.current = onDrawingsChange
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange)
  onVisibleRangeChangeRef.current = onVisibleRangeChange

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
  const indicatorsRef = useRef(indicators)
  indicatorsRef.current = indicators
  const sessionBandsRef = useRef(sessionBands)
  sessionBandsRef.current = sessionBands
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const rebuildOverlaysRef = useRef<() => void>(() => {})
  rebuildOverlaysRef.current = () => {
    const chart = chartRef.current
    withReadyChart(chart, loadedBarsRef.current.length > 0, (chart) => {
      chart.removeOverlay({ groupId: ENTRY_EXIT_GROUP })
      chart.removeOverlay({ groupId: SL_TP_LINE_GROUP })
      chart.removeOverlay({ groupId: ZONE_GROUP })
      // filterTradesForReplay (chart/replay.ts, already tested, already
      // used by PriceChart.tsx) both hides a trade that hasn't entered yet
      // as of the cursor and clips a still-open trade's exit -- in normal
      // mode (cursorTime null) it's a no-op that returns every trade with
      // showExit:true, so this is the same code path either way.
      const cursor = cursorTimeRef.current
      const views = filterTradesForReplay(tradesRef.current, cursor)
      const selectedView = selectedTradeRef.current
        ? (filterTradesForReplay([selectedTradeRef.current], cursor)[0] ?? null)
        : null
      const entryExit = buildEntryExitOverlays(
        views,
        loadedBarsRef.current,
        selectedTradeRef.current?.trade_id ?? null,
        colorsRef.current,
      )
      const selected = buildSelectedTradeOverlays(selectedView, loadedBarsRef.current[0]?.time ?? null, colorsRef.current)
      if (entryExit.length > 0 || selected.length > 0) chart.createOverlay([...entryExit, ...selected])
    })
  }

  // Backend-sourced indicators (Phase A3) -- VWAP/EMA20/EMA50/ATR14 are
  // pass-through custom indicators (see indicators.ts's header comment for
  // why they're not klinecharts' own built-in EMA/ATR formulas).
  // setIndicatorContext() first so each indicator's calc sees the fresh
  // points the instant createIndicator triggers its first calc pass.
  const rebuildIndicatorsRef = useRef<() => void>(() => {})
  rebuildIndicatorsRef.current = () => {
    const chart = chartRef.current
    withReadyChart(chart, loadedBarsRef.current.length > 0, (chart) => {
      setIndicatorContext(indicatorsRef.current)
      const spec = findInstrument(requestRef.current.instrument ?? '')
      const precision = spec ? pricePrecisionFromTick(spec.minmov, spec.pricescale) : 2
      chart.removeIndicator({ name: KL_VWAP })
      chart.removeIndicator({ name: KL_EMA20 })
      chart.removeIndicator({ name: KL_EMA50 })
      chart.removeIndicator({ name: KL_ATR14 })
      const p = prefsRef.current
      // `series: 'price'` on the template alone does NOT place these on
      // the main candle pane -- verified live that it creates a brand new
      // pane per indicator instead (getPaneOptions() showed 3 stacked
      // panes for VOL/klVwap alone, with candles pushed out of view).
      // paneId: 'candle_pane' is required to actually overlay on price.
      // isStack: true is ALSO required once more than one of these share
      // that pane -- verified live that without it, each new indicator on
      // an already-occupied pane silently replaces the previous one
      // instead of coexisting (enabling EMA20 then EMA50 left only EMA50
      // -- VWAP and EMA20 had vanished from getIndicators() entirely).
      if (p.vwap) chart.createIndicator({ name: KL_VWAP, precision, paneId: 'candle_pane' }, true)
      if (p.ema20) chart.createIndicator({ name: KL_EMA20, precision, paneId: 'candle_pane' }, true)
      if (p.ema50) chart.createIndicator({ name: KL_EMA50, precision, paneId: 'candle_pane' }, true)
      if (p.atr14) chart.createIndicator({ name: KL_ATR14 }, false)
    })
  }

  // Session shading + fair-value segments (Phase A3), from the same
  // /api/sessions data ChartPanel already fetches for lightweight-charts.
  const rebuildSessionOverlaysRef = useRef<() => void>(() => {})
  rebuildSessionOverlaysRef.current = () => {
    const chart = chartRef.current
    withReadyChart(chart, loadedBarsRef.current.length > 0, (chart) => {
      chart.removeOverlay({ groupId: SESSION_BAND_GROUP })
      chart.removeOverlay({ groupId: FAIR_VALUE_GROUP })
      const p = prefsRef.current
      const bands = sessionBandsRef.current
      const overlays: OverlayCreate[] = []
      if (p.sessionShading) overlays.push(...bands.map(buildSessionBandOverlay))
      if (p.fairValue) {
        for (const band of bands) {
          const fv = buildFairValueOverlay(band)
          if (fv) overlays.push(fv)
        }
      }
      if (overlays.length > 0) chart.createOverlay(overlays)
    })
  }

  // Guards persistDrawingsRef against firing on the *internal* housekeeping
  // remove/create inside restoreDrawingsRef below -- verified live that
  // chart.removeOverlay({groupId}) fires each removed overlay's onRemoved
  // callback before the others in the same group have been removed, so
  // without this guard a persist mid-removal snapshots a transient PARTIAL
  // set and overwrites storage with it (reproduced: 2 saved drawings ->
  // reload -> only 1 survived, because removing the first of two during
  // restoreDrawingsRef's own clear-before-restore step fired onRemoved,
  // which read getOverlays() while the second one was still present but
  // about to be removed, and saved that transient state). A real user
  // deleting a drawing (removeDrawing/clearDrawings handle methods) is
  // NOT wrapped in this guard, so those still persist correctly.
  const suppressPersistRef = useRef(false)

  // Reads the chart's current user-drawing overlays, saves them to
  // localStorage keyed by instrument, and tells the toolbar. Attached as
  // every drawing overlay's onDrawEnd/onPressedMoveEnd/onRemoved (both
  // freshly-placed ones and ones restored from storage), so anything that
  // changes what's on screen keeps storage and the toolbar in sync.
  const persistDrawingsRef = useRef<() => void>(() => {})
  persistDrawingsRef.current = () => {
    if (suppressPersistRef.current) return
    const chart = chartRef.current
    const inst = requestRef.current.instrument
    if (!chart || !inst) return
    const overlays = chart.getOverlays({ groupId: DRAWING_GROUP_ID })
    const persisted = overlays.map((o) =>
      serializeOverlay({ id: o.id, name: o.name, points: o.points, styles: o.styles ?? undefined, extendData: o.extendData }),
    )
    useKLDrawingStore.getState().setOverlaysForInstrument(inst, persisted)
    onDrawingsChangeRef.current?.(persisted)
  }

  const drawingCallbacks = () => ({
    onDrawEnd: () => {
      activeDrawingIdRef.current = null
      persistDrawingsRef.current()
    },
    onPressedMoveEnd: () => {
      persistDrawingsRef.current()
    },
    onRemoved: () => {
      persistDrawingsRef.current()
    },
  })

  // Clears whatever user-drawing overlays are on screen and recreates
  // this instrument's persisted set -- called once per successful bars
  // load (mount, instrument switch, or timeframe change), so drawings stay
  // correct across all three without separately tracking "did the
  // instrument actually change."
  const restoreDrawingsRef = useRef<() => void>(() => {})
  restoreDrawingsRef.current = () => {
    const chart = chartRef.current
    const inst = requestRef.current.instrument
    if (!chart || !inst) return
    suppressPersistRef.current = true
    try {
      chart.removeOverlay({ groupId: DRAWING_GROUP_ID })
      const persisted = overlaysForInstrument(useKLDrawingStore.getState().overlaysByInstrument, inst)
      for (const p of persisted) {
        chart.createOverlay(hydrateOverlay(p, drawingCallbacks()))
      }
      onDrawingsChangeRef.current?.(persisted)
    } finally {
      suppressPersistRef.current = false
    }
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
    ensureDrawingOverlaysRegistered()
    ensureIndicatorsRegistered()
    ensureSessionBandOverlayRegistered()
    if (!containerRef.current) return
    const chart = init(containerRef.current, { timezone: 'America/New_York' })
    if (!chart) return
    chartRef.current = chart
    // Plain klinecharts built-in (Phase A3) -- just visualizes each bar's
    // own volume field, no derived calculation, so no VIZ_SPEC risk. LWC
    // shows volume unconditionally (no toggle); matched here the same way.
    chart.createIndicator('VOL', false)

    // Applies the current replay cursor (if any) to whichever bars are
    // handed in, feeds the chart, and reruns everything downstream of
    // "what's visible" -- shared by both the real-fetch path and the
    // cursor-reslice path below, so they can never drift apart.
    const respond = (bars: Bar[], callback: (data: KLineData[], more: { forward: boolean; backward: boolean }) => void) => {
      const visible = filterBarsForReplay(bars, cursorTimeRef.current)
      loadedBarsRef.current = visible
      setMeasureBarsContext(visible)
      callback(visible.map(toKLineData), { forward: false, backward: false })
      rebuildOverlaysRef.current()
      restoreDrawingsRef.current()
      rebuildIndicatorsRef.current()
      rebuildSessionOverlaysRef.current()
    }

    chart.setDataLoader({
      getBars: ({ type, callback }) => {
        const req = requestRef.current
        if (type !== 'init' || !req.instrument || req.from == null || req.to == null) {
          callback([], { forward: false, backward: false })
          return
        }
        // A replay cursor tick re-triggers this via resetData() (see the
        // cursorTime effect below) purely to reslice already-fetched data
        // -- the window (instrument/tf/from/to) hasn't changed, so re-
        // hitting the backend on every single replay step (multiple times
        // a second at high speed) would be both wasteful and pointless.
        // Only a genuine window change (different key) triggers a real
        // fetch; anything else replays from the cached full set.
        const key = `${req.instrument}|${req.timeframe}|${req.from}|${req.to}`
        if (lastFetchKeyRef.current === key && fullBarsRef.current.length > 0) {
          respond(fullBarsRef.current, callback)
          return
        }
        api
          .getBars({ instrument: req.instrument, tf: req.timeframe, from: req.from, to: req.to, max_points: 5000 })
          .then((bars) => {
            fullBarsRef.current = bars
            lastFetchKeyRef.current = key
            respond(bars, callback)
          })
          .catch(() => {
            fullBarsRef.current = []
            lastFetchKeyRef.current = null
            loadedBarsRef.current = []
            callback([], { forward: false, backward: false })
          })
      },
    })

    // Multi-chart sync output (Phase A5) -- resolves klinecharts' own
    // index-based visible range to THIS chart's own bar timestamps before
    // reporting it (see the prop's own comment for why raw indices can't
    // be hand to a sibling at a different timeframe). Indices aren't
    // guaranteed to fall inside the loaded data (scrolling past either
    // edge is normal chart behavior), so they're clamped defensively
    // rather than trusted as valid array positions.
    const handleVisibleRangeChange = (data?: unknown) => {
      const onChange = onVisibleRangeChangeRef.current
      if (!onChange) return
      const range = data as { from: number; to: number } | undefined
      const dataList = chart.getDataList()
      if (!range || dataList.length === 0) {
        onChange(null)
        return
      }
      const clamp = (i: number) => Math.max(0, Math.min(i, dataList.length - 1))
      const fromBar = dataList[clamp(range.from)]
      const toBar = dataList[clamp(range.to)]
      onChange({ from: fromBar.timestamp / 1000, to: toBar.timestamp / 1000 })
    }
    chart.subscribeAction('onVisibleRangeChange', handleVisibleRangeChange)

    return () => {
      chart.unsubscribeAction('onVisibleRangeChange', handleVisibleRangeChange)
      dispose(chart)
      chartRef.current = null
      loadedBarsRef.current = []
      fullBarsRef.current = []
      lastFetchKeyRef.current = null
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

  // Indicator data/toggle changed but the window didn't -- redraw against
  // the bars already loaded, same as the trades effect above.
  useEffect(() => {
    rebuildIndicatorsRef.current()
  }, [indicators, prefs])

  useEffect(() => {
    rebuildSessionOverlaysRef.current()
  }, [sessionBands, prefs])

  // Replay cursor moved (Phase A4): reslice the already-fetched bars
  // rather than treating it as a fresh window -- resetData() is v10's only
  // way to change what's on the chart (no direct setDataList), but the
  // DataLoader's own fetch-key cache (see the mount effect) turns this
  // into a synchronous local reslice, not a new backend round trip.
  useEffect(() => {
    withReadyChart(chartRef.current, fullBarsRef.current.length > 0, (chart) => {
      chart.resetData()
    })
  }, [cursorTime])

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
      startDrawing: (toolName) => {
        withReadyChart(chartRef.current, loadedBarsRef.current.length > 0, (chart) => {
          const tool = toolByName(toolName)
          if (!tool) return
          let extendData: string | undefined
          if (tool.promptsForText) {
            const text = window.prompt(`${tool.label} text:`)
            if (text === null) return
            extendData = text
          }
          const id = `kl-drawing-${crypto.randomUUID()}`
          activeDrawingIdRef.current = id
          chart.createOverlay({ id, name: toolName, groupId: DRAWING_GROUP_ID, extendData, ...drawingCallbacks() })
        })
      },
      cancelActiveDrawing: () => {
        const chart = chartRef.current
        const id = activeDrawingIdRef.current
        if (!chart || !id) return
        chart.removeOverlay({ id })
        activeDrawingIdRef.current = null
        // Explicit, not just relying on onRemoved: verified live that
        // removing a still-incomplete overlay (points placed < totalStep,
        // e.g. Escaping a 2-point Trend line after only the first click)
        // doesn't reliably fire onRemoved the way removing a completed one
        // does, which left a stale partial overlay in storage even though
        // the chart itself no longer showed it.
        persistDrawingsRef.current()
      },
      removeDrawing: (id) => {
        chartRef.current?.removeOverlay({ id })
        persistDrawingsRef.current()
      },
      clearDrawings: () => {
        const chart = chartRef.current
        if (!chart) return
        chart.removeOverlay({ groupId: DRAWING_GROUP_ID })
        persistDrawingsRef.current()
      },
    }),
    [],
  )

  return <div ref={containerRef} className="h-full w-full" />
})

export default ChartKL
