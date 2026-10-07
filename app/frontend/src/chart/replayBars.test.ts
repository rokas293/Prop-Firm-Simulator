import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import {
  HISTORY_BARS,
  MAX_HISTORY_BARS,
  SESSION_TIMEFRAMES,
  bucketStart,
  formingBar,
  heldBaseBars,
  historyBarsFor,
  historyWindow,
  lastIndexAtOrBefore,
  nextStepIndex,
  prevStepIndex,
  revealedBars,
  shiftTimeframe,
  timeframeSeconds,
  visibleBars,
} from './replayBars'

// A small deterministic PRNG so the randomised tests are reproducible.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const T0 = 1_741_564_800 // 2025-03-10 00:00:00 UTC, on every timeframe's grid

// `minutes` 1m bars from T0 with random walks; `dropRate` removes minutes (the
// daily halt, quiet minutes) so bucket edges meet gaps.
function makeFeed(seed: number, minutes: number, dropRate = 0): Bar[] {
  const r = rng(seed)
  const bars: Bar[] = []
  let price = 20000
  for (let m = 0; m < minutes; m++) {
    const open = price
    price += (r() - 0.5) * 8
    const high = Math.max(open, price) + r() * 3
    const low = Math.min(open, price) - r() * 3
    if (r() < dropRate) continue
    bars.push({ time: T0 + m * 60, open, high, low, close: price, volume: 1 + Math.floor(r() * 100) })
  }
  return bars
}

// The reference the implementation must equal: the 1m bars of the candle holding
// feed[cursorIndex], from its open through the cursor -- written the obvious way.
function naiveForming(feed: Bar[], cursorIndex: number, tf: number): Bar {
  const time = bucketStart(feed[cursorIndex].time, tf)
  const inside = feed.filter((b, i) => i <= cursorIndex && b.time >= time)
  return {
    time,
    open: inside[0].open,
    high: Math.max(...inside.map((b) => b.high)),
    low: Math.min(...inside.map((b) => b.low)),
    close: inside[inside.length - 1].close,
    volume: inside.reduce((s, b) => s + b.volume, 0),
  }
}

// Every candle of `tf` the cursor has reached, built the obvious way (the last of
// each bucket's bars gives that candle as of the cursor).
function naiveAll(feed: Bar[], cursorIndex: number, tf: number): Bar[] {
  const out: Bar[] = []
  for (let i = 0; i <= cursorIndex; i++) {
    const last = i === cursorIndex || bucketStart(feed[i + 1].time, tf) !== bucketStart(feed[i].time, tf)
    if (last) out.push(naiveForming(feed, i, tf))
  }
  return out
}

const POISON: Omit<Bar, 'time'> = { open: 1e9, high: 2e9, low: -1e9, close: 5e8, volume: 1e9 }
function poisonAfter(feed: Bar[], cursorIndex: number): Bar[] {
  return feed.map((b, i) => (i > cursorIndex ? { ...POISON, time: b.time } : b))
}

describe('timeframes', () => {
  it('offers every timeframe at or above 1m, on the grid the backend resamples on', () => {
    expect(SESSION_TIMEFRAMES[0].seconds).toBe(60)
    for (const tf of SESSION_TIMEFRAMES) {
      expect(tf.seconds % 60).toBe(0)
      expect(86400 % tf.seconds).toBe(0) // divides the day, so buckets never straddle midnight
    }
  })

  it('maps ids to seconds and steps through the list', () => {
    expect(timeframeSeconds('1h')).toBe(3600)
    expect(timeframeSeconds('nope', 300)).toBe(300)
    expect(shiftTimeframe('1min', -1)).toBe('1min')
    expect(shiftTimeframe('1min', 1)).toBe('3min')
    expect(shiftTimeframe('4h', 1)).toBe('4h')
  })

  it('buckets a time into its candle', () => {
    expect(bucketStart(T0 + 3600 + 59 * 60, 3600)).toBe(T0 + 3600)
    expect(bucketStart(T0 + 7 * 60, 300)).toBe(T0 + 300)
    expect(bucketStart(T0 + 300, 300)).toBe(T0 + 300)
  })
})

