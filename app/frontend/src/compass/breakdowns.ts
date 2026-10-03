// Pattern breakdowns for the Compass panel (POLISH_ROADMAP Phase P5,
// VIZ_SPEC section 7). Per-leg and per-session breakdowns already exist
// server-side (StatsResponse.by_leg/by_session) and are reused as-is
// elsewhere -- this module only adds the breakdowns that don't already
// exist in the bundle: time-of-day, session-hour, weekday, hold-time, and
// streaks. All of
// it is descriptive aggregation (group/count/sum) over fields the engine
// already computed on each trade -- no PnL, R, or prop-rule recomputation
// (VIZ_SPEC section 0: frontend does zero financial math). This mirrors the
// R-histogram/MAE-MFE-scatter aggregation DashboardPanel has done
// client-side since Phase V5/P2.
import type { TradeRecord } from '../api/types'
import type { TradeFilters } from '../state/tradeStore'
import { etDayEndUnix, etDayStartUnix } from '../timeFormat'

export interface BucketStats {
  key: string
  trades: number
  wins: number
  winRate: number
  netPnlUsd: number
  netR: number
  expectancyUsd: number
}

function aggregateBy(trades: TradeRecord[], keyOf: (t: TradeRecord) => string): Map<string, BucketStats> {
  const groups = new Map<string, TradeRecord[]>()
  for (const t of trades) {
    const k = keyOf(t)
    const arr = groups.get(k)
    if (arr) arr.push(t)
    else groups.set(k, [t])
  }
  const out = new Map<string, BucketStats>()
  for (const [key, group] of groups) {
    const wins = group.filter((t) => t.pnl_usd > 0).length
    const netPnlUsd = group.reduce((s, t) => s + t.pnl_usd, 0)
    const netR = group.reduce((s, t) => s + (t.r_multiple ?? 0), 0)
    out.set(key, {
      key,
      trades: group.length,
      wins,
      winRate: wins / group.length,
      netPnlUsd,
      netR,
      expectancyUsd: netPnlUsd / group.length,
    })
  }
  return out
}

// Descriptive display conversion only (not session-boundary logic -- each
// trade already carries the engine's own `session` tag). Intl's timeZone
// handling is DST-correct without hardcoding an offset (CLAUDE.md section
// 2: "never hardcode UTC offsets"), same guarantee the engine's own
// session-anchoring gets from pandas tz-aware timestamps.
const NY_HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hour12: false,
})

export function nyHourOfDay(unixSeconds: number): number {
  const hourText = NY_HOUR_FORMATTER.formatToParts(new Date(unixSeconds * 1000)).find((p) => p.type === 'hour')?.value
  // Some engines format midnight as "24" with hour12:false -- normalize to 0-23.
  return Number(hourText ?? '0') % 24
}

export function byHourOfDay(trades: TradeRecord[]): BucketStats[] {
  const groups = aggregateBy(trades, (t) => String(nyHourOfDay(t.entry_time)).padStart(2, '0'))
  return [...groups.values()].sort((a, b) => Number(a.key) - Number(b.key))
}

// Distinct from byHourOfDay: that one pools every trade regardless of which
// session opened it, so a strong/weak hour specific to one session (e.g.
// "the 2nd hour after the London open underperforms") is invisible in the
// pooled view once it's averaged against Asia/NY hours. This facets
// byHourOfDay per session instead of building a new aggregation -- same
// hour derivation, just pre-filtered to one session's trades. Sessions are
// read from the trades themselves (not hardcoded), matching
// TradeListPanel's own sessionOptions derivation, since real runs tag
// sessions the spec's prose doesn't enumerate (e.g. "globex_reopen").
export function sessionsPresent(trades: TradeRecord[]): string[] {
  return [...new Set(trades.map((t) => t.session).filter((s): s is string => s !== null))].sort()
}

