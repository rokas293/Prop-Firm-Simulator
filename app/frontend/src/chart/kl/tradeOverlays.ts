// Pure trade-visual overlay builders for the KLineCharts engine
// (PART_A_REVISED_klinecharts.md Phase A1). Kept framework-free (no chart/
// React imports) so it's unit-testable without mounting a chart, same
// pattern as chart/tradeBracket.ts.
//
// DESIGN_LANGUAGE.md redesign: entry/exit used to be a verbose floating
// text label ("long entry" / "tp win") on a dashed stem several dozen
// pixels above the bar -- cluttered, and visually disconnected from the
// actual fill price. Replaced with a compact triangle marker sitting
// exactly AT the fill price (TradingView-execution-style): direction
// encodes the trade action (up = buy, down = sell), color encodes
// side/outcome, and the verbose detail moved to the existing hover
// tooltip (chart/tradeBracket.ts's formatBracketTooltip). An inline label
// is drawn only for the selected trade, so a busy day of markers stays
// readable.
import { registerOverlay } from 'klinecharts'
import type { OverlayCreate, OverlayFigure } from 'klinecharts'
import type { ThemeColors } from '../../state/themeStore'
import { hexToRgba } from '../color'
import { registerRectOverlay } from './rectOverlay'
import type { ReplayTradeView } from '../replay'
import { computeBracketBounds, shouldSimplify, type BracketDensity } from '../tradeBracket'

export const ENTRY_EXIT_GROUP = 'kl-trade-entry-exit'
export const SL_TP_LINE_GROUP = 'kl-trade-sltp-lines'
export const ZONE_GROUP = 'kl-trade-zones'

// klinecharts' DEFAULT behavior for ANY right-click that hits a figure
// without ignoreEvent is to DELETE the overlay outright, unless its
// onRightClick handler calls this preventDefault (confirmed against the
// v10.0.3 source -- not documented, and genuinely surprising). Every
// figure this file draws itself (the trade markers, the bracket zones) is
// already ignoreEvent:true and immune, but the SL/TP lines below ride the
// BUILT-IN `horizontalSegment` overlay, whose built-in `line` figure is
// interactive by klinecharts' own design -- without this, right-clicking
// a stop-loss line would silently delete it.
function suppressRightClickDelete(event: { preventDefault?: () => void }): void {
  event.preventDefault?.()
}

// TradeRecord/Bar times are unix SECONDS (VIZ_SPEC §6); klinecharts' own
// KLineData.timestamp -- and therefore every OverlayCreate point's own
// `timestamp` -- is MILLISECONDS. Missing this conversion doesn't error;
// it silently produces a garbage (far-past, often negative/off-screen)
// x-coordinate, which is exactly why priceLine still looked right (its Y
// position only depends on price, not this timestamp) while every
// point-anchored overlay (annotations, zone rects) rendered nowhere.
function toMs(seconds: number): number {
  return seconds * 1000
}

// Non-interactive (ignoreEvent: true) since these are derived, read-only
// trade visuals, not user-editable drawings -- see rectOverlay.ts for the
// shared geometry, also used by the user-drawn "Zone" tool (Phase A2).
const TRADE_ZONE_OVERLAY = 'klTradeZone'

export function ensureTradeZoneOverlayRegistered(): void {
  registerRectOverlay(TRADE_ZONE_OVERLAY, false)
}

// A compact, single-point marker: a small filled triangle whose TIP sits
// exactly at the anchor (time, price) -- the actual fill price, not a
// padded offset above the bar -- with an optional short text label beside
// it. `direction` is the trade ACTION at that point (up = buy, down =
// sell), not win/loss, so entries/exits at either side of a round-trip
// point the way the tape actually moved:
//   long entry / short exit (buy)  -> up,   tip-up triangle below the price
//   short entry / long exit (sell) -> down, tip-down triangle above the price
const TRADE_MARKER_OVERLAY = 'klTradeMarker'

interface TradeMarkerData {
  direction: 'up' | 'down'
  color: string
  label?: string
}

// Half-width/height of the triangle, in px -- deliberately small (a
// "compact" marker per the redesign brief), legible at any zoom since it's
// a fixed pixel size, not derived from bar width.
const MARKER_HALF_WIDTH = 4
const MARKER_HEIGHT = 7
const MARKER_LABEL_GAP = 5

let markerOverlayRegistered = false

