import { describe, expect, it } from 'vitest'
import type { TradeRecord } from '../api/types'
import { EMPTY_FILTERS } from '../state/tradeStore'
import {
  applyCompassFilters,
  byHoldTime,
  byHourOfDay,
  bySessionHour,
  byWeekday,
  computeStreakRuns,
  nyHourOfDay,
  sessionsPresent,
  summarizeStreaks,
  tradesInStreaksOfLength,
} from './breakdowns'

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 1,
    entry_time: 1626467460, // real trade #5 timestamp (MNQ run) -- 2021-07-16 16:31 America/New_York, a Friday
    exit_time: 1626468300,
    instrument: 'MNQ',
    side: 'long',
    leg: 'mean_reversion',
    session: 'ny',
    trading_day: '2021-07-16',
    size_contracts: 1,
    entry_price: 14661.75,
    exit_price: 14669.75,
    sl_price: 14653.75,
    tp_price: 14669.75,
    sl_points: 8,
    tp_points: 8,
    rr_planned: 1,
    exit_type: 'tp',
    pnl_usd: 14.7,
    r_multiple: 0.92,
    commission_usd: 1.3,
    mae_points: 2.75,
    mfe_points: 9.5,
    mae_r: 0.34,
    mfe_r: 1.19,
    bars_held: 15,
    ...overrides,
  }
}

describe('nyHourOfDay', () => {
  it('matches the independently-verified NY wall-clock hour for a real trade timestamp', () => {
    // 1626467460 UTC = 2021-07-16 16:31 America/New_York (EDT, UTC-4) --
    // cross-checked with Python's zoneinfo before writing this test.
    expect(nyHourOfDay(1626467460)).toBe(16)
  })

  it('handles a UTC midnight crossing into the previous NY day', () => {
    // 2021-07-16 03:00 UTC = 2021-07-15 23:00 EDT
    const ts = Date.UTC(2021, 6, 16, 3, 0, 0) / 1000
    expect(nyHourOfDay(ts)).toBe(23)
  })
})

describe('byHourOfDay', () => {
  it('groups trades into their NY hour bucket and reconciles totals', () => {
    const trades = [
      makeTrade({ trade_id: 1, entry_time: 1626467460, pnl_usd: 10 }), // hour 16
      makeTrade({ trade_id: 2, entry_time: 1626467460 + 60, pnl_usd: -5 }), // same hour
      makeTrade({ trade_id: 3, entry_time: 1626467460 - 3600, pnl_usd: 20 }), // hour 15
    ]
    const buckets = byHourOfDay(trades)
    const totalTrades = buckets.reduce((s, b) => s + b.trades, 0)
    const totalPnl = buckets.reduce((s, b) => s + b.netPnlUsd, 0)
    expect(totalTrades).toBe(3)
    expect(totalPnl).toBeCloseTo(25)

    const hour16 = buckets.find((b) => b.key === '16')
    expect(hour16?.trades).toBe(2)
    expect(hour16?.wins).toBe(1)
    expect(hour16?.winRate).toBeCloseTo(0.5)
    expect(hour16?.netPnlUsd).toBeCloseTo(5)
  })

  it('sorts buckets numerically by hour', () => {
    const trades = [makeTrade({ entry_time: 1626467460 - 3600 }), makeTrade({ entry_time: 1626467460 })]
    const buckets = byHourOfDay(trades)
    const hours = buckets.map((b) => Number(b.key))
    expect(hours).toEqual([...hours].sort((a, b) => a - b))
  })
})

