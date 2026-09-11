import { describe, expect, it } from 'vitest'
import {
  CONTRACT_SPECS,
  MAX_POSITION_CONTRACTS,
  advanceReplay,
  closePosition,
  computeAutoSize,
  computeMaeMfe,
  getContractSpec,
  impliedOrderType,
  marketFillPrice,
  openPositionAsTradeRecord,
  orderTriggered,
  riskUsdAtEntry,
  sideSign,
  toR,
  unrealizedPnl,
  type OpenPosition,
  type WorkingOrder,
} from './simBroker'
import { filterTradesForReplay } from './replay'
import type { Bar } from '../api/types'

// Fixed bars fixture -- the "fixed set of bars" the F2 prompt's mandatory
// test replays a fixed set of orders over. Every number below is hand-
// calculated against this exact fixture in the test comments.
const BARS: Bar[] = [
  { time: 0, open: 5000, high: 5003, low: 4998, close: 5002, volume: 100 },
  { time: 300, open: 5002, high: 5012, low: 5001, close: 5010, volume: 100 },
  { time: 600, open: 5010, high: 5015, low: 5004, close: 5005, volume: 100 },
  { time: 900, open: 5005, high: 5022, low: 5003, close: 5020, volume: 100 },
  { time: 1200, open: 5020, high: 5025, low: 5018, close: 5030, volume: 100 },
  { time: 1500, open: 5030, high: 5035, low: 5028, close: 5025, volume: 100 },
]

describe('marketFillPrice', () => {
  it('fills at the bar close (the documented F2 convention)', () => {
    expect(marketFillPrice(BARS[1])).toBe(5010)
  })
})

describe('sideSign / unrealizedPnl', () => {
  it('long profits when price rises, loses when it falls', () => {
    expect(sideSign('long')).toBe(1)
    expect(unrealizedPnl('long', 5000, 5010, 2, CONTRACT_SPECS.MES)).toBe(100) // (5010-5000)*5*2
    expect(unrealizedPnl('long', 5000, 4990, 2, CONTRACT_SPECS.MES)).toBe(-100)
  })

  it('short profits when price falls, loses when it rises', () => {
    expect(sideSign('short')).toBe(-1)
    expect(unrealizedPnl('short', 5000, 4990, 2, CONTRACT_SPECS.MES)).toBe(100)
    expect(unrealizedPnl('short', 5000, 5010, 2, CONTRACT_SPECS.MES)).toBe(-100)
  })

  it('scales with contracts and the instrument point value (MNQ vs MES)', () => {
    expect(unrealizedPnl('long', 5000, 5010, 1, CONTRACT_SPECS.MES)).toBe(50) // 10pts * $5
    expect(unrealizedPnl('long', 5000, 5010, 1, CONTRACT_SPECS.MNQ)).toBe(20) // 10pts * $2
  })
})

describe('getContractSpec', () => {
  it('returns MES/MNQ specs matching CLAUDE.md', () => {
    expect(getContractSpec('MES')).toEqual({ pointValue: 5, tickSize: 0.25 })
    expect(getContractSpec('MNQ')).toEqual({ pointValue: 2, tickSize: 0.25 })
  })

  it('throws for an instrument outside the FXR platform scope', () => {
    expect(() => getContractSpec('ZN')).toThrow()
  })
})

describe('riskUsdAtEntry', () => {
  it('uses percent-of-balance when set', () => {
    expect(riskUsdAtEntry(50000, 1, null)).toBe(500)
  })

  it('uses the fixed-dollar figure when percent is not set', () => {
    expect(riskUsdAtEntry(50000, null, 250)).toBe(250)
  })

  it('returns null when neither is set (no 1R basis)', () => {
    expect(riskUsdAtEntry(50000, null, null)).toBeNull()
  })
})

describe('toR', () => {
  it('divides pnl by the risk basis', () => {
    expect(toR(250, 500)).toBe(0.5)
    expect(toR(-250, 500)).toBe(-0.5)
  })

  it('returns null with no risk basis (0 or null)', () => {
    expect(toR(250, null)).toBeNull()
    expect(toR(250, 0)).toBeNull()
  })
})

