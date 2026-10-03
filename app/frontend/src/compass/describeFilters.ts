import type { TradeFilters } from '../state/tradeStore'

// Short human-readable label for whatever crossFilter() last set --
// crossFilter always clears everything else first, so normally only one of
// these is non-null. The one exception is the session-hour facet, which
// sets session + entryHourNy together (a single bar there means a specific
// hour within a specific session, not either alone), so that combination is
// checked before the single-dimension cases below.
// Shared by the Dashboard's cross-filter badge and LiveRegion's screen-reader
// announcement (the same wording for the same fact), and kept out of
// DashboardPanel so the always-loaded LiveRegion doesn't pull the lazy panel
// into the main bundle.
export function describeFilters(filters: TradeFilters): string {
  if (filters.session !== null && filters.entryHourNy !== null) {
    return `session = ${filters.session}, hour = ${String(filters.entryHourNy).padStart(2, '0')}:00 ET`
  }
  if (filters.tag !== null) return `tag = ${filters.tag}`
  if (filters.setup !== null) return `setup = ${filters.setup}`
  if (filters.grade !== null) return `grade = ${filters.grade}`
  if (filters.sessionId !== null) return `backtest session = ${filters.sessionId.slice(0, 13)}`
  if (filters.leg !== null) return `leg = ${filters.leg}`
  if (filters.session !== null) return `session = ${filters.session}`
  if (filters.side !== null) return `side = ${filters.side}`
  if (filters.result !== null) return `result = ${filters.result}`
  if (filters.exitType !== null) return `exit type = ${filters.exitType}`
  if (filters.dateFrom !== null || filters.dateTo !== null) return `date range`
  if (filters.entryHourNy !== null) return `hour = ${String(filters.entryHourNy).padStart(2, '0')}:00 ET`
  if (filters.weekday !== null) return `weekday = ${filters.weekday}`
  if (filters.holdTimeBucket !== null) return `hold time = ${filters.holdTimeBucket}`
  if (filters.streakSelector !== null) return `${filters.streakSelector.type} streak of ${filters.streakSelector.length}`
  return ''
}
