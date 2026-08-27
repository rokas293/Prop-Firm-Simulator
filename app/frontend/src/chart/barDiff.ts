// Pure diffing so PriceChart can tell "the bars array grew by appending
// new bars at the end" (cheap: N x series.update()) apart from "the window
// changed shape" (prepend, gap, timeframe switch, totally different range
// -- must fall back to series.setData(), the only thing LWC's update()
// supports is appending at/after the latest existing time, or replacing
// the single latest bar; it does not support inserting/prepending new
// bars). Kept framework-free so it's directly unit-testable.
import type { Bar } from '../api/types'

export type BarDiff =
  | { kind: 'append'; newBars: Bar[] }
  | { kind: 'replace' }

function barsEqual(a: Bar, b: Bar): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  )
}

export function diffBars(prevBars: Bar[], nextBars: Bar[]): BarDiff {
  if (prevBars.length === 0) return { kind: 'replace' }
  if (nextBars.length < prevBars.length) return { kind: 'replace' }

  for (let i = 0; i < prevBars.length; i++) {
    if (!barsEqual(prevBars[i], nextBars[i])) return { kind: 'replace' }
  }

  return { kind: 'append', newBars: nextBars.slice(prevBars.length) }
}
