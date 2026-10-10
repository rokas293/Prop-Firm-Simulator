// FXR_V2_SPEC.md section 4 (G7): two instruments, one cursor, one account.
// advanceSession walks every instrument's book on the shared 1m clock. These tests
// pin what makes that safe: a single-asset session fills exactly as advanceReplay
// does, each instrument's orders only ever meet its own bars, and the account's
// position cap holds across instruments at the moment a resting order would fill.
import { describe, expect, it } from 'vitest'
import {
  EMPTY_BOOK,
  advanceReplay,
  advanceSession,
  getContractSpec,
  sessionUnrealizedPnl,
  type InstrumentBook,
  type OpenPosition,
  type WorkingOrder,
} from './simBroker'
import { openContractsElsewhere, capRoom, positionCapMessage } from './positionCap'
import type { HoldingRule } from './holdingRestrictions'
import type { Bar } from '../api/types'

// 2024-03-06 13:00 UTC = 08:00 ET (Wednesday, EST).
const T0 = Date.UTC(2024, 2, 6, 13, 0, 0) / 1000

// A deterministic 1-minute feed: a seeded random walk with real ranges.
function feed(start: number, minutes: number, seed: number, step = 60): Bar[] {
  let state = seed
  const rnd = () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  const bars: Bar[] = []
  let price = start
  for (let i = 0; i < minutes; i++) {
    const open = price
    const close = Math.round((open + (rnd() - 0.5) * 6) * 4) / 4
    const high = Math.max(open, close) + Math.round(rnd() * 3 * 4) / 4
    const low = Math.min(open, close) - Math.round(rnd() * 3 * 4) / 4
    bars.push({ time: T0 + i * step, open, high, low, close, volume: 100 })
    price = close
  }
  return bars
}

const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  side: 'long',
  contracts: 1,
  entryPrice: 5000,
  entryTime: T0,
  entryIndex: 0,
  riskUsd: 100,
  slPrice: null,
  tpPrice: null,
  autoBreakeven: false,
  trailingPoints: null,
  tradeKey: 'trade-1',
  initialContracts: 1,
  ghostSl: null,
  ghostTp: null,
  ...over,
})

const order = (over: Partial<WorkingOrder> = {}): WorkingOrder => ({
  id: 'o1',
  side: 'long',
  orderType: 'limit',
  price: 5000,
  contracts: 1,
  slPrice: null,
  tpPrice: null,
  riskUsd: 100,
  placedTime: T0,
  placedIndex: 0,
  autoBreakeven: false,
  trailingPoints: null,
  ...over,
})

const bar = (time: number, o: number, h: number, l: number, c: number): Bar => ({ time, open: o, high: h, low: l, close: c, volume: 1 })

