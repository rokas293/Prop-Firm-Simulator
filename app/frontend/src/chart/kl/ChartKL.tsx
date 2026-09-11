import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { dispose, init, type Chart, type KLineData, type OverlayCreate } from 'klinecharts'
import { fetchBarsInWorker } from '../../workers/barsWorkerClient'
import { findInstrument, pricePrecisionFromTick, tfToPeriod, tfToSeconds } from './instruments'
import {
  ENTRY_EXIT_GROUP,
  SL_TP_LINE_GROUP,
  ZONE_GROUP,
  buildEntryExitOverlays,
  buildSelectedTradeOverlays,
  buildTradeBracketOverlays,
  ensureTradeMarkerOverlayRegistered,
  ensureTradeZoneOverlayRegistered,
} from './tradeOverlays'
import { findBracketAt, formatBracketTooltip, type BracketDensity } from '../tradeBracket'
import { hexToRgba } from '../color'
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
  resolveIndicatorLineColor,
  setIndicatorContext,
} from './indicators'
import { INDICATOR_KEY_BY_NAME, buildIndicatorFeatures, type IndicatorFeatureId } from './indicatorLegend'
import {
  FAIR_VALUE_GROUP,
  SESSION_BAND_GROUP,
  buildFairValueOverlay,
  buildSessionBandOverlay,
  ensureSessionBandOverlayRegistered,
  type SessionBand,
} from './sessionOverlay'
import { useKLDrawingStore, overlaysForInstrument } from '../../state/klDrawingStore'
import { useThemeStore, useThemeBase, type ThemeColors, type ThemeBase } from '../../state/themeStore'
import { useIndicatorStore, type ColorableIndicatorKey, type IndicatorPrefs } from '../../state/indicatorStore'
import type { Bar, IndicatorPoint, TradeRecord } from '../../api/types'
import { filterBarsForReplay, filterTradesForReplay, type ReplayTradeView } from '../replay'
import { computeMeasure, formatDuration, type MeasurePoint, type MeasureResult } from '../measure'
import LoadingBar from '../../components/LoadingBar'
import Skeleton from '../../components/Skeleton'
import ContextMenu, { type ContextMenuEntry } from '../../components/ContextMenu'
import DrawingStylePopover from './DrawingStylePopover'
import IndicatorSettingsPopover from './IndicatorSettingsPopover'
import type { Side } from '../simBroker'

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
  // REPLICA_ROADMAP.md Batch 2's drawing manager -- per-item and bulk
  // hide/lock, plus "select" (frame the drawing on screen + a brief
  // highlight flash, reusing the same hover-highlight mechanism Batch 1's
  // context menu already relies on).
  toggleDrawingVisible: (id: string) => void
  toggleDrawingLock: (id: string) => void
  setAllDrawingsVisible: (visible: boolean) => void
  setAllDrawingsLocked: (locked: boolean) => void
  selectDrawing: (id: string) => void
  // Magnet/snap (Batch 2): when on, every point placed or dragged on a NEW
  // or EXISTING drawing snaps to the nearest OHLC value of the bar under
  // it -- klinecharts' own built-in overlay `mode` field (confirmed native
  // in v10.0.3's OverlayView._coordinateToPoint), not anything hand-rolled
  // here. Scoped to this chart instance only (see the prop's own comment).
  setMagnetMode: (on: boolean) => void
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
  // All-trades bracket density (PART_A_REVISED_klinecharts.md parity audit
  // -- ported from PriceChart.tsx's TradeBracketPrimitive/Brackets toolbar,
  // same store, same three modes). Optional/defaulted since ChartPanel's
  // secondary split-view chart doesn't show trade brackets at all.
  bracketDensity?: BracketDensity
  // Same LoadingBar contract as PriceChart.tsx's own `loading` prop --
  // ChartPanel passes its `isFetching` flag straight through.
  loading?: boolean
  // Replay cursor (PART_A_REVISED_klinecharts.md Phase A4, VIZ_SPEC §0: no
  // look-ahead). null = normal mode, everything visible. When set, bars
  // and trade overlays are clipped to time <= cursorTime -- same contract
  // as PriceChart.tsx's own cursorTime prop, same source value (ChartPanel
  // computes it once, feeds both engines).
  cursorTime?: number | null
  // "Follow latest bar" (REPLICA_ROADMAP.md Batch 1), default false --
  // when true, revealing a new bar via cursorTime nudges the camera just
  // enough to keep it in view; when false, stepping never touches the
  // camera at all. See the cursorTime effect below.
  followLatestBar?: boolean
  // Fires whenever the set of user drawings changes (placed, dragged,
  // removed, or restored on load) so the toolbar's manage dropdown can
  // show an up-to-date list without polling the chart instance itself.
  onDrawingsChange?: (overlays: PersistedOverlay[]) => void
  // Fires with the currently-armed tool's name, or null once it's placed/
  // cancelled -- lets KLDrawingToolbar highlight the active tool the same
  // way ChartPanel's timeframe buttons already do (DESIGN_AUDIT.md's chart-
  // workspace elevation: "accent only on the active tool"), without the
  // toolbar polling chart internals to know when a shape completes.
  onDrawingArmedChange?: (toolName: string | null) => void
  // Multi-chart sync output (Phase A5), fired on every user pan/zoom --
  // undefined in single-chart mode. klinecharts' own onVisibleRangeChange
  // action reports DATA-INDEX bounds (confirmed against the v10.0.3
  // source), not timestamps -- meaningless to hand to a sibling chart at a
  // DIFFERENT timeframe (index 50 on a 1min chart is a different moment
  // than index 50 on a 15min chart), so this resolves the indices to this
  // chart's own loaded bar timestamps first and reports THOSE.
  onVisibleRangeChange?: (range: { from: number; to: number } | null) => void
  // REPLICA_ROADMAP.md Batch 5's "click-to-set replay start" -- fires on
  // ANY plain click on a candle bar (klinecharts' own native
  // onCandleBarClick action, confirmed in the v10.0.3 source), regardless
  // of whether the caller is currently in "pick" mode. Deliberately not
  // gated in here: ChartPanel already knows whether it's armed and this
  // keeps ChartKL's side a plain, always-on passthrough, same shape as
  // onVisibleRangeChange/onDrawingsChange above rather than a stateful
  // arm/disarm round-trip through the imperative handle.
  onCandleBarClick?: (bar: { timestamp: number }) => void
  // Swaps the cursor to a crosshair over the candle pane while true -- the
  // "you're in pick mode" affordance for the click above. Purely visual;
  // has no effect on what actually happens on click (that's pickMode's
  // caller deciding whether to act on onCandleBarClick).
  pickMode?: boolean
  // FXR_SPEC.md phase F3: overrides the SELECTED trade's SL line color
  // (buildSelectedTradeOverlays' own default is colors.negative). The
  // manual-session workspace passes colors.warning (orange), matching
  // FXR_SPEC section B's "SL orange, TP green" convention -- the
  // automated-backtest review (ChartPanel) leaves this unset and keeps
  // its own already-shipped red SL line.
  slLineColor?: string
  // The "New Trade" drag ticket (FXR_SPEC.md section B), non-null while
  // armed: renders 3 draggable ghost lines (entry/SL/TP) at these prices.
  // Deliberately read only ONCE per arm/disarm transition (see the effect
  // this drives) -- ChartKL owns the actual drag, the caller owns what the
  // numbers MEAN (R:R, $ risk, auto-sized contracts); re-pushing a price
  // on every drag frame would fight the user's own drag.
  tradeTicket?: { entryPrice: number; slPrice: number; tpPrice: number } | null
  // Fires live as any one of the 3 ticket lines is dragged, with the
  // COMPLETE updated price set (not just the moved field) -- the caller's
  // R:R/risk/contracts readout recomputes from this on every frame.
  onTradeTicketChange?: (prices: { entryPrice: number; slPrice: number; tpPrice: number }) => void
  // A placed-but-not-yet-filled limit/stop order: a locked (non-draggable)
  // preview -- a dashed accent line at the order price, plus dashed
  // orange/green SL/TP preview lines if attached. Position management
  // (dragging to modify a WORKING order) is explicitly F4 scope, not F3's.
  workingOrderView?: { side: Side; price: number; slPrice: number | null; tpPrice: number | null } | null
  // Right-click on empty chart area (Batch 1's existing menu) -- returns
  // extra items to APPEND to the built-in Reset-view/Remove-drawings menu,
  // given the clicked price/time. Lets the session workspace extend the
  // SAME menu with order-placement actions without ChartKL itself knowing
  // anything about trading.
  getEmptyAreaMenuExtraItems?: (info: { time: number; price: number }) => ContextMenuEntry[]
}

// Matches Tailwind's default `font-sans` stack (index.css has no custom
// @font-face override -- DESIGN_LANGUAGE.md §3: "Inter or the system UI
// stack"), so canvas-rendered text (which can't read a CSS variable/class)
// reads as the same family as the surrounding DOM chrome.
const FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const INDICATOR_LABEL: Record<ColorableIndicatorKey, string> = {
  vwap: 'VWAP',
  ema20: 'EMA 20',
  ema50: 'EMA 50',
  atr14: 'ATR(14)',
}