describe('computeMaeMfe', () => {
  it('scans the inclusive [entryIndex, exitIndex] window for a long', () => {
    // entry at bar1 (close 5010), window bars[1..4]: low min 5001 (bar1),
    // high max 5025 (bar4).
    const result = computeMaeMfe(BARS, 1, 4, 5010, 'long')
    expect(result).toEqual({ maePoints: 9, mfePoints: 15 })
  })

  it('mirrors mae/mfe for a short (adverse = up, favorable = down)', () => {
    const result = computeMaeMfe(BARS, 1, 4, 5010, 'short')
    expect(result).toEqual({ maePoints: 15, mfePoints: 9 })
  })

  it('handles a single-bar window (entry and exit on the same bar)', () => {
    // bar2 alone: low 5004, high 5015, entry 5010.
    const result = computeMaeMfe(BARS, 2, 2, 5010, 'long')
    expect(result).toEqual({ maePoints: 6, mfePoints: 5 })
  })
})

// The MANDATORY test (F2 prompt): replay a fixed set of orders over a
// fixed set of bars and assert identical fills/PnL/R -- fills must be
// reproducible from (bars, orders) alone (FXR_SPEC.md section 3/6).
describe('closePosition -- deterministic fill reproducibility', () => {
  const position: OpenPosition = {
    side: 'long',
    contracts: 2,
    entryPrice: 5010, // marketFillPrice(BARS[1])
    entryTime: BARS[1].time,
    entryIndex: 1,
    riskUsd: 100,
    slPrice: null,
    tpPrice: null,
  }

  function handCalcExpected() {
    // Exit at bar4: close 5030. Gross = (5030-5010)*5*2 = 200.
    // Commission = 1.3 * 2 = 2.6. Net = 197.4. R = 197.4 / 100 = 1.974.
    // mae/mfe from the computeMaeMfe test above: 9 / 15 points.
    // riskPointsEquivalent = 100 / (5*2) = 10 -> maeR 0.9, mfeR 1.5.
    // barsHeld = 4 - 1 + 1 = 4.
    return {
      side: 'long' as const,
      contracts: 2,
      entryTime: 300,
      entryPrice: 5010,
      exitTime: 1200,
      exitPrice: 5030,
      exitType: 'manual_close' as const,
      slPrice: null,
      tpPrice: null,
      pnlUsd: 197.4,
      commissionUsd: 2.6,
      rMultiple: 1.974,
      maePoints: 9,
      mfePoints: 15,
      maeR: 0.9,
      mfeR: 1.5,
      barsHeld: 4,
    }
  }

  it('matches a hand calculation exactly', () => {
    const result = closePosition(BARS, position, 4, CONTRACT_SPECS.MES, 1.3)
    expect(result).toEqual(handCalcExpected())
  })

  it('is reproducible: identical (bars, position, exitIndex) always yields an identical result', () => {
    const first = closePosition(BARS, position, 4, CONTRACT_SPECS.MES, 1.3)
    const second = closePosition(BARS, position, 4, CONTRACT_SPECS.MES, 1.3)
    expect(second).toEqual(first)
  })

  it('a short position over the same bars produces the mirrored PnL', () => {
    const shortPosition: OpenPosition = { ...position, side: 'short' }
    // Gross = (5010-5030)*5*2 = -200; net = -202.6; R = -2.026.
    const result = closePosition(BARS, shortPosition, 4, CONTRACT_SPECS.MES, 1.3)
    expect(result.pnlUsd).toBe(-202.6)
    expect(result.rMultiple).toBeCloseTo(-2.026, 10)
    // mae/mfe mirror too (short's adverse move is price UP).
    expect(result.maePoints).toBe(15)
    expect(result.mfePoints).toBe(9)
  })

  it('with no risk basis (no risk-per-trade configured), r_multiple/mae_r/mfe_r are null, not 0', () => {
    const noRiskPosition: OpenPosition = { ...position, riskUsd: null }
    const result = closePosition(BARS, noRiskPosition, 4, CONTRACT_SPECS.MES, 1.3)
    expect(result.rMultiple).toBeNull()
    expect(result.maeR).toBeNull()
    expect(result.mfeR).toBeNull()
    // pnl itself is unaffected by the missing risk basis.
    expect(result.pnlUsd).toBe(197.4)
  })

  it('exiting on the same bar as entry still produces a valid (bars_held=1) result', () => {
    const result = closePosition(BARS, position, 1, CONTRACT_SPECS.MES, 1.3)
    expect(result.barsHeld).toBe(1)
    expect(result.exitPrice).toBe(5010) // same bar's close as entry -- flat trade
    expect(result.pnlUsd).toBe(-2.6) // 0 gross, minus commission
  })
})