describe('advanceSession: a single-asset session is advanceReplay', () => {
  // Rewritten so the closed trades compare without the instrument tag.
  const strip = <T extends { instrument?: string }>(rows: T[]) => rows.map(({ instrument: _i, ...rest }) => rest)

  const scenarios: { name: string; pos: OpenPosition | null; orders: WorkingOrder[]; holding: HoldingRule | null }[] = [
    { name: 'a long with a stop and a target', pos: position({ slPrice: 4985, tpPrice: 5020 }), orders: [], holding: null },
    { name: 'a short with auto break-even and a trail', pos: position({ side: 'short', slPrice: 5015, autoBreakeven: true, trailingPoints: 6 }), orders: [], holding: null },
    { name: 'a resting limit that fills, then its bracket', pos: null, orders: [order({ price: 4994, slPrice: 4980, tpPrice: 5012 })], holding: null },
    { name: 'a stop order and the 16:00 no-overnight flatten', pos: null, orders: [order({ id: 'o2', orderType: 'stop', price: 5004, side: 'long' })], holding: { noOvernight: true, noWeekend: false, closeMinutes: 16 * 60, closeLabel: '16:00' } },
    { name: 'an open position flattened at the close', pos: position({ slPrice: 4900 }), orders: [], holding: { noOvernight: true, noWeekend: false, closeMinutes: 16 * 60, closeLabel: '16:00' } },
  ]

  for (const sc of scenarios) {
    for (const seed of [3, 17, 91]) {
      for (const stepBars of [1, 7, 60, 600]) {
        it(`${sc.name}, seed ${seed}, stepping ${stepBars} bars at a time`, () => {
          const bars = feed(5000, 660, seed)
          const spec = getContractSpec('MES')

          // advanceReplay: the original single-instrument walk, one step.
          const ref = advanceReplay(bars, 0, bars.length - 1, sc.pos, sc.orders, spec, 1.3, sc.holding)

          // advanceSession, stepped `stepBars` at a time.
          let books: Record<string, InstrumentBook> = { MES: { position: sc.pos, workingOrders: sc.orders } }
          const trades: ReturnType<typeof advanceSession>['closedTrades'] = []
          const filled: string[] = []
          for (let from = 0; from < bars.length - 1; from += stepBars) {
            const to = Math.min(bars.length - 1, from + stepBars)
            const r = advanceSession({
              feeds: { MES: bars },
              books,
              fromTime: bars[from].time,
              toTime: bars[to].time,
              commissions: { MES: 1.3 },
              holding: sc.holding,
              cap: null,
            })
            books = r.books
            trades.push(...r.closedTrades)
            filled.push(...r.filledOrderIds)
            expect(r.rejectedOrders).toEqual([])
          }

          expect(books.MES.position).toEqual(ref.position)
          expect(books.MES.workingOrders).toEqual(ref.workingOrders)
          expect(strip(trades)).toEqual(ref.closedTrades)
          expect(filled).toEqual(ref.filledOrderIds)
        })
      }
    }
  }
})

describe('advanceSession: fills are per instrument and never look ahead', () => {
  // MES and MNQ at completely different price levels.
  const mes = [bar(T0, 5000, 5002, 4998, 5001), bar(T0 + 60, 5001, 5003, 4999, 5002), bar(T0 + 120, 5002, 5004, 4990, 4995), bar(T0 + 180, 4995, 5001, 4994, 5000)]
  const mnq = [bar(T0, 18000, 18010, 17995, 18005), bar(T0 + 60, 18005, 18030, 18000, 18020), bar(T0 + 120, 18020, 18025, 17900, 17950), bar(T0 + 180, 17950, 18040, 17940, 18035)]

  it("an instrument's order is judged only against that instrument's own bars", () => {
    // A MES buy limit at 4992 and a MNQ buy limit at 17960: each fills on its own
    // feed's third minute -- MES's low 4990 and MNQ's low 17900 -- and the MES
    // order would never be touched by MNQ's prices (nor MNQ's by MES's).
    const r = advanceSession({
      feeds: { MES: mes, MNQ: mnq },
      books: {
        MES: { position: null, workingOrders: [order({ id: 'mes', price: 4992, placedTime: T0 })] },
        MNQ: { position: null, workingOrders: [order({ id: 'mnq', price: 17960, placedTime: T0 })] },
      },
      fromTime: T0,
      toTime: T0 + 120,
      commissions: { MES: 1.3, MNQ: 1.3 },
      holding: null,
      cap: null,
    })
    expect(r.books.MES.position?.entryPrice).toBe(4992)
    expect(r.books.MNQ.position?.entryPrice).toBe(17960)
    expect(r.filledOrderIds.sort()).toEqual(['mes', 'mnq'])
  })

  it('a price one instrument reaches never fills the other instrument', () => {
    // A MES limit at 17960 (a MNQ-level price) can never trade on MES's bars.
    const r = advanceSession({
      feeds: { MES: mes, MNQ: mnq },
      books: { MES: { position: null, workingOrders: [order({ id: 'x', price: 17960, side: 'short', orderType: 'limit' })] }, MNQ: EMPTY_BOOK },
      fromTime: T0,
      toTime: T0 + 180,
      commissions: { MES: 1.3, MNQ: 1.3 },
      holding: null,
      cap: null,
    })
    expect(r.books.MNQ.position).toBeNull()
    expect(r.books.MES.position).toBeNull()
  })

  it('reads nothing after the cursor: a bar past toTime cannot fill', () => {
    // The 4990 low is on the third bar (T0 + 120); stopping at T0 + 60 must leave
    // the order resting.
    const r = advanceSession({
      feeds: { MES: mes },
      books: { MES: { position: null, workingOrders: [order({ price: 4992, placedTime: T0 })] } },
      fromTime: T0,
      toTime: T0 + 60,
      commissions: { MES: 1.3 },
      holding: null,
      cap: null,
    })
    expect(r.books.MES.position).toBeNull()
    expect(r.books.MES.workingOrders).toHaveLength(1)
  })

  it("closing trades carry their instrument and use that instrument's point value", () => {
    // MES long 1 from 5000 stopped at 4995 (-5 pts * $5); MNQ long 1 from 18000
    // stopped at 17950 (-50 pts * $2): both stops hit on the third minute.
    const r = advanceSession({
      feeds: { MES: mes, MNQ: mnq },
      books: {
        MES: { position: position({ entryPrice: 5000, slPrice: 4995 }), workingOrders: [] },
        MNQ: { position: position({ entryPrice: 18000, slPrice: 17950, tradeKey: 'trade-2' }), workingOrders: [] },
      },
      fromTime: T0,
      toTime: T0 + 120,
      commissions: { MES: 0, MNQ: 0 },
      holding: null,
      cap: null,
    })
    const by = Object.fromEntries(r.closedTrades.map((t) => [t.instrument, t.pnlUsd]))
    expect(by.MES).toBe(-25)
    expect(by.MNQ).toBe(-100)
  })
})