// Theme/mode-changed effect (REDESIGN_APPROACH.md Part C1) recolors
// everything klinecharts renders that ISN'T a trade/session/drawing
// overlay (those rebuild fresh from `colors` on every change already, see
// rebuildOverlaysRef etc. below) -- candles, volume, grid, axis, and
// crosshair. klinecharts has no per-series color option (unlike Lightweight
// Charts' series.applyOptions), only this chart-wide setStyles(), so it's
// all set together here. compareRule: 'current_open' makes a candle's own
// color depend on ITS close vs ITS open (bullish/bearish within the bar) --
// the same convention Lightweight Charts' candlestick series uses -- rather
// than klinecharts' other option of comparing to the previous bar's close,
// which would visibly disagree with every other chart in the app on quiet,
// small-range bars. There is deliberately no "background" here: klinecharts'
// public Styles has no pane-background field at all (confirmed against the
// v10.0.3 type declarations) -- the canvas is transparent and the visible
// background is the container div's own CSS (bg-bg, set on the wrapper
// below), same as every other panel.
function themeStyles(colors: ThemeColors, base: ThemeBase) {
  return {
    grid: {
      horizontal: { color: base.grid },
      vertical: { color: base.grid },
    },
    candle: {
      bar: {
        compareRule: 'current_open' as const,
        upColor: colors.upCandle,
        downColor: colors.downCandle,
        noChangeColor: colors.upCandle,
        upBorderColor: colors.upCandle,
        downBorderColor: colors.downCandle,
        noChangeBorderColor: colors.upCandle,
        upWickColor: colors.upCandle,
        downWickColor: colors.downCandle,
        noChangeWickColor: colors.upCandle,
      },
    },
    indicator: {
      bars: [{ upColor: colors.upCandle, downColor: colors.downCandle, noChangeColor: colors.upCandle }],
      // The on-chart per-indicator legend row's typography (REPLICA_
      // ROADMAP.md Batch 3) -- klinecharts' own default is an unthemed
      // 'Helvetica Neue'/flat-gray (confirmed in the v10.0.3 source), which
      // doesn't track the app's theme tokens or DESIGN_LANGUAGE.md §3's
      // "one family, system UI stack" the rest of the app uses. showRule
      // is already 'always' by default (unchanged) -- only typography
      // needs setting here; the feature icons (settings/eye/remove/
      // reorder) are applied per-indicator in rebuildIndicatorsRef below,
      // not globally, since which icons apply differs by indicator kind.
      tooltip: {
        title: { color: base.textMuted, family: FONT_FAMILY },
        legend: { color: base.text, family: FONT_FAMILY },
      },
    },
    xAxis: {
      axisLine: { color: base.border },
      tickLine: { color: base.border },
      tickText: { color: base.textMuted },
    },
    yAxis: {
      axisLine: { color: base.border },
      tickLine: { color: base.border },
      tickText: { color: base.textMuted },
    },
    crosshair: {
      horizontal: { line: { color: base.textMuted }, text: { color: base.text, backgroundColor: base.surface } },
      vertical: { line: { color: base.textMuted }, text: { color: base.text, backgroundColor: base.surface } },
    },
    // The pane-divider line between the candle pane and VOL/ATR sub-panes.
    separator: { color: base.border },
    // Every user-drawn tool's DEFAULT appearance (Part A2's left toolbar --
    // trendlines, shapes, the measure tool, Fibonacci, annotations) --
    // confirmed none of them pass their own explicit `styles` at creation
    // (drawingOverlays.ts/ChartKL.tsx's startDrawing), so they all render
    // from this one global default. Previously never set at all, meaning
    // every drawing rendered in klinecharts' own unthemed built-in colors
    // regardless of theme (Part C3 audit gap #1) -- accent for strokes/
    // points (a legible, theme-following "pen" color, the same role accent
    // already plays as the trade entry-marker color in tradeOverlays.ts),
    // translucent accent for shape fills, body text color for labels.
    // Setting this is also what makes EXISTING un-styled drawings recolor
    // on a later theme change, not just new ones -- they have no per-
    // instance styles of their own to override this default with.
    overlay: {
      point: { color: colors.accent, borderColor: base.surface },
      line: { color: colors.accent },
      rect: { color: hexToRgba(colors.accent, 0.15), borderColor: colors.accent },
      polygon: { color: hexToRgba(colors.accent, 0.15), borderColor: colors.accent },
      circle: { color: hexToRgba(colors.accent, 0.15), borderColor: colors.accent },
      arc: { color: colors.accent },
      text: { color: base.text, backgroundColor: base.surface, borderColor: colors.accent },
    },
  }
}

