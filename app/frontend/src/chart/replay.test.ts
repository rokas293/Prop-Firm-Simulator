import { describe, expect, it } from 'vitest'
import { equityAtCursor, filterBarsForReplay, filterTradesForReplay, runningTotals } from './replay'
import type { Bar, EquityPoint, TradeRecord } from '../api/types'

function bar(time: number): Bar {
  return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 }
}

function trade(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    trade_id: 1,
    entry_time: 100,
    exit_time: 200,
    instrument: 'MNQ',
    side: 'long',
    leg: 'continuation',
    session: 'ny',
    trading_day: '2024-01-01',
    size_contracts: 1,
    entry_price: 100,
    exit_price: 110,
    sl_price: 90,
    tp_price: 110,
    sl_points: 10,
    tp_points: 10,
    rr_planned: 1,
    exit_type: 'tp',
    pnl_usd: 50,
    r_multiple: 1,
    commission_usd: 1,
    mae_points: 1,
    mfe_points: 10,
    mae_r: 0.1,
    mfe_r: 1,
    bars_held: 5,
    ...overrides,
  }
}

const BARS: Bar[] = [bar(10), bar(20), bar(30), bar(40), bar(50)]

describe('filterBarsForReplay', () => {
  it('returns everything when not in replay mode (cursorTime null)', () => {
    expect(filterBarsForReplay(BARS, null)).toEqual(BARS)
  })

  it('only returns bars at or before the cursor -- nothing after it', () => {
    const result = filterBarsForReplay(BARS, 30)
    expect(result.map((b) => b.time)).toEqual([10, 20, 30])
  })

  it('returns no bars when the cursor is before every bar', () => {
    expect(filterBarsForReplay(BARS, 5)).toEqual([])
  })

  it('includes a bar exactly at the cursor time (boundary is inclusive)', () => {
    const result = filterBarsForReplay(BARS, 20)
    expect(result.map((b) => b.time)).toEqual([10, 20])
  })
})

describe('filterTradesForReplay', () => {
  const trades = [
    trade({ trade_id: 1, entry_time: 100, exit_time: 200 }),
    trade({ trade_id: 2, entry_time: 150, exit_time: 300 }),
    trade({ trade_id: 3, entry_time: 400, exit_time: 500 }),
  ]

  it('shows every trade fully when not in replay mode', () => {
    const result = filterTradesForReplay(trades, null)
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.showExit)).toBe(true)
  })

  it('omits trades whose entry has not happened yet as of the cursor', () => {
    const result = filterTradesForReplay(trades, 120)
    expect(result.map((r) => r.trade.trade_id)).toEqual([1])
  })

  it('shows entered-but-not-exited trades with showExit false and openSpanEnd == cursor', () => {
    // At cursor=180, both trade 1 (entry 100) and trade 2 (entry 150) have
    // started; neither has reached its exit (200 / 300) yet.
    const result = filterTradesForReplay(trades, 180)
    expect(result.map((r) => r.trade.trade_id)).toEqual([1, 2])
    expect(result.every((r) => r.showExit === false)).toBe(true)
    expect(result.every((r) => r.openSpanEnd === 180)).toBe(true)
  })

  it('shows a fully-closed trade with showExit true and openSpanEnd == its real exit_time', () => {
    const result = filterTradesForReplay(trades, 250)
    const t1 = result.find((r) => r.trade.trade_id === 1)!
    expect(t1.showExit).toBe(true)
    expect(t1.openSpanEnd).toBe(200)
    // trade 2 entered (150) but not yet exited (300) at cursor=250
    const t2 = result.find((r) => r.trade.trade_id === 2)!
    expect(t2.showExit).toBe(false)
    expect(t2.openSpanEnd).toBe(250)
    // trade 3 hasn't entered yet (400 > 250)
    expect(result.find((r) => r.trade.trade_id === 3)).toBeUndefined()
  })

  it('exit boundary is inclusive: showExit true exactly at exit_time', () => {
    const result = filterTradesForReplay(trades, 200)
    const t1 = result.find((r) => r.trade.trade_id === 1)!
    expect(t1.showExit).toBe(true)
  })
})

describe('equityAtCursor', () => {
  const points: EquityPoint[] = [10, 20, 30].map(
    (time): EquityPoint => ({
      time,
      balance: 50000,
      open_pnl: time,
      equity: 50000 + time,
      mll_floor: 48000,
      daily_loss_floor: 49000,
      target_level: 53000,
      trading_day: '2024-01-01',
      day_start_balance: 50000,
      breached: false,
      daily_locked: false,
      drawdown_usd: 0,
    }),
  )

  it('returns null when not in replay mode', () => {
    expect(equityAtCursor(points, null)).toBeNull()
  })

  it('returns the latest point at or before the cursor', () => {
    expect(equityAtCursor(points, 25)?.time).toBe(20)
  })

  it('returns null when the cursor is before every point', () => {
    expect(equityAtCursor(points, 5)).toBeNull()
  })

  it('is inclusive of a point exactly at the cursor', () => {
    expect(equityAtCursor(points, 20)?.time).toBe(20)
  })
})

describe('runningTotals', () => {
  const trades = [
    trade({ trade_id: 1, entry_time: 100, exit_time: 200, pnl_usd: 50, r_multiple: 1 }),
    trade({ trade_id: 2, entry_time: 150, exit_time: 300, pnl_usd: -20, r_multiple: -0.5 }),
    trade({ trade_id: 3, entry_time: 400, exit_time: 500, pnl_usd: 100, r_multiple: 2 }),
  ]

  it('sums only closed (exit_time <= cursor) trades', () => {
    expect(runningTotals(trades, 250)).toEqual({ pnlUsd: 50, r: 1 })
  })

  it('sums everything when not in replay mode', () => {
    expect(runningTotals(trades, null)).toEqual({ pnlUsd: 130, r: 2.5 })
  })

  it('sums nothing before any trade has closed', () => {
    expect(runningTotals(trades, 50)).toEqual({ pnlUsd: 0, r: 0 })
  })
})
