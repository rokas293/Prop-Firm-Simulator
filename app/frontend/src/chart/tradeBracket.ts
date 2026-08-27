// Pure geometry + hit-testing + formatting for on-chart trade brackets
// (POLISH_ROADMAP Phase P3). Kept separate from TradeBracketPrimitive so
// "does this point fall inside this trade's bracket", "is this trade too
// narrow to show a full box", and the tooltip text are all unit-testable
// without mounting a Lightweight Charts instance. Every value comes
// straight off the TradeRecord -- no recomputation (VIZ_SPEC section 0).
import type { TradeRecord } from '../api/types'
import type { ReplayTradeView } from './replay'

export type BracketDensity = 'auto' | 'full' | 'markers'
export type BracketOutcome = 'win' | 'loss' | 'open'

export interface BracketBounds {
  trade: TradeRecord
  outcome: BracketOutcome
  timeFrom: number
  timeTo: number
  priceLo: number
  priceHi: number
}

// A trade "wins" by the same >0 threshold already used for its entry/exit
// chart markers (PriceChart.tsx) -- kept identical so a bracket and its own
// markers never disagree about the outcome. A trade that hasn't exited yet
// as of the replay cursor is "open": its outcome (and therefore its PnL
// zone/label) isn't known yet, so it must not be shown -- no look-ahead.
export function bracketOutcome(view: ReplayTradeView): BracketOutcome {
  if (!view.showExit) return 'open'
  return view.trade.pnl_usd > 0 ? 'win' : 'loss'
}

// The bracket's full extent, including its SL/TP corridors -- this is also
// the hover hit-test region, so hovering anywhere over the shaded
// risk/reward area (not just the thin PnL box itself) surfaces the tooltip.
export function computeBracketBounds(view: ReplayTradeView): BracketBounds {
  const t = view.trade
  const outcome = bracketOutcome(view)
  const prices = [t.entry_price]
  if (outcome !== 'open') prices.push(t.exit_price)
  if (t.sl_price !== null) prices.push(t.sl_price)
  if (t.tp_price !== null) prices.push(t.tp_price)
  return {
    trade: t,
    outcome,
    timeFrom: t.entry_time,
    timeTo: view.openSpanEnd,
    priceLo: Math.min(...prices),
    priceHi: Math.max(...prices),
  }
}

export function hitTestBracket(bounds: BracketBounds, time: number, price: number): boolean {
  return time >= bounds.timeFrom && time <= bounds.timeTo && price >= bounds.priceLo && price <= bounds.priceHi
}

// Later trades are drawn on top (same iteration order as the renderer), so
// on overlap the most-recently-entered trade wins the hit test.
export function findBracketAt(views: ReplayTradeView[], time: number, price: number): TradeRecord | null {
  let found: TradeRecord | null = null
  for (const view of views) {
    if (hitTestBracket(computeBracketBounds(view), time, price)) found = view.trade
  }
  return found
}

// Below this on-screen pixel width, a full bracket (box + SL/TP corridors +
// label) collapses to a single small marker -- otherwise a full day/week of
// trades zoomed out turns into a wall of overlapping boxes (POLISH_ROADMAP
// Phase P3: "density control").
export const MIN_BRACKET_WIDTH_PX = 28
export const MIN_LABEL_WIDTH_PX = 64

export function shouldSimplify(widthPx: number, density: BracketDensity): boolean {
  if (density === 'markers') return true
  if (density === 'full') return false
  return widthPx < MIN_BRACKET_WIDTH_PX
}

export function shouldShowLabel(widthPx: number): boolean {
  return widthPx >= MIN_LABEL_WIDTH_PX
}

function formatClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

// Hover tooltip content (POLISH_ROADMAP Phase P3: "tooltip with full trade
// detail"). One string, newline-joined, written straight into a DOM node's
// textContent by the caller -- see PriceChart.tsx's crosshair handler.
export function formatBracketTooltip(t: TradeRecord): string {
  const pnlSign = t.pnl_usd >= 0 ? '+' : '-'
  const rText = t.r_multiple !== null ? `  (${t.r_multiple >= 0 ? '+' : ''}${t.r_multiple.toFixed(2)}R)` : ''
  const rows = [
    `#${t.trade_id}  ${t.side}  ·  ${t.leg ?? '-'}  ·  ${t.session ?? '-'}`,
    `Entry ${t.entry_price.toFixed(2)} @ ${formatClock(t.entry_time)}`,
    `Exit  ${t.exit_price.toFixed(2)} @ ${formatClock(t.exit_time)}  (${t.exit_type})`,
    `PnL ${pnlSign}$${Math.abs(t.pnl_usd).toFixed(2)}${rText}`,
    `MAE ${t.mae_points.toFixed(2)} pts  ·  MFE ${t.mfe_points.toFixed(2)} pts`,
    `Bars held: ${t.bars_held}`,
  ]
  return rows.join('\n')
}