describe('openPositionAsTradeRecord', () => {
  const position: OpenPosition = {
    side: 'long',
    contracts: 1,
    entryPrice: 5010,
    entryTime: 300,
    entryIndex: 1,
    riskUsd: 50,
    slPrice: null,
    tpPrice: null,
  }

  it('marks to market at the current cursor bar and computes live pnl/r', () => {
    const record = openPositionAsTradeRecord({
      position,
      instrument: 'MES',
      cursorIndex: 3,
      markPrice: BARS[3].close, // 5020
      cursorTime: BARS[3].time,
    })
    expect(record.pnl_usd).toBe(50) // (5020-5010)*5*1
    expect(record.r_multiple).toBe(1) // 50/50
    expect(record.entry_price).toBe(5010)
    expect(record.side).toBe('long')
    expect(record.bars_held).toBe(3) // 3 - 1 + 1
  })

  it('uses trade_id 0, a sentinel real journaled trades (assigned from 1) never collide with', () => {
    const record = openPositionAsTradeRecord({
      position,
      instrument: 'MES',
      cursorIndex: 1,
      markPrice: 5010,
      cursorTime: 300,
    })
    expect(record.trade_id).toBe(0)
  })

  it('sets exit_time strictly after the cursor, so filterTradesForReplay treats it as still-open', () => {
    const record = openPositionAsTradeRecord({
      position,
      instrument: 'MES',
      cursorIndex: 1,
      markPrice: 5010,
      cursorTime: 300,
    })
    const [view] = filterTradesForReplay([record], 300)
    expect(view.showExit).toBe(false)
    expect(view.openSpanEnd).toBe(300) // grows with the cursor, not a fake future exit
  })

  it('never renders an exit marker/outcome while open, even after being replayed forward', () => {
    const record = openPositionAsTradeRecord({
      position,
      instrument: 'MES',
      cursorIndex: 4,
      markPrice: BARS[4].close,
      cursorTime: BARS[4].time,
    })
    const [view] = filterTradesForReplay([record], BARS[4].time)
    expect(view.showExit).toBe(false)
  })

  it('carries real sl_price/tp_price through to sl_points/tp_points/rr_planned (F3)', () => {
    const withStops: OpenPosition = { ...position, slPrice: 5000, tpPrice: 5030 }
    const record = openPositionAsTradeRecord({
      position: withStops,
      instrument: 'MES',
      cursorIndex: 1,
      markPrice: 5010,
      cursorTime: 300,
    })
    expect(record.sl_price).toBe(5000)
    expect(record.tp_price).toBe(5030)
    expect(record.sl_points).toBe(10) // |5010-5000|
    expect(record.tp_points).toBe(20) // |5030-5010|
    expect(record.rr_planned).toBe(2) // 20/10
  })
})

