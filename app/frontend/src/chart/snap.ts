// Bar lookups for the legend/multi-chart-sync/replay readouts
// (POLISH_ROADMAP Phase P2).
import type { Bar } from '../api/types'

export function findBarAtTime(bars: Bar[], time: number): Bar | undefined {
  return bars.find((b) => b.time === time)
}

// Multi-chart crosshair sync (POLISH_ROADMAP Phase P2): a time hovered on
// one chart (e.g. a 1min chart) rarely lands exactly on a bar boundary of
// a sibling chart at a different timeframe (e.g. 15min), so mirroring the
// crosshair there needs "closest bar at or before this time", not an
// exact match. `bars` must be sorted ascending by time.
export function findBarAtOrBefore(bars: Bar[], time: number): Bar | undefined {
  let result: Bar | undefined
  for (const b of bars) {
    if (b.time > time) break
    result = b
  }
  return result
}
