// FXR_V2_SPEC.md section 4 (G6): no-overnight / no-weekend holding -- the pure
// close-time arithmetic, and the broker flattening at it with no look-ahead.
import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import { etWallTimeToUnix } from '../timeFormat'
import { entryRefusal, flattenNotice, holdingRule, nextCloseAfter, parseCloseTime, type HoldingRule } from './holdingRestrictions'
import { advanceReplay, CONTRACT_SPECS, type OpenPosition, type WorkingOrder } from './simBroker'

const et = (local: string) => etWallTimeToUnix(local) as number
const rules = (over: Partial<{ no_overnight: boolean; no_weekend: boolean; close_time: string }> = {}) =>
  holdingRule({ no_overnight: true, no_weekend: false, close_time: '16:00', ...over }) as HoldingRule

describe('holdingRule', () => {
  it('is null when neither restriction is on, or the close time is unreadable', () => {
    expect(holdingRule(null)).toBeNull()
    expect(holdingRule({ no_overnight: false, no_weekend: false, close_time: '16:00' })).toBeNull()
    expect(holdingRule({ no_overnight: true, no_weekend: false, close_time: '4pm' })).toBeNull()
  })
  it('parses HH:MM', () => {
    expect(parseCloseTime('16:00')).toBe(960)
    expect(parseCloseTime('09:30')).toBe(570)
    expect(parseCloseTime('24:00')).toBeNull()
  })
})

describe('nextCloseAfter', () => {
  it('no overnight: the same day before the close, the next trading day at or after it', () => {
    // Mon 2025-01-06 (EST).
    expect(nextCloseAfter(rules(), et('2025-01-06T10:00'))).toBe(et('2025-01-06T16:00'))
    expect(nextCloseAfter(rules(), et('2025-01-06T16:00'))).toBe(et('2025-01-07T16:00')) // strictly after
    expect(nextCloseAfter(rules(), et('2025-01-06T18:30'))).toBe(et('2025-01-07T16:00'))
  })
  it('no overnight skips the weekend', () => {
    expect(nextCloseAfter(rules(), et('2025-01-10T17:00'))).toBe(et('2025-01-13T16:00')) // Fri -> Mon
    expect(nextCloseAfter(rules(), et('2025-01-12T19:00'))).toBe(et('2025-01-13T16:00')) // Sun evening -> Mon
  })
  it('no weekend alone only closes on Fridays', () => {
    const r = rules({ no_overnight: false, no_weekend: true })
    expect(nextCloseAfter(r, et('2025-01-06T10:00'))).toBe(et('2025-01-10T16:00'))
    expect(nextCloseAfter(r, et('2025-01-10T16:00'))).toBe(et('2025-01-17T16:00'))
  })
  it('follows ET across the daylight-saving change', () => {
    // 16:00 ET is 21:00Z in January and 20:00Z after the 9 March 2025 spring-forward.
    expect(new Date(nextCloseAfter(rules(), et('2025-01-06T10:00')) * 1000).toISOString()).toBe('2025-01-06T21:00:00.000Z')
    expect(new Date(nextCloseAfter(rules(), et('2025-03-10T10:00')) * 1000).toISOString()).toBe('2025-03-10T20:00:00.000Z')
  })
})

