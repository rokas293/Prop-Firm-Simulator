// Shapes the /monte-carlo response (propbt.sim.monte_carlo's trade-sequence
// Monte Carlo, computed server-side) into rows for the fan chart. Reshaping
// only -- every percentile and probability comes from the engine.
import type { MonteCarloResponse } from '../api/types'

export interface FanRow {
  trade: number // 0 = before the first trade
  band90: [number, number] // 5th..95th percentile of cumulative P&L
  band50: [number, number] // 25th..75th
  median: number
  actual: number
}

export function fanRows(mc: MonteCarloResponse): FanRow[] {
  return mc.actual_path.map((actual, i) => ({
    trade: i,
    band90: [mc.fan['5'][i], mc.fan['95'][i]],
    band50: [mc.fan['25'][i], mc.fan['75'][i]],
    median: mc.fan['50'][i],
    actual,
  }))
}

// Where the realized terminal P&L ranks among the simulated ones, as a
// fraction of the 5/25/50/75/95 percentile grid the server returns -- coarse
// on purpose (we only have those five points), so it is reported as a band,
// never as a fake-precise percentile.
export function actualRankBand(mc: MonteCarloResponse): string {
  const actual = mc.actual_final_pnl
  const p = (k: string) => mc.final_pnl_pct[k]
  if (actual < p('5')) return 'below the 5th percentile'
  if (actual < p('25')) return 'between the 5th and 25th percentile'
  if (actual < p('50')) return 'between the 25th and 50th percentile'
  if (actual < p('75')) return 'between the 50th and 75th percentile'
  if (actual < p('95')) return 'between the 75th and 95th percentile'
  return 'above the 95th percentile'
}