describe('the forming candle is the aggregate of exactly the 1m bars at or before the cursor', () => {
  it('equals the naive aggregate at every cursor, on every timeframe, with gaps in the data', () => {
    const feed = makeFeed(1, 6 * 60, 0.08)
    for (const tf of SESSION_TIMEFRAMES) {
      for (let i = 0; i < feed.length; i += 7) {
        expect(formingBar(feed, i, tf.seconds)).toEqual(naiveForming(feed, i, tf.seconds))
      }
    }
  })

  it('has the cursor bar as its close and the candle open as its time', () => {
    const feed = makeFeed(2, 3 * 60)
    const i = 100 // 01:40
    const c = formingBar(feed, i, 3600)
    expect(c.time).toBe(T0 + 3600)
    expect(c.close).toBe(feed[i].close)
    expect(c.open).toBe(feed[60].open)
    expect(c.volume).toBe(feed.slice(60, i + 1).reduce((s, b) => s + b.volume, 0))
  })

  it('never reads a bar after the cursor: poisoning the future changes nothing', () => {
    const r = rng(3)
    const feed = makeFeed(4, 8 * 60, 0.05)
    for (let n = 0; n < 200; n++) {
      const i = Math.floor(r() * feed.length)
      const tf = SESSION_TIMEFRAMES[Math.floor(r() * SESSION_TIMEFRAMES.length)].seconds
      expect(formingBar(poisonAfter(feed, i), i, tf)).toEqual(formingBar(feed, i, tf))
    }
  })

  it('a candle at the end of its bucket equals the whole completed candle (what /api/bars returns)', () => {
    const feed = makeFeed(5, 5 * 60)
    for (const tf of [300, 900, 3600]) {
      const lastOfBucket = feed.findIndex((b) => b.time === T0 + 2 * 3600 + 59 * 60)
      const start = bucketStart(feed[lastOfBucket].time, tf)
      const whole = feed.filter((b) => b.time >= start && b.time < start + tf)
      const expected = {
        time: start,
        open: whole[0].open,
        high: Math.max(...whole.map((b) => b.high)),
        low: Math.min(...whole.map((b) => b.low)),
        close: whole[whole.length - 1].close,
        volume: whole.reduce((s, b) => s + b.volume, 0),
      }
      expect(formingBar(feed, lastOfBucket, tf)).toEqual(expected)
    }
  })

  it('a 1m timeframe is the bar itself', () => {
    const feed = makeFeed(6, 30)
    expect(formingBar(feed, 12, 60)).toEqual(feed[12])
  })
})

describe('revealedBars: what a step adds', () => {
  it('a 1m step touches exactly one candle -- the forming one, updated in place', () => {
    const feed = makeFeed(7, 3 * 60)
    const out = revealedBars(feed, 90, 91, 3600)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(naiveForming(feed, 91, 3600))
  })

  it('a step across a candle edge updates the old candle and starts the new one', () => {
    const feed = makeFeed(8, 3 * 60)
    const out = revealedBars(feed, 118, 121, 3600) // 01:58 -> 02:01
    expect(out.map((b) => b.time)).toEqual([T0 + 3600, T0 + 7200])
    expect(out[0]).toEqual(naiveForming(feed, 119, 3600)) // the old candle is now complete (all of 01:00..01:59)
    expect(out[1]).toEqual(naiveForming(feed, 121, 3600))
  })

  it('a big step yields every candle it passed, none skipped', () => {
    const feed = makeFeed(9, 8 * 60)
    const out = revealedBars(feed, 59, 6 * 60 + 5, 3600) // 00:59 -> 06:05
    // 00:59 is already shown; the new minutes touch the 01:00 candle through the 06:00 one.
    expect(out.map((b) => b.time)).toEqual([1, 2, 3, 4, 5, 6].map((h) => T0 + h * 3600))
    expect(out[0]).toEqual(naiveForming(feed, 119, 3600)) // 01:00 complete
    expect(out[out.length - 1]).toEqual(naiveForming(feed, 6 * 60 + 5, 3600))
  })

  it('from nothing shown, the first candle is built from its own open', () => {
    const feed = makeFeed(10, 90)
    expect(revealedBars(feed, -1, 10, 3600)).toEqual([naiveForming(feed, 10, 3600)])
  })

  it('does not read past the target either', () => {
    const r = rng(11)
    const feed = makeFeed(12, 6 * 60, 0.05)
    for (let n = 0; n < 100; n++) {
      const to = 1 + Math.floor(r() * (feed.length - 1))
      const from = Math.floor(r() * to)
      const tf = SESSION_TIMEFRAMES[Math.floor(r() * SESSION_TIMEFRAMES.length)].seconds
      expect(revealedBars(poisonAfter(feed, to), from, to, tf)).toEqual(revealedBars(feed, from, to, tf))
    }
  })

  it('applying every step in place gives the same chart as rebuilding it at the cursor (the in-place update is faithful)', () => {
    const r = rng(13)
    const feed = makeFeed(14, 10 * 60, 0.04)
    for (const tf of SESSION_TIMEFRAMES) {
      let cursor = 30
      // The candles fetched before the replay starts (history), then built in place as it runs.
      const historyEnd = bucketStart(feed[cursor].time, tf.seconds)
      const history = naiveAll(feed, cursor, tf.seconds).filter((b) => b.time < historyEnd)
      const shown = visibleBars(history, [], feed, cursor, tf.seconds)
      while (cursor < feed.length - 1) {
        const next = Math.min(feed.length - 1, cursor + 1 + Math.floor(r() * 25))
        for (const b of revealedBars(feed, cursor, next, tf.seconds)) {
          if (shown.length && shown[shown.length - 1].time === b.time) shown[shown.length - 1] = b
          else shown.push(b)
        }
        cursor = next
        expect(shown).toEqual(naiveAll(feed, cursor, tf.seconds))
      }
    }
  })
})

