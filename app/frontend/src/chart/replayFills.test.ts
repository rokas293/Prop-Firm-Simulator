// FXR_V2_SPEC.md section 5 (G5): fills are evaluated on EVERY 1m bar, whatever the
// chart's timeframe or the step size. These tests pin the three things that has
// to mean: the true order of events inside an hour decides a same-hour SL+TP
// case, a result never depends on a bar after the cursor, and it does not depend
// on how the replay was stepped.
import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import { advanceReplay, type AdvanceReplayResult, type OpenPosition, type WorkingOrder, CONTRACT_SPECS } from './simBroker'
import { formingBar, nextStepIndex } from './replayBars'

const SPEC = CONTRACT_SPECS.MNQ
const T0 = 1_741_564_800 // 2025-03-10 00:00 UTC

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One flat hour of 1m bars at `price`, with chosen minutes overridden.
function flatHour(price: number, overrides: Record<number, Partial<Bar>> = {}, minutes = 60): Bar[] {
  return Array.from({ length: minutes }, (_, m) => ({
    time: T0 + m * 60,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 10,
    ...overrides[m],
  }))
}

function longAt(entryIndex: number, feed: Bar[], extra: Partial<OpenPosition> = {}): OpenPosition {
  return {
    side: 'long',
    contracts: 1,
    entryPrice: feed[entryIndex].close,
    entryTime: feed[entryIndex].time,
    entryIndex,
    riskUsd: 40,
    slPrice: null,
    tpPrice: null,
    autoBreakeven: false,
    trailingPoints: null,
    tradeKey: 'k1',
    initialContracts: 1,
    ghostSl: null,
    ghostTp: null,
    ...extra,
  }
}

const advance = (feed: Bar[], from: number, to: number, pos: OpenPosition | null, orders: WorkingOrder[] = []) =>
  advanceReplay(feed, from, to, pos, orders, SPEC, 0)

describe('a same-hour SL+TP case resolves by the real order of the 1m bars', () => {
  // Entry 20000 long, TP 20010, SL 19990. Inside ONE hour both levels are touched.
  const entry = 20000
  const tpFirst = flatHour(entry, { 10: { high: 20012 }, 40: { low: 19985 } }) // TP at 00:10, SL at 00:40
  const slFirst = flatHour(entry, { 10: { low: 19985 }, 40: { high: 20012 } }) // SL at 00:10, TP at 00:40

  it('stepping the whole hour at once still takes the level touched FIRST', () => {
    const a = advance(tpFirst, 0, 59, longAt(0, tpFirst, { slPrice: 19990, tpPrice: 20010 }))
    expect(a.closedTrades).toHaveLength(1)
    expect(a.closedTrades[0]).toMatchObject({ exitType: 'take_profit', exitPrice: 20010, exitTime: T0 + 10 * 60 })
    const b = advance(slFirst, 0, 59, longAt(0, slFirst, { slPrice: 19990, tpPrice: 20010 }))
    expect(b.closedTrades[0]).toMatchObject({ exitType: 'stop_loss', exitPrice: 19990, exitTime: T0 + 10 * 60 })
  })

  it('is what the old hour-bar replay could not know: its single bar touched both, so it always assumed the stop', () => {
    const hourBar = formingBar(tpFirst, 59, 3600)
    expect(hourBar.high).toBeGreaterThanOrEqual(20010)
    expect(hourBar.low).toBeLessThanOrEqual(19990)
    // The old replay: the entry sat on the previous hour's bar, and this hour was ONE bar.
    const previousHour: Bar = { time: T0 - 3600, open: entry, high: entry, low: entry, close: entry, volume: 1 }
    const old = advance([previousHour, hourBar], 0, 1, longAt(0, [previousHour], { slPrice: 19990, tpPrice: 20010 }))
    expect(old.closedTrades[0].exitType).toBe('stop_loss') // wrong: the target was hit first
    const truth = advance(tpFirst, 0, 59, longAt(0, tpFirst, { slPrice: 19990, tpPrice: 20010 }))
    expect(truth.closedTrades[0].exitType).toBe('take_profit')
  })

  it('a short resolves the same way (target below, stop above)', () => {
    const feed = flatHour(entry, { 20: { low: 19988 }, 30: { high: 20015 } }) // target 00:20, stop 00:30
    const r = advance(feed, 0, 59, longAt(0, feed, { side: 'short', slPrice: 20010, tpPrice: 19990 }))
    expect(r.closedTrades[0]).toMatchObject({ exitType: 'take_profit', exitPrice: 19990, exitTime: T0 + 20 * 60 })
  })

  it('both touched inside a SINGLE minute is the one case left ambiguous: the stop, as in the engine', () => {
    const feed = flatHour(entry, { 15: { high: 20012, low: 19985 } })
    const r = advance(feed, 0, 59, longAt(0, feed, { slPrice: 19990, tpPrice: 20010 }))
    expect(r.closedTrades[0]).toMatchObject({ exitType: 'stop_loss', exitTime: T0 + 15 * 60 })
  })

  it('the fill happens at the right minute even if the step stops earlier or later', () => {
    const pos = longAt(0, tpFirst, { slPrice: 19990, tpPrice: 20010 })
    const early = advance(tpFirst, 0, 9, pos) // before 00:10: nothing yet
    expect(early.closedTrades).toHaveLength(0)
    const at = advance(tpFirst, 0, 10, pos) // the step ends ON the minute
    expect(at.closedTrades[0].exitTime).toBe(T0 + 10 * 60)
    const after = advance(tpFirst, 10, 59, at.position) // nothing left to close
    expect(after.closedTrades).toHaveLength(0)
  })

  it('a working order fills at its minute and its own bracket then resolves by the later minutes', () => {
    const feed = flatHour(entry, { 5: { low: 19995 }, 12: { high: 20011 }, 30: { low: 19980 } })
    const order: WorkingOrder = {
      id: 'o1', side: 'long', orderType: 'limit', price: 19995, contracts: 1, slPrice: 19990, tpPrice: 20010,
      riskUsd: 10, placedTime: feed[0].time, placedIndex: 0, autoBreakeven: false, trailingPoints: null,
    }
    const r = advance(feed, 0, 59, null, [order])
    expect(r.filledOrderIds).toEqual(['o1'])
    expect(r.closedTrades[0]).toMatchObject({ entryTime: T0 + 5 * 60, entryPrice: 19995, exitType: 'take_profit', exitTime: T0 + 12 * 60 })
  })
})

