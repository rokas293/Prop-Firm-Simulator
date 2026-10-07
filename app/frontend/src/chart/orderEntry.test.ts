import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import {
  GHOST_FALLBACK_POINTS,
  GHOST_MIN_TICKS,
  GHOST_REWARD_RISK,
  averageTrueRange,
  breakevenRefusal,
  withBracketsNote,
  fmtSignedUsd,
  ghostLevels,
  ghostsApply,
  labelSegments,
  levelReadout,
  levelRefusal,
  partialCloseChoices,
  partialCloseRefusal,
  rightClickOrders,
  roundToTick,
  tradeOpenContracts,
} from './orderEntry'
import { CONTRACT_SPECS } from './simBroker'

const MNQ = CONTRACT_SPECS.MNQ // $2/pt, 0.25 tick
const MES = CONTRACT_SPECS.MES // $5/pt, 0.25 tick

function bar(time: number, o: number, h: number, l: number, c: number): Bar {
  return { time, open: o, high: h, low: l, close: c, volume: 1 }
}

describe('ghost SL/TP placement (3.2)', () => {
  it('long: SL below, TP above at the reward:risk multiple, on the tick grid', () => {
    const g = ghostLevels('long', 20000, MNQ, 6)
    expect(g.sl).toBe(19994) // one ATR (6 pts) under the entry
    expect(g.tp).toBe(20000 + 6 * GHOST_REWARD_RISK) // 20012
    expect(g.sl).toBeLessThan(20000)
    expect(g.tp).toBeGreaterThan(20000)
  })

  it('short mirrors it: SL above, TP below', () => {
    const g = ghostLevels('short', 20000, MNQ, 6)
    expect(g.sl).toBe(20006)
    expect(g.tp).toBe(19988)
  })

  it('never closer than the minimum tick distance, however quiet the market', () => {
    const g = ghostLevels('long', 20000, MNQ, 0.25) // ATR of one tick
    expect(20000 - g.sl).toBeCloseTo(GHOST_MIN_TICKS * MNQ.tickSize)
  })

  it('falls back to a fixed distance when there is no volatility to read', () => {
    expect(ghostLevels('long', 5000, MES, null).sl).toBe(5000 - GHOST_FALLBACK_POINTS)
    expect(ghostLevels('long', 5000, MES, 0).sl).toBe(5000 - GHOST_FALLBACK_POINTS)
  })

  it('snaps an off-grid ATR to the tick size', () => {
    const g = ghostLevels('long', 20000, MNQ, 6.1)
    expect((20000 - g.sl) % MNQ.tickSize).toBeCloseTo(0)
    expect((g.tp - 20000) % MNQ.tickSize).toBeCloseTo(0)
  })

  it('ghosts appear only when neither SL nor TP is set', () => {
    expect(ghostsApply(null, null)).toBe(true)
    expect(ghostsApply(19990, null)).toBe(false)
    expect(ghostsApply(null, 20020)).toBe(false)
    expect(ghostsApply(19990, 20020)).toBe(false)
  })

  describe('averageTrueRange reads the revealed bars only (no look-ahead)', () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(60, 100, 104, 100, 103), bar(120, 103, 103, 98, 99), bar(180, 99, 300, 1, 150)]

    it('uses bars up to and including the cursor, never later ones', () => {
      // True ranges: bar1 = max(4, |104-100|, |100-100|) = 4; bar2 = max(5, 0, 5) = 5.
      expect(averageTrueRange(bars, 2)).toBeCloseTo((4 + 5) / 2)
      // The wild bar at index 3 must not leak into a cursor at 2.
      expect(averageTrueRange(bars, 2)).toBeLessThan(10)
    })

    it('is null with a single revealed bar', () => {
      expect(averageTrueRange(bars, 0)).toBeNull()
    })

    it('averages only the last `period` bars', () => {
      expect(averageTrueRange(bars, 3, 1)).toBeCloseTo(Math.max(299, Math.abs(300 - 99), Math.abs(1 - 99)))
    })
  })
})

describe('level validity', () => {
  it('a long stop must be below the market, a long target above', () => {
    expect(levelRefusal('long', 'sl', 19990, 20000, 0.25)).toBeNull()
    expect(levelRefusal('long', 'sl', 20000, 20000, 0.25)).not.toBeNull() // at the market
    expect(levelRefusal('long', 'sl', 20010, 20000, 0.25)).not.toBeNull()
    expect(levelRefusal('long', 'tp', 20010, 20000, 0.25)).toBeNull()
    expect(levelRefusal('long', 'tp', 19990, 20000, 0.25)).not.toBeNull()
  })

  it('a short mirrors it', () => {
    expect(levelRefusal('short', 'sl', 20010, 20000, 0.25)).toBeNull()
    expect(levelRefusal('short', 'sl', 19990, 20000, 0.25)).not.toBeNull()
    expect(levelRefusal('short', 'tp', 19990, 20000, 0.25)).toBeNull()
    expect(levelRefusal('short', 'tp', 20010, 20000, 0.25)).not.toBeNull()
  })

  it('a profit-locking stop (above entry but still below the market) is fine for a long', () => {
    // Entered at 20000, now 20030: a stop at 20010 locks profit and is legal.
    expect(levelRefusal('long', 'sl', 20010, 20030, 0.25)).toBeNull()
  })

  it('judges the tick-snapped price', () => {
    expect(levelRefusal('long', 'sl', 19999.9, 20000, 0.25)).not.toBeNull() // snaps to 20000 = the market
  })
})