describe('visibleBars: what the chart shows at the cursor', () => {
  it('is the candles before the forming one, then the forming one', () => {
    const feed = makeFeed(15, 5 * 60)
    const history = feed.filter((b) => b.time < T0 + 3 * 3600)
    const shown = visibleBars(history, [], feed, 3 * 60 + 20, 300)
    expect(shown[shown.length - 1].time).toBe(bucketStart(feed[200].time, 300))
    expect(shown.slice(0, -1).every((b) => b.time < shown[shown.length - 1].time)).toBe(true)
    expect(shown[shown.length - 1]).toEqual(naiveForming(feed, 200, 300))
  })

  it('after a rewind, replaces a candle that was completed further on with what the cursor can see', () => {
    const feed = makeFeed(16, 4 * 60)
    // History and tail built when the cursor was at 03:30: candles up to 03:00 complete.
    const wide = naiveAll(feed, 3 * 60 + 30, 3600) // 00:00, 01:00, 02:00 complete and 03:00 forming
    const rewound = visibleBars([], wide, feed, 2 * 60 + 15, 3600) // back to 02:15
    expect(rewound.map((b) => b.time)).toEqual([T0, T0 + 3600, T0 + 7200]) // 00:00, 01:00 and the 02:00 forming
    const last = rewound[rewound.length - 1]
    expect(last.time).toBe(T0 + 2 * 3600)
    expect(last).toEqual(naiveForming(feed, 2 * 60 + 15, 3600)) // 02:00..02:15 only, not the whole hour
    expect(last.close).toBe(feed[2 * 60 + 15].close)
  })

  it('fills in candles the lists lack from the feed (steps taken while the history was loading)', () => {
    const feed = makeFeed(30, 6 * 60)
    const cursor = 4 * 60 + 20 // 04:20
    const everything = naiveAll(feed, cursor, 3600)
    // The chart only has 00:00 and 01:00; 02:00 and 03:00 completed while it was loading.
    const base = everything.filter((b) => b.time <= T0 + 3600)
    expect(visibleBars(base, [], feed, cursor, 3600)).toEqual(everything)
    // ...and from nothing at all it is built from the feed alone.
    expect(visibleBars([], [], feed, cursor, 3600)).toEqual(everything)
  })

  it('never contains a candle at or after the forming candle other than the forming one', () => {
    const feed = makeFeed(17, 6 * 60)
    const full = [0, 1, 2, 3, 4, 5].map((h) => formingBar(feed, h * 60 + 59, 3600))
    const shown = visibleBars(full, full, feed, 2 * 60 + 5, 3600)
    expect(shown.map((b) => b.time)).toEqual([T0, T0 + 3600, T0 + 7200])
  })
})

