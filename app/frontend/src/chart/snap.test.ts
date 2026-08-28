import { describe, expect, it } from 'vitest'
import { findBarAtOrBefore, findBarAtTime } from './snap'
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