describe('live drag readout: $, ticks and %', () => {
  it('long SL below the entry is a loss in $, ticks and %', () => {
    const r = levelReadout('long', 20000, 19990, 2, MNQ) // 10 pts * $2 * 2
    expect(r.pnlUsd).toBe(-40)
    expect(r.ticks).toBe(40)
    expect(r.percent).toBeCloseTo(0.05)
  })

  it('long TP above is a gain; short flips the signs', () => {
    expect(levelReadout('long', 5000, 5010, 1, MES).pnlUsd).toBe(50)
    expect(levelReadout('short', 5000, 5010, 1, MES).pnlUsd).toBe(-50)
    expect(levelReadout('short', 5000, 4990, 1, MES).pnlUsd).toBe(50)
  })

  it('reads the tick-snapped price', () => {
    const r = levelReadout('long', 20000, 19990.1, 1, MNQ) // snaps to 19990.00
    expect(r.ticks).toBe(40)
  })

  it('formats money with an explicit plus sign', () => {
    expect(fmtSignedUsd(127.94)).toBe('+$127.94')
    expect(fmtSignedUsd(-40)).toBe('-$40.00')
    expect(fmtSignedUsd(0)).toBe('$0.00')
  })
})

describe('on-chart label segments (R10 / R11)', () => {
  const base = { side: 'long' as const, entryPrice: 20000, contracts: 2, spec: MNQ }

  it('position line reads "LONG 2 | +$127.94 | ×"', () => {
    const segs = labelSegments({ ...base, role: 'position', pnlUsd: 127.94 }, 20000)
    expect(segs.map((s) => s.text)).toEqual(['LONG 2', '+$127.94', '×'])
    expect(segs[1].tone).toBe('positive')
    expect(segs[2].key).toBe('close')
  })

  it('a losing short position colours only the number negative', () => {
    const segs = labelSegments({ ...base, side: 'short', role: 'position', pnlUsd: -12.5 }, 20000)
    expect(segs.map((s) => s.text)).toEqual(['SHORT 2', '-$12.50', '×'])
    expect(segs[0].tone).toBe('neutral')
    expect(segs[1].tone).toBe('negative')
  })

  it('SL/TP labels carry $, ticks and % at the line\'s CURRENT price (so a drag is live)', () => {
    const at = (price: number) => labelSegments({ ...base, role: 'sl' }, price).map((s) => s.text)
    expect(at(19990)).toEqual(['', 'SL', '-$40.00 | 40 ticks | 0.05%', '2', '×'])
    expect(at(19980)).toEqual(['', 'SL', '-$80.00 | 80 ticks | 0.10%', '2', '×'])
    expect(labelSegments({ ...base, role: 'tp' }, 20020).map((s) => s.text)).toEqual(['', 'TP', '+$80.00 | 80 ticks | 0.10%', '2', '×'])
  })

  it('a GHOST says "drag to place", has a grip, and carries no quantity -- it cannot be mistaken for a placed stop', () => {
    const ghost = labelSegments({ ...base, role: 'ghost-sl' }, 19990)
    expect(ghost.map((s) => s.key)).toEqual(['grip', 'tag', 'hint', 'body', 'close'])
    expect(ghost.find((s) => s.key === 'hint')!.text).toBe('drag to place')
    expect(ghost.map((s) => s.text)).toContain('-$40.00 | 40 ticks | 0.05%') // the live readout is still there
    const placed = labelSegments({ ...base, role: 'sl' }, 19990)
    expect(placed.map((s) => s.key)).toEqual(['grip', 'tag', 'body', 'qty', 'close'])
    expect(placed.some((s) => s.key === 'hint')).toBe(false)
  })

  it('a working order says what it is and has a cancel ×', () => {
    const segs = labelSegments({ ...base, role: 'order', orderType: 'limit' }, 19990)
    expect(segs.map((s) => s.text)).toEqual(['BUY LIMIT 2', '×'])
    expect(labelSegments({ ...base, side: 'short', role: 'order', orderType: 'stop' }, 19990)[0].text).toBe('SELL STOP 2')
  })
})