describe('break-even and trailing are evaluated every minute too', () => {
  it('a trailing stop ratchets on the minute price peaks and is hit on the minute it gives it back', () => {
    // +10 at 00:10 (stop trails to +5), back to +4 at 00:20 -> stopped at +5 at 00:20.
    const hold = (price: number) => ({ open: price, high: price, low: price, close: price })
    const overrides: Record<number, Partial<Bar>> = { 10: hold(20010), 20: { ...hold(20004) } }
    for (let m = 11; m < 20; m++) overrides[m] = hold(20008) // holds above the trailed stop
    for (let m = 21; m < 60; m++) overrides[m] = hold(20004)
    const feed = flatHour(20000, overrides)
    const r = advance(feed, 0, 59, longAt(0, feed, { slPrice: 19990, trailingPoints: 5 }))
    expect(r.closedTrades[0]).toMatchObject({ exitType: 'stop_loss', exitPrice: 20005, exitTime: T0 + 20 * 60 })
    // The hour candle alone would show a high of +10 and a close of +4: the trail
    // would have been applied once, at the hour's end, and never been hit.
    const hourBar = formingBar(feed, 59, 3600)
    const previousHour: Bar = { time: T0 - 3600, open: 20000, high: 20000, low: 20000, close: 20000, volume: 1 }
    const old = advance([previousHour, hourBar], 0, 1, longAt(0, [previousHour], { slPrice: 19990, trailingPoints: 5 }))
    expect(old.closedTrades).toHaveLength(0) // never hit: the trail was applied once, at the end of the hour
  })

  it('auto break-even moves the stop on the minute the trigger is reached, then the retrace takes it out', () => {
    const feed = flatHour(20000, { 8: { high: 20020 }, 9: { low: 19999 }, 25: { low: 19998 } })
    const r = advance(feed, 0, 59, longAt(0, feed, { slPrice: 19990, autoBreakeven: true, breakevenPoints: 15 }))
    // +20 at 00:08 trips break-even (stop to entry); the first minute back through
    // the entry (00:09 touches 19999) stops it out at 20000.
    expect(r.closedTrades[0]).toMatchObject({ exitType: 'stop_loss', exitPrice: 20000, exitTime: T0 + 9 * 60 })
  })
})

// ---- randomised properties --------------------------------------------------

function randomFeed(r: () => number, minutes: number, price = 20000): Bar[] {
  const bars: Bar[] = []
  let p = price
  for (let m = 0; m < minutes; m++) {
    const open = p
    p += (r() - 0.5) * 10
    bars.push({
      time: T0 + m * 60,
      open,
      high: Math.max(open, p) + r() * 4,
      low: Math.min(open, p) - r() * 4,
      close: p,
      volume: 1 + Math.floor(r() * 50),
    })
  }
  return bars
}

