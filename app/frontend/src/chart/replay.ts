// Pure, framework-free replay-cursor filtering (VIZ_SPEC section 0: "no
// look-ahead in the picture either" -- replay must respect the same "data
// <= cursor" rule as the backtest engine). Kept separate from PriceChart
// so the filtering logic is directly unit-testable without mounting a
// Lightweight Charts instance.
import type { Bar, EquityPoint, TradeRecord } from '../api/types'

// cursorTime === null means "not in replay mode" -- everything is visible,
// matching the chart's normal (non-replay) behavior.
export function filterBarsForReplay(bars: Bar[], cursorTime: number | null): Bar[] {
  if (cursorTime === null) return bars
  return bars.filter((b) => b.time <= cursorTime)
}

export interface ReplayTradeView {
  trade: TradeRecord
  // Whether the exit has happened yet as of the cursor -- if false, the
  // trade is still "open" from the replay's point of view even though the
  // full historical record already contains its (future, hidden) exit.
  showExit: boolean
  // End of the "position open" shading span: the real exit time once it's
  // happened, otherwise the cursor itself (the position visually grows
  // open as replay advances, rather than jumping straight to a future exit).
  openSpanEnd: number
}

// Trades whose entry hasn't happened yet as of the cursor are omitted
// entirely -- they don't exist from the replay's point of view.
export function filterTradesForReplay(trades: TradeRecord[], cursorTime: number | null): ReplayTradeView[] {
  if (cursorTime === null) {
    return trades.map((trade) => ({ trade, showExit: true, openSpanEnd: trade.exit_time }))
  }
  return trades
    .filter((trade) => trade.entry_time <= cursorTime)
    .map((trade) => {
      const showExit = trade.exit_time <= cursorTime
      return { trade, showExit, openSpanEnd: showExit ? trade.exit_time : cursorTime }
    })
}

// Latest equity point at or before the cursor -- the engine-computed
// balance/equity/mll_floor "as of now" for the live readout. `points` must
// be sorted ascending by time (true of /api/equity responses). Pure lookup,
// no recomputation: VIZ_SPEC's "frontend does zero financial math".
export function equityAtCursor(points: EquityPoint[], cursorTime: number | null): EquityPoint | null {
  if (cursorTime === null || points.length === 0) return null
  let result: EquityPoint | null = null
  for (const p of points) {
    if (p.time > cursorTime) break
    result = p
  }
  return result
}

// Sum of realized pnl_usd/r_multiple for trades already closed (exit_time
// <= cursor) among the given set -- simple aggregation of already-computed
// per-trade engine outputs, same category as counting wins/losses.
export function runningTotals(trades: TradeRecord[], cursorTime: number | null): { pnlUsd: number; r: number } {
  const closed = cursorTime === null ? trades : trades.filter((t) => t.exit_time <= cursorTime)
  let pnlUsd = 0
  let r = 0
  for (const t of closed) {
    pnlUsd += t.pnl_usd
    r += t.r_multiple ?? 0
  }
  return { pnlUsd, r }
}
