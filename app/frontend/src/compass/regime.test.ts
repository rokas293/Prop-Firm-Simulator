import { describe, expect, it } from 'vitest'
import type { TradeRecord } from '../api/types'
import { computeMaeMfeRegime, isClippedStop } from './regime'

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

describe('isClippedStop', () => {
  it('is true for an SL exit whose MFE reached the planned TP distance', () => {
    expect(isClippedStop(makeTrade({ exit_type: 'sl', tp_points: 10, mfe_points: 12 }))).toBe(true)
  })

  it('is false when the exit was not a stop-loss', () => {
    expect(isClippedStop(makeTrade({ exit_type: 'tp', tp_points: 10, mfe_points: 12 }))).toBe(false)
  })

  it('is false when tp_points is null', () => {
    expect(isClippedStop(makeTrade({ exit_type: 'sl', tp_points: null, mfe_points: 12 }))).toBe(false)
  })

  it('is false when MFE never reached the TP distance', () => {
    expect(isClippedStop(makeTrade({ exit_type: 'sl', tp_points: 10, mfe_points: 5 }))).toBe(false)
  })
})

describe('computeMaeMfeRegime', () => {
  it('reconciles losses/clipped counts against the raw trade set', () => {
    const trades = [
      makeTrade({ trade_id: 1, pnl_usd: -40, exit_type: 'sl', tp_points: 10, mfe_points: 12, sl_points: 8, mae_points: 8 }),
      makeTrade({ trade_id: 2, pnl_usd: -20, exit_type: 'sl', tp_points: 10, mfe_points: 3, sl_points: 8, mae_points: 8 }),
      makeTrade({ trade_id: 3, pnl_usd: 50, exit_type: 'tp', tp_points: 10, mfe_points: 10, sl_points: 8, mae_points: 2 }),
    ]
    const regime = computeMaeMfeRegime(trades)
    expect(regime.losses).toBe(2)
    expect(regime.clippedStops).toBe(1)
    expect(regime.clippedStopsShare).toBeCloseTo(0.5)
  })

  it('returns null shares/ratios when there is nothing to divide by', () => {
    const regime = computeMaeMfeRegime([])
    expect(regime.losses).toBe(0)
    expect(regime.clippedStopsShare).toBeNull()
    expect(regime.avgMaeToSlRatio).toBeNull()
  })

  it('computes the average MAE/SL ratio only over trades with a set stop', () => {
    const trades = [
      makeTrade({ trade_id: 1, sl_points: 10, mae_points: 5 }), // ratio 0.5
      makeTrade({ trade_id: 2, sl_points: 4, mae_points: 4 }), // ratio 1.0
      makeTrade({ trade_id: 3, sl_points: null, mae_points: 100 }), // excluded
    ]
    const regime = computeMaeMfeRegime(trades)
    expect(regime.avgMaeToSlRatio).toBeCloseTo(0.75)
  })
})