// All four resolve through resolveIndicatorLineColor (indicators.ts): the
// user's own per-indicator color pick (REPLICA_ROADMAP.md Batch 3's
// on-chart legend "settings" swatch) if one exists, else the theme
// default -- VWAP tracks accent, ATR14 tracks textMuted (differs dark vs
// light), EMA20/EMA50 are fixed categorical defaults. Restyled via
// overrideIndicator rather than baked into the one-time registerIndicator
// call (indicators.ts), which only sets an initial placeholder. Safe to
// call even when an indicator isn't currently created -- overrideIndicator
// just returns false, confirmed from the v10.0.3 types.
function applyIndicatorColors(chart: Chart, colors: ThemeColors, base: ThemeBase): void {
  const keys: ColorableIndicatorKey[] = ['vwap', 'ema20', 'ema50', 'atr14']
  const names = { vwap: KL_VWAP, ema20: KL_EMA20, ema50: KL_EMA50, atr14: KL_ATR14 }
  for (const key of keys) {
    chart.overrideIndicator({ name: names[key], styles: { lines: [{ color: resolveIndicatorLineColor(key, colors, base) }] } })
  }
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

// The exact [leftTime, rightTime] (unix seconds) the candle pane is
// currently showing, via pixel->time conversion at both edges -- avoids
// reasoning about klinecharts' own internal bar-count/offset indexing
// entirely (see the cursorTime effect below, REPLICA_ROADMAP.md Batch 1's
// "free camera," for why that matters: resetData() rebuilds the whole data
// list on every replay step, so a bar INDEX captured before the rebuild
// doesn't necessarily mean the same thing after it, but a TIMESTAMP does).
function getVisibleTimeRange(chart: Chart): { leftTime: number; rightTime: number } | null {
  const width = chart.getSize()?.width
  if (!width) return null
  const [left, right] = chart.convertFromPixel([{ x: 0 }, { x: width }], { paneId: 'candle_pane' }) as Array<{
    timestamp?: number
  }>
  if (left?.timestamp === undefined || right?.timestamp === undefined) return null
  return { leftTime: left.timestamp / 1000, rightTime: right.timestamp / 1000 }
}

// The sole price-chart engine (PART_A_REVISED_klinecharts.md Phases A1-A5
// brought it to parity with, and then replaced, the old lightweight-charts
// PriceChart.tsx) -- trade-visual parity (A1), a full drawing toolbar on
// klinecharts' own overlay system (A2, replacing the old hand-built drawing
// engine entirely), backend-sourced indicators/session shading (A3), replay
// (A4), and multi-chart sync (A5).
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
    bracketDensity = 'auto',
    loading = false,
    cursorTime = null,
    followLatestBar = false,
    onDrawingsChange,
    onDrawingArmedChange,
    onVisibleRangeChange,
    onCandleBarClick,
    pickMode = false,
    slLineColor,
    tradeTicket = null,
    onTradeTicketChange,
    workingOrderView = null,
    getEmptyAreaMenuExtraItems,
  },
  ref,
) {
  const colors = useThemeStore((s) => s.colors)
  const base = useThemeBase()
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  // REPLICA_AUDIT.md Top 10 #7 -- Alt+drag measure, TradingView's own
  // ephemeral ruler gesture: no arming step (unlike the pre-existing
  // `klMeasure` drawing tool, which stays on the chart as a real overlay
  // once placed -- this leaves nothing behind). `anchor` is screen pixels +
  // the resolved time/price at mousedown; `current` is the live pixel
  // position while dragging, used only to draw the connecting line (the
  // actual measurement re-derives its own time/price from the SAME
  // convertFromPixel call onCrosshairChange already makes for the bracket
  // tooltip above, not from raw pixel deltas).
  const [measureDrag, setMeasureDrag] = useState<{
    anchor: { x: number; y: number }
    current: { x: number; y: number }
    result: MeasureResult
  } | null>(null)
  const measureAnchorRef = useRef<MeasurePoint | null>(null)
  // Right-click menus (REPLICA_ROADMAP.md Batch 1). `contextMenu` covers
  // both the empty-chart-area menu and a specific drawing's menu; `styleEditor`
  // is the color/width popover "Edit style" opens (a separate small state
  // rather than nesting it inside contextMenu, since picking a color
  // outlives the menu itself being open).
  const [contextMenu, setContextMenu] = useState<
    | { kind: 'empty'; x: number; y: number; time: number | null; price: number | null }
    | { kind: 'drawing'; x: number; y: number; id: string; name: string; locked: boolean }
    | null
  >(null)
  const [styleEditor, setStyleEditor] = useState<{ id: string; x: number; y: number } | null>(null)
  // Set synchronously inside a drawing overlay's onRightClick (fired from
  // klinecharts' own mousedown handling) -- read and cleared by the
  // native 'contextmenu' listener below, which fires slightly later (on
  // mouseup) for the SAME right-click. Lets one native listener tell
  // "this click hit a drawing, which already opened its own menu" apart
  // from "this click hit nothing, open the empty-area menu" without
  // threading chart hit-testing through two separate code paths.
  const rightClickHandledRef = useRef(false)
  // Captured original per-drawing style right before the hover-highlight
  // override touches it, so onMouseLeave can put back the EXACT value
  // (klinecharts' overrideOverlay deep-merges, so there's no "unset").
  const hoverSnapshotRef = useRef(new Map<string, OverlayCreate['styles']>())
  // First-paint gate for the full-canvas loading skeleton (DESIGN_AUDIT.md
  // C2): true forever once this ChartKL instance has shown real bars once,
  // so only the very first render of a freshly-mounted chart gets the full
  // skeleton -- every later reload (timeframe switch, trade switch) keeps
  // using the existing subtle LoadingBar sweep instead, which is the right
  // amount of interruption once the user has already seen the chart.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

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
  const followLatestBarRef = useRef(followLatestBar)
  followLatestBarRef.current = followLatestBar
  // The one overlay currently mid-placement (createOverlay was called but
  // the user hasn't finished clicking all its points yet), so Escape can
  // cancel it -- see cancelActiveDrawing below.
  const activeDrawingIdRef = useRef<string | null>(null)
  // Magnet/snap toggle (REPLICA_ROADMAP.md Batch 2), off by default --
  // read by startDrawing (new overlays are created with this mode already
  // set) and by setMagnetMode itself (which also retroactively overrides
  // every already-placed drawing, so dragging an existing point picks up
  // the current setting too). 'strong_magnet' snaps unconditionally to the
  // nearest OHLC value; klinecharts' 'weak_magnet' (snap only within a
  // pixel buffer near the high/low) isn't exposed here -- the roadmap asks
  // for one on/off toggle, not two snap strengths.
  const magnetModeRef = useRef<'normal' | 'strong_magnet'>('normal')
  // On-chart legend "hide/show" (REPLICA_ROADMAP.md Batch 3) -- a per-
  // indicator eye toggle, deliberately NOT stored in indicatorStore
  // (that's "is this indicator on at all", reused as-is for the legend's
  // "remove"). rebuildIndicatorsRef destroys+recreates every indicator on
  // any prefs/data/theme change (existing behavior, unchanged), which
  // would silently reset a native `visible:false` override each time --
  // this ref is what survives that and gets reapplied on every rebuild.
  const hiddenIndicatorsRef = useRef<Set<keyof IndicatorPrefs>>(new Set())
  // The most recent raw mouse position in PAGE coordinates, tracked via a
  // plain native listener on the container (below) -- klinecharts'
  // onIndicatorTooltipFeatureClick action reports WHICH indicator/icon was
  // clicked but no pixel coordinate (confirmed against the v10.0.3 source:
  // the action payload is just {paneId, indicator, feature}), so this is
  // what the settings popover uses to position itself near the click
  // instead. NOT klinecharts' own onCrosshairChange action -- confirmed
  // live that it only ever fires for the candle pane, never for a sub-pane
  // (VOL/ATR14), which is exactly where this is needed most.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const [indicatorSettings, setIndicatorSettings] = useState<{ key: ColorableIndicatorKey; x: number; y: number } | null>(null)
  const onDrawingsChangeRef = useRef(onDrawingsChange)
  onDrawingsChangeRef.current = onDrawingsChange
  const onDrawingArmedChangeRef = useRef(onDrawingArmedChange)
  onDrawingArmedChangeRef.current = onDrawingArmedChange
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange)
  onVisibleRangeChangeRef.current = onVisibleRangeChange
  const onCandleBarClickRef = useRef(onCandleBarClick)
  onCandleBarClickRef.current = onCandleBarClick

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
  const baseRef = useRef(base)
  baseRef.current = base
  const indicatorsRef = useRef(indicators)
  indicatorsRef.current = indicators
  const sessionBandsRef = useRef(sessionBands)
  sessionBandsRef.current = sessionBands
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const bracketDensityRef = useRef(bracketDensity)
  bracketDensityRef.current = bracketDensity
  const slLineColorRef = useRef(slLineColor)
  slLineColorRef.current = slLineColor

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
      const entryExit = buildEntryExitOverlays(views, selectedTradeRef.current?.trade_id ?? null, colorsRef.current)
      const selected = buildSelectedTradeOverlays(selectedView, colorsRef.current, slLineColorRef.current)
      // Per-trade on-screen width, for the density collapse threshold
      // (tradeBracket.ts's shouldSimplify) -- resolved here, not inside the
      // framework-free tradeOverlays.ts, since only the mounted chart
      // instance can convert a timestamp to a pixel coordinate. A trade
      // whose span has scrolled off either edge of the pane comes back
      // undefined from convertToPixel; treated as "can't measure it", so
      // it's skipped rather than guessed at (matches TradeBracketPrimitive
      // skipping items whose coordinates it can't resolve either).
      const widthPxFor = (view: ReplayTradeView) => {
        const bounds = { from: view.trade.entry_time, to: view.openSpanEnd }
        const [p1, p2] = chart.convertToPixel(
          [{ timestamp: bounds.from * 1000 }, { timestamp: bounds.to * 1000 }],
          { paneId: 'candle_pane' },
        ) as Array<{ x?: number }>
        if (p1?.x === undefined || p2?.x === undefined) return null
        return Math.abs(p2.x - p1.x)
      }
      const brackets = buildTradeBracketOverlays(
        views,
        selectedTradeRef.current?.trade_id ?? null,
        bracketDensityRef.current,
        widthPxFor,
        colorsRef.current,
      )
      if (entryExit.length > 0 || selected.length > 0 || brackets.length > 0) {
        chart.createOverlay([...entryExit, ...selected, ...brackets])
      }
    })
  }

  // Backend-sourced indicators (Phase A3) -- VWAP/EMA20/EMA50/ATR14 are
  // pass-through custom indicators (see indicators.ts's header comment for
  // why they're not klinecharts' own built-in EMA/ATR formulas).
  // setIndicatorContext() first so each indicator's calc sees the fresh
  // points the instant createIndicator triggers its first calc pass.
  // On-chart legend feature icons (REPLICA_ROADMAP.md Batch 3) -- called
  // once per rebuildIndicatorsRef run, right after (re)creating whichever
  // indicators are active, so every one gets a fresh createTooltipDataSource
  // reflecting the CURRENT hidden-state and reorder-eligibility. klinecharts
  // only honors a per-INDICATOR override of the tooltip's `features` array
  // via this callback (confirmed against the v10.0.3 source's
  // getIndicatorTooltipData -- the chart-wide styles.indicator.tooltip.
  // features is just the fallback default; createTooltipDataSource's own
  // return is what actually varies per indicator, which is exactly what's
  // needed here since VOL/ATR14 get reorder arrows and VWAP/EMA/ATR14 get
  // a settings swatch but VOL doesn't). name/calcParamsText/legends are
  // deliberately omitted from the returned object so klinecharts keeps
  // computing its own defaults (the whole point -- only the icon cluster
  // is custom). The public IndicatorTooltipData type marks those fields
  // required, but the runtime (isString/isValid guards, same source)
  // treats an absent field as "no override", NOT as "override with
  // nothing" -- returning legends: [] here would instead wipe the real
  // values, so the cast below is a deliberate, verified-safe mismatch
  // with the published (slightly over-strict) type, not a shortcut.
  const applyIndicatorLegendFeatures = (chart: Chart, p: IndicatorPrefs) => {
    const base = baseRef.current
    const color = base.textMuted
    const activeColor = base.text
    const hoverBg = hexToRgba(base.text, 0.08)

    const tooltipDataSource = (features: ReturnType<typeof buildIndicatorFeatures>) =>
      (() => ({ features })) as unknown as NonNullable<Parameters<Chart['overrideIndicator']>[0]['createTooltipDataSource']>

    const applyOne = (name: string, key: keyof IndicatorPrefs, showSettings: boolean, reorder: 'up' | 'down' | 'both' | 'none') => {
      const hidden = hiddenIndicatorsRef.current.has(key)
      chart.overrideIndicator({
        name,
        visible: !hidden,
        createTooltipDataSource: tooltipDataSource(buildIndicatorFeatures({ hidden, showSettings, reorder, color, activeColor, hoverBg })),
      })
    }

    if (p.vwap) applyOne(KL_VWAP, 'vwap', true, 'none')
    if (p.ema20) applyOne(KL_EMA20, 'ema20', true, 'none')
    if (p.ema50) applyOne(KL_EMA50, 'ema50', true, 'none')

    // Sub-panes (volume/ATR) additionally get reorder arrows, but only
    // when BOTH are on screen (reordering one pane against itself is
    // meaningless) -- direction is derived from each pane's CURRENT order
    // (not creation order), so it stays correct across repeated reorder
    // clicks: the topmost-on-screen pane can only move down, the bottom
    // one can only move up.
    //
    // klinecharts leaves EVERY new indicator pane's `order` at the same
    // default (confirmed live: both come back 0) and instead breaks the
    // tie by array-insertion/creation order internally -- so two tied
    // panes visually stack correctly on first paint, but a "swap this
    // pane's order with its sibling's" click would just be exchanging
    // 0 for 0, a no-op. Normalizing to distinct 0/1 values here (every
    // rebuild, idempotent once already distinct) is what gives the
    // reorder click below two actually-different numbers to swap.
    const subPanes: Array<{ name: string; key: 'volume' | 'atr14' }> = []
    if (p.volume) subPanes.push({ name: 'VOL', key: 'volume' })
    if (p.atr14) subPanes.push({ name: KL_ATR14, key: 'atr14' })
    const ordered = subPanes
      .map((e) => {
        const [ind] = chart.getIndicators({ name: e.name })
        const options = ind ? (chart.getPaneOptions(ind.paneId) as { order: number } | null) : null
        return { ...e, paneId: ind?.paneId, order: options?.order ?? 0 }
      })
      .sort((a, b) => a.order - b.order)
    ordered.forEach((entry, i) => {
      if (entry.paneId !== undefined && entry.order !== i) {
        chart.setPaneOptions({ id: entry.paneId, order: i })
      }
      const reorder: 'up' | 'down' | 'both' | 'none' = ordered.length < 2 ? 'none' : i === 0 ? 'down' : 'up'
      applyOne(entry.name, entry.key, entry.key === 'atr14', reorder)
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
      chart.removeIndicator({ name: 'VOL' })
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
      // VOL created first (matches its old mount-time-first behavior, now
      // gated by prefs.volume -- REPLICA_ROADMAP.md Batch 3 "remove sub-
      // panes" needed SOME toggle to remove it through), so its pane keeps
      // landing above ATR14's when both are on, same default stacking
      // every screenshot this whole project has shown so far.
      if (p.volume) chart.createIndicator('VOL', false)
      if (p.vwap) chart.createIndicator({ name: KL_VWAP, precision, paneId: 'candle_pane' }, true)
      if (p.ema20) chart.createIndicator({ name: KL_EMA20, precision, paneId: 'candle_pane' }, true)
      if (p.ema50) chart.createIndicator({ name: KL_EMA50, precision, paneId: 'candle_pane' }, true)
      if (p.atr14) chart.createIndicator({ name: KL_ATR14 }, false)
      applyIndicatorColors(chart, colorsRef.current, baseRef.current)
      applyIndicatorLegendFeatures(chart, p)
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
      serializeOverlay({
        id: o.id,
        name: o.name,
        points: o.points,
        // If this overlay is CURRENTLY showing the hover-highlight override
        // (REPLICA_ROADMAP.md Batch 1's own hover cue), save the style it
        // had BEFORE that, not the transient highlight -- otherwise any
        // persist that happens to land while still hovering (right-
        // clicking it to open this very menu, or ending a drag with the
        // mouse still over the now-moved line, which is the common case)
        // would permanently bake the highlight color/width in.
        styles: hoverSnapshotRef.current.has(o.id) ? hoverSnapshotRef.current.get(o.id) : (o.styles ?? undefined),
        extendData: o.extendData,
        lock: o.lock,
        visible: o.visible,
      }),
    )
    useKLDrawingStore.getState().setOverlaysForInstrument(inst, persisted)
    onDrawingsChangeRef.current?.(persisted)
  }

  // The hover-highlight override below (REPLICA_ROADMAP.md Batch 1: "add a
  // hover-highlight so it's clear what will be selected") -- a restrained
  // cue reusing the theme accent (DESIGN_LANGUAGE.md §1: "one accent"),
  // not a new color, plus a 1px thicker stroke/border so it reads even for
  // colorblind users. Shared by onMouseEnter below and DrawingStylePopover's
  // callers never need it directly.
  const hoverOverrideStyles = () => {
    const accent = colorsRef.current.accent
    return {
      line: { color: accent, size: 3 },
      point: { color: accent },
      rect: { borderColor: accent, borderSize: 2 },
      polygon: { borderColor: accent, borderSize: 2 },
      circle: { borderColor: accent, borderSize: 2 },
    }
  }

  // Reverts a drawing's live style back to whatever it was BEFORE the
  // hover-highlight override, if it's currently showing one -- shared by
  // onMouseLeave (the normal path) and onRightClick (opening this
  // drawing's menu is an implicit "the mouse is leaving it," since the
  // menu itself then sits on top of the canvas and swallows further
  // mousemove, so klinecharts would otherwise never see a real leave).
  // No-ops cleanly if this overlay isn't currently hover-highlighted.
  const clearHoverOverride = (id: string) => {
    const chart = chartRef.current
    if (!chart || !hoverSnapshotRef.current.has(id)) return
    const snapshot = hoverSnapshotRef.current.get(id)
    hoverSnapshotRef.current.delete(id)
    const accent = colorsRef.current.accent
    const s = snapshot as
      | { line?: { color?: string; size?: number }; point?: { color?: string }; rect?: { borderColor?: string; borderSize?: number }; polygon?: { borderColor?: string; borderSize?: number }; circle?: { borderColor?: string; borderSize?: number } }
      | undefined
    chart.overrideOverlay({
      id,
      styles: {
        line: { color: s?.line?.color ?? accent, size: s?.line?.size ?? 1 },
        point: { color: s?.point?.color ?? accent },
        rect: { borderColor: s?.rect?.borderColor ?? accent, borderSize: s?.rect?.borderSize ?? 1 },
        polygon: { borderColor: s?.polygon?.borderColor ?? accent, borderSize: s?.polygon?.borderSize ?? 1 },
        circle: { borderColor: s?.circle?.borderColor ?? accent, borderSize: s?.circle?.borderSize ?? 1 },
      },
    })
  }

  const drawingCallbacks = () => ({
    onDrawEnd: () => {
      activeDrawingIdRef.current = null
      onDrawingArmedChangeRef.current?.(null)
      persistDrawingsRef.current()
    },
    onPressedMoveEnd: () => {
      persistDrawingsRef.current()
    },
    onRemoved: () => {
      persistDrawingsRef.current()
    },
    // klinecharts' DEFAULT right-click behavior is to delete the overlay
    // outright unless prevented (confirmed against the v10.0.3 source --
    // undocumented) -- without this, right-clicking any drawing silently
    // deleted it. Prevented here, then opens this drawing's own menu
    // (REPLICA_ROADMAP.md Batch 1) using the SAME state the empty-area
    // menu uses, so only one menu is ever on screen.
    onRightClick: (event: { preventDefault?: () => void; pageX?: number; pageY?: number; overlay: { id: string; name: string; lock: boolean } }) => {
      event.preventDefault?.()
      rightClickHandledRef.current = true
      clearHoverOverride(event.overlay.id)
      setContextMenu({
        kind: 'drawing',
        x: event.pageX ?? 0,
        y: event.pageY ?? 0,
        id: event.overlay.id,
        name: event.overlay.name,
        locked: event.overlay.lock,
      })
    },
    onMouseEnter: (event: { overlay: { id: string } }) => {
      const chart = chartRef.current
      const id = event.overlay.id
      if (!chart || hoverSnapshotRef.current.has(id)) return
      const [current] = chart.getOverlays({ id })
      if (!current) return
      // structuredClone, not a bare reference: klinecharts' overrideOverlay
      // deep-merges INTO the overlay's existing styles object in place
      // (confirmed against the v10.0.3 source) -- storing the reference
      // itself meant the very next hover-override call (below) silently
      // corrupted this "before" snapshot too, since it was the same object.
      // Verified live: this produced a snapshot that was ALREADY the
      // hover-highlighted style, so "leaving" a drawing (or right-clicking
      // it to open its menu) restored the highlight instead of clearing
      // it, permanently baking the accent color/thicker stroke into
      // storage on the next persist.
      hoverSnapshotRef.current.set(id, current.styles ? structuredClone(current.styles) : undefined)
      chart.overrideOverlay({ id, styles: hoverOverrideStyles() })
    },
    onMouseLeave: (event: { overlay: { id: string } }) => clearHoverOverride(event.overlay.id),
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
    ensureTradeMarkerOverlayRegistered()
    ensureDrawingOverlaysRegistered()
    ensureIndicatorsRegistered()
    ensureSessionBandOverlayRegistered()
    if (!containerRef.current) return
    const chart = init(containerRef.current, { timezone: 'America/New_York' })
    if (!chart) return
    chartRef.current = chart
    chart.setStyles(themeStyles(colorsRef.current, baseRef.current))
    // VOL (a plain klinecharts built-in, Phase A3 -- just visualizes each
    // bar's own volume field, no derived calculation) used to be created
    // unconditionally right here. REPLICA_ROADMAP.md Batch 3 made it a
    // real on/off indicator like the other five (prefs.volume, gated in
    // rebuildIndicatorsRef below) so its sub-pane can be removed/reordered
    // through the same on-chart legend controls as VWAP/EMA/ATR14 -- the
    // respond() callback a few lines down calls rebuildIndicatorsRef on
    // every bars load, so it still ends up created on first paint exactly
    // as before, just no longer unconditionally.

    // Applies the current replay cursor (if any) to whichever bars are
    // handed in, feeds the chart, and reruns everything downstream of
    // "what's visible" -- shared by both the real-fetch path and the
    // cursor-reslice path below, so they can never drift apart.
    const respond = (bars: Bar[], callback: (data: KLineData[], more: { forward: boolean; backward: boolean }) => void) => {
      const visible = filterBarsForReplay(bars, cursorTimeRef.current)
      loadedBarsRef.current = visible
      setMeasureBarsContext(visible)
      setHasLoadedOnce(true)
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
        // Off the main thread (POLISH_ROADMAP Phase P4) -- this is the
        // hottest bars fetch in the app (every pan/zoom-triggered window
        // change, every timeframe/instrument switch), so it's the one most
        // worth moving the fetch+JSON.parse off-thread; measured live via
        // Chrome's Long Tasks API before this change (a timeframe-switch +
        // pan sequence blocked the main thread for ~755ms across 7 tasks,
        // one over 200ms) and after (see this phase's commit message for
        // the re-measured numbers).
        fetchBarsInWorker({ instrument: req.instrument, tf: req.timeframe, from: req.from, to: req.to, max_points: 5000 })
          .then((bars) => {
            fullBarsRef.current = bars
            lastFetchKeyRef.current = key
            respond(bars, callback)
          })
          .catch(() => {
            fullBarsRef.current = []
            lastFetchKeyRef.current = null
            loadedBarsRef.current = []
            // A definitive (if empty) answer -- don't leave the skeleton
            // showing forever over a failed fetch.
            setHasLoadedOnce(true)
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
    // Bracket widths are pixel-based (see widthPxFor above), so every pan/
    // zoom can flip a trade across the density threshold -- rebuild
    // whenever the visible range moves, not just when trades/colors/
    // density change.
    const handleVisibleRangeChangeForBrackets = () => rebuildOverlaysRef.current()
    chart.subscribeAction('onVisibleRangeChange', handleVisibleRangeChange)
    chart.subscribeAction('onVisibleRangeChange', handleVisibleRangeChangeForBrackets)

    // Bracket hover tooltip (PriceChart.tsx's bracketTooltipRef parity) --
    // onCrosshairChange gives a pixel position + timestamp directly;
    // convertFromPixel resolves the price at that same pixel so
    // findBracketAt (chart/tradeBracket.ts, framework-free) can hit-test
    // against the same bounds buildTradeBracketOverlays just drew.
    const handleCrosshairChange = (data?: unknown) => {
      const crosshair = data as { x?: number; y?: number; paneId?: string } | undefined
      if (!crosshair || crosshair.x === undefined || crosshair.y === undefined) {
        setTooltip(null)
        return
      }
      if (crosshair.paneId && crosshair.paneId !== 'candle_pane') {
        setTooltip(null)
        return
      }
      // The action payload's own `timestamp` field is unreliable (observed
      // live: absent from the emitted Crosshair object even though the
      // public type declares it) -- convertFromPixel resolves timestamp
      // AND price together from the same x/y, so it's used for both here
      // instead of trusting the action data's timestamp.
      const [point] = chart.convertFromPixel([{ x: crosshair.x, y: crosshair.y }], { paneId: 'candle_pane' }) as Array<{
        timestamp?: number
        value?: number
      }>
      if (point?.value === undefined || point?.timestamp === undefined) {
        setTooltip(null)
        return
      }
      if (measureAnchorRef.current) {
        const current: MeasurePoint = { time: point.timestamp / 1000, price: point.value }
        setMeasureDrag((prev) =>
          prev ? { anchor: prev.anchor, current: { x: crosshair.x!, y: crosshair.y! }, result: computeMeasure(measureAnchorRef.current!, current, loadedBarsRef.current) } : prev,
        )
      }
      const cursor = cursorTimeRef.current
      const views = filterTradesForReplay(tradesRef.current, cursor)
      const trade = findBracketAt(views, point.timestamp / 1000, point.value)
      setTooltip(trade ? { x: crosshair.x, y: crosshair.y, text: formatBracketTooltip(trade) } : null)
    }
    chart.subscribeAction('onCrosshairChange', handleCrosshairChange)

    // On-chart legend feature-icon clicks (REPLICA_ROADMAP.md Batch 3) --
    // one shared handler for every indicator's settings/eye/remove/reorder
    // icons (see applyIndicatorLegendFeatures above for how each
    // indicator's OWN feature set is built); this just dispatches by
    // feature id + indicator name.
    const handleIndicatorFeatureClick = (data?: unknown) => {
      const payload = data as
        | { indicator?: { name: string; paneId: string }; feature?: { id: string } }
        | undefined
      const name = payload?.indicator?.name
      const featureId = payload?.feature?.id as IndicatorFeatureId | undefined
      if (!name || !featureId) return
      const key = INDICATOR_KEY_BY_NAME[name]
      if (!key) return
      switch (featureId) {
        case 'ind-remove':
          useIndicatorStore.getState().toggle(key)
          break
        case 'ind-eye': {
          const hidden = hiddenIndicatorsRef.current
          if (hidden.has(key)) hidden.delete(key)
          else hidden.add(key)
          // Immediate, not waiting for an unrelated prefs/data change to
          // trigger the next rebuild -- reapplies visible + a freshly
          // glyph-swapped eye icon for every indicator right now.
          applyIndicatorLegendFeatures(chart, prefsRef.current)
          break
        }
        case 'ind-settings': {
          if (key === 'volume') break // no single line color to pick for volume's up/down bars
          const pointer = lastPointerRef.current
          if (!pointer) break
          setIndicatorSettings({ key: key as ColorableIndicatorKey, x: pointer.x, y: pointer.y })
          break
        }
        case 'ind-up':
        case 'ind-down': {
          // Only VOL/ATR14 ever get these two ids (see applyIndicatorLegendFeatures'
          // reorder logic) -- swap this pane's order with its one sibling
          // sub-pane, whichever that is.
          const siblingName = name === 'VOL' ? KL_ATR14 : 'VOL'
          const [thisInd] = chart.getIndicators({ name })
          const [siblingInd] = chart.getIndicators({ name: siblingName })
          if (!thisInd || !siblingInd) break
          const thisOptions = chart.getPaneOptions(thisInd.paneId) as { order: number } | null
          const siblingOptions = chart.getPaneOptions(siblingInd.paneId) as { order: number } | null
          if (!thisOptions || !siblingOptions) break
          // Snapshot both orders into plain numbers BEFORE mutating either --
          // getPaneOptions returns klinecharts' own LIVE options object by
          // reference (confirmed against the v10.0.3 source: DrawPane.
          // getOptions() returns `this._options` directly, and setOptions
          // merges into that SAME object), so reading `thisOptions.order`
          // AFTER the first setPaneOptions call below would already see the
          // just-written new value, not the original -- turning this into a
          // no-op (both panes end up with the SAME order) instead of a swap.
          const thisOrder = thisOptions.order
          const siblingOrder = siblingOptions.order
          chart.setPaneOptions({ id: thisInd.paneId, order: siblingOrder })
          chart.setPaneOptions({ id: siblingInd.paneId, order: thisOrder })
          // Re-derive which pane now shows "up" vs "down" for the new order.
          applyIndicatorLegendFeatures(chart, prefsRef.current)
          break
        }
      }
    }
    chart.subscribeAction('onIndicatorTooltipFeatureClick', handleIndicatorFeatureClick)

    // Click-to-set-replay-start (REPLICA_ROADMAP.md Batch 5) -- a plain
    // passthrough of klinecharts' own native onCandleBarClick action (data
    // shape confirmed against the v10.0.3 source: {dataIndex, data:
    // {current, prev, next}, ...}); ChartPanel decides whether it's
    // currently in "pick" mode, this file doesn't need to know.
    const handleCandleBarClick = (data?: unknown) => {
      const payload = data as { data?: { current?: { timestamp?: number } | null } } | undefined
      const timestamp = payload?.data?.current?.timestamp
      if (timestamp === undefined) return
      onCandleBarClickRef.current?.({ timestamp })
    }
    chart.subscribeAction('onCandleBarClick', handleCandleBarClick)

    // Right-click empty chart area -> "Reset chart view" / "Remove all
    // drawings" (REPLICA_ROADMAP.md Batch 1). klinecharts already calls
    // preventDefault on 'contextmenu' for its OWN target internally (so the
    // native browser menu never shows over the chart), but that's a
    // separate native event from the drawing-hit onRightClick above --
    // both fire for the SAME right-click (mousedown, then this, on
    // mouseup), in that order, which is what makes the ref-flag handoff
    // below reliable: if a drawing's onRightClick already ran (and opened
    // ITS menu), skip; otherwise this click hit nothing, so open the
    // empty-area menu here.
    const container = containerRef.current
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      if (rightClickHandledRef.current) {
        rightClickHandledRef.current = false
        return
      }
      // FXR_SPEC.md phase F3: resolve the clicked price/time too (same
      // convertFromPixel call the Alt+drag measure gesture already makes),
      // so getEmptyAreaMenuExtraItems can offer order-placement actions AT
      // this exact level -- null if this landed outside the candle pane
      // (an axis, a sub-pane), where "place an order here" is meaningless.
      let time: number | null = null
      let price: number | null = null
      if (container) {
        const rect = container.getBoundingClientRect()
        const [point] = chart.convertFromPixel(
          [{ x: e.clientX - rect.left, y: e.clientY - rect.top }],
          { paneId: 'candle_pane' },
        ) as Array<{ timestamp?: number; value?: number }>
        if (point?.timestamp !== undefined && point?.value !== undefined) {
          time = point.timestamp / 1000
          price = point.value
        }
      }
      setContextMenu({ kind: 'empty', x: e.clientX, y: e.clientY, time, price })
    }
    container?.addEventListener('contextmenu', handleContextMenu)

    // Plain page-coordinate mouse tracking for the settings popover (see
    // lastPointerRef's own comment) -- covers the WHOLE chart (candle pane,
    // every sub-pane, axes), unlike klinecharts' own crosshair action.
    const handlePointerMove = (e: MouseEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY }
    }
    container?.addEventListener('mousemove', handlePointerMove)

    // Alt+drag measure (REPLICA_AUDIT.md Top 10 #7) -- TradingView's own
    // ephemeral ruler gesture, no arming step (unlike the pre-existing
    // `klMeasure` drawing tool below, which stays on the chart as a real
    // overlay once placed). Registered with capture: true so a qualifying
    // press never reaches klinecharts' OWN mousedown handling at all --
    // klinecharts starts its pan/zoom drag from that same event, and
    // there's no public API to suppress just that for one press without
    // disabling pan for every other one. Confirmed live: with the initial
    // mousedown never seen by klinecharts, it treats the subsequent
    // mousemoves as plain hover (same as with no button held), so
    // onCrosshairChange below keeps firing normally through the whole drag
    // instead of klinecharts entering its own pan state.
    const handleMeasureMouseDown = (e: MouseEvent) => {
      if (!e.altKey || e.button !== 0 || !container) return
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const [point] = chart.convertFromPixel([{ x, y }], { paneId: 'candle_pane' }) as Array<{
        timestamp?: number
        value?: number
      }>
      if (point?.value === undefined || point?.timestamp === undefined) return
      e.preventDefault()
      e.stopPropagation()
      const anchor: MeasurePoint = { time: point.timestamp / 1000, price: point.value }
      measureAnchorRef.current = anchor
      setMeasureDrag({ anchor: { x, y }, current: { x, y }, result: computeMeasure(anchor, anchor, loadedBarsRef.current) })
    }
    container?.addEventListener('mousedown', handleMeasureMouseDown, true)

    // Window, not container -- a real drag routinely ends with the pointer
    // outside the chart pane (or even outside the browser window), and a
    // mouseup there must still clear the readout.
    const handleMeasureMouseUp = () => {
      if (!measureAnchorRef.current) return
      measureAnchorRef.current = null
      setMeasureDrag(null)
    }
    window.addEventListener('mouseup', handleMeasureMouseUp)

    // Axis interaction (REPLICA_ROADMAP.md Batch 2): drag-to-scale on both
    // axes, and double-click the Y axis to auto-reset, are klinecharts'
    // OWN native behavior (confirmed against the v10.0.3 source --
    // AxisImp.scrollZoomEnabled defaults to true, and Event.
    // mouseDoubleClickEvent already resets the Y axis's autoCalcTickFlag on
    // a Y-axis double-click) -- nothing to wire up for those. There is NO
    // equivalent native double-click handler for the X axis (its
    // mouseDoubleClickEvent switch only handles the MAIN and Y_AXIS widget
    // cases), so that one gap is filled here, reusing the exact same
    // "reset chart view" resetView() the empty-area right-click menu
    // already calls. 'x_axis_pane' is klinecharts' own internal pane id
    // (PaneIdConstants.X_AXIS in the source) -- used the same way
    // 'candle_pane' already is elsewhere in this file, as a plain string
    // literal rather than an import, since neither is exported as a named
    // constant from the package's public API.
    //
    // Deliberately NOT a native 'dblclick' listener: klinecharts' own
    // event layer doesn't rely on the browser's synthesized 'dblclick'
    // event either (see its EventHandlerImp source -- it double-click-
    // detects off raw mousedown/mouseup timing+distance itself, which is
    // exactly what this mirrors, at the same 500ms/manhattan-distance
    // shape). Confirmed live that headless Chrome via CDP (as used by this
    // project's own puppeteer verification) never actually synthesizes a
    // native 'dblclick' DOM event from two dispatched mousedown/mouseup
    // pairs -- reproduced even on a bare, library-free <div> -- so a plain
    // addEventListener('dblclick', ...) would have been both untestable
    // AND a real risk of the same flakiness in whatever real browser
    // quirk that CDP behavior is standing in for.
    const xAxisDom = chart.getDom('x_axis_pane', 'root')
    let lastXAxisClickAt = 0
    let lastXAxisClickX = 0
    const handleXAxisClick = (e: MouseEvent) => {
      const now = performance.now()
      if (now - lastXAxisClickAt < 400 && Math.abs(e.clientX - lastXAxisClickX) < 6) {
        resetView()
        lastXAxisClickAt = 0
        return
      }
      lastXAxisClickAt = now
      lastXAxisClickX = e.clientX
    }
    xAxisDom?.addEventListener('click', handleXAxisClick)

    return () => {
      chart.unsubscribeAction('onVisibleRangeChange', handleVisibleRangeChange)
      chart.unsubscribeAction('onVisibleRangeChange', handleVisibleRangeChangeForBrackets)
      chart.unsubscribeAction('onCrosshairChange', handleCrosshairChange)
      chart.unsubscribeAction('onIndicatorTooltipFeatureClick', handleIndicatorFeatureClick)
      chart.unsubscribeAction('onCandleBarClick', handleCandleBarClick)
      container?.removeEventListener('contextmenu', handleContextMenu)
      container?.removeEventListener('mousemove', handlePointerMove)
      container?.removeEventListener('mousedown', handleMeasureMouseDown, true)
      window.removeEventListener('mouseup', handleMeasureMouseUp)
      xAxisDom?.removeEventListener('click', handleXAxisClick)
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

  // Trades/selection/theme/density changed but the window didn't (e.g.
  // picking a different already-visible trade, a theme switch, or toggling
  // the Brackets density button) -- no refetch needed, just redraw the
  // overlays against the bars already loaded.
  useEffect(() => {
    rebuildOverlaysRef.current()
  }, [trades, selectedTrade, colors, bracketDensity, slLineColor])

  // Theme/mode switch (REDESIGN_APPROACH.md Part C1) -- recolor the
  // candles/volume/grid/axis/crosshair too, not just the trade overlays
  // above, and restyle the two theme-tracking indicator lines. Safe to call
  // before data loads (setStyles/overrideIndicator don't touch data),
  // unlike the withReadyChart-guarded calls elsewhere in this file.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setStyles(themeStyles(colors, base))
    applyIndicatorColors(chart, colors, base)
  }, [colors, base])

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
  //
  // REPLICA_ROADMAP.md Batch 1 ("free camera"): resetData()'s 'init'
  // reload unconditionally recomputes the scroll offset from a FIXED
  // right-side pixel distance (confirmed against the v10.0.3 source --
  // setOffsetRightDistance(this._offsetRightDistance) runs on every init
  // load, independent of how far the user had panned), which is exactly
  // why the camera used to snap back to the right edge on every step. The
  // fix captures/restores the visible range in TIME, not klinecharts' own
  // bar-index space (getVisibleTimeRange above) -- resetData() rebuilds
  // the whole data list every tick, so an index captured before doesn't
  // reliably mean the same thing after, but a timestamp does. Zoom
  // (barSpace) is untouched by resetData() itself, so only scroll needs
  // restoring. respond() (the mount effect's DataLoader) runs synchronously
  // for a replay tick (same window, cache hit), so loadedBarsRef.current
  // already reflects the new cursor by the time resetData() returns.
  useEffect(() => {
    withReadyChart(chartRef.current, fullBarsRef.current.length > 0, (chart) => {
      const before = getVisibleTimeRange(chart)
      chart.resetData()
      if (!before) return
      const centerTime = (before.leftTime + before.rightTime) / 2
      const newLastBarTime = loadedBarsRef.current[loadedBarsRef.current.length - 1]?.time
      // Follow ON and the newly-revealed bar would land off the right
      // edge: nudge just enough to bring it into view -- never a hard
      // recenter, and no-op (falls through to the plain restore below)
      // for a backward step, since an earlier bar is never past the old
      // right edge.
      if (followLatestBarRef.current && newLastBarTime !== undefined && newLastBarTime > before.rightTime) {
        chart.scrollToTimestamp((centerTime + (newLastBarTime - before.rightTime)) * 1000, 0)
      } else {
        // Follow OFF (or nothing new past the edge): put the camera back
        // exactly where the user left it -- stepping must never move it.
        chart.scrollToTimestamp(centerTime * 1000, 0)
      }
    })
  }, [cursorTime])

  // FXR_SPEC.md phase F3's "New Trade" drag ticket: 3 draggable ghost
  // lines (entry/SL/TP), created ONCE per arm/disarm transition -- keyed
  // on `tradeTicketActive`'s boolean flip, NOT the live prices themselves.
  // Re-creating the overlays on every drag frame (if this depended on the
  // prices) would fight the user's own in-progress drag, since klinecharts
  // already owns the line's visual position for the rest of that gesture;
  // the ARMING prices are read once via a ref for exactly that reason.
  // Confirming or cancelling sets tradeTicket back to null, which tears
  // these down via the cleanup below.
  const TICKET_GROUP_ID = 'kl-trade-ticket'
  const tradeTicketRef = useRef(tradeTicket)
  tradeTicketRef.current = tradeTicket
  const onTradeTicketChangeRef = useRef(onTradeTicketChange)
  onTradeTicketChangeRef.current = onTradeTicketChange
  const tradeTicketActive = tradeTicket !== null

  useEffect(() => {
    const chart = chartRef.current
    const initial = tradeTicketRef.current
    if (!chart || !tradeTicketActive || !initial) return
    const anchorMs = (cursorTimeRef.current ?? 0) * 1000

    const makeLine = (id: string, price: number, color: string, field: 'entryPrice' | 'slPrice' | 'tpPrice'): OverlayCreate => ({
      id,
      name: 'horizontalStraightLine',
      groupId: TICKET_GROUP_ID,
      lock: false,
      points: [{ timestamp: anchorMs, value: price }],
      styles: { line: { color, style: 'dashed', size: 2 } },
      onPressedMoving: (event) => {
        const newPrice = event.overlay.points[0]?.value
        const current = tradeTicketRef.current
        if (typeof newPrice !== 'number' || !current) return
        onTradeTicketChangeRef.current?.({ ...current, [field]: newPrice })
      },
    })

    chart.createOverlay([
      makeLine('kl-ticket-entry', initial.entryPrice, colorsRef.current.accent, 'entryPrice'),
      makeLine('kl-ticket-sl', initial.slPrice, baseRef.current.warning, 'slPrice'),
      makeLine('kl-ticket-tp', initial.tpPrice, colorsRef.current.positive, 'tpPrice'),
    ])

    return () => {
      chart.removeOverlay({ groupId: TICKET_GROUP_ID })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeTicketActive])

  // A placed-but-not-yet-filled limit/stop order: a LOCKED preview, unlike
  // the ticket above -- dragging to modify a WORKING order is explicitly
  // F4 scope ("position management"), not F3's, so this just reacts to
  // whatever values it's given, no drag-fighting concern.
  const WORKING_ORDER_GROUP_ID = 'kl-working-order'
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !workingOrderView) return
    const anchorMs = (cursorTimeRef.current ?? 0) * 1000
    const line = (id: string, price: number, color: string): OverlayCreate => ({
      id,
      name: 'horizontalStraightLine',
      groupId: WORKING_ORDER_GROUP_ID,
      lock: true,
      points: [{ timestamp: anchorMs, value: price }],
      styles: { line: { color, style: 'dashed', size: 1 } },
    })
    const overlays: OverlayCreate[] = [line('kl-working-order-entry', workingOrderView.price, colorsRef.current.accent)]
    if (workingOrderView.slPrice !== null) {
      overlays.push(line('kl-working-order-sl', workingOrderView.slPrice, baseRef.current.warning))
    }
    if (workingOrderView.tpPrice !== null) {
      overlays.push(line('kl-working-order-tp', workingOrderView.tpPrice, colorsRef.current.positive))
    }
    chart.createOverlay(overlays)
    return () => {
      chart.removeOverlay({ groupId: WORKING_ORDER_GROUP_ID })
    }
  }, [workingOrderView?.price, workingOrderView?.slPrice, workingOrderView?.tpPrice, workingOrderView?.side])

  // Shared by the imperative fitRange handle AND the empty-area menu's
  // "Reset chart view" (which calls it with the full loaded window).
  const fitRangeImpl = (from: number, to: number) => {
    withReadyChart(chartRef.current, loadedBarsRef.current.length > 0, (chart) => {
      const seconds = tfToSeconds(requestRef.current.timeframe)
      const width = chart.getSize()?.width
      if (!seconds || !width) return
      const barCount = Math.max(1, (to - from) / seconds)
      // setBarSpace (the zoom step) has no animation/duration parameter in
      // klinecharts' public API -- confirmed against the v10.0.3 type
      // declarations, so only the pan (scrollToTimestamp) half of "fit
      // trade" can ease. Still a real improvement over the previous
      // duration:0 (an instant snap on both axes) -- matches
      // scrollToTrade's own 200ms below, so a trade-list click and an "F"
      // fit-trade press feel like the same motion (POLISH_ROADMAP Phase
      // P6: "subtle easing on fit trade/scroll-to-trade").
      chart.setBarSpace(width / barCount)
      chart.scrollToTimestamp(((from + to) / 2) * 1000, 200)
    })
  }

  // Empty-area context menu actions (REPLICA_ROADMAP.md Batch 1).
  const resetView = () => {
    const bars = loadedBarsRef.current
    if (bars.length === 0) return
    fitRangeImpl(bars[0].time, bars[bars.length - 1].time)
  }
  const drawingCount = () => chartRef.current?.getOverlays({ groupId: DRAWING_GROUP_ID }).length ?? 0
  const removeAllDrawings = () => {
    const count = drawingCount()
    if (count === 0) return
    // "confirm if there are many" -- a handful of accidental single-
    // drawing deletes are a Ctrl/Cmd+Z away from painless (well, not
    // undoable here, but cheap to redraw); wiping out a dozen isn't.
    if (count > 5 && !window.confirm(`Remove all ${count} drawings? This can't be undone.`)) return
    chartRef.current?.removeOverlay({ groupId: DRAWING_GROUP_ID })
    persistDrawingsRef.current()
  }

  // Per-drawing context menu actions.
  const deleteDrawing = (id: string) => {
    chartRef.current?.removeOverlay({ id })
    persistDrawingsRef.current()
  }
  const cloneDrawing = (id: string) => {
    const chart = chartRef.current
    if (!chart) return
    const [orig] = chart.getOverlays({ id })
    if (!orig) return
    // Offset every point's PRICE by a small % of its own value (scale-safe
    // across instruments, same trick tradeOverlays.ts used to use for
    // marker padding) so the clone doesn't render exactly on top of the
    // original -- TIME can't shift this generically without knowing the
    // chart's current bar spacing.
    const offsetPoints = orig.points.map((p) =>
      typeof p.value === 'number' ? { ...p, value: p.value + (Math.abs(p.value) * 0.004 || 0.01) } : { ...p },
    )
    chart.createOverlay({
      id: `kl-drawing-${crypto.randomUUID()}`,
      name: orig.name,
      groupId: DRAWING_GROUP_ID,
      points: offsetPoints,
      styles: orig.styles ?? undefined,
      extendData: orig.extendData,
      lock: orig.lock,
      ...drawingCallbacks(),
    })
    persistDrawingsRef.current()
  }
  const toggleDrawingLock = (id: string) => {
    const chart = chartRef.current
    if (!chart) return
    const [orig] = chart.getOverlays({ id })
    if (!orig) return
    chart.overrideOverlay({ id, lock: !orig.lock })
    persistDrawingsRef.current()
  }

  // Drawing manager (REPLICA_ROADMAP.md Batch 2) -- per-item hide, plus the
  // "hide all"/"lock all" bulk actions. `visible` is a real klinecharts
  // Overlay field (confirmed in the v10.0.3 public types), so this is a
  // thin overrideOverlay wrapper, same shape as toggleDrawingLock above.
  const toggleDrawingVisible = (id: string) => {
    const chart = chartRef.current
    if (!chart) return
    const [orig] = chart.getOverlays({ id })
    if (!orig) return
    chart.overrideOverlay({ id, visible: !orig.visible })
    persistDrawingsRef.current()
  }
  const setAllDrawingsVisible = (visible: boolean) => {
    const chart = chartRef.current
    if (!chart) return
    for (const o of chart.getOverlays({ groupId: DRAWING_GROUP_ID })) {
      chart.overrideOverlay({ id: o.id, visible })
    }
    persistDrawingsRef.current()
  }
  const setAllDrawingsLocked = (locked: boolean) => {
    const chart = chartRef.current
    if (!chart) return
    for (const o of chart.getOverlays({ groupId: DRAWING_GROUP_ID })) {
      chart.overrideOverlay({ id: o.id, lock: locked })
    }
    persistDrawingsRef.current()
  }
  // "Select" a drawing from the manager list: frame it on screen (center
  // the chart's time axis on its own point range -- the Y axis needs no
  // help, it already auto-fits whatever's visible unless the user manually
  // scaled it, same as clicking a trade in the Trade List) and flash the
  // SAME hover-highlight Batch 1 already uses for mouse-hover, so there's
  // only one "this is the drawing you mean" visual language in the app,
  // not two. Reuses hoverSnapshotRef/hoverOverrideStyles/clearHoverOverride
  // as-is; a bare setTimeout is enough here (no cleanup-on-unmount worry --
  // clearHoverOverride is itself a no-op if the drawing/chart is gone by
  // the time it fires).
  const selectDrawing = (id: string) => {
    const chart = chartRef.current
    if (!chart) return
    const [o] = chart.getOverlays({ id })
    if (!o) return
    const times = o.points.map((p) => p.timestamp).filter((t): t is number => typeof t === 'number')
    if (times.length > 0) {
      chart.scrollToTimestamp(((Math.min(...times) + Math.max(...times)) / 2), 200)
    }
    if (!hoverSnapshotRef.current.has(id)) {
      hoverSnapshotRef.current.set(id, o.styles ? structuredClone(o.styles) : undefined)
      chart.overrideOverlay({ id, styles: hoverOverrideStyles() })
      window.setTimeout(() => clearHoverOverride(id), 900)
    }
  }
  const updateDrawingColor = (id: string, hex: string) => {
    const chart = chartRef.current
    if (!chart) return
    chart.overrideOverlay({
      id,
      styles: { line: { color: hex }, point: { color: hex }, rect: { borderColor: hex }, polygon: { borderColor: hex }, circle: { borderColor: hex }, text: { color: hex } },
    })
    persistDrawingsRef.current()
  }
  const updateDrawingWidth = (id: string, size: number) => {
    const chart = chartRef.current
    if (!chart) return
    chart.overrideOverlay({ id, styles: { line: { size } } })
    persistDrawingsRef.current()
  }

  // On-chart legend "settings" swatch (REPLICA_ROADMAP.md Batch 3) --
  // applies immediately (so the click feels instant, same as every other
  // popover in this file) AND persists to indicatorStore so the pick
  // survives the next rebuildIndicatorsRef (theme switch, timeframe
  // change, toggling an unrelated indicator all fully recreate every
  // indicator -- see that function's own comment).
  const KL_NAME_BY_COLORABLE_KEY: Record<ColorableIndicatorKey, string> = {
    vwap: KL_VWAP,
    ema20: KL_EMA20,
    ema50: KL_EMA50,
    atr14: KL_ATR14,
  }
  const updateIndicatorColor = (key: ColorableIndicatorKey, hex: string) => {
    const chart = chartRef.current
    if (!chart) return
    chart.overrideIndicator({ name: KL_NAME_BY_COLORABLE_KEY[key], styles: { lines: [{ color: hex }] } })
    useIndicatorStore.getState().setIndicatorColor(key, hex)
  }

  useImperativeHandle(
    ref,
    () => ({
      fitRange: fitRangeImpl,
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
          onDrawingArmedChangeRef.current?.(toolName)
          chart.createOverlay({
            id,
            name: toolName,
            groupId: DRAWING_GROUP_ID,
            extendData,
            mode: magnetModeRef.current,
            ...drawingCallbacks(),
          })
        })
      },
      cancelActiveDrawing: () => {
        const chart = chartRef.current
        const id = activeDrawingIdRef.current
        if (!chart || !id) return
        chart.removeOverlay({ id })
        activeDrawingIdRef.current = null
        onDrawingArmedChangeRef.current?.(null)
        // Explicit, not just relying on onRemoved: verified live that
        // removing a still-incomplete overlay (points placed < totalStep,
        // e.g. Escaping a 2-point Trend line after only the first click)
        // doesn't reliably fire onRemoved the way removing a completed one
        // does, which left a stale partial overlay in storage even though
        // the chart itself no longer showed it.
        persistDrawingsRef.current()
      },
      removeDrawing: deleteDrawing,
      clearDrawings: () => {
        const chart = chartRef.current
        if (!chart) return
        chart.removeOverlay({ groupId: DRAWING_GROUP_ID })
        persistDrawingsRef.current()
      },
      toggleDrawingVisible,
      toggleDrawingLock,
      setAllDrawingsVisible,
      setAllDrawingsLocked,
      selectDrawing,
      setMagnetMode: (on) => {
        magnetModeRef.current = on ? 'strong_magnet' : 'normal'
        const chart = chartRef.current
        if (!chart) return
        for (const o of chart.getOverlays({ groupId: DRAWING_GROUP_ID })) {
          chart.overrideOverlay({ id: o.id, mode: magnetModeRef.current })
        }
      },
    }),
    [],
  )

  return (
    <div className="relative h-full w-full bg-bg">
      <LoadingBar active={loading} />
      <div ref={containerRef} className={`h-full w-full ${pickMode ? 'cursor-crosshair' : ''}`} />
      {/* First-paint skeleton (DESIGN_AUDIT.md C2): klinecharts needs
          containerRef mounted from the start to call init() against, so
          this overlays the (still-blank) canvas rather than replacing it
          the way a plain "loading ? <Skeleton/> : <content/>" panel would.
          Shaped roughly like the real layout -- a thin readout-line
          skeleton, the big candle-pane skeleton, a short volume-pane
          skeleton -- rather than a bare blank grid or a spinner. */}
      {!hasLoadedOnce && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col gap-2 bg-bg p-3">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="min-h-0 flex-1" />
          <Skeleton className="h-16" />
        </div>
      )}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 whitespace-pre rounded border border-border bg-surface/95 px-2 py-1 text-xs tabular-nums text-text shadow-lg"
          style={{ left: Math.min(tooltip.x + 12, (containerRef.current?.clientWidth ?? 0) - 180), top: Math.max(tooltip.y - 12, 0) }}
        >
          {tooltip.text}
        </div>
      )}
      {/* Alt+drag measure readout (REPLICA_AUDIT.md Top 10 #7) -- same
          floating-box shell/shadow as the bracket tooltip above for one
          consistent "on-demand chrome" look, plus a thin dashed guide line
          so it's clear WHERE the two points being compared are. Both are
          plain DOM/SVG on top of the canvas, not a klinecharts overlay --
          nothing is added to the chart's data model, so there's nothing to
          clean up beyond clearing this state on mouseup. */}
      {measureDrag && (
        <>
          <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible">
            <line
              x1={measureDrag.anchor.x}
              y1={measureDrag.anchor.y}
              x2={measureDrag.current.x}
              y2={measureDrag.current.y}
              stroke={base.textMuted}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <circle cx={measureDrag.anchor.x} cy={measureDrag.anchor.y} r={3} fill={base.textMuted} />
            <circle cx={measureDrag.current.x} cy={measureDrag.current.y} r={3} fill={base.textMuted} />
          </svg>
          <div
            className="pointer-events-none absolute z-20 whitespace-nowrap rounded border border-border bg-surface/95 px-2 py-2 shadow-lg"
            style={{
              left: Math.min(measureDrag.current.x + 14, (containerRef.current?.clientWidth ?? 0) - 160),
              top: Math.max(measureDrag.current.y - 14, 0),
            }}
          >
            <span className={`text-xs font-medium tabular-nums ${measureDrag.result.points >= 0 ? 'text-positive' : 'text-negative'}`}>
              {measureDrag.result.points >= 0 ? '+' : ''}
              {measureDrag.result.points.toFixed(2)} ({measureDrag.result.percent >= 0 ? '+' : ''}
              {measureDrag.result.percent.toFixed(2)}%)
            </span>
            <div className="mt-0.5 text-[11px] tabular-nums text-text-muted">
              {measureDrag.result.bars} bars &middot; {formatDuration(measureDrag.result.seconds)}
            </div>
          </div>
        </>
      )}
      {contextMenu?.kind === 'empty' && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label="Chart"
          onClose={() => setContextMenu(null)}
          items={[
            { label: 'Reset chart view', onSelect: resetView },
            { separator: true },
            { label: 'Remove all drawings', onSelect: removeAllDrawings, disabled: drawingCount() === 0, destructive: true },
            // FXR_SPEC.md phase F3: order-placement actions, appended only
            // when both the caller supplied them AND the click resolved to
            // a real price (never on an axis/sub-pane click).
            ...(getEmptyAreaMenuExtraItems && contextMenu.time !== null && contextMenu.price !== null
              ? [{ separator: true } as const, ...getEmptyAreaMenuExtraItems({ time: contextMenu.time, price: contextMenu.price })]
              : []),
          ]}
        />
      )}
      {contextMenu?.kind === 'drawing' && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={toolByName(contextMenu.name)?.label ?? contextMenu.name}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'Edit style',
              onSelect: () => setStyleEditor({ id: contextMenu.id, x: contextMenu.x, y: contextMenu.y }),
            },
            { label: 'Clone', onSelect: () => cloneDrawing(contextMenu.id) },
            { label: contextMenu.locked ? 'Unlock' : 'Lock', onSelect: () => toggleDrawingLock(contextMenu.id) },
            { separator: true },
            { label: 'Delete', onSelect: () => deleteDrawing(contextMenu.id), destructive: true },
          ]}
        />
      )}
      {styleEditor && (
        <DrawingStylePopover
          x={styleEditor.x}
          y={styleEditor.y}
          colors={colors}
          onPickColor={(hex) => updateDrawingColor(styleEditor.id, hex)}
          onPickWidth={(size) => updateDrawingWidth(styleEditor.id, size)}
          onClose={() => setStyleEditor(null)}
        />
      )}
      {indicatorSettings && (
        <IndicatorSettingsPopover
          x={indicatorSettings.x}
          y={indicatorSettings.y}
          label={INDICATOR_LABEL[indicatorSettings.key]}
          colors={colors}
          onPickColor={(hex) => updateIndicatorColor(indicatorSettings.key, hex)}
          onReset={() => {
            useIndicatorStore.getState().setIndicatorColor(indicatorSettings.key, null)
            const chart = chartRef.current
            if (chart) {
              chart.overrideIndicator({
                name: KL_NAME_BY_COLORABLE_KEY[indicatorSettings.key],
                styles: { lines: [{ color: resolveIndicatorLineColor(indicatorSettings.key, colorsRef.current, baseRef.current) }] },
              })
            }
          }}
          onClose={() => setIndicatorSettings(null)}
        />
      )}
    </div>
  )
})

export default ChartKL