describe('computeAutoSize (F3 -- auto position sizing)', () => {
  it('sizes to exactly the risk budget divided by the dollar risk per contract', () => {
    // $500 risk, 10pt SL distance on MES ($5/pt) = $50/contract -> 10
    // contracts, but MAX_POSITION_CONTRACTS caps it.
    expect(computeAutoSize(500, 5010, 5000, CONTRACT_SPECS.MES)).toBe(MAX_POSITION_CONTRACTS)
  })

  it('matches a hand calc under the cap: 1% of $50k over a 20pt MES stop', () => {
    // riskUsd = 50000 * 0.01 = 500. slDistance = 20. riskPerContract = 100.
    // floor(500/100) = 5 -- exactly AT the cap, not clipped by it.
    const riskUsd = 50000 * 0.01
    expect(computeAutoSize(riskUsd, 5020, 5000, CONTRACT_SPECS.MES)).toBe(5)
  })

  it('floors to whole contracts, never rounds up past the risk budget', () => {
    // riskPerContract = 15*5 = 75. 220/75 = 2.93 -> floors to 2, not 3.
    expect(computeAutoSize(220, 5015, 5000, CONTRACT_SPECS.MES, 10)).toBe(2)
  })

  it('floors at 1 contract even when the budget technically covers less than one', () => {
    expect(computeAutoSize(10, 5020, 5000, CONTRACT_SPECS.MES, 10)).toBe(1)
  })

  it('caps at the given maxContracts', () => {
    expect(computeAutoSize(100000, 5001, 5000, CONTRACT_SPECS.MES, 5)).toBe(5)
  })

  it('falls back to 1 with no risk basis or a zero-distance stop', () => {
    expect(computeAutoSize(null, 5010, 5000, CONTRACT_SPECS.MES)).toBe(1)
    expect(computeAutoSize(500, 5010, 5010, CONTRACT_SPECS.MES)).toBe(1)
  })
})

describe('impliedOrderType', () => {
  it('a long order above market is a stop (chasing a breakout up)', () => {
    expect(impliedOrderType('long', 5010, 5000)).toBe('stop')
  })
  it('a long order below market is a limit (waiting for a pullback down)', () => {
    expect(impliedOrderType('long', 4990, 5000)).toBe('limit')
  })
  it('a short order below market is a stop (chasing a breakdown)', () => {
    expect(impliedOrderType('short', 4990, 5000)).toBe('stop')
  })
  it('a short order above market is a limit (waiting for a pullback up)', () => {
    expect(impliedOrderType('short', 5010, 5000)).toBe('limit')
  })
})

// F3's own bars fixture: enough range/structure to exercise a limit fill,
// a stop fill, a TP-only hit, and a same-bar SL+TP ambiguity, each hand-
// calculated in its own test.
const BARS2: Bar[] = [
  { time: 0, open: 5000, high: 5005, low: 4995, close: 5000, volume: 100 },
  { time: 300, open: 5000, high: 5005, low: 4990, close: 4995, volume: 100 },
  { time: 600, open: 4995, high: 5000, low: 4980, close: 4985, volume: 100 },
  { time: 900, open: 4985, high: 5010, low: 4983, close: 5005, volume: 100 },
  { time: 1200, open: 5005, high: 5030, low: 5000, close: 5025, volume: 100 },
  { time: 1500, open: 5025, high: 5035, low: 4970, close: 4975, volume: 100 },
  { time: 1800, open: 4975, high: 4980, low: 4960, close: 4965, volume: 100 },
  { time: 2100, open: 4965, high: 4990, low: 4960, close: 4985, volume: 100 },
]

function baseOrder(overrides: Partial<WorkingOrder> = {}): WorkingOrder {
  return {
    id: 'order-1',
    side: 'long',
    orderType: 'limit',
    price: 4988,
    contracts: 1,
    slPrice: null,
    tpPrice: null,
    riskUsd: null,
    placedTime: BARS2[0].time,
    placedIndex: 0,
    ...overrides,
  }
}

describe('orderTriggered', () => {
  it('a buy limit triggers when a later bar\'s low touches or crosses it', () => {
    const order = baseOrder({ price: 4988 })
    expect(orderTriggered(order, BARS2[1])).toBe(false) // low 4990, doesn't reach 4988
    expect(orderTriggered(order, BARS2[2])).toBe(true) // low 4980 <= 4988
  })

  it('a buy stop triggers when a later bar\'s high touches or crosses it', () => {
    const order = baseOrder({ orderType: 'stop', price: 5015 })
    expect(orderTriggered(order, BARS2[3])).toBe(false) // high 5010, doesn't reach 5015
    expect(orderTriggered(order, BARS2[4])).toBe(true) // high 5030 >= 5015
  })

  it('a sell limit/stop mirror the long conditions', () => {
    expect(orderTriggered(baseOrder({ side: 'short', orderType: 'limit', price: 5010 }), BARS2[3])).toBe(true) // high 5010 >= 5010
    expect(orderTriggered(baseOrder({ side: 'short', orderType: 'stop', price: 4980 }), BARS2[2])).toBe(true) // low 4980 <= 4980
  })
})