export function ensureTradeMarkerOverlayRegistered(): void {
  if (markerOverlayRegistered) return
  markerOverlayRegistered = true
  registerOverlay({
    name: TRADE_MARKER_OVERLAY,
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates }) => {
      const [p] = coordinates
      if (!p) return []
      const data = overlay.extendData as TradeMarkerData
      const baseY = data.direction === 'up' ? p.y + MARKER_HEIGHT : p.y - MARKER_HEIGHT
      const figures: OverlayFigure[] = [
        {
          type: 'polygon',
          attrs: {
            coordinates: [
              { x: p.x, y: p.y },
              { x: p.x - MARKER_HALF_WIDTH, y: baseY },
              { x: p.x + MARKER_HALF_WIDTH, y: baseY },
            ],
          },
          styles: { style: 'fill', color: data.color },
          ignoreEvent: true,
        },
      ]
      if (data.label) {
        figures.push({
          type: 'text',
          attrs: {
            x: p.x + MARKER_HALF_WIDTH + MARKER_LABEL_GAP,
            y: p.y,
            text: data.label,
            align: 'left',
            baseline: 'middle',
          },
          styles: { color: data.color, size: 11 },
          ignoreEvent: true,
        })
      }
      return figures
    },
  })
}

function tradeMarker(
  id: string,
  timestamp: number,
  price: number,
  direction: 'up' | 'down',
  color: string,
  label?: string,
): OverlayCreate {
  return {
    id,
    name: TRADE_MARKER_OVERLAY,
    groupId: ENTRY_EXIT_GROUP,
    lock: true,
    points: [{ timestamp: toMs(timestamp), value: price }],
    extendData: { direction, color, label } satisfies TradeMarkerData,
  }
}

// Entry/exit markers for every visible trade (PriceChart.tsx's marker
// effect draws one per trade in `trades`, not just the selected one -- same
// scope here). Takes ReplayTradeView[] (chart/replay.ts's existing, tested
// filterTradesForReplay output) -- same "reveal at entry, hide the exit
// until it's happened" contract PriceChart.tsx's own marker effect already
// implements for lightweight-charts (VIZ_SPEC §0: no look-ahead). In
// non-replay mode (cursorTime null) filterTradesForReplay itself returns
// every trade with showExit:true, so this behaves exactly as before.
//
// The inline label is populated ONLY for the selected trade (`emphasize`)
// -- every other trade gets the bare marker, so a busy session doesn't
// drown in text; full detail (side, leg, PnL, R, entry/exit, SL/TP) is
// always available via the hover tooltip (formatBracketTooltip) for any
// trade, selected or not.
export function buildEntryExitOverlays(
  views: ReplayTradeView[],
  selectedTradeId: number | null,
  colors: ThemeColors,
): OverlayCreate[] {
  const overlays: OverlayCreate[] = []
  for (const { trade: t, showExit } of views) {
    const emphasize = t.trade_id === selectedTradeId
    const entryDirection: 'up' | 'down' = t.side === 'long' ? 'up' : 'down'
    overlays.push(
      tradeMarker(
        `kl-entry-${t.trade_id}`,
        t.entry_time,
        t.entry_price,
        entryDirection,
        colors.accent,
        emphasize ? t.entry_price.toFixed(2) : undefined,
      ),
    )
    if (showExit && t.exit_time > t.entry_time) {
      const win = t.pnl_usd > 0
      // Exiting is the opposite action of entering: closing a long is a
      // sell (down), closing a short is a buy-to-cover (up).
      const exitDirection: 'up' | 'down' = t.side === 'long' ? 'down' : 'up'
      const exitColor = win ? colors.positive : colors.negative
      const exitLabel = emphasize
        ? t.r_multiple !== null
          ? `${t.r_multiple >= 0 ? '+' : ''}${t.r_multiple.toFixed(2)}R`
          : `${t.pnl_usd >= 0 ? '+' : '-'}$${Math.abs(t.pnl_usd).toFixed(0)}`
        : undefined
      overlays.push(tradeMarker(`kl-exit-${t.trade_id}`, t.exit_time, t.exit_price, exitDirection, exitColor, exitLabel))
    }
  }
  return overlays
}

// SL/TP levels for the SELECTED trade only -- exactly PriceChart.tsx's
// split (its SL/TP price-line effect is keyed on `selectedTrade`, not
// `trades`). Takes a ReplayTradeView (or null) -- SL/TP are the PLANNED
// levels known from the moment of entry, so their lines render regardless
// of whether the trade has exited yet (VIZ_SPEC §0: no look-ahead is about
// the PnL zone's outcome, not these), growing to `openSpanEnd` (the replay
// cursor) while still open, same as the zone corridors below.
//
// DESIGN_LANGUAGE.md redesign: these used to be a klinecharts `priceLine`,
// which draws from its anchor rightward to the pane's edge regardless of
// how long the trade actually lasted -- a stale SL/TP level would visually
// bleed across every later trade. `horizontalSegment` (already used by
// sessionOverlay.ts's fair-value lines for the identical reason) is a
// plain two-point line, so bounding it to [entry_time, the trade's own
// close] makes the level disappear along with the trade it belonged to.
export function buildSelectedTradeOverlays(view: ReplayTradeView | null, colors: ThemeColors): OverlayCreate[] {
  if (!view) return []
  const trade = view.trade
  const bounds = computeBracketBounds(view)
  const overlays: OverlayCreate[] = []

  if (trade.sl_price !== null) {
    overlays.push({
      id: `kl-sl-line-${trade.trade_id}`,
      name: 'horizontalSegment',
      groupId: SL_TP_LINE_GROUP,
      lock: true,
      points: [
        { timestamp: toMs(trade.entry_time), value: trade.sl_price },
        { timestamp: toMs(bounds.timeTo), value: trade.sl_price },
      ],
      styles: { line: { color: colors.negative, style: 'dashed', size: 1 } },
      onRightClick: suppressRightClickDelete,
    })
  }
  if (trade.tp_price !== null) {
    overlays.push({
      id: `kl-tp-line-${trade.trade_id}`,
      name: 'horizontalSegment',
      groupId: SL_TP_LINE_GROUP,
      lock: true,
      points: [
        { timestamp: toMs(trade.entry_time), value: trade.tp_price },
        { timestamp: toMs(bounds.timeTo), value: trade.tp_price },
      ],
      styles: { line: { color: colors.positive, style: 'dashed', size: 1 } },
      onRightClick: suppressRightClickDelete,
    })
  }

  return overlays
}

