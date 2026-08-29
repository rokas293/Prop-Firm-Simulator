// Pure trade-visual overlay builders for the KLineCharts engine
// (PART_A_REVISED_klinecharts.md Phase A1). Mirrors PriceChart.tsx's
// markers/price-lines/span exactly in spirit -- same colors, same source
// fields off TradeRecord, no recomputation (VIZ_SPEC section 0) -- just
// expressed as klinecharts OverlayCreate objects instead of Lightweight
// Charts series markers/price lines. Kept framework-free (no chart/React
// imports) so it's unit-testable without mounting a chart, same pattern as
// chart/tradeBracket.ts.
import type { OverlayCreate } from 'klinecharts'
import type { ThemeColors } from '../../state/themeStore'
import { hexToRgba } from '../color'
import { registerRectOverlay } from './rectOverlay'
import type { ReplayTradeView } from '../replay'
import { computeBracketBounds, shouldSimplify, type BracketDensity } from '../tradeBracket'

export const ENTRY_EXIT_GROUP = 'kl-trade-entry-exit'
export const SL_TP_LINE_GROUP = 'kl-trade-sltp-lines'
export const ZONE_GROUP = 'kl-trade-zones'

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

function entryExitAnnotation(
  id: string,
  timestamp: number,
  anchorPrice: number,
  text: string,
  color: string,
  emphasize: boolean,
): OverlayCreate {
  return {
    id,
    name: 'simpleAnnotation',
    groupId: ENTRY_EXIT_GROUP,
    lock: true,
    points: [{ timestamp: toMs(timestamp), value: anchorPrice }],
    extendData: text,
    styles: {
      line: { color, size: emphasize ? 2 : 1 },
      polygon: { color, borderColor: color },
      text: { color, size: emphasize ? 13 : 12 },
    },
  }
}

// Entry/exit markers for every visible trade (PriceChart.tsx's marker
// effect draws one per trade in `trades`, not just the selected one -- same
// scope here). Takes ReplayTradeView[] (chart/replay.ts's existing, tested
// filterTradesForReplay output), not raw TradeRecord[] -- same "reveal at
// entry, hide the exit until it's happened" contract PriceChart.tsx's own
// marker effect already implements for lightweight-charts (VIZ_SPEC §0: no
// look-ahead). In non-replay mode (cursorTime null) filterTradesForReplay
// itself returns every trade with showExit:true, so this behaves exactly
// as before. `simpleAnnotation`'s fixed geometry (confirmed from source: a
// dashed stem + downward arrow + text, always extending upward from its
// anchor point) doesn't have a mirrored "point up from below" variant the
// way Lightweight Charts' arrowUp/belowBar marker does, so long and short
// entries aren't distinguished by arrow direction here -- only by color
// (accent, matching PriceChart's entry color exactly) and by the label
// text ("long entry"/"short entry"), which is unambiguous. Anchored just
// above each relevant bar's high so the arrow reads naturally as pointing
// down onto the bar regardless of side.
export function buildEntryExitOverlays(
  views: ReplayTradeView[],
  bars: { time: number; high: number }[],
  selectedTradeId: number | null,
  colors: ThemeColors,
): OverlayCreate[] {
  const overlays: OverlayCreate[] = []
  for (const { trade: t, showExit } of views) {
    const emphasize = t.trade_id === selectedTradeId
    const entryBar = findBarAtOrBefore(bars, t.entry_time)
    const entryAnchor = (entryBar?.high ?? t.entry_price) + anchorPad(entryBar?.high ?? t.entry_price)
    overlays.push(
      entryExitAnnotation(
        `kl-entry-${t.trade_id}`,
        t.entry_time,
        entryAnchor,
        `${t.side} entry`,
        colors.accent,
        emphasize,
      ),
    )
    if (showExit && t.exit_time > t.entry_time) {
      const win = t.pnl_usd > 0
      const exitBar = findBarAtOrBefore(bars, t.exit_time)
      const exitAnchor = (exitBar?.high ?? t.exit_price) + anchorPad(exitBar?.high ?? t.exit_price)
      overlays.push(
        entryExitAnnotation(
          `kl-exit-${t.trade_id}`,
          t.exit_time,
          exitAnchor,
          `${t.exit_type} ${win ? 'win' : 'loss'}`,
          win ? colors.up : colors.down,
          emphasize,
        ),
      )
    }
  }
  return overlays
}

