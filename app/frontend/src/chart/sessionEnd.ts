// FXR_V2_SPEC.md section 4 (G1): "a session ends when the cursor reaches its
// end date." Pure and framework-free like discipline.ts -- the workspace asks
// "what is the furthest bar the cursor may reach?" and "has the session
// ended?", the backend refuses a cursor past end_date on save too
// (bt_session_service.update_cursor), and both are tested on their own.
import type { Bar } from '../api/types'

// Index of the last bar the cursor may reach in the CURRENTLY loaded bars: the
// latest bar at or before end_date, or simply the last loaded bar when the
// session has no end (or the end lies beyond the loaded window). -1 for an
// empty array.
export function lastAllowedIndex(bars: Bar[], endDate: number | null): number {
  if (bars.length === 0) return -1
  if (endDate === null) return bars.length - 1
  let best = 0
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time <= endDate) best = i
    else break
  }
  return best
}

// True once the cursor sits on the last allowed bar AND stepping further is
// blocked by end_date (not merely by the loaded window ending, which a
// re-anchor fixes). A bar at exactly end_date also ends the session even if
// no later bar is loaded.
export function isSessionEnded(bars: Bar[], cursorIndex: number, endDate: number | null): boolean {
  if (endDate === null || bars.length === 0) return false
  const last = lastAllowedIndex(bars, endDate)
  if (cursorIndex < last) return false
  const nextBlocked = last < bars.length - 1
  return nextBlocked || bars[last].time >= endDate
}

// The name shown in the top bar: the session's own, else "<assets> · <start>".
export function sessionDisplayName(
  session: { name: string | null; assets: string[]; instrument: string; start_time: number },
  fmtDate: (unixSeconds: number) => string,
): string {
  if (session.name && session.name.trim()) return session.name.trim()
  const assets = session.assets.length > 0 ? session.assets.join(' + ') : session.instrument
  return `${assets} · ${fmtDate(session.start_time)}`
}

// The step-granularity dropdown (FXR_V2_SPEC.md section 2/5). Until the replay
// engine can build a forming candle from 1m data (G5), one step can only be a
// whole number of the session's own base bars, so a granularity finer than the
// base timeframe is not offered yet.
export const STEP_GRANULARITIES = [
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
] as const

export type StepGranularityLabel = (typeof STEP_GRANULARITIES)[number]['label']

// How many base bars one step advances at the chosen granularity; null when
// that granularity is finer than (or not a whole multiple of) the base bar.
export function stepBarCount(granularitySeconds: number, baseSeconds: number): number | null {
  if (granularitySeconds < baseSeconds || granularitySeconds % baseSeconds !== 0) return null
  return granularitySeconds / baseSeconds
}

// The cursor index one step forward/back from `index`: moves `count` bars and
// clamps to [minIndex, maxIndex]. Forward only ever lands on a bar at or
// before the cursor's own allowed range (no look-ahead past end_date or the
// loaded window).
export function steppedIndex(index: number, direction: 1 | -1, count: number, minIndex: number, maxIndex: number): number {
  return Math.max(minIndex, Math.min(maxIndex, index + direction * count))
}

// The granularity one notch finer (-1) or coarser (+1) in the dropdown's order,
// skipping any the session's base bar cannot step by (G4's hotkeys: until the
// 1m forming-candle replay of G5, only granularities at or above the base
// timeframe are available). Stays where it is at either end.
export function shiftGranularity(
  current: StepGranularityLabel,
  direction: 1 | -1,
  available: ReadonlySet<StepGranularityLabel>,
): StepGranularityLabel {
  const index = STEP_GRANULARITIES.findIndex((g) => g.label === current)
  for (let i = index + direction; i >= 0 && i < STEP_GRANULARITIES.length; i += direction) {
    if (available.has(STEP_GRANULARITIES[i].label)) return STEP_GRANULARITIES[i].label
  }
  return current
}