// The KL counterpart to PriceChart.tsx's TradeBracketPrimitive (PART_A_
// REVISED_klinecharts.md's parity audit) -- one PnL/SL/TP zone box per
// VISIBLE trade (not just the selected one), collapsing to nothing but its
// existing entry/exit marker (buildEntryExitOverlays already draws that,
// for every trade, unconditionally) when `widthPx` is too narrow to read --
// reuses tradeBracket.ts's shouldSimplify exactly as TradeBracketPrimitive
// does, so the two engines collapse at the same zoom level. `widthPx` is
// supplied by the caller (ChartKL resolves it via chart.convertToPixel,
// which this framework-free module can't do itself) -- same "pass in what
// needs the chart instance, keep the builder pure" pattern as `bars`/
// `leftEdgeTime` elsewhere in this file. The selected trade still gets a
// box here (matching TradeBracketPrimitive, which does not skip it either)
// -- only its border thickens, via `isSelected`.
//
// DESIGN_LANGUAGE.md redesign: fills quieted (PnL 0.18->0.10 fill,
// 0.9->0.55 border; SL/TP corridor 0.08->0.05) so the new triangle markers
// read as the primary signal and the zones stay a background cue, not
// competing color -- "restraint is the aesthetic" (DESIGN_LANGUAGE.md §1).
export function buildTradeBracketOverlays(
  views: ReplayTradeView[],
  selectedTradeId: number | null,
  density: BracketDensity,
  widthPxFor: (view: ReplayTradeView) => number | null,
  colors: ThemeColors,
): OverlayCreate[] {
  const overlays: OverlayCreate[] = []
  for (const view of views) {
    const widthPx = widthPxFor(view)
    if (widthPx === null || shouldSimplify(widthPx, density)) continue
    const trade = view.trade
    const bounds = computeBracketBounds(view)
    const isSelected = trade.trade_id === selectedTradeId
    const borderSize = isSelected ? 2 : 1

    if (trade.sl_price !== null) {
      overlays.push({
        id: `kl-bracket-sl-${trade.trade_id}`,
        name: TRADE_ZONE_OVERLAY,
        groupId: ZONE_GROUP,
        lock: true,
        points: [
          { timestamp: toMs(trade.entry_time), value: trade.entry_price },
          { timestamp: toMs(bounds.timeTo), value: trade.sl_price },
        ],
        styles: { rect: { style: 'fill', color: hexToRgba(colors.negative, 0.05) } },
      })
    }
    if (trade.tp_price !== null) {
      overlays.push({
        id: `kl-bracket-tp-${trade.trade_id}`,
        name: TRADE_ZONE_OVERLAY,
        groupId: ZONE_GROUP,
        lock: true,
        points: [
          { timestamp: toMs(trade.entry_time), value: trade.entry_price },
          { timestamp: toMs(bounds.timeTo), value: trade.tp_price },
        ],
        styles: { rect: { style: 'fill', color: hexToRgba(colors.positive, 0.05) } },
      })
    }

    if (bounds.outcome === 'open') continue // exit_price/outcome unknown yet -- no look-ahead (VIZ_SPEC §0)
    const win = bounds.outcome === 'win'
    const stroke = win ? colors.positive : colors.negative
    overlays.push({
      id: `kl-bracket-pnl-${trade.trade_id}`,
      name: TRADE_ZONE_OVERLAY,
      groupId: ZONE_GROUP,
      lock: true,
      points: [
        { timestamp: toMs(trade.entry_time), value: trade.entry_price },
        { timestamp: toMs(bounds.timeTo), value: trade.exit_price },
      ],
      styles: {
        rect: { style: 'stroke_fill', color: hexToRgba(stroke, 0.1), borderColor: hexToRgba(stroke, 0.55), borderSize },
      },
    })
  }
  return overlays
}