export function bySessionHour(trades: TradeRecord[], session: string): BucketStats[] {
  return byHourOfDay(trades.filter((t) => t.session === session))
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function byWeekday(trades: TradeRecord[]): BucketStats[] {
  const groups = aggregateBy(trades, (t) => WEEKDAY_FORMATTER.format(new Date(t.entry_time * 1000)))
  return [...groups.values()].sort((a, b) => WEEKDAY_ORDER.indexOf(a.key) - WEEKDAY_ORDER.indexOf(b.key))
}

// Buckets on bars_held (an engine-computed field, VIZ_SPEC section 4) --
// not a re-derivation of elapsed wall-clock time, which would need to
// account for the base timeframe (CLAUDE.md section 2: bar-count windows
// mean different wall-clock spans on sparser instruments like ZN).
const HOLD_TIME_BUCKETS = [
  { label: '1-5 bars', max: 5 },
  { label: '6-15 bars', max: 15 },
  { label: '16-30 bars', max: 30 },
  { label: '31-60 bars', max: 60 },
  { label: '60+ bars', max: Infinity },
]

function holdTimeLabel(barsHeld: number): string {
  return (HOLD_TIME_BUCKETS.find((b) => barsHeld <= b.max) ?? HOLD_TIME_BUCKETS[HOLD_TIME_BUCKETS.length - 1]).label
}

export function byHoldTime(trades: TradeRecord[]): BucketStats[] {
  const groups = aggregateBy(trades, (t) => holdTimeLabel(t.bars_held))
  const order = HOLD_TIME_BUCKETS.map((b) => b.label)
  return [...groups.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
}

export interface StreakRun {
  type: 'win' | 'loss'
  length: number
}

// Same win threshold (pnl_usd > 0) as the chart's entry/exit markers
// (PriceChart.tsx) and trade brackets (tradeBracket.ts's bracketOutcome) --
// kept identical everywhere a trade's outcome is classified.
export function computeStreakRuns(trades: TradeRecord[]): StreakRun[] {
  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time)
  const runs: StreakRun[] = []
  for (const t of sorted) {
    const type: StreakRun['type'] = t.pnl_usd > 0 ? 'win' : 'loss'
    const last = runs[runs.length - 1]
    if (last && last.type === type) last.length += 1
    else runs.push({ type, length: 1 })
  }
  return runs
}

export interface StreakSummary {
  longestWin: number
  longestLoss: number
  current: StreakRun | null
  // How many win-streaks and how many loss-streaks of each length occurred
  // -- e.g. {length: 3, winCount: 2, lossCount: 1} means two 3-in-a-row win
  // streaks and one 3-in-a-row loss streak.
  distribution: { length: number; winCount: number; lossCount: number }[]
}

export function summarizeStreaks(trades: TradeRecord[]): StreakSummary {
  const runs = computeStreakRuns(trades)
  const longestWin = Math.max(0, ...runs.filter((r) => r.type === 'win').map((r) => r.length))
  const longestLoss = Math.max(0, ...runs.filter((r) => r.type === 'loss').map((r) => r.length))

  const byLength = new Map<number, { winCount: number; lossCount: number }>()
  for (const r of runs) {
    const entry = byLength.get(r.length) ?? { winCount: 0, lossCount: 0 }
    if (r.type === 'win') entry.winCount += 1
    else entry.lossCount += 1
    byLength.set(r.length, entry)
  }
  const distribution = [...byLength.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([length, counts]) => ({ length, ...counts }))

  return {
    longestWin,
    longestLoss,
    current: runs.length > 0 ? runs[runs.length - 1] : null,
    distribution,
  }
}

// Every trade that was part of ANY streak of exactly this type/length --
// the distribution bar the user clicked represents a *count* of such
// streaks, which can span multiple separate occurrences, so "select this
// bar" means "every trade belonging to one of them," not one specific
// occurrence.
export function tradesInStreaksOfLength(trades: TradeRecord[], type: 'win' | 'loss', length: number): Set<number> {
  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time)
  const ids = new Set<number>()
  let i = 0
  while (i < sorted.length) {
    const runType: StreakRun['type'] = sorted[i].pnl_usd > 0 ? 'win' : 'loss'
    let j = i + 1
    while (j < sorted.length && (sorted[j].pnl_usd > 0 ? 'win' : 'loss') === runType) j++
    if (runType === type && j - i === length) {
      for (let k = i; k < j; k++) ids.add(sorted[k].trade_id)
    }
    i = j
  }
  return ids
}