describe('entryRefusal', () => {
  const bar = (local: string) => et(local) // a bar's OPEN time
  it('allows an order on a bar that ends before the close, refuses from the bar that ends at it', () => {
    expect(entryRefusal(rules(), bar('2025-01-06T15:58'))).toBeNull() // fills at 15:59
    expect(entryRefusal(rules(), bar('2025-01-06T15:59'))).toMatch(/No new orders after the 16:00 ET close/) // fills at 16:00
    expect(entryRefusal(rules(), bar('2025-01-06T16:30'))).toMatch(/forbid holding overnight/)
  })
  it('lets orders resume at the 18:00 reopen and the next morning', () => {
    expect(entryRefusal(rules(), bar('2025-01-06T17:58'))).not.toBeNull()
    expect(entryRefusal(rules(), bar('2025-01-06T18:00'))).toBeNull()
    expect(entryRefusal(rules(), bar('2025-01-07T09:30'))).toBeNull()
  })
  it('no weekend: only the Friday close blocks', () => {
    const r = rules({ no_overnight: false, no_weekend: true })
    expect(entryRefusal(r, bar('2025-01-08T16:30'))).toBeNull() // Wednesday after the time: fine
    expect(entryRefusal(r, bar('2025-01-10T16:30'))).toMatch(/forbid holding over the weekend/)
    expect(entryRefusal(r, bar('2025-01-12T18:30'))).toBeNull() // Sunday reopen
  })
  it('is nothing without a rule', () => {
    expect(entryRefusal(null, bar('2025-01-06T16:30'))).toBeNull()
  })
})

describe('flattenNotice', () => {
  it('names the instrument, the close and the rule', () => {
    expect(flattenNotice(rules(), 'MNQ')).toBe('MNQ position flattened at the 16:00 ET close (no overnight holding).')
    expect(flattenNotice(rules({ no_overnight: false, no_weekend: true }), 'MES')).toContain('no weekend holding')
  })
})

// ---- the broker flattening at the close ----

const SPEC = CONTRACT_SPECS.MNQ

function bars(fromLocal: string, count: number, price = 20000, over: Record<number, Partial<Bar>> = {}): Bar[] {
  const t0 = et(fromLocal)
  return Array.from({ length: count }, (_, i) => ({
    time: t0 + i * 60, open: price, high: price, low: price, close: price, volume: 1, ...over[i],
  }))
}

function longAt(feed: Bar[], entryIndex: number, extra: Partial<OpenPosition> = {}): OpenPosition {
  return {
    side: 'long', contracts: 2, entryPrice: feed[entryIndex].close, entryTime: feed[entryIndex].time, entryIndex,
    riskUsd: 40, slPrice: null, tpPrice: null, autoBreakeven: false, trailingPoints: null, tradeKey: 'k',
    initialContracts: 2, ghostSl: null, ghostTp: null, ...extra,
  }
}

const orderAt = (price: number, placedTime: number): WorkingOrder => ({
  id: 'o1', side: 'long', orderType: 'limit', price, contracts: 1, slPrice: null, tpPrice: null, riskUsd: 20,
  placedTime, placedIndex: 0, autoBreakeven: false, trailingPoints: null,
})

