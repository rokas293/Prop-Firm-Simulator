// The "stops clipping winners" predicate (POLISH_ROADMAP Phase P5, VIZ_SPEC
// section 4's MAE/MFE note): a trade that got stopped out yet still
// traveled at least its own planned TP distance in favorable excursion at
// some point -- i.e. it would have been a winner at a wider stop. Extracted
// from DashboardPanel's MAE/MFE scatter (POLISH_ROADMAP Phase P2) so
// CompassPanel's regime breakdown and the Dashboard scatter can never
// disagree about which trades count as "clipped." Pure read of
// already-engine-computed fields -- no recomputation.
import type { TradeRecord } from '../api/types'

export function isClippedStop(t: TradeRecord): boolean {
  return t.exit_type === 'sl' && t.tp_points !== null && t.mfe_points >= t.tp_points
}

export interface MaeMfeRegime {
  losses: number
  clippedStops: number
  clippedStopsShare: number | null // clippedStops / losses, null when there are no losses
  avgMaeToSlRatio: number | null // mean(mae_points / sl_points) across trades with sl_points set -- how close, on average, adverse excursion got to the stop
}

export function computeMaeMfeRegime(trades: TradeRecord[]): MaeMfeRegime {
  const losses = trades.filter((t) => t.pnl_usd <= 0)
  const clipped = losses.filter(isClippedStop)

  const ratios = trades
    .filter((t): t is TradeRecord & { sl_points: number } => t.sl_points !== null && t.sl_points > 0)
    .map((t) => t.mae_points / t.sl_points)

  return {
    losses: losses.length,
    clippedStops: clipped.length,
    clippedStopsShare: losses.length > 0 ? clipped.length / losses.length : null,
    avgMaeToSlRatio: ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
  }
}
