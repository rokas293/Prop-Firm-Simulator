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
import {
  cameraRestoreIndex,
  captureTimeframeAnchor,
  captureViewAnchor,
  firstViewPlan,
  reanchorRestoreIndex,
  rightMarginForPane,
  timeframeSwitchView,
} from './cameraPreserve'
import { bucketStart, formingBar, lastIndexAtOrBefore, revealedBars, visibleBars } from '../replayBars'
import { smoothFrame } from '../smoothCandle'
import {
  HANDLE_INDEX,
  KL_POSITION_TOOL,
  POSITION_TOOL_GROUP_ID,
  POSITION_TOOL_ID,
  POSITION_TOOL_LONG,
  POSITION_TOOL_SHORT,
  ensurePositionToolOverlayRegistered,
  toolPoints,
  type PositionToolData,
  type PositionToolPalette,
} from './positionToolOverlay'
import { moveToolLevel, type PositionToolLevels, type ToolHandle, type ToolSizing } from '../positionTool'
import type { ContractSpec } from '../simBroker'
import { KL_ORDER_LABEL, ensureOrderLabelOverlayRegistered, ghostStroke, isGhostRole, type OrderLabelData, type OrderLabelPalette } from './orderLabelOverlay'
import { roundToTick, type OrderLineInfo, type OrderLineRole } from '../orderEntry'
import { fmtPrice } from '../../format'
import { useKLDrawingStore, overlaysForInstrument } from '../../state/klDrawingStore'
import { KL_DEFAULT_INDICATOR_LINES, ON_ACCENT_DARK, ON_ACCENT_LIGHT, useThemeStore, useThemeBase, type ThemeColors, type ThemeBase } from '../../state/themeStore'
import { MIN_TEXT_CONTRAST, ensureContrast, ensureTextVariant, pickOnAccent } from '../../state/contrast'
import { useIndicatorStore, type ColorableIndicatorKey, type IndicatorPrefs } from '../../state/indicatorStore'
import type { Bar, IndicatorPoint, TradeRecord } from '../../api/types'
import { filterBarsForReplay, filterTradesForReplay, type ReplayTradeView } from '../replay'
import { computeMeasure, formatDuration, type MeasurePoint, type MeasureResult } from '../measure'
import LoadingBar from '../../components/LoadingBar'
import Skeleton from '../../components/Skeleton'
import ContextMenu, { type ContextMenuEntry } from '../../components/ContextMenu'
import DrawingStylePopover from './DrawingStylePopover'
import IndicatorSettingsPopover from './IndicatorSettingsPopover'

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
  // The first view of a session: the newest (cursor) bar in view, `visibleBars`
  // across the pane, the right margin applied -- placed instantly, never animated.
  showLatest: (visibleBars: number) => void
  scrollToTrade: (time: number) => void
  // G5: park the newest (cursor) bar at the right edge again, margin applied --
  // the way back from a Go To / a scrolled-back view. Camera only.
  scrollToLatest: () => void
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
  // FXR_SPEC.md section C, phase F5: "screenshots/chart markup of the
  // chart ... saved to the trade" -- a plain data URL of the chart's
  // current canvas (candles, trades, drawings), via klinecharts' own
  // getConvertPictureUrl. Synchronous and read-only: captures whatever is
  // currently rendered, no camera move of its own (the caller jumps/pans
  // first via fitRange, then captures once that's settled). Returns null
  // if the chart hasn't initialized yet.
  captureScreenshot: () => string | null
  // Re-reads this instrument's drawings from the persisted store and redraws
  // them (the session toolbar's undo/redo writes the store, then calls this).
  reloadDrawings: () => void
  // FXR_V2_SPEC.md 3.5 (G3): arms the Long/Short Position tool. The next click on
  // the chart places it (anchored on that bar, clamped to the cursor bar) with
  // the given levels -- already at the current price -- and reports it through
  // onPositionToolDrawn. Replaces any tool already on the chart.
  startPositionTool: (tool: PositionToolSpec) => void
}

// A position tool as the caller owns it: its three levels plus what its live
// labels need (the instrument's spec and the risk budget that sizes them).
export interface PositionToolSpec {
  levels: PositionToolLevels
  spec: ContractSpec
  sizing: ToolSizing
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
  // FXR_V2_SPEC.md 3.5 (G3): the Long/Short Position tool on the chart, or null
  // for none. The caller owns its levels; ChartKL owns the drag and reports each
  // move. While a drag is in progress the incoming levels are not pushed back
  // (klinecharts owns the handle for the rest of the gesture).
  positionTool?: PositionToolSpec | null
  // The armed tool was placed by its click (the levels are already the defaults).
  onPositionToolDrawn?: (levels: PositionToolLevels) => void
  // A handle moved: the COMPLETE updated levels, on every frame of the drag.
  onPositionToolChange?: (levels: PositionToolLevels) => void
  // The tool's own x was clicked.
  onPositionToolRemove?: () => void
  // Right-click on the tool -> its menu items.
  getPositionToolMenu?: () => ContextMenuEntry[]
  // A press on / drag of the tool (the caller pauses the replay: the market must
  // not run under the levels being set).
  onPositionToolInteract?: () => void
  // FXR_V2_SPEC.md G2: the sim broker's on-chart order lines -- the open
  // position's line, its SL/TP (placed or ghost) and working orders, each a
  // dashed line with a segmented label and a y-axis price tag
  // (orderLabelOverlay.ts). The caller owns what they MEAN; ChartKL owns the
  // drag. A line is created once per `id` and thereafter only synced (price,
  // label inputs) -- never rebuilt mid-drag, which would fight the gesture.
  orderLines?: OrderLineSpec[]
  // A draggable line's gesture: 'start' on press, 'move' with each new
  // (unsnapped) price, 'end' on release with the final price.
  onOrderLineDrag?: (id: string, price: number, phase: 'start' | 'move' | 'end') => void
  // The label's x button (close the position / remove a level / cancel the order).
  onOrderLineClose?: (id: string) => void
  // Right-click on a line -> its menu items (empty = no menu).
  getOrderLineMenu?: (id: string) => ContextMenuEntry[]
  // The empty-area menu is opening (the caller pauses replay: an order
  // surface opening always pauses).
  onEmptyAreaMenuOpen?: () => void
  // Right-click on empty chart area (Batch 1's existing menu) -- returns
  // extra items to APPEND to the built-in Reset-view/Remove-drawings menu,
  // given the clicked price/time. Lets the session workspace extend the
  // SAME menu with order-placement actions without ChartKL itself knowing
  // anything about trading.
  getEmptyAreaMenuExtraItems?: (info: { time: number; price: number }) => ContextMenuEntry[]
  // FXR_V2_SPEC.md G2: pixels of empty chart to the right of the newest bar,
  // so the order labels (which hug the right edge) never cover recent price
  // (references R10/R11). Applied on every (re)load, and held by the replay
  // camera as bars are revealed. Unset = klinecharts' default, flush follow.
  rightMarginPx?: number
  // Manual-session replay: when the fetch window is re-anchored on the cursor
  // (same instrument/timeframe, different from/to), keep the view on the same
  // bars instead of letting klinecharts reset the scroll. Off for the
  // automated-run review, whose own fit owns the camera on a window change.
  preserveViewOnWindowChange?: boolean
  // The candle series style (the session toolbar's chart-type menu). Pure
  // presentation of the same OHLC bars -- never changes data or the cursor.
  candleType?: KLCandleType
  // FXR_V2_SPEC.md section 5 (G5): a manual-session REPLAY chart. `timeframe`/
  // `from`/`to` then fetch only the HISTORY (completed candles before the one
  // forming at load); everything from there on is built from `replay.feed` -- the
  // 1-minute bars, of which only those at or before `cursorIndex` are ever read
  // (chart/replayBars.ts). A step updates the forming candle IN PLACE and appends
  // a new one at a boundary, instead of reloading every bar.
  //   undefined = not a replay chart (the automated-run review): `cursorTime` clips
  //               the fetched bars as before;
  //   null      = a replay chart whose feed has not loaded: nothing is drawn.
  replay?: ReplayFeed | null
  // Glide the forming candle between steps (cosmetic; see chart/smoothCandle.ts).
  // The caller turns it on only while auto-playing.
  smoothCandles?: boolean
  smoothMs?: number
  // A view-only Go To (G5): centre the chart on `time` (never moves the replay
  // cursor). A new `nonce` is a new request; `time` is clamped by the caller to
  // the revealed range.
  goTo?: { time: number; nonce: number } | null
  // Fires when the view becomes parked away from the replay cursor by a Go To (true) or
  // returns to it (false), so the caller can offer the way back.
  onDetachedChange?: (detached: boolean) => void
}

