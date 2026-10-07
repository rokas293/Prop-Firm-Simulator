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
