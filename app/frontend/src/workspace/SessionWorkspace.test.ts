import { describe, expect, it } from 'vitest'
import { computeWindow, resyncCursorIndex } from './SessionWorkspace'
import type { Bar } from '../api/types'

function bar(time: number): Bar {
  return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 }
}

describe('computeWindow', () => {
  it('anchors the window on the given time, weighted toward the future', () => {
    const w = computeWindow(1_000_000, '5min')
    expect(w.from).toBeLessThan(1_000_000)
    expect(w.to).toBeGreaterThan(1_000_000)
    // More lookahead than lookback -- replay only ever moves forward.
    expect(w.to - 1_000_000).toBeGreaterThan(1_000_000 - w.from)
  })

  it('scales the span with the timeframe bar size', () => {
    const w1min = computeWindow(1_000_000, '1min')
    const w1h = computeWindow(1_000_000, '1h')
    expect(w1h.to - w1h.from).toBeGreaterThan(w1min.to - w1min.from)
  })

  it('falls back to a 5min-sized span for an unknown timeframe', () => {
    const w = computeWindow(1_000_000, '5min')
    const wUnknown = computeWindow(1_000_000, 'bogus')
    expect(wUnknown).toEqual(w)
  })
})

describe('resyncCursorIndex', () => {
  const bars = [bar(100), bar(200), bar(300), bar(400)]

  it('finds the exact bar matching the target time -- the core resume-to-cursor guarantee', () => {
    expect(resyncCursorIndex(bars, 300)).toBe(2)
  })

  it('returns 0 for a null target (no session loaded yet)', () => {
    expect(resyncCursorIndex(bars, null)).toBe(0)
  })

  it('returns 0 for an empty bars array', () => {
    expect(resyncCursorIndex([], 300)).toBe(0)
  })

  it('falls back to the latest bar AT OR BEFORE an unmatched target time, never one after it', () => {
    // No bar at exactly 250 -- a re-anchored/re-timeframed window edge case.
    // Must land on 200 (index 1), never 300 (index 2): landing past the
    // saved cursor would be a look-ahead violation.
    expect(resyncCursorIndex(bars, 250)).toBe(1)
  })

  it('returns the first bar when the target predates every loaded bar', () => {
    expect(resyncCursorIndex(bars, 50)).toBe(0)
  })

  it('returns the last bar when the target is after every loaded bar', () => {
    expect(resyncCursorIndex(bars, 999)).toBe(3)
  })
})
