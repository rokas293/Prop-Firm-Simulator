import { describe, expect, it } from 'vitest'
import { computeMeasure, formatDuration } from './measure'
import type { Bar } from '../api/types'

function bar(time: number): Bar {
  return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 }
}

describe('computeMeasure', () => {
  it('computes signed points and percent for a favorable move', () => {
    const bars: Bar[] = [bar(100), bar(160), bar(220)]
    const result = computeMeasure({ time: 100, price: 5000 }, { time: 220, price: 5050 }, bars)
    expect(result.points).toBe(50)
    expect(result.percent).toBeCloseTo((50 / 5000) * 100)
    expect(result.seconds).toBe(120)
  })

  it('computes negative points/percent for an adverse move', () => {
    const result = computeMeasure({ time: 0, price: 5000 }, { time: 60, price: 4950 }, [])
    expect(result.points).toBe(-50)
    expect(result.percent).toBeCloseTo((-50 / 5000) * 100)
  })

  it('counts bars inclusively regardless of which point is measured first', () => {
    const bars: Bar[] = [bar(90), bar(100), bar(160), bar(220), bar(300)]
    // measuring from the later point back to the earlier point should give the same bar count
    const forward = computeMeasure({ time: 100, price: 1 }, { time: 220, price: 1 }, bars)
    const backward = computeMeasure({ time: 220, price: 1 }, { time: 100, price: 1 }, bars)
    expect(forward.bars).toBe(3) // 100, 160, 220
    expect(backward.bars).toBe(3)
    expect(forward.seconds).toBe(backward.seconds)
  })

  it('excludes bars outside the measured range', () => {
    const bars: Bar[] = [bar(0), bar(50), bar(100), bar(150), bar(200)]
    const result = computeMeasure({ time: 50, price: 1 }, { time: 150, price: 1 }, bars)
    expect(result.bars).toBe(3) // 50, 100, 150 -- not 0 or 200
  })

  it('handles a zero-price anchor without dividing by zero', () => {
    const result = computeMeasure({ time: 0, price: 0 }, { time: 10, price: 5 }, [])
    expect(result.percent).toBe(0)
  })
})

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(45)).toBe('45s')
  })
  it('formats minutes', () => {
    expect(formatDuration(150)).toBe('2m')
  })
  it('formats hours and minutes', () => {
    expect(formatDuration(3 * 3600 + 15 * 60)).toBe('3h 15m')
  })
  it('formats bare hours with no minute remainder', () => {
    expect(formatDuration(2 * 3600)).toBe('2h')
  })
  it('formats days and hours', () => {
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe('2d 5h')
  })
})
