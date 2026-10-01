// "Heat" (FXR_SPEC.md section D: "reuse MAE/MFE to show how much heat trades
// take before resolving"): how far each trade went against the entry, in
// multiples of its own planned risk (mae_r, already computed per trade by the
// sim broker / engine), split by whether the trade ultimately won. Pure
// descriptive aggregation of existing fields -- same standing as the R
// histogram and the MAE/MFE scatter in DashboardPanel.
import type { TradeRecord } from '../api/types'

export const HEAT_BUCKET_R = 0.25

export interface HeatBucket {
  r: number // bucket lower bound, in R
  winners: number
  losers: number
}

export interface HeatSummary {
  buckets: HeatBucket[]
  sample: number // trades with a known mae_r (needs a stop to define 1R)
  winnersMedianR: number | null
  losersMedianR: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function heatSummary(trades: TradeRecord[]): HeatSummary {
  const withHeat = trades.filter((t): t is TradeRecord & { mae_r: number } => t.mae_r !== null)
  if (withHeat.length === 0) return { buckets: [], sample: 0, winnersMedianR: null, losersMedianR: null }

  const maxBucket = Math.max(...withHeat.map((t) => Math.floor(t.mae_r / HEAT_BUCKET_R)))
  const buckets: HeatBucket[] = Array.from({ length: maxBucket + 1 }, (_, i) => ({
    r: +(i * HEAT_BUCKET_R).toFixed(2),
    winners: 0,
    losers: 0,
  }))
  for (const t of withHeat) {
    const b = buckets[Math.floor(t.mae_r / HEAT_BUCKET_R)]
    if (t.pnl_usd > 0) b.winners += 1
    else b.losers += 1
  }

  return {
    buckets,
    sample: withHeat.length,
    winnersMedianR: median(withHeat.filter((t) => t.pnl_usd > 0).map((t) => t.mae_r)),
    losersMedianR: median(withHeat.filter((t) => t.pnl_usd <= 0).map((t) => t.mae_r)),
  }
}
