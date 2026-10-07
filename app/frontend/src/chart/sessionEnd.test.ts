import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import { isSessionEnded, lastAllowedIndex, sessionDisplayName, shiftGranularity, stepBarCount, steppedIndex, type StepGranularityLabel } from './sessionEnd'

const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
const bars = [0, 300, 600, 900, 1200, 1500].map(bar)

describe('lastAllowedIndex', () => {
  it('is the last loaded bar with no end date', () => {
    expect(lastAllowedIndex(bars, null)).toBe(5)
  })
  it('is the latest bar at or before the end date', () => {
    expect(lastAllowedIndex(bars, 900)).toBe(3)
    expect(lastAllowedIndex(bars, 1000)).toBe(3)
  })
  it('never reaches past an end date inside the window, and clamps to the window when it lies beyond', () => {
    expect(lastAllowedIndex(bars, 1499)).toBe(4)
    expect(lastAllowedIndex(bars, 99999)).toBe(5)
  })
  it('is 0 for an end date before the first bar, and -1 for no bars', () => {
    expect(lastAllowedIndex(bars, -10)).toBe(0)
    expect(lastAllowedIndex([], 900)).toBe(-1)
  })
})

describe('isSessionEnded', () => {
  it('is false with no end date or before the last allowed bar', () => {
    expect(isSessionEnded(bars, 5, null)).toBe(false)
    expect(isSessionEnded(bars, 2, 900)).toBe(false)
  })
  it('is true on the last allowed bar when a later loaded bar exists past the end', () => {
    expect(isSessionEnded(bars, 3, 950)).toBe(true)
  })
  it('is true on a bar exactly at the end date even with nothing loaded after it', () => {
    expect(isSessionEnded(bars, 5, 1500)).toBe(true)
  })
  it('is false when the end lies beyond the loaded window (a re-anchor can still extend it)', () => {
    expect(isSessionEnded(bars, 5, 99999)).toBe(false)
  })
})

describe('sessionDisplayName', () => {
  const fmt = (t: number) => `d${t}`
  it('prefers the session name', () => {
    expect(sessionDisplayName({ name: ' Reps ', assets: ['MES'], instrument: 'MES', start_time: 5 }, fmt)).toBe('Reps')
  })
  it('falls back to the assets and start date, and to the instrument for a bare v1 shape', () => {
    expect(sessionDisplayName({ name: null, assets: ['MNQ', 'MES'], instrument: 'MNQ', start_time: 5 }, fmt)).toBe('MNQ + MES · d5')
    expect(sessionDisplayName({ name: null, assets: [], instrument: 'MNQ', start_time: 5 }, fmt)).toBe('MNQ · d5')
  })
})

describe('step granularity', () => {
  it('counts whole base bars per step and refuses a finer or non-multiple granularity', () => {
    expect(stepBarCount(900, 300)).toBe(3)
    expect(stepBarCount(300, 300)).toBe(1)
    expect(stepBarCount(60, 300)).toBeNull()
    expect(stepBarCount(900, 600)).toBeNull()
  })
  it('steps and clamps into [min, max]', () => {
    expect(steppedIndex(2, 1, 3, 0, 10)).toBe(5)
    expect(steppedIndex(9, 1, 3, 0, 10)).toBe(10)
    expect(steppedIndex(2, -1, 3, 1, 10)).toBe(1)
  })
})

describe('shiftGranularity (the step-size hotkeys)', () => {
  const all = new Set<StepGranularityLabel>(['1m', '5m', '15m', '1h'])
  // A 5-minute session cannot step by 1m until the 1m replay (G5).
  const fromFive = new Set<StepGranularityLabel>(['5m', '15m', '1h'])

  it('moves one notch coarser or finer', () => {
    expect(shiftGranularity('1m', 1, all)).toBe('5m')
    expect(shiftGranularity('15m', -1, all)).toBe('5m')
    expect(shiftGranularity('5m', 1, all)).toBe('15m')
  })

  it('stays put at either end', () => {
    expect(shiftGranularity('1h', 1, all)).toBe('1h')
    expect(shiftGranularity('1m', -1, all)).toBe('1m')
  })

  it('never lands on a size finer than the session timeframe', () => {
    expect(shiftGranularity('5m', -1, fromFive)).toBe('5m')
    expect(shiftGranularity('15m', -1, fromFive)).toBe('5m')
  })

  it('skips a size that is not a whole multiple of the base bar (a 15-minute session has no 1m or 5m)', () => {
    const fromFifteen = new Set<StepGranularityLabel>(['15m', '1h'])
    expect(shiftGranularity('15m', -1, fromFifteen)).toBe('15m')
    expect(shiftGranularity('15m', 1, fromFifteen)).toBe('1h')
    // From a size that is no longer offered (a saved 1m on a 5m session) it heads for the nearest available.
    expect(shiftGranularity('1m', 1, fromFive)).toBe('5m')
  })
})
