// FXR_SPEC.md section A, phase F7b: the bar magnifier -- expand a revealed
// bar of a >1-minute chart into the 1-minute bars inside it.
//
// No-look-ahead is the whole point, so it is enforced structurally and twice:
// `magnifierRange` only ever yields a window inside a bar the cursor has
// reached (so the fetch never even asks for later data), and
// `clampMagnifierBars` drops anything outside that window from whatever comes
// back (so a wrong or coarsened response can't leak either).
//
// Cursor convention (G5): the cursor is the open time of the last 1-minute bar
// revealed, and that bar is revealed whole. A candle the cursor is still inside
// (the forming one) therefore magnifies only up to the cursor minute; a completed
// one in full; and nothing after the cursor, ever.
import type { Bar } from '../api/types'

export const MAGNIFIER_SOURCE_TF = '1min'
export const MAGNIFIER_SOURCE_SECONDS = 60

export interface MagnifierRange {
  from: number // open time of the first 1-minute bar (inclusive)
  to: number // open time of the last 1-minute bar (inclusive -- the API's `to` is inclusive)
}

// null = nothing may be shown: a 1-minute (or finer) chart has no lower
// timeframe to magnify, or the bar hasn't been reached by the cursor yet.
export function magnifierRange(barTime: number, tfSeconds: number, cursorTime: number | null): MagnifierRange | null {
  if (tfSeconds <= MAGNIFIER_SOURCE_SECONDS) return null
  if (cursorTime === null || barTime > cursorTime) return null
  return { from: barTime, to: Math.min(barTime + tfSeconds - MAGNIFIER_SOURCE_SECONDS, cursorTime) }
}

export function clampMagnifierBars(bars: Bar[], barTime: number, tfSeconds: number, cursorTime: number | null): Bar[] {
  const range = magnifierRange(barTime, tfSeconds, cursorTime)
  if (!range) return []
  return bars.filter((b) => b.time >= range.from && b.time <= range.to)
}
