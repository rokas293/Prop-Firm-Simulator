// FXR_V2_SPEC.md section 6 (G8): the trades table's filtering and paging.
import { describe, expect, it } from 'vitest'
import type { TradeRecord } from '../api/types'
import { etWallTimeToUnix } from '../timeFormat'
import { NO_FILTERS, NO_SETUP, UNGRADED, entryHourEt, filterOptions, filterTrades, hourLabel, newestFirst, paginate } from './tradeTable'

let n = 0
function trade(over: Partial<TradeRecord> & { at?: string }): TradeRecord {
  n += 1
  const { at, ...rest } = over
  const entry = etWallTimeToUnix(at ?? '2025-03-11T09:45') as number
  return {
    trade_id: n,
    entry_time: entry,
    exit_time: entry + 600,
    instrument: 'MNQ',
    side: 'long',
    leg: null,
    session: null,
    trading_day: '2025-03-11',
    size_contracts: 1,
    entry_price: 100,
    exit_price: 101,
    sl_price: null,
    tp_price: null,
    sl_points: null,
    tp_points: null,
    rr_planned: null,
    exit_type: 'manual_close',
    pnl_usd: 10,
    r_multiple: null,
    commission_usd: 1,
    mae_points: 0,
    mfe_points: 0,
    mae_r: null,
    mfe_r: null,
    bars_held: 1,
    tags: [],
    setup_name: null,
    grade: null,
    ...rest,
  }
}

const TRADES = [
  trade({ at: '2025-03-11T09:45', tags: ['breakout'], setup_name: 'ORB', grade: 'A', side: 'long', instrument: 'MNQ' }),
  trade({ at: '2025-03-11T10:15', tags: ['breakout', 'news'], setup_name: 'ORB', grade: 'B', side: 'short', instrument: 'MES' }),
  trade({ at: '2025-03-12T14:05', tags: [], side: 'long', instrument: 'MNQ' }),
  trade({ at: '2025-03-13T09:59', tags: ['fade'], setup_name: 'Fade', grade: 'A', side: 'short', instrument: 'MNQ' }),
]

describe('filterTrades', () => {
  it('no filters: every trade', () => {
    expect(filterTrades(TRADES, NO_FILTERS)).toHaveLength(4)
  })

  it('narrows by tag, setup, grade, side and instrument', () => {
    expect(filterTrades(TRADES, { ...NO_FILTERS, tag: 'breakout' })).toHaveLength(2)
    expect(filterTrades(TRADES, { ...NO_FILTERS, setup: 'ORB' })).toHaveLength(2)
    expect(filterTrades(TRADES, { ...NO_FILTERS, grade: 'A' })).toHaveLength(2)
    expect(filterTrades(TRADES, { ...NO_FILTERS, side: 'short' })).toHaveLength(2)
    expect(filterTrades(TRADES, { ...NO_FILTERS, instrument: 'MES' })).toHaveLength(1)
  })

  it('a trade with no setup or grade is reachable by its placeholder', () => {
    expect(filterTrades(TRADES, { ...NO_FILTERS, setup: NO_SETUP })).toHaveLength(1)
    expect(filterTrades(TRADES, { ...NO_FILTERS, grade: UNGRADED })).toHaveLength(1)
  })

  it('time of day is the ET clock hour of the entry', () => {
    expect(entryHourEt(TRADES[3])).toBe(9)
    expect(filterTrades(TRADES, { ...NO_FILTERS, hour: 9 })).toHaveLength(2) // 09:45 and 09:59
    expect(filterTrades(TRADES, { ...NO_FILTERS, hour: 14 })).toHaveLength(1)
  })

  it('filters combine', () => {
    const f = { ...NO_FILTERS, side: 'short' as const, tag: 'breakout' }
    expect(filterTrades(TRADES, f).map((t) => t.instrument)).toEqual(['MES'])
  })
})

describe('filterOptions', () => {
  it('offers only what the trades have', () => {
    const o = filterOptions(TRADES)
    expect(o.tags).toEqual(['breakout', 'fade', 'news'])
    expect(o.setups).toEqual([NO_SETUP, 'Fade', 'ORB'])
    expect(o.grades).toEqual(['A', 'B', UNGRADED])
    expect(o.hours).toEqual([9, 10, 14])
    expect(o.instruments).toEqual(['MES', 'MNQ'])
  })
})

describe('paginate', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i + 1)

  it('slices a page and reports where it is', () => {
    const p = paginate(rows, 2, 10)
    expect(p.rows).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect([p.page, p.pageCount, p.total, p.from, p.to]).toEqual([2, 3, 23, 11, 20])
  })

  it('the last page is short', () => {
    const p = paginate(rows, 3, 10)
    expect(p.rows).toEqual([21, 22, 23])
    expect([p.from, p.to]).toEqual([21, 23])
  })

  it('clamps a page that no longer exists (after a filter or a bigger page size)', () => {
    expect(paginate(rows, 9, 10).page).toBe(3)
    expect(paginate(rows, 0, 10).page).toBe(1)
    expect(paginate(rows, 5, 50).page).toBe(1)
  })

  it('an empty list is one empty page', () => {
    const p = paginate([], 1, 25)
    expect([p.rows.length, p.pageCount, p.from, p.to, p.total]).toEqual([0, 1, 0, 0, 0])
  })

  it('every row appears on exactly one page', () => {
    const seen: number[] = []
    const first = paginate(rows, 1, 7)
    for (let page = 1; page <= first.pageCount; page++) seen.push(...paginate(rows, page, 7).rows)
    expect(seen).toEqual(rows)
  })
})

describe('helpers', () => {
  it('newestFirst orders by entry time, newest first', () => {
    expect(newestFirst(TRADES).map((t) => t.trade_id)).toEqual([TRADES[3].trade_id, TRADES[2].trade_id, TRADES[1].trade_id, TRADES[0].trade_id])
  })
  it('an hour label spans the hour', () => {
    expect(hourLabel(9)).toBe('09:00–09:59')
  })
})
