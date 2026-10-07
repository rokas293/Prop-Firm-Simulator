// FXR_V2_SPEC.md section 5 (G5): indicators on the forming candle. The BACKEND
// computes them (/api/indicators/replay: 1m bars at or before the cursor only, the
// partial candle included) -- the frontend never recomputes a value. All that
// happens here is bookkeeping: which points to ask for each step, and splicing
// what comes back onto the history that was loaded once.
//
// The chart's indicators are two pieces:
//   history -- /api/indicators up to the end of the candles fetched when the chart
//              loaded (all completed, all before the forming candle);
//   tail    -- /api/indicators/replay: the candles built since, the forming one last.
// A tail point replaces any history point at or after its first one, so even after
// a rewind into history the forming candle's value is the as-of-cursor one, never
// the full-candle value the history holds for that bucket.
import type { IndicatorPoint } from '../api/types'
import { bucketStart } from './replayBars'

export interface TailRequest {
  // Ask for points at or after this time.
  since: number
  // True when the tail must be rebuilt from `since`: the first request, or the
  // cursor went backwards (what was held for later candles no longer applies).
  reset: boolean
}

// What to ask for after the cursor moved to `cursor`, given the cursor of the
// last answer applied (null = none yet) and where the loaded history ends.
// Returns null when there is nothing to ask (the cursor has not moved).
export function tailRequest(input: {
  lastAcceptedCursor: number | null
  cursor: number
  historyEnd: number // time of the last history candle's last second, i.e. the forming candle's open - 1 at load
  tfSeconds: number
}): TailRequest | null {
  const { lastAcceptedCursor, cursor, historyEnd, tfSeconds } = input
  if (lastAcceptedCursor === cursor) return null
  if (lastAcceptedCursor === null || cursor < lastAcceptedCursor) {
    return { since: Math.min(historyEnd + 1, bucketStart(cursor, tfSeconds)), reset: true }
  }
  // Forward: only the candle that was forming has changed since (it may have
  // completed), plus whatever the new minutes added.
  return { since: bucketStart(lastAcceptedCursor, tfSeconds), reset: false }
}

// Adds `incoming` points onto `held` (both ascending by time): an incoming point
// replaces a held one at the same time and discards every held point after the
// first incoming one (they belong to a cursor further on).
export function foldTail(held: readonly IndicatorPoint[], incoming: readonly IndicatorPoint[]): IndicatorPoint[] {
  if (incoming.length === 0) return held.slice()
  const first = incoming[0].time
  const out: IndicatorPoint[] = []
  for (const p of held) if (p.time < first) out.push(p)
  for (const p of incoming) out.push(p)
  return out
}

// The series the chart draws: history up to where the tail begins, then the tail.
export function spliceTail(history: readonly IndicatorPoint[], tail: readonly IndicatorPoint[]): IndicatorPoint[] {
  if (tail.length === 0) return history.slice()
  const first = tail[0].time
  const out: IndicatorPoint[] = []
  for (const p of history) {
    if (p.time >= first) break
    out.push(p)
  }
  for (const p of tail) out.push(p)
  return out
}