describe('sessionsPresent / bySessionHour', () => {
  it('derives the distinct session list from the trades, sorted, excluding null', () => {
    const trades = [
      makeTrade({ trade_id: 1, session: 'ny' }),
      makeTrade({ trade_id: 2, session: 'asia' }),
      makeTrade({ trade_id: 3, session: null }),
      makeTrade({ trade_id: 4, session: 'asia' }),
    ]
    expect(sessionsPresent(trades)).toEqual(['asia', 'ny'])
  })

  it('facets byHourOfDay to just the given session, reconciling against that session\'s own total', () => {
    const nyHour16 = makeTrade({ trade_id: 1, entry_time: 1626467460, session: 'ny', pnl_usd: 10 }) // NY hour 16
    const nyHour15 = makeTrade({ trade_id: 2, entry_time: 1626467460 - 3600, session: 'ny', pnl_usd: -4 }) // NY hour 15
    const asiaHour16 = makeTrade({ trade_id: 3, entry_time: 1626467460, session: 'asia', pnl_usd: 100 }) // same wall-clock hour, different session
    const trades = [nyHour16, nyHour15, asiaHour16]

    const nyBuckets = bySessionHour(trades, 'ny')
    expect(nyBuckets.reduce((s, b) => s + b.trades, 0)).toBe(2)
    expect(nyBuckets.reduce((s, b) => s + b.netPnlUsd, 0)).toBeCloseTo(6)
    // The asia trade in the same hour must not leak into the ny facet.
    expect(nyBuckets.find((b) => b.key === '16')?.netPnlUsd).toBeCloseTo(10)

    const asiaBuckets = bySessionHour(trades, 'asia')
    expect(asiaBuckets).toEqual([{ key: '16', trades: 1, wins: 1, winRate: 1, netPnlUsd: 100, netR: asiaHour16.r_multiple, expectancyUsd: 100 }])
  })

  it('returns an empty list for a session with no trades', () => {
    expect(bySessionHour([makeTrade({ session: 'ny' })], 'london')).toEqual([])
  })
})

describe('byWeekday', () => {
  it('buckets the known trade under Fri', () => {
    const buckets = byWeekday([makeTrade()])
    expect(buckets).toHaveLength(1)
    expect(buckets[0].key).toBe('Fri')
    expect(buckets[0].trades).toBe(1)
  })

  it('orders Mon..Sun regardless of input order', () => {
    // Thu (Jul 15), Fri (Jul 16), Mon (Jul 12) 2021, all ~16:30 NY.
    const thu = makeTrade({ trade_id: 1, entry_time: 1626467460 - 86400 })
    const fri = makeTrade({ trade_id: 2, entry_time: 1626467460 })
    const mon = makeTrade({ trade_id: 3, entry_time: 1626467460 - 4 * 86400 })
    const buckets = byWeekday([fri, mon, thu])
    expect(buckets.map((b) => b.key)).toEqual(['Mon', 'Thu', 'Fri'])
  })
})

describe('byHoldTime', () => {
  it('reconciles bucket totals against the input trade count', () => {
    const trades = [
      makeTrade({ trade_id: 1, bars_held: 3 }),
      makeTrade({ trade_id: 2, bars_held: 15 }),
      makeTrade({ trade_id: 3, bars_held: 16 }),
      makeTrade({ trade_id: 4, bars_held: 200 }),
    ]
    const buckets = byHoldTime(trades)
    expect(buckets.reduce((s, b) => s + b.trades, 0)).toBe(4)
    expect(buckets.map((b) => b.key)).toEqual(['1-5 bars', '6-15 bars', '16-30 bars', '60+ bars'])
  })

  it('puts an exact boundary value in the lower bucket (inclusive max)', () => {
    const buckets = byHoldTime([makeTrade({ bars_held: 5 })])
    expect(buckets[0].key).toBe('1-5 bars')
  })
})

describe('computeStreakRuns / summarizeStreaks', () => {
  it('splits a win/loss sequence into runs in entry-time order', () => {
    const trades = [
      makeTrade({ trade_id: 1, entry_time: 1, pnl_usd: 10 }),
      makeTrade({ trade_id: 2, entry_time: 2, pnl_usd: 20 }),
      makeTrade({ trade_id: 3, entry_time: 3, pnl_usd: -5 }),
      makeTrade({ trade_id: 4, entry_time: 4, pnl_usd: 5 }),
    ]
    const runs = computeStreakRuns(trades)
    expect(runs).toEqual([
      { type: 'win', length: 2 },
      { type: 'loss', length: 1 },
      { type: 'win', length: 1 },
    ])
  })

  it('is order-independent (sorts by entry_time itself)', () => {
    const a = makeTrade({ trade_id: 1, entry_time: 2, pnl_usd: 10 })
    const b = makeTrade({ trade_id: 2, entry_time: 1, pnl_usd: 10 })
    expect(computeStreakRuns([a, b])).toEqual([{ type: 'win', length: 2 }])
  })

  it('summarizes longest streaks, current streak, and a reconciling distribution', () => {
    const trades = [
      makeTrade({ trade_id: 1, entry_time: 1, pnl_usd: 10 }),
      makeTrade({ trade_id: 2, entry_time: 2, pnl_usd: 10 }),
      makeTrade({ trade_id: 3, entry_time: 3, pnl_usd: -5 }),
      makeTrade({ trade_id: 4, entry_time: 4, pnl_usd: -5 }),
      makeTrade({ trade_id: 5, entry_time: 5, pnl_usd: -5 }),
    ]
    const summary = summarizeStreaks(trades)
    expect(summary.longestWin).toBe(2)
    expect(summary.longestLoss).toBe(3)
    expect(summary.current).toEqual({ type: 'loss', length: 3 })
    // distribution must account for every trade exactly once
    const tradesInDistribution = summary.distribution.reduce((s, d) => s + d.length * (d.winCount + d.lossCount), 0)
    expect(tradesInDistribution).toBe(trades.length)
  })

  it('handles an empty trade list', () => {
    const summary = summarizeStreaks([])
    expect(summary).toEqual({ longestWin: 0, longestLoss: 0, current: null, distribution: [] })
  })
})