describe('stepping', () => {
  // Every minute present, T0 aligned: indexes are minutes since 00:00.
  const feed = makeFeed(18, 6 * 60)
  const idxOf = (h: number, m: number) => h * 60 + m

  it('a 1m step is one bar, forward and back', () => {
    expect(nextStepIndex(feed, 50, 60)).toBe(51)
    expect(prevStepIndex(feed, 50, 60)).toBe(49)
  })

  it('from the end of a candle, a step is exactly one more candle of the step size', () => {
    expect(nextStepIndex(feed, idxOf(1, 4), 300)).toBe(idxOf(1, 9)) // 5m, aligned: +5 bars
    expect(nextStepIndex(feed, idxOf(1, 59), 3600)).toBe(idxOf(2, 59))
    expect(nextStepIndex(feed, idxOf(0, 14), 900)).toBe(idxOf(0, 29))
  })

  it('from mid-candle, a step completes that candle first (it lands on the step-size grid)', () => {
    expect(nextStepIndex(feed, idxOf(1, 2), 300)).toBe(idxOf(1, 4))
    expect(nextStepIndex(feed, idxOf(1, 20), 3600)).toBe(idxOf(1, 59))
    expect(nextStepIndex(feed, idxOf(1, 20), 900)).toBe(idxOf(1, 29))
  })

  it('back from the end of a candle loses the whole candle; back from mid-candle loses the revealed part of it', () => {
    expect(prevStepIndex(feed, idxOf(1, 9), 300)).toBe(idxOf(1, 4))
    expect(prevStepIndex(feed, idxOf(1, 7), 300)).toBe(idxOf(1, 4))
    expect(prevStepIndex(feed, idxOf(2, 30), 3600)).toBe(idxOf(1, 59))
  })

  it('stops at the bounds (end_date, the lock floor, the loaded feed)', () => {
    expect(nextStepIndex(feed, 100, 3600, 110)).toBe(110)
    expect(nextStepIndex(feed, 110, 3600, 110)).toBe(110)
    expect(prevStepIndex(feed, 100, 3600, 95)).toBe(95)
    expect(prevStepIndex(feed, 95, 3600, 95)).toBe(95)
    expect(nextStepIndex(feed, feed.length - 1, 60)).toBe(feed.length - 1)
  })

  it('steps over a gap in the data to the candle holding the next bar that exists', () => {
    // A halt: minutes 100..179 are missing.
    const gappy = makeFeed(19, 300).filter((_, i) => i < 100 || i >= 180)
    const before = gappy.findIndex((b) => b.time === T0 + 99 * 60)
    const after = gappy.findIndex((b) => b.time === T0 + 180 * 60)
    expect(nextStepIndex(gappy, before, 60)).toBe(after)
    // 5m from the last bar before the halt: the next existing bar (03:00) is in the 03:00 candle, completed.
    expect(nextStepIndex(gappy, before, 300)).toBe(gappy.findIndex((b) => b.time === T0 + 184 * 60))
    expect(prevStepIndex(gappy, after, 60)).toBe(before)
  })

  it('always makes progress and never leaves the feed, whatever the data and step', () => {
    const r = rng(20)
    const gappy = makeFeed(21, 10 * 60, 0.15)
    for (let n = 0; n < 300; n++) {
      const i = Math.floor(r() * gappy.length)
      const tf = SESSION_TIMEFRAMES[Math.floor(r() * SESSION_TIMEFRAMES.length)].seconds
      const f = nextStepIndex(gappy, i, tf)
      const b = prevStepIndex(gappy, i, tf)
      if (i < gappy.length - 1) expect(f).toBeGreaterThan(i)
      if (i > 0) expect(b).toBeLessThan(i)
      expect(f).toBeLessThanOrEqual(gappy.length - 1)
      expect(b).toBeGreaterThanOrEqual(0)
      // A forward step lands at the end of a step-size candle: the next bar is in a later one.
      if (f < gappy.length - 1) expect(bucketStart(gappy[f + 1].time, tf)).toBeGreaterThan(bucketStart(gappy[f].time, tf))
    }
  })

  it('finds the last bar at or before a time', () => {
    expect(lastIndexAtOrBefore(feed, T0 - 1)).toBe(-1)
    expect(lastIndexAtOrBefore(feed, T0 + 5 * 60 + 30)).toBe(5)
    expect(lastIndexAtOrBefore(feed, T0 + 1e9)).toBe(feed.length - 1)
  })
})

describe('the chart history window', () => {
  it('ends the second before the forming candle opens, so it can never hold an unrevealed minute', () => {
    for (const tf of SESSION_TIMEFRAMES) {
      const anchor = T0 + 5 * 3600 + 37 * 60
      const w = historyWindow(anchor, tf.seconds)
      expect(w.to).toBe(bucketStart(anchor, tf.seconds) - 1)
      expect(w.to).toBeLessThan(anchor)
      expect(w.to - w.from).toBe(HISTORY_BARS * tf.seconds)
    }
  })

  it('stays under the bars cap however many candles are asked for', () => {
    expect(historyWindow(T0, 60, 99999).to - historyWindow(T0, 60, 99999).from).toBe(MAX_HISTORY_BARS * 60)
  })

  it('a Go To asks for enough candles to reach the time, capped, and says when the cap stops short', () => {
    const anchor = T0 + 10 * 24 * 3600
    const near = historyBarsFor(anchor, anchor - 3600, 300)
    expect(near).toEqual({ bars: HISTORY_BARS, reachable: true }) // already inside the default window
    const far = historyBarsFor(anchor, anchor - 20 * 24 * 3600, 300) // 5760 5m bars back
    expect(far.bars).toBe(MAX_HISTORY_BARS)
    expect(far.reachable).toBe(false)
    const mid = historyBarsFor(anchor, anchor - 12 * 24 * 3600, 300) // 3456 + 60
    expect(mid.reachable).toBe(true)
    expect(mid.bars).toBeGreaterThan(HISTORY_BARS)
  })
})