describe('advanceReplay with a holding rule', () => {
  it('flattens at the close of the bar that ends at the configured close, and not before', () => {
    // 15:50..16:09 ET. The 15:59 bar ends at 16:00 and closes at 20010.
    const feed = bars('2025-01-06T15:50', 20, 20000, { 9: { close: 20010, high: 20010 } })
    const pos = longAt(feed, 0)
    const before = advanceReplay(feed, 0, 8, pos, [], SPEC, 0, rules())
    expect(before.position).not.toBeNull()
    expect(before.flattenedAtClose).toBe(false)

    const r = advanceReplay(feed, 0, 12, pos, [], SPEC, 0, rules())
    expect(r.position).toBeNull()
    expect(r.flattenedAtClose).toBe(true)
    expect(r.closedTrades).toHaveLength(1)
    const t = r.closedTrades[0]
    expect(t.exitType).toBe('session_close')
    expect(t.exitTime).toBe(feed[9].time) // the 15:59 bar
    expect(t.exitPrice).toBe(20010)
    expect(t.pnlUsd).toBe(10 * SPEC.pointValue * 2)
  })

  it('never reads a bar after the one it flattens on', () => {
    const feed = bars('2025-01-06T15:50', 20, 20000, { 9: { close: 20010 }, 12: { close: 1, low: 1, high: 99999 } })
    const r = advanceReplay(feed, 0, 12, longAt(feed, 0), [], SPEC, 0, rules())
    expect(r.closedTrades[0].exitPrice).toBe(20010)
  })

  it('gives the same trade whether stepped bar by bar or in one jump', () => {
    const feed = bars('2025-01-06T15:50', 20, 20000, { 9: { close: 20010 } })
    const jump = advanceReplay(feed, 0, 19, longAt(feed, 0), [], SPEC, 0, rules())
    let pos: OpenPosition | null = longAt(feed, 0)
    const closed = []
    for (let i = 0; i < 19; i++) {
      const r = advanceReplay(feed, i, i + 1, pos, [], SPEC, 0, rules())
      pos = r.position
      closed.push(...r.closedTrades)
    }
    expect(closed).toEqual(jump.closedTrades)
  })

  it('applies a close that falls in a gap at the last bar before it, and lets nothing fill after', () => {
    // 15:50..15:54 ET, then the market is shut until the 18:00 reopen.
    const day = bars('2025-01-06T15:50', 5, 20000, { 4: { close: 20004 } })
    const reopen = bars('2025-01-06T18:00', 3, 19000, { 0: { low: 18000, high: 19000 } })
    const feed = [...day, ...reopen]
    const order = orderAt(18500, day[0].time) // would fill on the 18:00 bar
    const r = advanceReplay(feed, 0, 7, longAt(feed, 0), [order], SPEC, 0, rules())
    expect(r.closedTrades).toHaveLength(1)
    expect(r.closedTrades[0].exitTime).toBe(day[4].time)
    expect(r.closedTrades[0].exitPrice).toBe(20004)
    expect(r.workingOrders).toEqual([])
    expect(r.position).toBeNull() // the cancelled order never became a position
    expect(r.filledOrderIds).toEqual([])
  })

  it('cancels a working order at the close even with no position', () => {
    const feed = bars('2025-01-06T15:50', 20)
    const r = advanceReplay(feed, 0, 12, null, [orderAt(15000, feed[0].time)], SPEC, 0, rules())
    expect(r.workingOrders).toEqual([])
    expect(r.flattenedAtClose).toBe(true)
    expect(r.closedTrades).toEqual([])
  })

  it('an SL hit on the closing bar wins over the flatten (it happened inside the bar)', () => {
    const feed = bars('2025-01-06T15:50', 20, 20000, { 9: { low: 19980, close: 19990 } })
    const r = advanceReplay(feed, 0, 12, longAt(feed, 0, { slPrice: 19985 }), [], SPEC, 0, rules())
    expect(r.closedTrades).toHaveLength(1)
    expect(r.closedTrades[0].exitType).toBe('stop_loss')
    expect(r.flattenedAtClose).toBe(false)
  })

  it('holds a position through the close when there is no rule, or only the weekend rule on a Monday', () => {
    const feed = bars('2025-01-06T15:50', 20)
    expect(advanceReplay(feed, 0, 19, longAt(feed, 0), [], SPEC, 0, null).position).not.toBeNull()
    const weekend = rules({ no_overnight: false, no_weekend: true })
    expect(advanceReplay(feed, 0, 19, longAt(feed, 0), [], SPEC, 0, weekend).position).not.toBeNull()
  })

  it('flattens on a Friday under the weekend rule', () => {
    const feed = bars('2025-01-10T15:50', 20)
    const weekend = rules({ no_overnight: false, no_weekend: true })
    const r = advanceReplay(feed, 0, 19, longAt(feed, 0), [], SPEC, 0, weekend)
    expect(r.position).toBeNull()
    expect(r.closedTrades[0].exitType).toBe('session_close')
  })

  it('flattens at Monday close even when the jump runs into Tuesday', () => {
    const mon = bars('2025-01-06T15:55', 10) // 15:55..16:04
    const tue = bars('2025-01-07T09:30', 1)
    const feed = [...mon, ...tue]
    const r = advanceReplay(feed, 0, 10, longAt(feed, 0), [], SPEC, 0, rules())
    expect(r.closedTrades).toHaveLength(1)
    expect(r.closedTrades[0].exitTime).toBe(feed[4].time) // the 15:59 bar
  })
})