describe('tradesInStreaksOfLength', () => {
  it('collects every trade from every matching streak, not just one occurrence', () => {
    // win, win, loss, win, win  -> two separate 2-in-a-row win streaks
    const trades = [
      makeTrade({ trade_id: 1, entry_time: 1, pnl_usd: 10 }),
      makeTrade({ trade_id: 2, entry_time: 2, pnl_usd: 10 }),
      makeTrade({ trade_id: 3, entry_time: 3, pnl_usd: -5 }),
      makeTrade({ trade_id: 4, entry_time: 4, pnl_usd: 10 }),
      makeTrade({ trade_id: 5, entry_time: 5, pnl_usd: 10 }),
    ]
    const ids = tradesInStreaksOfLength(trades, 'win', 2)
    expect(ids).toEqual(new Set([1, 2, 4, 5]))
  })

  it('returns an empty set when no streak matches', () => {
    const trades = [makeTrade({ trade_id: 1, pnl_usd: 10 })]
    expect(tradesInStreaksOfLength(trades, 'loss', 5)).toEqual(new Set())
  })
})

describe('applyCompassFilters', () => {
  const hourTrade = makeTrade({ trade_id: 1, entry_time: 1626467460 }) // NY hour 16, Fri
  const otherHourTrade = makeTrade({ trade_id: 2, entry_time: 1626467460 - 3600 }) // NY hour 15, Fri
  const trades = [hourTrade, otherHourTrade]

  it('passes everything through when no compass filter is set', () => {
    expect(applyCompassFilters(trades, EMPTY_FILTERS)).toEqual(trades)
  })

  it('filters by entryHourNy', () => {
    const result = applyCompassFilters(trades, { ...EMPTY_FILTERS, entryHourNy: 16 })
    expect(result.map((t) => t.trade_id)).toEqual([1])
  })

  it('filters by weekday', () => {
    const result = applyCompassFilters(trades, { ...EMPTY_FILTERS, weekday: 'Fri' })
    expect(result.map((t) => t.trade_id)).toEqual([1, 2])
    expect(applyCompassFilters(trades, { ...EMPTY_FILTERS, weekday: 'Mon' })).toEqual([])
  })

  it('filters by holdTimeBucket', () => {
    const short = makeTrade({ trade_id: 1, bars_held: 3 })
    const long = makeTrade({ trade_id: 2, bars_held: 100 })
    const result = applyCompassFilters([short, long], { ...EMPTY_FILTERS, holdTimeBucket: '1-5 bars' })
    expect(result.map((t) => t.trade_id)).toEqual([1])
  })

  it('filters by streakSelector', () => {
    const a = makeTrade({ trade_id: 1, entry_time: 1, pnl_usd: 10 })
    const b = makeTrade({ trade_id: 2, entry_time: 2, pnl_usd: 10 })
    const c = makeTrade({ trade_id: 3, entry_time: 3, pnl_usd: -5 })
    const result = applyCompassFilters([a, b, c], { ...EMPTY_FILTERS, streakSelector: { type: 'win', length: 2 } })
    expect(result.map((t) => t.trade_id).sort()).toEqual([1, 2])
  })

  it('composes multiple compass filters (AND)', () => {
    const result = applyCompassFilters(trades, { ...EMPTY_FILTERS, weekday: 'Fri', entryHourNy: 15 })
    expect(result.map((t) => t.trade_id)).toEqual([2])
  })
})