describe('the position cap counts contracts across instruments', () => {
  const mes = feed(5000, 30, 5)
  const mnq = feed(18000, 30, 6)

  it('openContractsElsewhere sums every other instrument', () => {
    const books = { MNQ: { position: position({ contracts: 3 }), workingOrders: [] }, MES: { position: position({ contracts: 2 }), workingOrders: [] } }
    expect(openContractsElsewhere(books, 'MES')).toBe(3)
    expect(openContractsElsewhere(books, 'MNQ')).toBe(2)
    expect(openContractsElsewhere(books)).toBe(5)
  })

  it('3 MNQ open leaves room for 2 MES, not 3', () => {
    expect(capRoom(5, 3)).toBe(2)
    expect(positionCapMessage(2, 5, 'Order', 3, 'MNQ')).toBeNull()
    const msg = positionCapMessage(3, 5, 'Order', 3, 'MNQ')
    expect(msg).toContain('6 open')
    expect(msg).toContain('3 already in MNQ')
    expect(msg).toContain('every instrument together')
    expect(capRoom(null, 3)).toBeNull()
  })

  it('a resting order that would breach the cap when it fills is cancelled with the reason', () => {
    // 3 MNQ are open; a 3-lot MES limit would make 6 > 5 at its fill.
    const limit = order({ id: 'mes-3', price: 4980, side: 'short', contracts: 3, orderType: 'limit' })
    const r = advanceSession({
      feeds: { MES: mes, MNQ: mnq },
      books: {
        MNQ: { position: position({ contracts: 3, entryPrice: 18000, entryTime: mnq[0].time }), workingOrders: [] },
        MES: { position: null, workingOrders: [limit] },
      },
      fromTime: mes[0].time,
      toTime: mes[mes.length - 1].time,
      commissions: { MES: 1.3, MNQ: 1.3 },
      holding: null,
      cap: 5,
      capMessage: (contracts, elsewhere) => positionCapMessage(contracts, 5, 'Order', elsewhere, 'MNQ'),
    })
    expect(r.books.MES.position).toBeNull()
    expect(r.books.MES.workingOrders).toEqual([])
    expect(r.rejectedOrders).toHaveLength(1)
    expect(r.rejectedOrders[0]).toMatchObject({ instrument: 'MES', id: 'mes-3' })
    expect(r.rejectedOrders[0].reason).toContain('3 already in MNQ')
    // the MNQ position is untouched
    expect(r.books.MNQ.position?.contracts).toBe(3)
  })

  it('the same order fills when it fits (2 MES with 3 MNQ open = 5)', () => {
    const limit = order({ id: 'mes-2', price: 4980, side: 'short', contracts: 2, orderType: 'limit' })
    const r = advanceSession({
      feeds: { MES: mes, MNQ: mnq },
      books: {
        MNQ: { position: position({ contracts: 3, entryPrice: 18000, entryTime: mnq[0].time }), workingOrders: [] },
        MES: { position: null, workingOrders: [limit] },
      },
      fromTime: mes[0].time,
      toTime: mes[mes.length - 1].time,
      commissions: { MES: 1.3, MNQ: 1.3 },
      holding: null,
      cap: 5,
    })
    expect(r.rejectedOrders).toEqual([])
    expect(r.books.MES.position?.contracts).toBe(2)
  })

  it('exits free the cap in time order: MNQ closes at minute 2, so a MES fill at minute 3 fits', () => {
    // 5 MNQ open, stopped out at 17990 on the second bar; a 1-lot MES buy limit
    // that only touches on the third bar fits because the minutes are processed in
    // time order across instruments.
    const mnqBars = [bar(T0, 18000, 18001, 17999, 18000), bar(T0 + 60, 18000, 18001, 17980, 17985), bar(T0 + 120, 17985, 17990, 17980, 17988)]
    const mesBars = [bar(T0, 5000, 5001, 4999, 5000), bar(T0 + 60, 5000, 5001, 4999, 5000), bar(T0 + 120, 5000, 5001, 4980, 4985)]
    const r = advanceSession({
      feeds: { MES: mesBars, MNQ: mnqBars },
      books: {
        MNQ: { position: position({ contracts: 5, entryPrice: 18000, slPrice: 17990, entryTime: T0 }), workingOrders: [] },
        MES: { position: null, workingOrders: [order({ id: 'late', price: 4990, contracts: 1, placedTime: T0 })] },
      },
      fromTime: T0,
      toTime: T0 + 120,
      commissions: { MES: 0, MNQ: 0 },
      holding: null,
      cap: 5,
    })
    expect(r.books.MNQ.position).toBeNull()
    expect(r.rejectedOrders).toEqual([])
    expect(r.books.MES.position?.entryPrice).toBe(4990)
  })
})

describe('sessionUnrealizedPnl', () => {
  it('sums every open position, each at its own instrument price and point value', () => {
    const books = {
      MNQ: { position: position({ side: 'long', contracts: 2, entryPrice: 18000 }), workingOrders: [] },
      MES: { position: position({ side: 'short', contracts: 3, entryPrice: 5000 }), workingOrders: [] },
    }
    // MNQ: +10 pts * $2 * 2 = +40; MES short: (5000 - 4996) * $5 * 3 = +60
    expect(sessionUnrealizedPnl(books, { MNQ: 18010, MES: 4996 })).toBe(100)
    // ...and a loss on one nets against a gain on the other.
    expect(sessionUnrealizedPnl(books, { MNQ: 17980, MES: 4996 })).toBe(-80 + 60)
  })

  it('counts a book with no mark yet as nothing, and a flat book as nothing', () => {
    const books = { MNQ: { position: position({ contracts: 1, entryPrice: 18000 }), workingOrders: [] }, MES: EMPTY_BOOK }
    expect(sessionUnrealizedPnl(books, { MES: 5000 })).toBe(0)
    expect(sessionUnrealizedPnl(books, { MNQ: 18005 })).toBe(10)
  })
})