const POISON = { open: 9e8, high: 9e9, low: -9e9, close: 5e8, volume: 9e8 }
const poisonAfter = (feed: Bar[], cursor: number): Bar[] => feed.map((b, i) => (i > cursor ? { ...POISON, time: b.time } : b))

// A random trade set-up at the cursor: either a position or a working order (or
// both set on different sides), with random SL/TP/break-even/trailing.
function randomSetup(r: () => number, feed: Bar[], at: number): { position: OpenPosition | null; orders: WorkingOrder[] } {
  const px = feed[at].close
  const side = r() < 0.5 ? 'long' : 'short'
  const sgn = side === 'long' ? 1 : -1
  const sl = r() < 0.8 ? px - sgn * (3 + r() * 25) : null
  const tp = r() < 0.8 ? px + sgn * (3 + r() * 40) : null
  const common = {
    side: side as 'long' | 'short',
    contracts: 1 + Math.floor(r() * 3),
    slPrice: sl,
    tpPrice: tp,
    autoBreakeven: r() < 0.3,
    trailingPoints: r() < 0.3 ? 4 + r() * 10 : null,
  }
  if (r() < 0.5) {
    return {
      position: {
        ...common, entryPrice: px, entryTime: feed[at].time, entryIndex: at, riskUsd: 50, breakevenPoints: r() < 0.5 ? 6 : null,
        tradeKey: 'p', initialContracts: common.contracts, ghostSl: null, ghostTp: null,
      },
      orders: [],
    }
  }
  const limitPrice = px - sgn * (2 + r() * 15)
  return {
    position: null,
    orders: [
      {
        id: 'o', side: common.side, orderType: r() < 0.5 ? 'limit' : 'stop',
        price: r() < 0.5 ? limitPrice : px + sgn * (2 + r() * 15),
        contracts: common.contracts, slPrice: sl, tpPrice: tp, riskUsd: 50, placedTime: feed[at].time, placedIndex: at,
        autoBreakeven: common.autoBreakeven, trailingPoints: common.trailingPoints,
      },
    ],
  }
}

const sameResult = (a: AdvanceReplayResult, b: AdvanceReplayResult) => expect(a).toEqual(b)

describe('fills never depend on bars after the cursor (randomised)', () => {
  it('poisoning every bar after the cursor changes no fill, exit, stop move or trade', () => {
    const r = rng(2025)
    for (let n = 0; n < 300; n++) {
      const feed = randomFeed(r, 240)
      const at = 5 + Math.floor(r() * 40)
      const { position, orders } = randomSetup(r, feed, at)
      const cursor = at + 1 + Math.floor(r() * 180)
      const clean = advance(feed, at, cursor, position, orders)
      const poisoned = advance(poisonAfter(feed, cursor), at, cursor, position, orders)
      sameResult(poisoned, clean)
    }
  })

  it('and the same holds for a whole stepped replay: the state at every cursor is blind to what comes after', () => {
    const r = rng(77)
    for (let n = 0; n < 60; n++) {
      const feed = randomFeed(r, 300)
      const step = [60, 300, 900, 3600][Math.floor(r() * 4)]
      const at = 3
      const { position, orders } = randomSetup(r, feed, at)
      const stopAt = 20 + Math.floor(r() * 250)

      // Walk the clean feed step by step, remembering the state when the cursor first reaches >= stopAt.
      let cursor = at
      let pos = position
      let ords = orders
      const closed: AdvanceReplayResult['closedTrades'] = []
      while (cursor < stopAt) {
        const next = nextStepIndex(feed, cursor, step, stopAt)
        const res = advance(feed, cursor, next, pos, ords)
        pos = res.position
        ords = res.workingOrders
        closed.push(...res.closedTrades)
        cursor = next
      }

      // The same walk on a feed whose future is garbage must land in the identical state.
      const bad = poisonAfter(feed, cursor)
      let cursor2 = at
      let pos2 = position
      let ords2 = orders
      const closed2: AdvanceReplayResult['closedTrades'] = []
      while (cursor2 < cursor) {
        const next = nextStepIndex(bad, cursor2, step, cursor)
        const res = advance(bad, cursor2, next, pos2, ords2)
        pos2 = res.position
        ords2 = res.workingOrders
        closed2.push(...res.closedTrades)
        cursor2 = next
      }
      expect(cursor2).toBe(cursor)
      expect(pos2).toEqual(pos)
      expect(ords2).toEqual(ords)
      expect(closed2).toEqual(closed)
    }
  })
})