function anchorPad(price: number): number {
  // A small fixed fraction of price so the annotation clears the wick
  // regardless of instrument scale (works for MES's ~5000 and ZN's ~110
  // alike) without needing the tick-size table just for this.
  return Math.abs(price) * 0.001 || 0.01
}

function findBarAtOrBefore<T extends { time: number }>(bars: T[], time: number): T | null {
  let result: T | null = null
  for (const b of bars) {
    if (b.time > time) break
    result = b
  }
  return result
}

// SL/TP price lines for the SELECTED trade only -- exactly PriceChart.tsx's
// split (its SL/TP price-line effect is keyed on `selectedTrade`, not
// `trades`). Takes a ReplayTradeView (or null), same as
// buildEntryExitOverlays -- SL/TP are the PLANNED levels known from the
// moment of entry, so their lines render regardless of whether the trade
// has exited yet (VIZ_SPEC §0: no look-ahead is about the PnL zone's
// outcome, not these). `priceLine`'s built-in geometry draws from its own
// anchor point rightward to the pane edge (confirmed from v10.0.3 source),
// not the full pane width both directions like Lightweight Charts'
// createPriceLine -- anchoring at `leftEdgeTime` (the earliest loaded bar)
// makes it span the whole visible chart to match. The PnL/SL/TP shaded
// zones themselves live in buildTradeBracketOverlays below, which covers
// every trade (selected included, via a thicker border) -- exactly
// PriceChart.tsx's own split between its selected-trade price-line effect
// and its all-trades TradeBracketPrimitive.
export function buildSelectedTradeOverlays(
  view: ReplayTradeView | null,
  leftEdgeTime: number | null,
  colors: ThemeColors,
): OverlayCreate[] {
  if (!view || leftEdgeTime === null) return []
  const trade = view.trade
  const overlays: OverlayCreate[] = []

  if (trade.sl_price !== null) {
    overlays.push({
      id: `kl-sl-line-${trade.trade_id}`,
      name: 'priceLine',
      groupId: SL_TP_LINE_GROUP,
      lock: true,
      points: [{ timestamp: toMs(leftEdgeTime), value: trade.sl_price }],
      styles: { line: { color: colors.down, style: 'dashed', size: 2 }, text: { color: colors.down } },
    })
  }
  if (trade.tp_price !== null) {
    overlays.push({
      id: `kl-tp-line-${trade.trade_id}`,
      name: 'priceLine',
      groupId: SL_TP_LINE_GROUP,
      lock: true,
      points: [{ timestamp: toMs(leftEdgeTime), value: trade.tp_price }],
      styles: { line: { color: colors.up, style: 'dashed', size: 2 }, text: { color: colors.up } },
    })
  }

  return overlays
}

// The KL counterpart to PriceChart.tsx's TradeBracketPrimitive (PART_A_
// REVISED_klinecharts.md's parity audit) -- one PnL/SL/TP zone box per
// VISIBLE trade (not just the selected one), collapsing to nothing but its
// existing entry/exit annotation (buildEntryExitOverlays already draws
// that, for every trade, unconditionally) when `widthPx` is too narrow to
// read -- reuses tradeBracket.ts's shouldSimplify exactly as
// TradeBracketPrimitive does, so the two engines collapse at the same
// zoom level. `widthPx` is supplied by the caller (ChartKL resolves it via
// chart.convertToPixel, which this framework-free module can't do itself)
// -- same "pass in what needs the chart instance, keep the builder pure"
// pattern as `bars`/`leftEdgeTime` elsewhere in this file. The selected
// trade still gets a box here (matching TradeBracketPrimitive, which does
// not skip it either) -- only its border thickens, via `isSelected`, since
// buildSelectedTradeOverlays above no longer duplicates this zone.
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
        styles: { rect: { style: 'fill', color: hexToRgba(colors.down, 0.08) } },
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
        styles: { rect: { style: 'fill', color: hexToRgba(colors.up, 0.08) } },
      })
    }

    if (bounds.outcome === 'open') continue // exit_price/outcome unknown yet -- no look-ahead (VIZ_SPEC §0)
    const win = bounds.outcome === 'win'
    const stroke = win ? colors.up : colors.down
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
        rect: { style: 'stroke_fill', color: hexToRgba(stroke, 0.18), borderColor: hexToRgba(stroke, 0.9), borderSize },
      },
    })
  }
  return overlays
}
