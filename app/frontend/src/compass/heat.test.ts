import { describe, expect, it } from 'vitest'
import type { TradeRecord } from '../api/types'
import { heatSummary } from './heat'

function t(pnl: number, maeR: number | null): TradeRecord {
  return { pnl_usd: pnl, mae_r: maeR } as TradeRecord
}

describe('heatSummary', () => {
  it('buckets adverse excursion in R by outcome and reports the median heat of winners vs losers', () => {
    // winners' heat: 0.10, 0.30, 0.60 -> median 0.30; losers' heat: 0.90, 1.00 -> median 0.95
    const s = heatSummary([t(100, 0.1), t(50, 0.3), t(80, 0.6), t(-100, 0.9), t(-100, 1.0)])
    expect(s.sample).toBe(5)
    expect(s.winnersMedianR).toBeCloseTo(0.3)
    expect(s.losersMedianR).toBeCloseTo(0.95)
    // 0.25R buckets: [0,.25) [.25,.5) [.5,.75) [.75,1.0) [1.0,1.25)
    expect(s.buckets.map((b) => [b.r, b.winners, b.losers])).toEqual([
      [0, 1, 0],
      [0.25, 1, 0],
      [0.5, 1, 0],
      [0.75, 0, 1],
      [1, 0, 1],
    ])
  })

  it('ignores trades with no defined R (no stop) and is empty-safe', () => {
    expect(heatSummary([t(10, null)])).toEqual({ buckets: [], sample: 0, winnersMedianR: null, losersMedianR: null })
    expect(heatSummary([]).sample).toBe(0)
    const s = heatSummary([t(10, null), t(-5, 0.5)])
    expect(s.sample).toBe(1)
    expect(s.winnersMedianR).toBeNull()
  })

  it('counts a breakeven trade as a loser, same win threshold (pnl > 0) as everywhere else', () => {
    expect(heatSummary([t(0, 0.1)]).buckets[0]).toEqual({ r: 0, winners: 0, losers: 1 })
  })
})