describe('the result does not depend on how the replay was stepped (randomised)', () => {
  it('one minute at a time, any chunking, or all at once: the same trades, stops and fills', () => {
    const r = rng(4242)
    for (let n = 0; n < 200; n++) {
      const feed = randomFeed(r, 240)
      const at = 2 + Math.floor(r() * 20)
      const { position, orders } = randomSetup(r, feed, at)
      const end = 200

      const once = advance(feed, at, end, position, orders)

      let pos = position
      let ords = orders
      let closed: AdvanceReplayResult['closedTrades'] = []
      let filled: string[] = []
      for (let c = at; c < end; c++) {
        const res = advance(feed, c, c + 1, pos, ords)
        pos = res.position
        ords = res.workingOrders
        closed = closed.concat(res.closedTrades)
        filled = filled.concat(res.filledOrderIds)
      }
      expect(closed).toEqual(once.closedTrades)
      expect(pos).toEqual(once.position)
      expect(ords).toEqual(once.workingOrders)
      expect(filled).toEqual(once.filledOrderIds)

      let c = at
      pos = position
      ords = orders
      closed = []
      while (c < end) {
        const next = Math.min(end, c + 1 + Math.floor(r() * 90))
        const res = advance(feed, c, next, pos, ords)
        pos = res.position
        ords = res.workingOrders
        closed = closed.concat(res.closedTrades)
        c = next
      }
      expect(closed).toEqual(once.closedTrades)
      expect(pos).toEqual(once.position)
    }
  })
})

describe('existing sessions: stepping by their old base bar gives the old results unless a bar was ambiguous', () => {
  // A legacy 5m session evaluated whole 5m bars. With only ONE level set there is
  // no SL-vs-TP ambiguity, so the 1m walk must close at the same price and for the
  // same reason -- only the exit TIME is now the true minute.
  it('same exit type and price as the 5m-bar replay when only one level can be hit', () => {
    const r = rng(9)
    let compared = 0
    for (let n = 0; n < 300; n++) {
      const feed = randomFeed(r, 600)
      const at = 4 + 5 * Math.floor(r() * 10) // the last minute of a 5m candle
      const side = r() < 0.5 ? 'long' : 'short'
      const sgn = side === 'long' ? 1 : -1
      const px = feed[at].close
      const useSl = r() < 0.5
      const dist = 5 + r() * 30
      const level = useSl ? { slPrice: px - sgn * dist } : { tpPrice: px + sgn * dist }
      const pos = longAt(at, feed, { side, entryPrice: px, ...level })

      // The old replay: 5m bars of the same feed, the cursor on the candle ending at `at`.
      const bars5: Bar[] = []
      for (let i = 4; i < feed.length; i += 5) bars5.push(formingBar(feed, i, 300))
      const idx5 = (at - 4) / 5
      const old = advance(bars5, idx5, bars5.length - 1, { ...pos, entryIndex: idx5, entryTime: bars5[idx5].time })
      const now = advance(feed, at, feed.length - 1, pos)

      expect(now.closedTrades.length).toBe(old.closedTrades.length)
      if (old.closedTrades[0]) {
        compared++
        expect(now.closedTrades[0].exitType).toBe(old.closedTrades[0].exitType)
        expect(now.closedTrades[0].exitPrice).toBe(old.closedTrades[0].exitPrice)
        expect(now.closedTrades[0].pnlUsd).toBe(old.closedTrades[0].pnlUsd)
        // And the true minute lies inside the 5m bar the old replay closed on.
        const exit5 = bars5[bars5.findIndex((b) => b.time + 300 > now.closedTrades[0].exitTime && b.time <= now.closedTrades[0].exitTime)]
        expect(old.closedTrades[0].exitTime).toBe(exit5.time)
      }
    }
    expect(compared).toBeGreaterThan(100)
  })
})

describe('rewinding does not make a trade react to price action from before it existed', () => {
  it('a position entered at 00:30, with the cursor rewound to 00:10 and replayed, is not stopped by the 00:20 dip', () => {
    const feed = flatHour(20000, { 20: { low: 19950 } })
    const pos = longAt(30, feed, { slPrice: 19990 })
    const replayed = advance(feed, 10, 59, pos) // the cursor was rewound to minute 10, then stepped forward
    expect(replayed.closedTrades).toHaveLength(0)
    expect(replayed.position).not.toBeNull()
  })

  it('an order placed at 00:30 is not filled by the touch at 00:20 when the replay passes it again', () => {
    const feed = flatHour(20000, { 20: { low: 19990 } })
    const order: WorkingOrder = {
      id: 'o', side: 'long', orderType: 'limit', price: 19995, contracts: 1, slPrice: null, tpPrice: null,
      riskUsd: 10, placedTime: feed[30].time, placedIndex: 30, autoBreakeven: false, trailingPoints: null,
    }
    const replayed = advance(feed, 10, 59, null, [order])
    expect(replayed.filledOrderIds).toEqual([])
    expect(replayed.workingOrders).toHaveLength(1)
  })
})