// The MANDATORY test (F3 prompt): a right-click limit order must fill
// correctly in replay, deterministically, from (bars, orders) alone --
// extends F2's own mandatory determinism test to order types that trigger
// mid-replay instead of at the instant of a click.
describe('advanceReplay -- deterministic order fills in replay', () => {
  it('a working buy-limit fills exactly at its own price on the first bar that reaches it, matching a hand calc', () => {
    const order = baseOrder({ id: 'limit-1', side: 'long', orderType: 'limit', price: 4988, contracts: 1 })
    const result = advanceReplay(BARS2, -1, 3, null, [order], CONTRACT_SPECS.MES, 1.3)
    // Fills on bar2 (idx2, low 4980 <= 4988), not bar1 (low 4990, doesn't
    // reach it) -- fill price is the ORDER's own price, not the bar's low.
    expect(result.filledOrderIds).toEqual(['limit-1'])
    expect(result.workingOrders).toEqual([])
    expect(result.closedTrades).toEqual([])
    expect(result.position).toEqual({
      side: 'long',
      contracts: 1,
      entryPrice: 4988,
      entryTime: 600,
      entryIndex: 2,
      riskUsd: null,
      slPrice: null,
      tpPrice: null,
    })
  })

  it('is reproducible: identical (bars, orders) always yields an identical result', () => {
    const order = baseOrder({ id: 'limit-1' })
    const first = advanceReplay(BARS2, -1, 3, null, [order], CONTRACT_SPECS.MES, 1.3)
    const second = advanceReplay(BARS2, -1, 3, null, [order], CONTRACT_SPECS.MES, 1.3)
    expect(second).toEqual(first)
  })

  it('processing one long jump gives the SAME result as stepping bar-by-bar', () => {
    const order = baseOrder({ id: 'limit-1' })
    const jumped = advanceReplay(BARS2, -1, 6, null, [order], CONTRACT_SPECS.MES, 1.3)

    let pos = null as ReturnType<typeof advanceReplay>['position']
    let orders = [order]
    let closedTrades: ReturnType<typeof advanceReplay>['closedTrades'] = []
    for (let i = -1; i < 6; i++) {
      const step = advanceReplay(BARS2, i, i + 1, pos, orders, CONTRACT_SPECS.MES, 1.3)
      pos = step.position
      orders = step.workingOrders
      closedTrades = [...closedTrades, ...step.closedTrades]
    }
    expect(pos).toEqual(jumped.position)
    expect(orders).toEqual(jumped.workingOrders)
    expect(closedTrades).toEqual(jumped.closedTrades)
  })

  it('an order that never gets touched stays working, untouched', () => {
    const order = baseOrder({ id: 'far-limit', price: 4000 })
    const result = advanceReplay(BARS2, -1, 7, null, [order], CONTRACT_SPECS.MES, 1.3)
    expect(result.position).toBeNull()
    expect(result.workingOrders).toEqual([order])
    expect(result.filledOrderIds).toEqual([])
  })

  it('a buy stop fills at its own price, not the bar high that triggered it', () => {
    const order = baseOrder({ id: 'stop-1', orderType: 'stop', price: 5015, contracts: 1 })
    const result = advanceReplay(BARS2, -1, 4, null, [order], CONTRACT_SPECS.MES, 1.3)
    expect(result.position?.entryPrice).toBe(5015)
    expect(result.position?.entryIndex).toBe(4) // bar4: high 5030 >= 5015
  })

  it('fills a working order, then auto-closes on TP within the same advance call, journaling one closed trade', () => {
    // Buy stop @ 5015 with TP 5025 -- fills on bar4 (high 5030), and that
    // SAME bar's high (5030) also reaches TP 5025, so it closes on the
    // very bar it opened on (matches propbt/engine/broker.py's own same-
    // bar-exit handling).
    const order = baseOrder({ id: 'stop-tp', orderType: 'stop', price: 5015, tpPrice: 5025, riskUsd: 100, contracts: 1 })
    const result = advanceReplay(BARS2, -1, 4, null, [order], CONTRACT_SPECS.MES, 1.3)
    expect(result.position).toBeNull()
    expect(result.workingOrders).toEqual([])
    expect(result.closedTrades).toHaveLength(1)
    const trade = result.closedTrades[0]
    expect(trade.exitType).toBe('take_profit')
    expect(trade.entryPrice).toBe(5015)
    expect(trade.exitPrice).toBe(5025)
    expect(trade.barsHeld).toBe(1)
    // Gross = (5025-5015)*5*1 = 50; commission 1.3; net 48.7; R = 0.487.
    expect(trade.pnlUsd).toBe(48.7)
    expect(trade.rMultiple).toBeCloseTo(0.487, 10)
  })

  it('closes an already-open position on SL, hand-calculated exactly', () => {
    const position: OpenPosition = {
      side: 'long',
      contracts: 1,
      entryPrice: 5005,
      entryTime: BARS2[3].time,
      entryIndex: 3,
      riskUsd: 50,
      slPrice: 4980,
      tpPrice: 5040,
    }
    // bar5 (idx5): low 4970 <= slPrice 4980 -- closes there, at the SL
    // price exactly, not the bar's own (worse) low.
    const result = advanceReplay(BARS2, 3, 5, position, [], CONTRACT_SPECS.MES, 1.3)
    expect(result.position).toBeNull()
    expect(result.closedTrades).toHaveLength(1)
    const trade = result.closedTrades[0]
    expect(trade.exitType).toBe('stop_loss')
    expect(trade.exitPrice).toBe(4980)
    expect(trade.exitTime).toBe(1500)
    // Gross = (4980-5005)*5*1 = -125; commission 1.3; net -126.3; R -2.526.
    expect(trade.pnlUsd).toBe(-126.3)
    expect(trade.rMultiple).toBeCloseTo(-2.526, 10)
  })

  it('when SL and TP are BOTH touched within the same bar, conservatively assumes the SL (the worse outcome)', () => {
    const position: OpenPosition = {
      side: 'long',
      contracts: 1,
      entryPrice: 5005,
      entryTime: BARS2[3].time,
      entryIndex: 3,
      riskUsd: 50,
      slPrice: 4970, // touched by bar5's low (4970)
      // 5031, not 5030: bar4's own high (5030) would otherwise already
      // close this on TP a bar early, before the intended same-bar
      // ambiguity on bar5 (high 5035) is ever reached.
      tpPrice: 5031,
    }
    const result = advanceReplay(BARS2, 3, 5, position, [], CONTRACT_SPECS.MES, 1.3)
    expect(result.closedTrades[0].exitType).toBe('stop_loss')
    expect(result.closedTrades[0].exitPrice).toBe(4970)
  })

  it('a working order never fills while a position is already open (single-position limit)', () => {
    const openPos: OpenPosition = {
      side: 'long',
      contracts: 1,
      entryPrice: 5000,
      entryTime: BARS2[0].time,
      entryIndex: 0,
      riskUsd: null,
      slPrice: null,
      tpPrice: null,
    }
    const order = baseOrder({ id: 'limit-1', price: 4988 })
    const result = advanceReplay(BARS2, 0, 3, openPos, [order], CONTRACT_SPECS.MES, 1.3)
    // bar2 would have triggered the limit, but the position was still open
    // the whole way through (no SL/TP to close it) -- the order must stay
    // untouched, not silently fill into a second position.
    expect(result.position).toEqual(openPos)
    expect(result.workingOrders).toEqual([order])
    expect(result.filledOrderIds).toEqual([])
  })
})
