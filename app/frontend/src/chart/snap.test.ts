import { describe, expect, it } from 'vitest'
import { findBarAtOrBefore, findBarAtTime, snapPrice } from './snap'
import type { Bar } from '../api/types'

const bars: Bar[] = [
  { time: 100, open: 5000, high: 5010, low: 4990, close: 5005 },
  { time: 200, open: 5005, high: 5020, low: 5000, close: 5015 },
].map((b) => ({ ...b, volume: 10 }))

describe('findBarAtTime', () => {
  it('finds the bar with an exact matching time', () => {
    expect(findBarAtTime(bars, 200)?.close).toBe(5015)
  })

  it('returns undefined when no bar has that exact time', () => {
    expect(findBarAtTime(bars, 150)).toBeUndefined()
  })
})

describe('findBarAtOrBefore', () => {
  it('finds the exact bar when the time matches', () => {
    expect(findBarAtOrBefore(bars, 200)?.time).toBe(200)
  })

  it('finds the closest earlier bar when there is no exact match (cross-timeframe sync)', () => {
    expect(findBarAtOrBefore(bars, 150)?.time).toBe(100)
    expect(findBarAtOrBefore(bars, 250)?.time).toBe(200)
  })

  it('returns undefined when the time is before every bar', () => {
    expect(findBarAtOrBefore(bars, 50)).toBeUndefined()
  })
})

describe('snapPrice', () => {
  const bar = bars[0] // open 5000, high 5010, low 4990, close 5005

  it('snaps to the closest OHLC value', () => {
    expect(snapPrice(5009, bar)).toBe(5010) // closest to high
    expect(snapPrice(4991, bar)).toBe(4990) // closest to low
    expect(snapPrice(5006, bar)).toBe(5005) // closest to close
    expect(snapPrice(5001, bar)).toBe(5000) // closest to open
  })

  it('returns the raw price unchanged when there is no bar to snap to', () => {
    expect(snapPrice(5123.45, undefined)).toBe(5123.45)
  })

  it('picks the nearer of two equidistant-ish candidates deterministically', () => {
    // exactly between open (5000) and close (5005) -> 5002.5, closer to neither by a hair;
    // first candidate encountered (open) wins ties by construction of reduce()
    expect(snapPrice(5002.5, bar)).toBe(5000)
  })
})