describe('right-click order pair (3.3, R5)', () => {
  const market = 20050.25

  it('below the market: buy limit + sell stop, sized by the Quick quantity', () => {
    const orders = rightClickOrders(20040, market, 2, 'MNQ', MNQ)
    expect(orders.map((o) => [o.side, o.orderType])).toEqual([
      ['long', 'limit'],
      ['short', 'stop'],
    ])
    expect(orders.map((o) => o.label)).toEqual(['Buy 2 MNQ @ 20,040.00 limit', 'Sell 2 MNQ @ 20,040.00 stop'])
    expect(orders.every((o) => o.contracts === 2 && o.price === 20040)).toBe(true)
  })

  it('above the market: buy stop + sell limit', () => {
    const orders = rightClickOrders(20060.25, market, 3, 'MNQ', MNQ)
    expect(orders.map((o) => [o.side, o.orderType])).toEqual([
      ['long', 'stop'],
      ['short', 'limit'],
    ])
    expect(orders.map((o) => o.label)).toEqual(['Buy 3 MNQ @ 20,060.25 stop', 'Sell 3 MNQ @ 20,060.25 limit'])
  })

  it('snaps the clicked price to the tick before deciding and labelling', () => {
    const orders = rightClickOrders(20050.4, market, 1, 'MNQ', MNQ) // snaps to 20050.50, above the market
    expect(orders[0].price).toBe(20050.5)
    expect(orders[0].orderType).toBe('stop')
  })

  it('offers nothing on the market price itself', () => {
    expect(rightClickOrders(20050.3, market, 2, 'MNQ', MNQ)).toEqual([]) // snaps to the market
  })

  it('a stop/limit is never mislabelled: every order sits on its own side of the market', () => {
    for (const click of [19900, 20000, 20049.75, 20050.5, 20100, 20500]) {
      for (const o of rightClickOrders(click, market, 1, 'MNQ', MNQ)) {
        const above = o.price > market
        if (o.side === 'long') expect(o.orderType).toBe(above ? 'stop' : 'limit')
        else expect(o.orderType).toBe(above ? 'limit' : 'stop')
      }
    }
  })

  it('rounds to the tick helper consistently', () => {
    expect(roundToTick(20050.4, 0.25)).toBe(20050.5)
    expect(roundToTick(20050.1, 0.25)).toBe(20050)
  })
})

describe('partial close and break-even (3.6)', () => {
  it('accepts any whole quantity below the open size', () => {
    for (const q of [1, 2, 7, 49]) expect(partialCloseRefusal(q, 50)).toBeNull()
  })

  it('refuses zero, fractions, the full size, more than open, and a one-lot', () => {
    expect(partialCloseRefusal(0, 4)).not.toBeNull()
    expect(partialCloseRefusal(1.5, 4)).not.toBeNull()
    expect(partialCloseRefusal(4, 4)).not.toBeNull() // that is Close
    expect(partialCloseRefusal(5, 4)).not.toBeNull()
    expect(partialCloseRefusal(1, 1)).not.toBeNull()
  })

  it('lists every quantity for a small position and a spread for a large one', () => {
    expect(partialCloseChoices(1)).toEqual([])
    expect(partialCloseChoices(2)).toEqual([1])
    expect(partialCloseChoices(5)).toEqual([1, 2, 3, 4])
    expect(partialCloseChoices(20)).toEqual([1, 5, 10, 15])
    expect(partialCloseChoices(8).every((q) => q >= 1 && q < 8)).toBe(true)
  })

  it('break-even needs the trade in profit and no stop already at entry', () => {
    const long = { side: 'long' as const, entryPrice: 20000, slPrice: null }
    expect(breakevenRefusal(long, 20010)).toBeNull()
    expect(breakevenRefusal(long, 20000)).not.toBeNull()
    expect(breakevenRefusal(long, 19990)).not.toBeNull()
    expect(breakevenRefusal({ ...long, slPrice: 20000 }, 20010)).not.toBeNull()
    const short = { side: 'short' as const, entryPrice: 20000, slPrice: 20010 }
    expect(breakevenRefusal(short, 19990)).toBeNull()
    expect(breakevenRefusal(short, 20005)).not.toBeNull()
  })

  it('a journaled trade is partly open until its exits cover its entry size', () => {
    const exit = (contracts: number) => ({ time: 1, price: 1, contracts, pnl_usd: 0, commission_usd: 0, exit_type: 'manual_close', risk_usd: null })
    expect(tradeOpenContracts({ size_contracts: 3, exits: [exit(1)] })).toBe(2)
    expect(tradeOpenContracts({ size_contracts: 3, exits: [exit(1), exit(2)] })).toBe(0)
    expect(tradeOpenContracts({ size_contracts: 3, exits: [] })).toBe(0) // pre-G2 trade
    expect(tradeOpenContracts({ size_contracts: 3 })).toBe(0)
  })
})


describe('withBracketsNote (right-click rows while Scalper Mode is armed)', () => {
  const label = 'Buy 2 MNQ @ 20,050.25 limit'
  it('adds "with brackets" only when a stop or a target will really be placed', () => {
    expect(withBracketsNote(label, { slPrice: 20040, tpPrice: 20070 })).toBe(`${label} · with brackets`)
    expect(withBracketsNote(label, { slPrice: 20040, tpPrice: null })).toBe(`${label} · with brackets`)
    expect(withBracketsNote(label, { slPrice: null, tpPrice: 20070 })).toBe(`${label} · with brackets`)
  })
  it('leaves the row exactly as it was when disarmed or when armed with nothing on', () => {
    expect(withBracketsNote(label, null)).toBe(label)
    expect(withBracketsNote(label, { slPrice: null, tpPrice: null })).toBe(label)
  })
})
