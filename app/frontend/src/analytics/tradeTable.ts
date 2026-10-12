// FXR_V2_SPEC.md section 6 (G8): the Analytics page's trades table. Filtering and
// paging are presentation over the trade list the server already returned -- no
// trade, P&L or R is derived here, and the sums that sit above this table (the
// stat tiles) come from the server, from the very same list.
import type { TradeRecord } from '../api/types'
import { etClock } from '../timeFormat'

export const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100] as const
export const DEFAULT_ROWS_PER_PAGE = 25

export interface TableFilters {
  tag: string | null
  setup: string | null
  grade: string | null
  side: 'long' | 'short' | null
  // The ET clock hour the trade was entered in (0-23).
  hour: number | null
  instrument: string | null
}

export const NO_FILTERS: TableFilters = { tag: null, setup: null, grade: null, side: null, hour: null, instrument: null }

export const NO_SETUP = '(no setup)'
export const UNGRADED = 'ungraded'

export function entryHourEt(t: Pick<TradeRecord, 'entry_time'>): number {
  return Math.floor(etClock(t.entry_time).minutes / 60)
}

export function filterTrades(trades: TradeRecord[], f: TableFilters): TradeRecord[] {
  return trades.filter((t) => {
    if (f.instrument !== null && t.instrument !== f.instrument) return false
    if (f.side !== null && t.side !== f.side) return false
    if (f.tag !== null && !(t.tags ?? []).includes(f.tag)) return false
    if (f.setup !== null && (t.setup_name ?? NO_SETUP) !== f.setup) return false
    if (f.grade !== null && (t.grade ?? UNGRADED) !== f.grade) return false
    if (f.hour !== null && entryHourEt(t) !== f.hour) return false
    return true
  })
}

export interface FilterOptions {
  tags: string[]
  setups: string[]
  grades: string[]
  hours: number[]
  instruments: string[]
}

// What each filter offers: only values the trades actually have.
export function filterOptions(trades: TradeRecord[]): FilterOptions {
  const tags = new Set<string>()
  const setups = new Set<string>()
  const grades = new Set<string>()
  const hours = new Set<number>()
  const instruments = new Set<string>()
  for (const t of trades) {
    for (const tag of t.tags ?? []) tags.add(tag)
    setups.add(t.setup_name ?? NO_SETUP)
    grades.add(t.grade ?? UNGRADED)
    hours.add(entryHourEt(t))
    instruments.add(t.instrument)
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b))
  return {
    tags: sorted(tags),
    setups: sorted(setups),
    grades: sorted(grades),
    hours: [...hours].sort((a, b) => a - b),
    instruments: sorted(instruments),
  }
}

export interface Page<T> {
  rows: T[]
  page: number // 1-based, clamped into range
  pageCount: number
  total: number
  from: number // 1-based index of the first row shown (0 when empty)
  to: number
}

export function paginate<T>(rows: readonly T[], page: number, perPage: number): Page<T> {
  const per = Math.max(1, Math.floor(perPage))
  const pageCount = Math.max(1, Math.ceil(rows.length / per))
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount)
  const start = (clamped - 1) * per
  const slice = rows.slice(start, start + per)
  return {
    rows: slice,
    page: clamped,
    pageCount,
    total: rows.length,
    from: slice.length ? start + 1 : 0,
    to: start + slice.length,
  }
}

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59`

// Newest entry first -- what a trader reviews. Ties keep the journal's own order.
export function newestFirst(trades: TradeRecord[]): TradeRecord[] {
  return [...trades].sort((a, b) => b.entry_time - a.entry_time || b.trade_id - a.trade_id)
}