describe('heldBaseBars', () => {
  it('counts the base-timeframe candles a trade touched (what v1 journaled as bars_held)', () => {
    const feed = makeFeed(40, 3 * 60)
    expect(heldBaseBars(feed, T0 + 62 * 60, T0 + 62 * 60, 300)).toBe(1) // inside one 5m candle
    expect(heldBaseBars(feed, T0 + 62 * 60, T0 + 69 * 60, 300)).toBe(2) // 01:02 -> 01:09 touches the 01:00 and 01:05 candles
    expect(heldBaseBars(feed, T0 + 60 * 60, T0 + 119 * 60, 3600)).toBe(1)
    expect(heldBaseBars(feed, T0 + 59 * 60, T0 + 61 * 60, 3600)).toBe(2)
    expect(heldBaseBars(feed, T0 + 10 * 60, T0 + 19 * 60, 60)).toBe(10) // a 1m session: minutes
  })

  it('skips candles with no data (a halt), as v1 counted loaded bars', () => {
    const feed = makeFeed(41, 300).filter((_, i) => i < 100 || i >= 160)
    expect(heldBaseBars(feed, T0 + 95 * 60, T0 + 165 * 60, 3600)).toBe(2) // 01:00 candle, then 02:00 .. (no 01:xx data after 01:39)
  })
})

describe('existing sessions behave as before by default (step size = the old base timeframe)', () => {
  it('stepping by the base timeframe walks exactly the old base bars, each one fully formed, gaps and all', () => {
    for (const base of [300, 900, 3600]) {
      const feed = makeFeed(50 + base, 12 * 60, 0.08)
      // What a v1 session showed: the resampled base bars, one per step.
      const legacy = naiveAll(feed, feed.length - 1, base)
      // A migrated cursor is the LAST minute of its base bar (bucket_last_minute on the backend).
      let cursor = lastIndexAtOrBefore(feed, legacy[2].time + base - 60)
      expect(formingBar(feed, cursor, base)).toEqual(legacy[2])
      for (let k = 3; k < legacy.length; k++) {
        cursor = nextStepIndex(feed, cursor, base)
        expect(formingBar(feed, cursor, base)).toEqual(legacy[k]) // the next base bar, complete
      }
      expect(nextStepIndex(feed, cursor, base)).toBe(cursor) // and it ends where the data does
    }
  })

  it('every candle of the migrated chart is the old base bar (the history is unchanged)', () => {
    const feed = makeFeed(60, 8 * 60, 0.05)
    for (const base of [300, 3600]) {
      const legacy = naiveAll(feed, feed.length - 1, base)
      const cursor = lastIndexAtOrBefore(feed, legacy[5].time + base - 60)
      expect(naiveAll(feed, cursor, base)).toEqual(legacy.slice(0, 6))
    }
  })
})

describe('switching the chart timeframe does not move the cursor (G5)', () => {
  it('whatever the timeframe, the newest candle closes on the cursor bar and holds no later minute', () => {
    const r = rng(70)
    const feed = makeFeed(71, 10 * 60, 0.05)
    for (let n = 0; n < 100; n++) {
      const cursor = Math.floor(r() * feed.length)
      for (const tf of SESSION_TIMEFRAMES) {
        const shown = visibleBars([], naiveAll(feed, cursor, tf.seconds), poisonAfter(feed, cursor), cursor, tf.seconds)
        const newest = shown[shown.length - 1]
        expect(newest.close).toBe(feed[cursor].close)
        expect(newest.time).toBe(bucketStart(feed[cursor].time, tf.seconds))
        expect(newest.high).toBeLessThan(POISON.high) // nothing after the cursor got in
        expect(newest.low).toBeGreaterThan(POISON.low)
      }
    }
  })
})
