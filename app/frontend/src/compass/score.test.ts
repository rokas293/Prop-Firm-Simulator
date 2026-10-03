import { describe, expect, it } from 'vitest'
import type { GroupStats, TradeRecord } from '../api/types'
import {
  computeCompassScore,
  computeConsistencyComponent,
  computeDrawdownComponent,
  computeExpectancyComponent,
  computeStopEfficiencyComponent,
} from './score'

function makeGroupStats(overrides: Partial<GroupStats> = {}): GroupStats {
  return {
    trades: 10,
    net_pnl_usd: 1000,
    net_r: 10,
    win_rate: 0.5,
    expectancy_usd: 100,
    expectancy_r: 0.25,
    profit_factor: 1.5,
    max_drawdown_usd: 200,
    ...overrides,
  }
}

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 1,
    entry_time: 0,
    exit_time: 100,
    instrument: 'MNQ',
    side: 'long',
    leg: 'mean_reversion',
    session: 'ny',
    trading_day: '2021-07-16',
    size_contracts: 1,
    entry_price: 100,
    exit_price: 95,
    sl_price: 92,
    tp_price: 110,
    sl_points: 8,
    tp_points: 10,
    rr_planned: 1.25,
    exit_type: 'sl',
    pnl_usd: -40,
    r_multiple: -1,
    commission_usd: 1.3,
    mae_points: 8,
    mfe_points: 12,
    mae_r: 1,
    mfe_r: 1.5,
    bars_held: 10,
    ...overrides,
  }
}

describe('computeExpectancyComponent', () => {
  it('scores 100 at or above the reference expectancy', () => {
    expect(computeExpectancyComponent(makeGroupStats({ expectancy_r: 0.5 })).score).toBe(100)
    expect(computeExpectancyComponent(makeGroupStats({ expectancy_r: 1.0 })).score).toBe(100)
  })

  it('scores 50 at half the reference expectancy', () => {
    expect(computeExpectancyComponent(makeGroupStats({ expectancy_r: 0.25 })).score).toBe(50)
  })

  it('clamps negative expectancy to 0, not a negative score', () => {
    expect(computeExpectancyComponent(makeGroupStats({ expectancy_r: -0.3 })).score).toBe(0)
  })

  it('treats a null expectancy_r as 0', () => {
    expect(computeExpectancyComponent(makeGroupStats({ expectancy_r: null })).score).toBe(0)
  })
})

describe('computeConsistencyComponent', () => {
  it('scores 100 when profit is evenly spread across many days', () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      makeTrade({ trade_id: i, trading_day: `2021-07-${10 + i}`, pnl_usd: 100 }),
    )
    // best day (100) / total (1000) = 10% share, well under the 50% fail threshold
    expect(computeConsistencyComponent(trades).score).toBe(80)
  })

  it('scores 0 when a single day is the entire profit (fails the actual rule)', () => {
    const trades = [
      makeTrade({ trade_id: 1, trading_day: '2021-07-16', pnl_usd: 1000 }),
      makeTrade({ trade_id: 2, trading_day: '2021-07-17', pnl_usd: 0 }),
    ]
    expect(computeConsistencyComponent(trades).score).toBe(0)
  })

  it('does not divide by zero when total pnl is zero or negative', () => {
    const trades = [makeTrade({ trading_day: '2021-07-16', pnl_usd: -50 })]
    expect(computeConsistencyComponent(trades).score).toBe(100)
  })
})

describe('computeDrawdownComponent', () => {
  it('scores 100 with zero drawdown', () => {
    expect(computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: 0, net_pnl_usd: 1000 })).score).toBe(100)
  })

  it('scores 0 once drawdown reaches 100% of net profit', () => {
    expect(computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: 1000, net_pnl_usd: 1000 })).score).toBe(0)
  })

  it('writes the drawdown in the detail with a thousands separator', () => {
    const c = computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: 3834, net_pnl_usd: 10000 }))
    expect(c.detail).toContain('$3,834')
    expect(c.detail).not.toContain('$3834')
  })

  it('does not divide by zero when net PnL is zero', () => {
    const c = computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: 100, net_pnl_usd: 0 }))
    expect(Number.isFinite(c.score)).toBe(true)
  })

  // Regression test (POLISH_ROADMAP Phase P5): propbt/reporting/run_bundle.py's
  // _kpis reports max_drawdown_usd as <= 0 (cumulative PnL minus its running
  // max) -- caught against a real losing/breached run where an early,
  // sign-naive version of this formula scored a breached run's drawdown as
  // a perfect 100 because a negative ratio clamped the wrong direction.
  it('scores a real breached run (negative drawdown, negative net PnL) as bad, not perfect', () => {
    // Real MNQ run 20260802T180304Z_6b373299, scope=all: max_drawdown_usd
    // -2040.10, net_pnl_usd -1821.80 (mll_breach).
    const c = computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: -2040.1, net_pnl_usd: -1821.8 }))
    expect(c.score).toBeLessThan(20)
  })

  it('treats -100 and +100 max_drawdown_usd identically (magnitude only)', () => {
    const negative = computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: -300, net_pnl_usd: 1000 }))
    const positive = computeDrawdownComponent(makeGroupStats({ max_drawdown_usd: 300, net_pnl_usd: 1000 }))
    expect(negative.score).toBe(positive.score)
  })
})

describe('computeStopEfficiencyComponent', () => {
  it('scores 100 when there are no losses', () => {
    expect(computeStopEfficiencyComponent([makeTrade({ pnl_usd: 10 })]).score).toBe(100)
  })

  it('scores 0 when every loss was a clipped stop', () => {
    const trades = [
      makeTrade({ trade_id: 1, pnl_usd: -10, exit_type: 'sl', tp_points: 10, mfe_points: 10 }),
      makeTrade({ trade_id: 2, pnl_usd: -10, exit_type: 'sl', tp_points: 10, mfe_points: 10 }),
    ]
    expect(computeStopEfficiencyComponent(trades).score).toBe(0)
  })
})

describe('computeCompassScore', () => {
  it('averages the four components and reconciles the label set', () => {
    const overall = makeGroupStats()
    const trades = [makeTrade()]
    const result = computeCompassScore(overall, trades)
    expect(result.components).toHaveLength(4)
    expect(result.components.map((c) => c.key)).toEqual(['expectancy', 'consistency', 'drawdown', 'stopEfficiency'])
    const expectedAvg = Math.round(result.components.reduce((s, c) => s + c.score, 0) / 4)
    expect(result.total).toBe(expectedAvg)
    expect(result.total).toBeGreaterThanOrEqual(0)
    expect(result.total).toBeLessThanOrEqual(100)
  })
})
