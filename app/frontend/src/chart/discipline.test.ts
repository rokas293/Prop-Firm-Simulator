import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import { isRewindBlocked, lockFloorIndex } from './discipline'

const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
const bars = [0, 300, 600, 900, 1200, 1500].map(bar)

describe('lockFloorIndex', () => {
  it('is the bar the trade was placed on', () => {
    expect(lockFloorIndex(bars, 900)).toBe(3)
  })
  it('falls back to the latest bar at or before a floor between bars', () => {
    expect(lockFloorIndex(bars, 950)).toBe(3)
  })
  it('is 0 with no floor, no bars, or a floor before the loaded window', () => {
    expect(lockFloorIndex(bars, null)).toBe(0)
    expect(lockFloorIndex([], 900)).toBe(0)
    expect(lockFloorIndex(bars, -50)).toBe(0)
  })
})

describe('isRewindBlocked', () => {
  it('never blocks with the lock off, or before any trade is placed', () => {
    expect(isRewindBlocked(false, 900, bars, 0)).toBe(false)
    expect(isRewindBlocked(true, null, bars, 0)).toBe(false)
  })
  it('blocks stepping back, scrubbing and re-setting the start to before the placement bar', () => {
    expect(isRewindBlocked(true, 900, bars, 2)).toBe(true)
    expect(isRewindBlocked(true, 900, bars, 0)).toBe(true)
  })
  it('allows the placement bar itself and anything forward', () => {
    expect(isRewindBlocked(true, 900, bars, 3)).toBe(false)
    expect(isRewindBlocked(true, 900, bars, 5)).toBe(false)
  })
})
