// Drawing tools "snap to price/time" (POLISH_ROADMAP Phase P2). Time
// snapping is already handled by Lightweight Charts itself --
// `timeScale().coordinateToTime()` only ever returns a real bar timestamp,
// never an arbitrary continuous value, since the time axis is indexed by
// the loaded bars. What's left to do here is price: snap a raw
// coordinate-derived price to whichever of that bar's own OHLC values is
// closest, so a horizontal line dropped near a candle's high lands
// exactly on the high, not one pixel off it.
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

export function snapPrice(rawPrice: number, bar: Bar | undefined): number {
  if (!bar) return rawPrice
  const candidates = [bar.open, bar.high, bar.low, bar.close]
  return candidates.reduce((closest, c) => (Math.abs(c - rawPrice) < Math.abs(closest - rawPrice) ? c : closest))
}