// The 1-minute bars a replay chart is built from, and how far the cursor is
// through them (the cursor bar is the last one revealed).
export interface ReplayFeed {
  feed: Bar[]
  cursorIndex: number
}

export interface OrderLineSpec {
  id: string
  price: number
  info: OrderLineInfo
  draggable: boolean
}

export type KLCandleType = 'candle_solid' | 'candle_stroke' | 'ohlc' | 'area'

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
export function themeStyles(colors: ThemeColors, base: ThemeBase) {
  return {
    grid: {
      horizontal: { color: base.grid },
      vertical: { color: base.grid },
    },
    candle: {
      // The always-on legend in the pane's top-left. klinecharts' default
      // template is verbose ("Time: … Open: … High: … Low: … Close: …
      // Volume: …", ~570px wide), which is both at odds with
      // DESIGN_LANGUAGE.md section 1/5 ("elevate by removing", quiet chrome)
      // and the main thing the sim broker's order lines collide with (see
      // orderLineOverlay.ts). Time is already on the x-axis and in the
      // replay bar, and volume has its own VOL sub-pane legend, so both go;
      // what's left is the compact O/H/L/C every trading chart uses. Titles
      // take the muted text level, values the primary one -- section 2's
      // "two levels of text, never color, for hierarchy".
      tooltip: {
        legend: {
          template: [
            { title: { text: 'O', color: base.textMuted }, value: { text: '{open}', color: base.text } },
            { title: { text: 'H', color: base.textMuted }, value: { text: '{high}', color: base.text } },
            { title: { text: 'L', color: base.textMuted }, value: { text: '{low}', color: base.text } },
            { title: { text: 'C', color: base.textMuted }, value: { text: '{close}', color: base.text } },
          ],
        },
        title: { color: base.textMuted, family: FONT_FAMILY },
      },
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
      // The VOL legend text takes the bar color, so nudge it to 4.5:1 on the
      // chart bg (no-op on dark, where up/down already pass).
      bars: [
        {
          upColor: ensureContrast(colors.upCandle, base.bg, MIN_TEXT_CONTRAST),
          downColor: ensureContrast(colors.downCandle, base.bg, MIN_TEXT_CONTRAST),
          noChangeColor: ensureContrast(colors.upCandle, base.bg, MIN_TEXT_CONTRAST),
        },
      ],
      // The on-chart per-indicator legend row's typography (REPLICA_
      // ROADMAP.md Batch 3) -- klinecharts' own default is an unthemed
      // 'Helvetica Neue'/flat-gray (confirmed in the v10.0.3 source), which
      // doesn't track the app's theme tokens or DESIGN_LANGUAGE.md §3's
      // "one family, system UI stack" the rest of the app uses. showRule
      // is already 'always' by default (unchanged) -- only typography
      // needs setting here; the feature icons (settings/eye/remove/
      // reorder) are applied per-indicator in rebuildIndicatorsRef below,
      // not globally, since which icons apply differs by indicator kind.
      // Built-in VOL/MA line colors drive their legend text; nudge each to
      // 4.5:1 on this bg (no-op on dark where they already pass).
      lines: KL_DEFAULT_INDICATOR_LINES.map((c) => ({
        style: 'solid' as const,
        smooth: false,
        size: 1,
        dashedValue: [2, 2],
        color: ensureContrast(c, base.bg, MIN_TEXT_CONTRAST),
      })),
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
      // One family: the axis tags use the UI sans like the order labels do.
      horizontal: { line: { color: base.textMuted }, text: { color: base.text, backgroundColor: base.surface, family: FONT_FAMILY } },
      vertical: { line: { color: base.textMuted }, text: { color: base.text, backgroundColor: base.surface, family: FONT_FAMILY } },
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
    positionTool = null,
    onPositionToolDrawn,
    onPositionToolChange,
    onPositionToolRemove,
    getPositionToolMenu,
    onPositionToolInteract,
    orderLines,
    onOrderLineDrag,
    onOrderLineClose,
    getOrderLineMenu,
    onEmptyAreaMenuOpen,
    getEmptyAreaMenuExtraItems,
    rightMarginPx,
    preserveViewOnWindowChange = false,
    candleType = 'candle_solid',
    replay,
    smoothCandles = false,
    smoothMs = 0,
    goTo = null,
    onDetachedChange,
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
    | { kind: 'orderLine'; x: number; y: number; id: string; items: ContextMenuEntry[] }
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
  // G5 replay state (see the `replay` prop). `tailRef` = the candles built from the
  // feed since the history was fetched (the forming one last); `appliedCursorTimeRef`
  // = the cursor the chart currently shows (null = nothing built yet);
  // `liveCallbackRef` = klinecharts' subscribeBar callback, the in-place update path.
  const replayRef = useRef(replay)
  replayRef.current = replay
  const tfSecondsRef = useRef(60)
  tfSecondsRef.current = tfToSeconds(timeframe) ?? 60
  const tailRef = useRef<Bar[]>([])
  const appliedCursorTimeRef = useRef<number | null>(null)
  const liveCallbackRef = useRef<((data: KLineData) => void) | null>(null)
  const smoothRef = useRef({ enabled: smoothCandles, ms: smoothMs })
  smoothRef.current = { enabled: smoothCandles, ms: smoothMs }
  // The forming candle as drawn mid-glide, and the animation frame driving it.
  const animRef = useRef<{ raf: number | null; shown: Bar | null }>({ raf: null, shown: null })
  const pendingGoToRef = useRef<number | null>(null)
  // A view-only Go To leaves the camera on a past date; "follow latest bar" must not
  // drag it back on the next step. Cleared by going back to the cursor, a reset of the
  // view, or the newest bar coming into view again by the user's own scrolling.
  const detachedRef = useRef(false)
  const onDetachedChangeRef = useRef(onDetachedChange)
  onDetachedChangeRef.current = onDetachedChange
  const setDetached = (value: boolean) => {
    if (detachedRef.current === value) return
    detachedRef.current = value
    onDetachedChangeRef.current?.(value)
  }
  const followingNow = () => followLatestBarRef.current && !detachedRef.current
  // The candle a time belongs to on THIS chart: markers and lines placed at a
  // 1-minute time sit on the candle that contains it (klinecharts would otherwise
  // pick the nearest bar, which can be the next one).
  const snapToChart = (t: number) => (replayRef.current === undefined || tfSecondsRef.current <= 60 ? t : bucketStart(t, tfSecondsRef.current))
  const anchorSec = () => snapToChart(cursorTimeRef.current ?? 0)
  // Trades as the replay cursor sees them (filterTradesForReplay: nothing before it
  // entered, an open one clipped), with entry/exit placed on the candles that hold them.
  const viewsForChart = (list: TradeRecord[]): ReplayTradeView[] => {
    const views = filterTradesForReplay(list, cursorTimeRef.current)
    if (replayRef.current === undefined || tfSecondsRef.current <= 60) return views
    return views.map((v) => ({
      ...v,
      trade: {
        ...v.trade,
        entry_time: snapToChart(v.trade.entry_time),
        exit_time: v.showExit ? snapToChart(v.trade.exit_time) : v.trade.exit_time,
      },
      openSpanEnd: snapToChart(v.openSpanEnd),
    }))
  }
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
  const candleTypeRef = useRef<KLCandleType>(candleType)
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
  const preserveViewOnWindowChangeRef = useRef(preserveViewOnWindowChange)
  preserveViewOnWindowChangeRef.current = preserveViewOnWindowChange
  // instrument|timeframe of the data currently on the chart -- a re-anchor
  // keeps this the same; a symbol/timeframe switch changes it and refits.
  const loadedSeriesKeyRef = useRef<string | null>(null)
  // A position line on screen draws its own SL/TP (as order lines), so the
  // locked trade-overlay SL/TP for the open-position sentinel are suppressed.
  const openPositionLineActive = (orderLines ?? []).some((l) => l.info.role === 'position')
  const openPositionLineActiveRef = useRef(openPositionLineActive)
  openPositionLineActiveRef.current = openPositionLineActive

  const rightMarginPxRef = useRef(rightMarginPx)
  rightMarginPxRef.current = rightMarginPx
  // The margin in pixels for the pane as it is NOW: the configured width, but
  // never more than RIGHT_MARGIN_MAX_PANE_SHARE of the pane, so a narrow pane
  // (the journal open) keeps most of its space for price.
  const effectiveRightMarginPx = (_chart?: Chart): number => {
    const configured = rightMarginPxRef.current
    if (!configured) return 0
    // The container's own width (not chart.getSize, which lags a resize by a frame).
    return rightMarginForPane(configured, containerRef.current?.clientWidth)
  }
  // ...in bars at the CURRENT zoom (bar space is pixels per bar).
  const rightMarginBars = (chart: Chart) => {
    const px = effectiveRightMarginPx(chart)
    return px ? Math.ceil(px / Math.max(1, chart.getBarSpace().bar)) : 0
  }

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
      const views = viewsForChart(tradesRef.current)
      const selectedView = selectedTradeRef.current ? (viewsForChart([selectedTradeRef.current])[0] ?? null) : null
      const entryExit = buildEntryExitOverlays(views, selectedTradeRef.current?.trade_id ?? null, colorsRef.current)
      // trade_id 0 is the open-position sentinel (openPositionAsTradeRecord's
      // own comment) -- while the F4 draggable editor below is active for it,
      // its SL/TP come from THAT overlay group instead, so the locked lines
      // this would otherwise draw are suppressed to avoid two overlapping
      // lines at the same price.
      const suppressLockedSlTp = openPositionLineActiveRef.current && selectedView?.trade.trade_id === 0
      const selected = buildSelectedTradeOverlays(
        suppressLockedSlTp ? { ...selectedView!, trade: { ...selectedView!.trade, sl_price: null, tp_price: null } } : selectedView,
        colorsRef.current,
        slLineColorRef.current,
      )
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

  // ---- G5 replay chart: in-place updates, glide, Go To ---------------------------
  //
  // The chart's data list is the history candles, then the candles built from the
  // replay feed (chart/replayBars.ts). A step reaches klinecharts through its
  // subscribeBar callback: the forming candle is replaced in place, or a new one
  // appended -- no reload, no overlay/indicator/drawing rebuild. Only a change of
  // series or window, or a rewind past the forming candle, reslices (resetData).
  const syncDiagnostics = () => {
    const host = containerRef.current
    const chart = chartRef.current
    if (!host || !chart) return
    const list = chart.getDataList()
    const last = list[list.length - 1]
    host.dataset.barCount = String(list.length)
    if (last) host.dataset.lastBar = [last.timestamp / 1000, last.open, last.high, last.low, last.close].join('|')
    const shown = loadedBarsRef.current[loadedBarsRef.current.length - 1]
    if (shown) host.dataset.revealedBar = [shown.time, shown.open, shown.high, shown.low, shown.close].join('|')
    if (appliedCursorTimeRef.current !== null) host.dataset.replayCursor = String(appliedCursorTimeRef.current)
    host.dataset.glide = animRef.current.raf !== null ? 'on' : 'off'
  }
  const cancelGlide = () => {
    const a = animRef.current
    if (a.raf !== null) cancelAnimationFrame(a.raf)
    a.raf = null
  }
  // The revealed candle goes into the caches everything else reads (the loaded bars
  // the overlays and tools use, and the tail kept across a reslice) -- always the
  // EXACT revealed state, whatever is being drawn mid-glide.
  const commitBar = (bar: Bar) => {
    const loaded = loadedBarsRef.current
    if (loaded.length && loaded[loaded.length - 1].time === bar.time) loaded[loaded.length - 1] = bar
    else loaded.push(bar)
    const tail = tailRef.current
    if (tail.length && tail[tail.length - 1].time === bar.time) tail[tail.length - 1] = bar
    else tail.push(bar)
  }
  const drawBar = (bar: Bar) => {
    liveCallbackRef.current?.(toKLineData(bar))
    syncDiagnostics()
  }
  const barFromChart = (time: number): Bar | null => {
    const list = chartRef.current?.getDataList() ?? []
    const last = list[list.length - 1]
    if (!last || last.timestamp !== time * 1000) return null
    return { time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 }
  }
  const canGlide = () => {
    const { enabled, ms } = smoothRef.current
    if (!enabled || ms <= 0 || document.visibilityState !== 'visible') return false
    return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }
  // Draws `target` (already committed) by gliding the forming candle from what is on
  // screen to it. Every frame is built only from those two revealed states
  // (smoothCandle.ts), and the last frame IS the target.
  const glideTo = (target: Bar) => {
    const a = animRef.current
    if (a.raf !== null) cancelAnimationFrame(a.raf)
    const from = barFromChart(target.time)
    const started = performance.now()
    const duration = Math.max(1, smoothRef.current.ms)
    const tick = (now: number) => {
      const progress = (now - started) / duration
      a.raf = progress < 1 ? requestAnimationFrame(tick) : null
      drawBar(smoothFrame(from, target, progress))
    }
    a.raf = requestAnimationFrame(tick)
  }
  // Centres the chart on a time once the candles holding it are loaded (a Go To that
  // needs older history waits for that window to land -- respond() retries).
  const tryGoTo = () => {
    const t = pendingGoToRef.current
    const chart = chartRef.current
    const bars = loadedBarsRef.current
    if (t === null || !chart || bars.length === 0) return
    const req = requestRef.current
    const windowLoaded = req.from != null && req.from <= t && lastFetchKeyRef.current === `${req.instrument}|${req.timeframe}|${req.from}|${req.to}`
    if (bars[0].time > t && !windowLoaded) return
    pendingGoToRef.current = null
    const idx = Math.max(0, lastIndexAtOrBefore(bars, t))
    const range = chart.getVisibleRange()
    const half = Math.floor((range.realTo - range.realFrom) / 2)
    // scrollToDataIndex(R - 2) puts the exclusive right edge at R (cameraPreserve.ts).
    chart.scrollToDataIndex(Math.min(idx + half - 1, bars.length + rightMarginBars(chart) - 2), 0)
    setDetached(true)
  }
  const tryGoToRef = useRef(tryGoTo)
  tryGoToRef.current = tryGoTo

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
    ensurePositionToolOverlayRegistered()
    ensureOrderLabelOverlayRegistered()
    if (!containerRef.current) return
    const chart = init(containerRef.current, { timezone: 'America/New_York' })
    if (!chart) return
    chartRef.current = chart
    chart.setStyles(themeStyles(colorsRef.current, baseRef.current))
    chart.setStyles({ candle: { type: candleTypeRef.current } })
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
    //
    // A replay chart (G5) is handed only the HISTORY; the candles from there to the
    // cursor come from the feed (chart/replayBars.ts visibleBars), so nothing past
    // the cursor is ever in the data list.
    const respond = (bars: Bar[], callback: (data: KLineData[], more: { forward: boolean; backward: boolean }) => void) => {
      const r = replayRef.current
      const tfSec = tfSecondsRef.current
      // Captured BEFORE the data list is swapped: where the viewport's right edge
      // sits, in time (see cameraPreserve.ts's re-anchor section).
      const prevSeriesKey = loadedSeriesKeyRef.current
      const seriesKey = `${requestRef.current.instrument}|${requestRef.current.timeframe}`
      const sameSeries = prevSeriesKey === seriesKey
      loadedSeriesKeyRef.current = seriesKey
      cancelGlide()
      let visible: Bar[]
      if (r === undefined) {
        visible = filterBarsForReplay(bars, cursorTimeRef.current)
      } else if (!r || !r.feed[r.cursorIndex]) {
        visible = []
        tailRef.current = []
        appliedCursorTimeRef.current = null
      } else {
        if (!sameSeries) tailRef.current = []
        visible = visibleBars(bars, tailRef.current, r.feed, r.cursorIndex, tfSec)
        // The candles after the fetched history are the tail (the forming one last).
        const lastHist = lastIndexAtOrBefore(bars, visible[visible.length - 1].time - 1)
        const lastHistTime = lastHist >= 0 ? bars[lastHist].time : -Infinity
        tailRef.current = visible.filter((b) => b.time > lastHistTime)
        appliedCursorTimeRef.current = r.feed[r.cursorIndex].time
      }
      loadedBarsRef.current = visible
      setMeasureBarsContext(visible)
      setHasLoadedOnce(true)
      const oldData = chart.getDataList()
      const oldRange = chart.getVisibleRange()
      const viewAnchor =
        preserveViewOnWindowChangeRef.current && sameSeries
          ? captureViewAnchor(
              oldData.map((d) => d.timestamp),
              oldRange.realTo,
            )
          : null
      // A timeframe switch (same instrument, a different candle size) keeps the
      // camera in TIME: the same right edge and stretch of time across the pane.
      const timeframeAnchor =
        r !== undefined && prevSeriesKey !== null && !sameSeries && prevSeriesKey.split('|')[0] === seriesKey.split('|')[0]
          ? captureTimeframeAnchor(
              oldData.map((d) => d.timestamp / 1000),
              oldRange.realFrom,
              oldRange.realTo,
            )
          : null
      callback(visible.map(toKLineData), { forward: false, backward: false })
      if (timeframeAnchor) {
        const view = timeframeSwitchView({
          anchor: timeframeAnchor,
          afterTimes: visible.map((b) => b.time),
          newTimeframeSeconds: tfSec,
          paneWidth: containerRef.current?.clientWidth ?? chart.getSize()?.width ?? 0,
          marginPx: effectiveRightMarginPx(chart),
        })
        if (view) {
          chart.setBarSpace(view.barSpace)
          chart.scrollToDataIndex(view.scrollIndex, 0)
        }
      } else {
        // Each init load resets klinecharts' scroll, so this runs for every
        // load (a re-anchor can respond more than once), before the overlays
        // below are placed against the visible range.
        const restoreIndex = reanchorRestoreIndex(
          viewAnchor,
          visible.map((b) => b.time * 1000),
          followingNow(),
          rightMarginBars(chart),
        )
        if (restoreIndex !== null) chart.scrollToDataIndex(restoreIndex, 0)
      }
      rebuildOverlaysRef.current()
      restoreDrawingsRef.current()
      rebuildIndicatorsRef.current()
      rebuildSessionOverlaysRef.current()
      syncDiagnostics()
      tryGoToRef.current()
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
        if (lastFetchKeyRef.current === key) {
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
            // A replay chart: an answer for a window/timeframe that has since been
            // replaced is dropped (the replacement's own load is already under way).
            if (replayRef.current !== undefined) {
              const now = requestRef.current
              if (now.instrument !== req.instrument || now.timeframe !== req.timeframe || now.from !== req.from || now.to !== req.to) return
            }
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
      // The in-place update path: klinecharts hands back a callback that replaces
      // the newest candle (same timestamp) or appends one (later timestamp).
      subscribeBar: ({ callback }) => {
        liveCallbackRef.current = callback
      },
      unsubscribeBar: () => {
        liveCallbackRef.current = null
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
      // Diagnostics (read by the browser checks of the first view): how many bars
      // are loaded and where the viewport's right edge sits, in bar indices.
      // Right edge minus bar count = the empty room right of the newest bar.
      const host = containerRef.current
      if (host) {
        const vr = chart.getVisibleRange()
        host.dataset.barCount = String(chart.getDataList().length)
        host.dataset.viewRealTo = String(vr.realTo)
        host.dataset.viewRealFrom = String(vr.realFrom)
        // The same edges as TIMES (the first and last visible bar), for checks that
        // the camera holds across a timeframe switch, where indices mean nothing.
        const list = chart.getDataList()
        if (list.length > 0) {
          const at = (i: number) => list[Math.max(0, Math.min(list.length - 1, i))].timestamp / 1000
          host.dataset.viewFromTime = String(at(Math.floor(vr.realFrom)))
          host.dataset.viewToTime = String(at(Math.ceil(vr.realTo) - 1))
        }
      }
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
      const views = viewsForChart(tradesRef.current)
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
      onEmptyAreaMenuOpenRef.current?.()
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
      // The replay state belongs to the chart instance that just went away.
      appliedCursorTimeRef.current = null
      tailRef.current = []
      liveCallbackRef.current = null
      loadedSeriesKeyRef.current = null
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
    // A position line's presence (not its live prices) governs whether this
    // rebuild suppresses the locked SL/TP lines in favour of the draggable
    // order lines -- only its appear/disappear transition retriggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, selectedTrade, colors, bracketDensity, slLineColor, openPositionLineActive])

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

  // Chart type: a style switch on the existing bars only.
  useEffect(() => {
    candleTypeRef.current = candleType
    chartRef.current?.setStyles({ candle: { type: candleType } })
  }, [candleType])

  // Indicator data/toggle changed but the window didn't -- redraw against
  // the bars already loaded, same as the trades effect above.
  //
  // G5: in a replay the data changes every step (the forming candle's point), and
  // destroying and recreating every indicator for that would be the very reload the
  // in-place update avoids. So there, a data-only change refreshes the context the
  // indicators read and re-applies the newest candle (klinecharts recalculates on
  // every data update); the structure is rebuilt only when prefs change.
  const rebuiltForPrefsRef = useRef<IndicatorPrefs | null>(null)
  useEffect(() => {
    const chart = chartRef.current
    const structureUnchanged = rebuiltForPrefsRef.current === prefs
    if (replayRef.current !== undefined && structureUnchanged && chart && loadedBarsRef.current.length > 0) {
      setIndicatorContext(indicatorsRef.current)
      const last = chart.getDataList()
      const newest = last[last.length - 1]
      if (newest) liveCallbackRef.current?.(newest)
      return
    }
    rebuiltForPrefsRef.current = prefs
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
  // fix captures/restores the viewport in klinecharts' own DATA-INDEX
  // space -- see chart/kl/cameraPreserve.ts for the full derivation and
  // for why the previous timestamp-midpoint restore walked the camera
  // backwards half a viewport on every single step. Zoom (barSpace) is
  // untouched by resetData() itself, so only scroll needs restoring.
  // respond() (the mount effect's DataLoader) runs synchronously for a
  // replay tick (same window, cache hit), so the data list already
  // reflects the new cursor by the time resetData() returns.
  const reslice = (hasData = fullBarsRef.current.length > 0) => {
    withReadyChart(chartRef.current, hasData, (chart) => {
      const beforeRange = chart.getVisibleRange()
      const beforeFirstBarTime = chart.getDataList()[0]?.timestamp ?? null
      chart.resetData()
      const afterList = chart.getDataList()
      const restoreIndex = cameraRestoreIndex({
        beforeRealTo: beforeRange.realTo,
        beforeFirstBarTime,
        afterFirstBarTime: afterList[0]?.timestamp ?? null,
        afterBarCount: afterList.length,
        followLatestBar: followingNow(),
        rightMarginBars: rightMarginBars(chart),
      })
      if (restoreIndex !== null) chart.scrollToDataIndex(restoreIndex, 0)
    })
  }
  useEffect(() => {
    // A replay chart (G5) is driven by `replay` below, not by the cursor time.
    if (replayRef.current !== undefined) return
    reslice()
  }, [cursorTime])

  // G5: the replay cursor moved. Forward within the loaded series this is an
  // in-place update of the candles the new minutes touch (the forming one grows, a
  // boundary appends a new one) -- O(step), no reload. Anything else (the chart's
  // series or window is still loading, a rewind past the forming candle, a jump)
  // reslices from the history and the feed.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !replay) return
    const cursorBar = replay.feed[replay.cursorIndex]
    if (!cursorBar) return
    const req = requestRef.current
    const loadedSeries = loadedSeriesKeyRef.current === `${req.instrument}|${req.timeframe}`
    const loadedWindow = lastFetchKeyRef.current === `${req.instrument}|${req.timeframe}|${req.from}|${req.to}`
    // The history fetch for the current series/window is still in flight: its own
    // arrival builds the chart from the latest cursor, so there is nothing to do yet.
    if (!loadedSeries || !loadedWindow) return
    const applied = appliedCursorTimeRef.current
    if (applied === null || loadedBarsRef.current.length === 0 || !liveCallbackRef.current) {
      reslice(true)
      return
    }
    if (cursorBar.time === applied) return
    const tfSec = tfSecondsRef.current
    if (cursorBar.time > applied) {
      const fromIndex = lastIndexAtOrBefore(replay.feed, applied)
      if (fromIndex < 0) {
        reslice(true)
        return
      }
      const bars = revealedBars(replay.feed, fromIndex, replay.cursorIndex, tfSec)
      if (bars.length === 0) return
      const beforeRange = chart.getVisibleRange()
      const beforeFirstBarTime = chart.getDataList()[0]?.timestamp ?? null
      // The user scrolled back to the newest candle themselves: following resumes.
      if (detachedRef.current && beforeRange.realTo >= chart.getDataList().length) setDetached(false)
      // The candles the step finished are drawn exactly; only the newest may glide.
      const glide = canGlide()
      bars.forEach((bar, i) => {
        commitBar(bar)
        if (glide && i === bars.length - 1) glideTo(bar)
        else drawBar(bar)
      })
      appliedCursorTimeRef.current = cursorBar.time
      const afterList = chart.getDataList()
      const restoreIndex = cameraRestoreIndex({
        beforeRealTo: beforeRange.realTo,
        beforeFirstBarTime,
        afterFirstBarTime: afterList[0]?.timestamp ?? null,
        afterBarCount: afterList.length,
        followLatestBar: followingNow(),
        rightMarginBars: rightMarginBars(chart),
      })
      if (restoreIndex !== null) chart.scrollToDataIndex(restoreIndex, 0)
      syncDiagnostics()
      return
    }
    // Backwards. Within the candle already forming it is still an in-place update
    // (the same candle, fewer minutes); across a candle boundary, a reslice.
    const forming = formingBar(replay.feed, replay.cursorIndex, tfSec)
    const newest = loadedBarsRef.current[loadedBarsRef.current.length - 1]
    if (newest && newest.time === forming.time) {
      cancelGlide()
      appliedCursorTimeRef.current = cursorBar.time
      commitBar(forming)
      drawBar(forming)
      return
    }
    reslice(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.feed, replay?.cursorIndex])

  // A glide must not outlive the chart or the option: settle on the exact candle.
  useEffect(() => {
    if (smoothCandles) return
    const a = animRef.current
    if (a.raf === null) return
    cancelGlide()
    const newest = loadedBarsRef.current[loadedBarsRef.current.length - 1]
    if (newest) drawBar(newest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothCandles])
  useEffect(() => cancelGlide, [])

  // A view-only Go To (G5): centre on the time. The replay cursor is untouched.
  useEffect(() => {
    if (!goTo) return
    pendingGoToRef.current = goTo.time
    tryGoToRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo?.nonce])

  // The right margin itself: klinecharts places the newest bar this many pixels
  // from the right edge on every init load (first load, Reset view, window swap).
  // It is re-derived whenever the pane's width changes (journal opened or
  // closed, window resized), and a followed view is re-parked at the new margin.
  useEffect(() => {
    const chart = chartRef.current
    const el = containerRef.current
    if (!chart || !el || rightMarginPx === undefined) return
    let lastPx = -1
    const apply = () => {
      const px = effectiveRightMarginPx(chart)
      if (px === lastPx) return
      const first = lastPx === -1
      lastPx = px
      chart.setOffsetRightDistance(px)
      const count = chart.getDataList().length
      if (!first && followLatestBarRef.current && count > 0) {
        chart.scrollToDataIndex(count - 2 + rightMarginBars(chart), 0)
      }
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightMarginPx])

  // FXR_V2_SPEC.md G2: the order lines (position / SL / TP / ghosts / working
  // orders). Reconciled by id whenever the spec list, the cursor (the anchor
  // point follows the revealed bars) or the theme changes:
  //   - new id   -> createOverlay
  //   - known id -> overrideOverlay (price + label inputs), EXCEPT the price
  //                 while that very line is being dragged -- klinecharts owns
  //                 its position for the rest of the gesture
  //   - gone id  -> removeOverlay
  // A non-draggable line (the position, a working order) snaps back to its
  // authoritative price if it is dragged anyway.
  const ORDER_LINE_GROUP_ID = 'kl-order-lines'
  const ORDER_LINE_Z_LEVEL = 10_000
  const orderLinesRef = useRef<OrderLineSpec[]>([])
  orderLinesRef.current = orderLines ?? []
  const onOrderLineDragRef = useRef(onOrderLineDrag)
  onOrderLineDragRef.current = onOrderLineDrag
  const onOrderLineCloseRef = useRef(onOrderLineClose)
  onOrderLineCloseRef.current = onOrderLineClose
  const getOrderLineMenuRef = useRef(getOrderLineMenu)
  getOrderLineMenuRef.current = getOrderLineMenu
  const onEmptyAreaMenuOpenRef = useRef(onEmptyAreaMenuOpen)
  onEmptyAreaMenuOpenRef.current = onEmptyAreaMenuOpen
  const orderLinePricesRef = useRef(new Map<string, number>())
  const draggingOrderLineRef = useRef<string | null>(null)
  const orderLineMovedRef = useRef(false)
  // The line under the pointer: it brightens (a ghost is faint until then) and
  // the cursor says it can be dragged.
  const [hoveredOrderLine, setHoveredOrderLine] = useState<string | null>(null)
  const hoveredOrderLineRef = useRef<string | null>(null)
  hoveredOrderLineRef.current = hoveredOrderLine
  // Over an order line the crosshair's horizontal line and price tag are
  // hidden: they run through the label and their tag (the raw pointer price)
  // covers the line's own tick-snapped one. The level's own tag is the readout.
  const positionToolHoverRef = useRef(false)
  const syncCrosshairForOrderLines = () => {
    const over = hoveredOrderLineRef.current !== null || draggingOrderLineRef.current !== null || positionToolHoverRef.current
    chartRef.current?.setStyles({ crosshair: { horizontal: { show: !over } } })
  }
  const setOrderLineCursor = (kind: 'ns-resize' | 'pointer' | null) => {
    const el = containerRef.current
    if (!el) return
    if (kind) el.dataset.orderCursor = kind
    else delete el.dataset.orderCursor
  }

  const orderLinePalette = (role: OrderLineRole): OrderLabelPalette => {
    const c = colorsRef.current
    const b = baseRef.current
    const line = role === 'ghost-sl' || role === 'sl' ? b.warning : role === 'ghost-tp' || role === 'tp' ? c.positive : c.accent
    return {
      line,
      surface: b.surface,
      text: b.text,
      textMuted: b.textMuted,
      positive: ensureTextVariant(c.positive, b.surface),
      negative: ensureTextVariant(c.negative, b.surface),
      onRole: pickOnAccent(line, ON_ACCENT_LIGHT, ON_ACCENT_DARK),
      ghost: ghostStroke(line, b.bg),
    }
  }

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const specs = orderLines ?? []
    const anchorMs = anchorSec() * 1000
    const existing = new Set(chart.getOverlays({ groupId: ORDER_LINE_GROUP_ID }).map((o) => o.id))
    const next = new Set(specs.map((l) => l.id))
    for (const id of existing) {
      if (!next.has(id)) {
        chart.removeOverlay({ id })
        orderLinePricesRef.current.delete(id)
        // A hovered line that disappears (its x was just clicked) never gets a
        // mouse-leave: release the crosshair and the cursor ourselves.
        if (hoveredOrderLineRef.current === id) {
          hoveredOrderLineRef.current = null
          setHoveredOrderLine(null)
          setOrderLineCursor(null)
          syncCrosshairForOrderLines()
        }
      }
    }
    for (const spec of specs) {
      orderLinePricesRef.current.set(spec.id, spec.price)
      const palette = orderLinePalette(spec.info.role)
      const hover = hoveredOrderLine === spec.id
      const extendData: OrderLabelData = { info: spec.info, palette, formatPrice: (v) => fmtPrice(v, instrument ?? ''), hover }
      // Placed SL/TP are SOLID; a ghost is faint and dashed until hovered or
      // dragged; the position and working orders keep the reference's dashes.
      const role = spec.info.role
      const styles = {
        line: {
          color: isGhostRole(role) && !hover ? palette.ghost : palette.line,
          style: (role === 'sl' || role === 'tp' ? 'solid' : 'dashed') as 'solid' | 'dashed',
          size: hover || draggingOrderLineRef.current === spec.id ? 2 : 1,
        },
      }
      if (existing.has(spec.id)) {
        const dragging = draggingOrderLineRef.current === spec.id
        chart.overrideOverlay({
          id: spec.id,
          extendData,
          styles,
          ...(dragging ? {} : { points: [{ timestamp: anchorMs, value: spec.price }] }),
        })
        continue
      }
      const id = spec.id
      chart.createOverlay({
        id,
        name: KL_ORDER_LABEL,
        groupId: ORDER_LINE_GROUP_ID,
        lock: false,
        // Always on top: klinecharts numbers overlays as they are created, and a
        // LOCKED overlay above these (a session fair-value line sitting within a
        // pixel of the entry, say) would still swallow their clicks and drags.
        zLevel: ORDER_LINE_Z_LEVEL,
        fixedZLevel: true,
        points: [{ timestamp: anchorMs, value: spec.price }],
        extendData,
        styles,
        // klinecharts reports a press as a move-start even when the pointer
        // never moves (a plain click, e.g. on the x button), so a gesture only
        // counts as a drag from its first actual move -- else every click would
        // also "place" the level it sits on, racing the click's own action.
        onPressedMoveStart: () => {
          draggingOrderLineRef.current = id
          orderLineMovedRef.current = false
        },
        onMouseEnter: () => {
          setHoveredOrderLine(id)
          hoveredOrderLineRef.current = id
          syncCrosshairForOrderLines()
        },
        // A draggable level shows a resize cursor (the x keeps the pointer).
        onMouseMove: (event) => {
          if (!orderLinesRef.current.find((l) => l.id === id)?.draggable) return
          setOrderLineCursor(event.figure?.key === 'close' ? 'pointer' : 'ns-resize')
        },
        onMouseLeave: () => {
          setHoveredOrderLine((h) => (h === id ? null : h))
          if (hoveredOrderLineRef.current === id) hoveredOrderLineRef.current = null
          setOrderLineCursor(null)
          syncCrosshairForOrderLines()
        },
        onPressedMoving: (event) => {
          const price = event.overlay.points[0]?.value
          if (typeof price !== 'number') return
          if (!orderLineMovedRef.current) {
            orderLineMovedRef.current = true
            if (orderLinesRef.current.find((l) => l.id === id)?.draggable) {
              // While a level is dragged its own tag is the one price readout:
              // the crosshair's tag shows the raw pointer price and would
              // disagree with the tick-snapped level (and strike through the label).
              syncCrosshairForOrderLines()
              onOrderLineDragRef.current?.(id, orderLinePricesRef.current.get(id) ?? spec.price, 'start')
            }
          }
          if (!orderLinesRef.current.find((l) => l.id === id)?.draggable) {
            // Not draggable (position / working order): put it straight back.
            const home = orderLinePricesRef.current.get(id)
            if (home !== undefined) chart.overrideOverlay({ id, points: [{ timestamp: anchorSec() * 1000, value: home }] })
            return
          }
          // The dragged line snaps to the tick grid as it moves.
          const tick = orderLinesRef.current.find((l) => l.id === id)?.info.spec.tickSize
          const snapped = tick ? roundToTick(price, tick) : price
          if (snapped !== price) {
            chart.overrideOverlay({ id, points: [{ timestamp: anchorSec() * 1000, value: snapped }] })
          }
          onOrderLineDragRef.current?.(id, snapped, 'move')
        },
        onPressedMoveEnd: (event) => {
          draggingOrderLineRef.current = null
          const price = event.overlay.points[0]?.value
          const moved = orderLineMovedRef.current
          orderLineMovedRef.current = false
          syncCrosshairForOrderLines()
          if (moved && orderLinesRef.current.find((l) => l.id === id)?.draggable && typeof price === 'number') {
            onOrderLineDragRef.current?.(id, price, 'end')
          }
        },
        onClick: (event) => {
          if (event.figure?.key === 'close') onOrderLineCloseRef.current?.(id)
        },
        onRightClick: (event) => {
          event.preventDefault?.()
          rightClickHandledRef.current = true
          const items = getOrderLineMenuRef.current?.(id) ?? []
          if (items.length === 0) return
          setContextMenu({ kind: 'orderLine', x: event.pageX ?? 0, y: event.pageY ?? 0, id, items })
        },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderLines, cursorTime, colors, base, instrument, hoveredOrderLine])


  // FXR_V2_SPEC.md 3.5 (G3, reference R2): the Long / Short Position tool.
  // `startPositionTool` arms it (klinecharts' own one-click placement), the
  // click anchors it on a bar -- never later than the cursor bar, so nothing
  // reaches into unrevealed data -- and from then on the CALLER owns its levels:
  // this effect syncs the overlay to them (price tags, labels and zones all
  // redraw from the overlay's own points), except while a handle is mid-drag,
  // when klinecharts owns the handle until release. Drags are vertical only:
  // onPressedMoving turns the pointer's price into one handle's new level
  // (moveToolLevel keeps the tool coherent) and puts every point back on the
  // anchor at the authoritative prices.
  const onPositionToolDrawnRef = useRef(onPositionToolDrawn)
  onPositionToolDrawnRef.current = onPositionToolDrawn
  const onPositionToolChangeRef = useRef(onPositionToolChange)
  onPositionToolChangeRef.current = onPositionToolChange
  const onPositionToolRemoveRef = useRef(onPositionToolRemove)
  onPositionToolRemoveRef.current = onPositionToolRemove
  const getPositionToolMenuRef = useRef(getPositionToolMenu)
  getPositionToolMenuRef.current = getPositionToolMenu
  const onPositionToolInteractRef = useRef(onPositionToolInteract)
  onPositionToolInteractRef.current = onPositionToolInteract
  // The spec the overlay was last given (the placing phase has no caller state yet).
  const toolSpecRef = useRef<PositionToolSpec | null>(null)
  const toolLevelsRef = useRef<PositionToolLevels | null>(null)
  // The anchor bar, ms. Fixed at placement; the tool does not follow the cursor.
  const toolAnchorRef = useRef<number | null>(null)
  const toolPlacingRef = useRef(false)
  const toolDraggingRef = useRef(false)
  const toolMovedRef = useRef(false)

  const positionToolPalette = (): PositionToolPalette => {
    const c = colorsRef.current
    const b = baseRef.current
    return {
      entry: c.accent,
      sl: b.warning,
      tp: c.positive,
      surface: b.surface,
      text: b.text,
      textMuted: b.textMuted,
      positive: ensureTextVariant(c.positive, b.surface),
      negative: ensureTextVariant(c.negative, b.surface),
      onEntry: pickOnAccent(c.accent, ON_ACCENT_LIGHT, ON_ACCENT_DARK),
      onSl: pickOnAccent(b.warning, ON_ACCENT_LIGHT, ON_ACCENT_DARK),
      onTp: pickOnAccent(c.positive, ON_ACCENT_LIGHT, ON_ACCENT_DARK),
    }
  }
  const positionToolData = (tool: PositionToolSpec, hover: boolean): PositionToolData => ({
    levels: tool.levels,
    spec: tool.spec,
    sizing: tool.sizing,
    instrument: instrument ?? '',
    palette: positionToolPalette(),
    hover,
    anchorMs: toolAnchorRef.current ?? anchorSec() * 1000,
  })
  const setPositionToolHover = (hover: boolean) => {
    positionToolHoverRef.current = hover
    const tool = toolSpecRef.current
    if (tool && chartRef.current?.getOverlays({ id: POSITION_TOOL_ID }).length) {
      chartRef.current.overrideOverlay({ id: POSITION_TOOL_ID, extendData: positionToolData(tool, hover) })
    }
    if (!hover) setOrderLineCursor(null)
    syncCrosshairForOrderLines()
  }

  const positionToolCallbacks = (): Partial<OverlayCreate> => ({
    onPressedMoveStart: () => {
      toolDraggingRef.current = true
      toolMovedRef.current = false
    },
    onMouseEnter: () => setPositionToolHover(true),
    onMouseLeave: () => setPositionToolHover(false),
    // A handle or level shows a resize cursor; the x keeps the pointer.
    onMouseMove: (event) => {
      const key = event.figure?.key
      setOrderLineCursor(key === 'close' ? 'pointer' : key && key in HANDLE_INDEX ? 'ns-resize' : null)
    },
    onPressedMoving: (event) => {
      const chart = chartRef.current
      const current = toolLevelsRef.current
      const tool = toolSpecRef.current
      if (!chart || !current || !tool) return
      if (!toolMovedRef.current) {
        toolMovedRef.current = true
        onPositionToolInteractRef.current?.()
      }
      const key = event.figure?.key
      if (key === 'entry' || key === 'sl' || key === 'tp') {
        const raw = event.overlay.points[HANDLE_INDEX[key as ToolHandle]]?.value
        if (typeof raw === 'number') {
          const next = moveToolLevel(current, key as ToolHandle, raw, tool.spec.tickSize)
          toolLevelsRef.current = next
          onPositionToolChangeRef.current?.(next)
        }
      }
      // Whatever was grabbed, every point goes back on the anchor at the
      // authoritative prices: the drag is vertical and the tool never slides.
      const anchor = toolAnchorRef.current ?? anchorSec() * 1000
      chart.overrideOverlay({ id: POSITION_TOOL_ID, points: toolPoints(toolLevelsRef.current ?? current, anchor) })
    },
    onPressedMoveEnd: () => {
      toolDraggingRef.current = false
      toolMovedRef.current = false
    },
    onClick: (event) => {
      if (event.figure?.key === 'close') onPositionToolRemoveRef.current?.()
    },
    onRightClick: (event) => {
      event.preventDefault?.()
      rightClickHandledRef.current = true
      const items = getPositionToolMenuRef.current?.() ?? []
      if (items.length === 0) return
      setContextMenu({ kind: 'orderLine', x: event.pageX ?? 0, y: event.pageY ?? 0, id: POSITION_TOOL_ID, items })
    },
    // The placing click: the tool is anchored on the cursor bar -- "now", where its
    // entry price is -- wherever on the chart the click landed. Its three levels
    // go on the anchor and it is reported.
    onDrawEnd: () => {
      const chart = chartRef.current
      const tool = toolSpecRef.current
      toolPlacingRef.current = false
      activeDrawingIdRef.current = null
      onDrawingArmedChangeRef.current?.(null)
      if (!chart || !tool) return
      const cursor = cursorTimeRef.current
      const latest = loadedBarsRef.current[loadedBarsRef.current.length - 1]
      const anchor = snapToChart(cursor ?? latest?.time ?? 0) * 1000
      toolAnchorRef.current = anchor
      toolLevelsRef.current = tool.levels
      chart.overrideOverlay({ id: POSITION_TOOL_ID, points: toolPoints(tool.levels, anchor) })
      onPositionToolDrawnRef.current?.(tool.levels)
    },
  })

  const createPositionToolOverlay = (tool: PositionToolSpec, points?: ReturnType<typeof toolPoints>) =>
    chartRef.current?.createOverlay({
      id: POSITION_TOOL_ID,
      name: KL_POSITION_TOOL,
      groupId: POSITION_TOOL_GROUP_ID,
      lock: false,
      // Under the order lines (which must always win a click), over the drawings.
      zLevel: 9_000,
      fixedZLevel: true,
      ...(points ? { points } : {}),
      extendData: positionToolData(tool, false),
      ...positionToolCallbacks(),
    })

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const [existing] = chart.getOverlays({ id: POSITION_TOOL_ID })
    if (!positionTool) {
      // Cleared by the caller (placed, discarded, replaced). Not while the first
      // click is still pending -- that overlay is the one being placed.
      if (existing && !toolPlacingRef.current) {
        chart.removeOverlay({ id: POSITION_TOOL_ID })
        toolLevelsRef.current = null
        toolAnchorRef.current = null
        toolDraggingRef.current = false
        if (positionToolHoverRef.current) setPositionToolHover(false)
      }
      return
    }
    toolSpecRef.current = positionTool
    // The anchor never sits past the cursor: stepping the replay BACK (practice
    // sessions) re-anchors the tool on the cursor bar rather than leaving it on a
    // bar that is no longer revealed.
    const cursorMs = anchorSec() * 1000
    const anchor = cursorTimeRef.current !== null && toolAnchorRef.current !== null ? Math.min(toolAnchorRef.current, cursorMs) : (toolAnchorRef.current ?? cursorMs)
    toolAnchorRef.current = anchor
    if (!existing) {
      // Given levels with no click (the caller restored a tool): anchor on the cursor bar.
      toolAnchorRef.current = anchor
      toolLevelsRef.current = positionTool.levels
      createPositionToolOverlay(positionTool, toolPoints(positionTool.levels, anchor))
      return
    }
    if (toolPlacingRef.current) return
    const extendData = positionToolData(positionTool, positionToolHoverRef.current)
    if (toolDraggingRef.current) {
      chart.overrideOverlay({ id: POSITION_TOOL_ID, extendData })
      return
    }
    toolLevelsRef.current = positionTool.levels
    chart.overrideOverlay({ id: POSITION_TOOL_ID, extendData, points: toolPoints(positionTool.levels, anchor) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionTool, colors, base, instrument, cursorTime])

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
    setDetached(false)
    const bars = loadedBarsRef.current
    if (bars.length === 0) return
    const chartNow = chartRef.current
    const margin = chartNow ? effectiveRightMarginPx(chartNow) : 0
    if (!margin) {
      fitRangeImpl(bars[0].time, bars[bars.length - 1].time)
      return
    }
    // Fit every bar into the width LESS the right margin, and park the newest
    // bar that margin short of the edge (the order-label room, G2).
    withReadyChart(chartRef.current, true, (chart) => {
      const width = chart.getSize()?.width
      if (!width) return
      const space = Math.max(1, (width - margin) / bars.length)
      chart.setBarSpace(space)
      chart.scrollToDataIndex(bars.length - 2 + Math.ceil(margin / space), 200)
    })
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
      showLatest: (visibleBars) => {
        setDetached(false)
        withReadyChart(chartRef.current, loadedBarsRef.current.length > 0, (chart) => {
          const plan = firstViewPlan({
            paneWidth: containerRef.current?.clientWidth ?? chart.getSize()?.width ?? 0,
            marginPx: effectiveRightMarginPx(chart),
            barCount: chart.getDataList().length,
            visibleBars,
          })
          if (!plan) return
          chart.setBarSpace(plan.barSpace)
          chart.scrollToDataIndex(plan.scrollIndex, 0)
        })
      },
      scrollToLatest: () => {
        setDetached(false)
        withReadyChart(chartRef.current, loadedBarsRef.current.length > 0, (chart) => {
          // The newest bar `margin` short of the right edge, as showLatest places it.
          chart.scrollToDataIndex(chart.getDataList().length - 2 + rightMarginBars(chart), 200)
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
        toolPlacingRef.current = false
        onDrawingArmedChangeRef.current?.(null)
        // Explicit, not just relying on onRemoved: verified live that
        // removing a still-incomplete overlay (points placed < totalStep,
        // e.g. Escaping a 2-point Trend line after only the first click)
        // doesn't reliably fire onRemoved the way removing a completed one
        // does, which left a stale partial overlay in storage even though
        // the chart itself no longer showed it.
        persistDrawingsRef.current()
      },
      reloadDrawings: () => restoreDrawingsRef.current(),
      startPositionTool: (tool) => {
        const chart = chartRef.current
        if (!chart || loadedBarsRef.current.length === 0) return
        // One drawing in progress at a time; one position tool on the chart.
        const active = activeDrawingIdRef.current
        if (active) chart.removeOverlay({ id: active })
        chart.removeOverlay({ groupId: POSITION_TOOL_GROUP_ID })
        toolSpecRef.current = tool
        toolLevelsRef.current = null
        toolAnchorRef.current = null
        toolPlacingRef.current = true
        activeDrawingIdRef.current = POSITION_TOOL_ID
        onDrawingArmedChangeRef.current?.(tool.levels.side === 'long' ? POSITION_TOOL_LONG : POSITION_TOOL_SHORT)
        onPositionToolInteractRef.current?.()
        createPositionToolOverlay(tool)
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
      captureScreenshot: () => {
        const chart = chartRef.current
        if (!chart) return null
        // jpeg (not png): a full candle-pane screenshot is mostly opaque
        // background, and this gets persisted as a data URL directly in
        // trades.json (no object storage in this app) -- smaller payload
        // matters here more than lossless color. includeOverlay=true so
        // drawings/markup and the trade's own entry/SL/TP lines are baked
        // into the capture, matching "chart markup ... saved to the trade".
        return chart.getConvertPictureUrl(true, 'jpeg', baseRef.current.bg)
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
      {/* The axis, crosshair and legend are all Eastern Time (the chart is
          init'd with timezone America/New_York); this says so, in the empty
          corner under the price axis. */}
      <span className="pointer-events-none absolute bottom-1 right-2 z-10 text-[11px] font-medium tracking-wide text-text-muted">
        ET
      </span>
      {tooltip && !contextMenu && (
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
            <span className={`text-xs font-medium tabular-nums ${measureDrag.result.points >= 0 ? 'text-positive-fg' : 'text-negative-fg'}`}>
              {measureDrag.result.points >= 0 ? '+' : ''}
              {measureDrag.result.points.toFixed(2)} ({measureDrag.result.percent >= 0 ? '+' : ''}
              {measureDrag.result.percent.toFixed(2)}%)
            </span>
            <div className="mt-1 text-[11px] tabular-nums text-text-muted">
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
            // FXR_V2_SPEC.md 3.3 (R5): the order pair for the clicked price
            // sits on top, the chart's own items below a separator. Offered
            // only when the caller supplied them AND the click resolved to a
            // real price (never on an axis/sub-pane click).
            ...(() => {
              const extra =
                getEmptyAreaMenuExtraItems && contextMenu.time !== null && contextMenu.price !== null
                  ? getEmptyAreaMenuExtraItems({ time: contextMenu.time, price: contextMenu.price })
                  : []
              return extra.length > 0 ? [...extra, { separator: true } as const] : []
            })(),
            { label: 'Reset chart view', onSelect: resetView },
            { separator: true },
            { label: 'Remove all drawings', onSelect: removeAllDrawings, disabled: drawingCount() === 0, destructive: true },
          ]}
        />
      )}
      {contextMenu?.kind === 'orderLine' && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} label="Order line" onClose={() => setContextMenu(null)} items={contextMenu.items} />
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
