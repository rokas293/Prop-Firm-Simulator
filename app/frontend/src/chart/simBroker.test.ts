import { describe, expect, it } from 'vitest'
import {
  CONTRACT_SPECS,
  closePosition,
  computeMaeMfe,
  getContractSpec,
  marketFillPrice,
  openPositionAsTradeRecord,
  riskUsdAtEntry,
  sideSign,
  toR,
  unrealizedPnl,
  type OpenPosition,
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
})
