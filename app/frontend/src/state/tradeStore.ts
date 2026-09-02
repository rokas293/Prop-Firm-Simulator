import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// side/exit_type are true fixed engine enums (VIZ_SPEC section 4) --
// hardcoding them isn't "financial math," and showing all of them even if
// the current run has zero trades of a given exit_type is useful/self-
// documenting. leg/session are NOT fixed: real runs add tags the spec's
// prose doesn't enumerate (e.g. "news_continuation", "globex_reopen" seen
// in the MNQ run), so those two are derived from the run's own trades
// instead of hardcoded here -- see TradeListPanel.
export const SIDE_OPTIONS = ['long', 'short'] as const
export const EXIT_TYPE_OPTIONS = ['tp', 'sl', 'time', 'eod', 'daily_lock'] as const

export type ResultFilter = 'win' | 'loss' | null

export interface TradeFilters {
  leg: string | null
  session: string | null
  side: string | null
  result: ResultFilter
  exitType: string | null
  dateFrom: string | null // yyyy-mm-dd, inclusive
  dateTo: string | null // yyyy-mm-dd, inclusive
  // Compass cross-filters (POLISH_ROADMAP Phase P5). Unlike every field
  // above, these are NEVER sent to /api/trades (see filtersToParams) --
  // entry-hour/weekday are timezone-derived, not stored columns, and
  // streak position is a sequence property, not a per-trade one, so none
  // of them are backend-filterable. compass/breakdowns.ts's
  // applyCompassFilters() applies them client-side to whatever the server
  // already returned, wherever a panel already has `filters` in hand.
  entryHourNy: number | null
  weekday: string | null
  holdTimeBucket: string | null
  streakSelector: { type: 'win' | 'loss'; length: number } | null
}

export const EMPTY_FILTERS: TradeFilters = {
  leg: null,
  session: null,
  side: null,
  result: null,
  exitType: null,
  dateFrom: null,
  dateTo: null,
  entryHourNy: null,
  weekday: null,
  holdTimeBucket: null,
  streakSelector: null,
}

// Extends the index signature so this is directly usable as fetch query
// params (see api/client.ts's QueryParams) without a cast at call sites.
export interface TradeQueryParams extends Record<string, string | number | undefined> {
  leg?: string
  session?: string
  side?: string
  result?: 'win' | 'loss'
  exit_type?: string
  from?: number
  to?: number
}

// Converts the UI filter shape to /api/trades query params. The date ->
// unix-seconds conversion is a plain UTC calendar boundary, not strategy
// math, so it's fine on the frontend (VIZ_SPEC section 0).
export function filtersToParams(f: TradeFilters): TradeQueryParams {
  return {
    leg: f.leg ?? undefined,
    session: f.session ?? undefined,
    side: f.side ?? undefined,
    result: f.result ?? undefined,
    exit_type: f.exitType ?? undefined,
    from: f.dateFrom ? Math.floor(Date.parse(`${f.dateFrom}T00:00:00Z`) / 1000) : undefined,
    to: f.dateTo ? Math.floor(Date.parse(`${f.dateTo}T23:59:59Z`) / 1000) : undefined,
  }
}

export type StatsScope = 'all' | 'is' | 'oos'

// Mirrors bundle_reader.get_stats' own scope split exactly (entry_time <
// split for IS, >= split for OOS) so any client-side trade set built from a
// scope agrees with the server's own /stats numbers for that scope. Shared
// by DashboardPanel and CompassPanel (POLISH_ROADMAP Phase P5) so both
// derive the same trade set for a given scope instead of each having its
// own copy that could drift. The date->unix conversion is a plain UTC
// calendar boundary lookup, not strategy math (VIZ_SPEC section 0).
export function scopeTradeParams(scope: StatsScope, splitDateIso: string | null): TradeQueryParams {
  if (scope === 'all' || !splitDateIso) return {}
  const splitUnix = Math.floor(Date.parse(`${splitDateIso}T00:00:00Z`) / 1000)
  return scope === 'is' ? { to: splitUnix - 1 } : { from: splitUnix }
}

interface TradeState {
  filters: TradeFilters
  setFilter: <K extends keyof TradeFilters>(key: K, value: TradeFilters[K]) => void
  clearFilters: () => void
  selectedTradeId: number | null
  selectTrade: (tradeId: number | null) => void
  // REPLICA_AUDIT.md Top 10 #3 -- ChartPanel.tsx's own trade-nav row
  // (Prev/Next/Fit/Full day) shows only once this is true, NOT whenever
  // `selectedTradeId` is non-null: ChartPanel auto-selects trade #1 on
  // every run load (a separate, deliberate feature -- it also drives the
  // chart's default fitted window) which would otherwise make the row
  // "conditional" in name only. Set explicitly by the two places a user
  // actually focuses a trade on purpose (TradeListPanel's row click,
  // ChartPanel's own pickTrade -- covers its Prev/Next buttons and the
  // nextTrade/prevTrade keyboard shortcuts) and NEVER by the auto-select
  // effect itself.
  tradeNavFocused: boolean
  setTradeNavFocused: (v: boolean) => void
}

// Only `filters` persists (Phase V7) -- selectedTradeId is ephemeral and
// already resets per-run (see ChartPage's run-change effect), so
// remembering it across reloads would just point at a stale trade.
export const useTradeStore = create<TradeState>()(
  persist(
    (set) => ({
      filters: EMPTY_FILTERS,
      setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
      clearFilters: () => set({ filters: EMPTY_FILTERS }),
      selectedTradeId: null,
      selectTrade: (tradeId) => set({ selectedTradeId: tradeId }),
      tradeNavFocused: false,
      setTradeNavFocused: (v) => set({ tradeNavFocused: v }),
    }),
    {
      name: 'propbt-viz:trade-filters',
      partialize: (s) => ({ filters: s.filters }),
    },
  ),
)
