import { describe, expect, it } from 'vitest'
import { ensureIndicatorsRegistered, valuesForBarsMs } from './indicators'
import type { IndicatorPoint } from '../../api/types'

describe('valuesForBarsMs', () => {
  const points: IndicatorPoint[] = [
    { time: 100, value: 1 },
    { time: 200, value: 2 },
    { time: 400, value: 4 },
  ]

  it('returns the most recent point value at or before each bar time', () => {
    const barTimesMs = [50, 100, 150, 400, 500].map((s) => s * 1000)
    expect(valuesForBarsMs(points, barTimesMs)).toEqual([undefined, 1, 1, 4, 4])
  })

  it('returns an empty-length array for no bars, and all undefined when points is empty', () => {
    expect(valuesForBarsMs(points, [])).toEqual([])
    expect(valuesForBarsMs([], [100_000, 200_000])).toEqual([undefined, undefined])
  })
})

describe('ensureIndicatorsRegistered', () => {
  it('does not throw, including when called more than once (idempotent)', () => {
    expect(() => {
      ensureIndicatorsRegistered()
      ensureIndicatorsRegistered()
    }).not.toThrow()
  })
})
