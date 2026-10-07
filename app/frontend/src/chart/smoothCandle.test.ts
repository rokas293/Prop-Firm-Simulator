import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import { SMOOTH_MAX_MS, easeOut, smoothDurationMs, smoothFrame } from './smoothCandle'

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

const candle = (o: number, h: number, l: number, c: number, v = 100, time = 3600): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v })

describe('smoothFrame', () => {
  it('starts at the previous state and ends exactly at the revealed one', () => {
    const from = candle(100, 105, 99, 104, 40)
    const to = candle(100, 110, 97, 108, 90)
    expect(smoothFrame(from, to, 0)).toEqual(from)
    expect(smoothFrame(from, to, 1)).toEqual(to)
    expect(smoothFrame(from, to, 2)).toEqual(to)
  })

  it('a candle that has only just begun grows from a flat line at its open', () => {
    const to = candle(100, 103, 98, 102)
    expect(smoothFrame(null, to, 0)).toEqual({ time: 3600, open: 100, high: 100, low: 100, close: 100, volume: 0 })
    // Another candle's state is not a starting point either.
    expect(smoothFrame(candle(50, 60, 40, 55, 10, 0), to, 0).high).toBe(100)
  })

  it('never shows a price outside what the cursor revealed (randomised)', () => {
    const r = rng(1)
    for (let n = 0; n < 2000; n++) {
      const open = 20000 + r() * 50
      // A revealed state, then a later one that only widens high/low (as a candle does).
      const h1 = open + r() * 10
      const l1 = open - r() * 10
      const c1 = l1 + r() * (h1 - l1)
      const h2 = h1 + r() * 10
      const l2 = l1 - r() * 10
      const c2 = l2 + r() * (h2 - l2)
      const from = candle(open, Math.max(h1, open), Math.min(l1, open), c1, 10)
      const to = candle(open, Math.max(h2, open), Math.min(l2, open), c2, 30)
      const f = smoothFrame(from, to, r())
      for (const v of [f.open, f.high, f.low, f.close]) {
        expect(v).toBeGreaterThanOrEqual(to.low)
        expect(v).toBeLessThanOrEqual(to.high)
      }
      expect(f.high).toBeGreaterThanOrEqual(Math.max(f.open, f.close))
      expect(f.low).toBeLessThanOrEqual(Math.min(f.open, f.close))
      expect(f.open).toBe(to.open)
      expect(f.volume).toBeLessThanOrEqual(to.volume)
    }
  })

  it('is safe after a rewind inside the candle (the old state is wider than the new target)', () => {
    const wide = candle(100, 120, 90, 118, 80)
    const narrow = candle(100, 104, 98, 102, 20)
    for (const p of [0, 0.25, 0.5, 0.99]) {
      const f = smoothFrame(wide, narrow, p)
      expect(f.high).toBeLessThanOrEqual(narrow.high)
      expect(f.low).toBeGreaterThanOrEqual(narrow.low)
      expect(f.close).toBeLessThanOrEqual(narrow.high)
      expect(f.close).toBeGreaterThanOrEqual(narrow.low)
    }
  })

  it('moves monotonically toward the target', () => {
    const from = candle(100, 105, 99, 101)
    const to = candle(100, 112, 95, 111)
    let prev = from.close
    for (let i = 1; i <= 10; i++) {
      const f = smoothFrame(from, to, i / 10)
      expect(f.close).toBeGreaterThanOrEqual(prev)
      prev = f.close
    }
  })
})

describe('easing and timing', () => {
  it('eases out: fast first, settling at the end, bounded', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
    expect(easeOut(-3)).toBe(0)
    expect(easeOut(9)).toBe(1)
  })

  it('settles before the next step and within the motion budget', () => {
    expect(smoothDurationMs(1)).toBe(SMOOTH_MAX_MS)
    expect(smoothDurationMs(16)).toBe(50)
    expect(smoothDurationMs(0.5)).toBe(SMOOTH_MAX_MS)
    expect(smoothDurationMs(0)).toBe(0)
    for (const s of [0.5, 1, 2, 4, 8, 16]) expect(smoothDurationMs(s)).toBeLessThan(1000 / s)
  })
})