// Applies the Compass-only cross-filter dimensions (POLISH_ROADMAP Phase
// P5) that /api/trades can't filter on server-side -- called by any panel
// that already has a server-fetched `trades` array and the current
// `filters` in hand (TradeListPanel, ChartPanel), right after the fetch.
// The other TradeFilters fields (leg/session/side/etc.) are already applied
// server-side via filtersToParams, so this only ever narrows further.
export function applyCompassFilters(trades: TradeRecord[], filters: TradeFilters): TradeRecord[] {
  let out = trades
  // Manual-run journal filters (FXR_SPEC.md phase F6). Also sent to the
  // server, so this only ever re-narrows an already-narrowed set -- but it's
  // what makes them work for a caller that holds an unfiltered array (the
  // journal drawer). A trade without the field never matches a set filter.
  if (filters.tag !== null) {
    const tag = filters.tag
    out = out.filter((t) => t.tags?.includes(tag) ?? false)
  }
  if (filters.setup !== null) {
    const setup = filters.setup
    out = out.filter((t) => t.setup_name === setup)
  }
  if (filters.grade !== null) {
    const grade = filters.grade
    out = out.filter((t) => t.grade === grade)
  }
  if (filters.sessionId !== null) {
    const sessionId = filters.sessionId
    out = out.filter((t) => t.session_id === sessionId)
  }
  if (filters.entryHourNy !== null) {
    const hour = filters.entryHourNy
    out = out.filter((t) => nyHourOfDay(t.entry_time) === hour)
  }
  if (filters.weekday !== null) {
    const weekday = filters.weekday
    out = out.filter((t) => WEEKDAY_FORMATTER.format(new Date(t.entry_time * 1000)) === weekday)
  }
  if (filters.holdTimeBucket !== null) {
    const bucket = filters.holdTimeBucket
    out = out.filter((t) => holdTimeLabel(t.bars_held) === bucket)
  }
  if (filters.streakSelector !== null) {
    const { type, length } = filters.streakSelector
    // Streak position depends on the FULL scoped trade set's sequence, not
    // whatever's already been narrowed by other filters -- but since this
    // runs after those other filters in practice, `out` is what's passed;
    // callers that want strictly-correct streak membership regardless of
    // other active filters should call this with the full unfiltered set.
    const ids = tradesInStreaksOfLength(out, type, length)
    out = out.filter((t) => ids.has(t.trade_id))
  }
  return out
}

// The WHOLE filter set applied client-side to an array that was NOT fetched
// through /api/runs/{id}/trades -- i.e. the journal drawer's own session
// trades. Mirrors bundle_reader.filter_trades_frame (server) field for field
// for the dimensions a manual trade has, then the compass dimensions, so a
// filter chosen in the analytics workspace narrows the journal list to
// exactly the trades the analytics trade list shows. (leg is always null on
// a manual trade, so a leg filter never matches -- same as the server.)
export function filterManualTrades<T extends TradeRecord>(trades: T[], filters: TradeFilters): T[] {
  let out = trades
  if (filters.leg !== null) out = out.filter((t) => t.leg === filters.leg)
  if (filters.session !== null) out = out.filter((t) => t.session === filters.session)
  if (filters.side !== null) out = out.filter((t) => t.side === filters.side)
  if (filters.result === 'win') out = out.filter((t) => t.pnl_usd > 0)
  if (filters.result === 'loss') out = out.filter((t) => t.pnl_usd <= 0)
  if (filters.exitType !== null) out = out.filter((t) => t.exit_type === filters.exitType)
  if (filters.dateFrom !== null) {
    const from = etDayStartUnix(filters.dateFrom)
    if (from !== null) out = out.filter((t) => t.entry_time >= from)
  }
  if (filters.dateTo !== null) {
    const to = etDayEndUnix(filters.dateTo)
    if (to !== null) out = out.filter((t) => t.entry_time <= to)
  }
  return applyCompassFilters(out, filters) as T[]
}
