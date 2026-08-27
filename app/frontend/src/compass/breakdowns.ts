// Pattern breakdowns for the Compass panel (POLISH_ROADMAP Phase P5,
// VIZ_SPEC section 7). Per-leg and per-session breakdowns already exist
// server-side (StatsResponse.by_leg/by_session) and are reused as-is
// elsewhere -- this module only adds the breakdowns that don't already
// exist in the bundle: time-of-day, weekday, hold-time, and streaks. All of
// it is descriptive aggregation (group/count/sum) over fields the engine
// already computed on each trade -- no PnL, R, or prop-rule recomputation
// (VIZ_SPEC section 0: frontend does zero financial math). This mirrors the
// R-histogram/MAE-MFE-scatter aggregation DashboardPanel has done
// client-side since Phase V5/P2.
import type { TradeRecord } from '../api/types'
import type { TradeFilters } from '../state/tradeStore'

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
