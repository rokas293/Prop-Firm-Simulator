import { describe, expect, it } from 'vitest'
import {
  computeWindow,
  defaultFitWindow,
  resyncCursorIndex,
  shouldReanchor,
  reviewFitWindow,
  sessionForTime,
  shouldRefitOnLoad,
} from './SessionWorkspace'
import type { Bar } from '../api/types'
import type { SessionBand } from '../chart/kl/sessionOverlay'

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

describe('computeWindow -- never forces a coarser timeframe', () => {
  // bar_service.get_bars steps to a coarser timeframe when the window would
  // hold more than max_points (3000) bars; it counts BOTH inclusive ends.
  it.each(['1min', '5min', '15min', '1h'])('%s: at most 3000 bars even with no session gaps', (tf) => {
    const secs: Record<string, number> = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600 }
    for (const ahead of [undefined, 200]) {
      const w = computeWindow(1_000_000, tf, ahead)
      expect((w.to - w.from) / secs[tf] + 1).toBeLessThanOrEqual(3000)
    }
  })

  it('a re-anchor window puts the cursor a small lookahead from its far end, history behind', () => {
    const w = computeWindow(1_000_000, '5min', 200)
    expect(w.to).toBe(1_000_000 + 200 * 300)
    expect(1_000_000 - w.from).toBeGreaterThan(2500 * 300)
  })
})

describe('shouldReanchor', () => {
  it('fires only when the cursor is within the trigger distance of the last loaded bar', () => {
    expect(shouldReanchor(100, 3000, 5000, null)).toBe(false)
    expect(shouldReanchor(2979, 3000, 5000, null)).toBe(true)
    expect(shouldReanchor(2978, 3000, 5000, null)).toBe(false)
    expect(shouldReanchor(2978, 3000, 5000, null, 25)).toBe(true)
  })

  it('does not require exactly MAX_POINTS bars (gaps give fewer)', () => {
    expect(shouldReanchor(2400, 2410, 5000, null)).toBe(true)
  })

  it('does not re-request for the same last bar (data ran out / fetch in flight)', () => {
    expect(shouldReanchor(2999, 3000, 5000, 5000)).toBe(false)
    expect(shouldReanchor(2999, 3000, 5300, 5000)).toBe(true)
  })

  it('never fires with no bars', () => {
    expect(shouldReanchor(0, 0, undefined, null)).toBe(false)
  })
})

describe('defaultFitWindow', () => {
  it('anchors on the given time, weighted toward the future (same shape as computeWindow)', () => {
    const w = defaultFitWindow(1_000_000, '5min')
    expect(w.from).toBeLessThan(1_000_000)
    expect(w.to).toBeGreaterThan(1_000_000)
    expect(w.to - 1_000_000).toBeGreaterThan(1_000_000 - w.from)
  })

  it('is much narrower than computeWindow -- the whole point of the split', () => {
    const fit = defaultFitWindow(1_000_000, '5min')
    const fetch = computeWindow(1_000_000, '5min')
    const fitSpan = fit.to - fit.from
    const fetchSpan = fetch.to - fetch.from
    expect(fitSpan).toBeLessThan(fetchSpan / 10)
  })

  it('scales the span with the timeframe bar size', () => {
    const w1min = defaultFitWindow(1_000_000, '1min')
    const w1h = defaultFitWindow(1_000_000, '1h')
    expect(w1h.to - w1h.from).toBeGreaterThan(w1min.to - w1min.from)
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

// FXR_SPEC.md section C, phase F5: trade-review jump.
describe('reviewFitWindow', () => {
  it('pads a window around the trade entry/exit span', () => {
    const w = reviewFitWindow(1_000_000, 1_001_500, '5min')
    expect(w.from).toBeLessThan(1_000_000)
    expect(w.to).toBeGreaterThan(1_001_500)
  })

  it('handles a short (long) trade -- entry before exit', () => {
    const w = reviewFitWindow(1_000_000, 1_002_000, '5min')
    expect(w.from).toBeLessThan(1_000_000)
    expect(w.to).toBeGreaterThan(1_002_000)
  })

  it('handles a short-side trade the same way regardless of argument order', () => {
    const w1 = reviewFitWindow(1_000_000, 1_002_000, '5min')
    const w2 = reviewFitWindow(1_002_000, 1_000_000, '5min')
    expect(w1).toEqual(w2)
  })

  it('scales the pad with the timeframe bar size', () => {
    const w1min = reviewFitWindow(1_000_000, 1_001_000, '1min')
    const w1h = reviewFitWindow(1_000_000, 1_001_000, '1h')
    expect(w1h.to - w1h.from).toBeGreaterThan(w1min.to - w1min.from)
  })
})

describe('sessionForTime', () => {
  const bands: SessionBand[] = [
    { start: 1000, end: 2000, session: 'Asia', fairValue: null },
    { start: 2000, end: 3000, session: 'London', fairValue: null },
  ]

  it('finds the band containing the given time', () => {
    expect(sessionForTime(bands, 1500)).toBe('Asia')
    expect(sessionForTime(bands, 2500)).toBe('London')
  })

  it('treats the band end as exclusive, matching the NEXT band instead', () => {
    expect(sessionForTime(bands, 2000)).toBe('London')
  })

  it('returns null when the time falls in no band', () => {
    expect(sessionForTime(bands, 500)).toBeNull()
    expect(sessionForTime(bands, 3500)).toBeNull()
  })

  it('returns null for an empty bands list', () => {
    expect(sessionForTime([], 1500)).toBeNull()
  })
})

describe('shouldRefitOnLoad', () => {
  it('refits for a fresh anchor (open / resume / session switch)', () => {
    expect(shouldRefitOnLoad(false)).toBe(true)
  })

  it('does not refit after a mid-replay window re-anchor (no camera hop)', () => {
    expect(shouldRefitOnLoad(true)).toBe(false)
  })
})
