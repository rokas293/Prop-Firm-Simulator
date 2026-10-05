import { describe, expect, it } from 'vitest'
import type { Bar } from '../api/types'
import { clampMagnifierBars, magnifierRange } from './magnifier'

const FIVE_MIN = 300
const oneMin = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
// A day of 1-minute bars, a stand-in for the whole dataset INCLUDING the future.
const DAY = Array.from({ length: 1440 }, (_, i) => oneMin(i * 60))

describe('magnifierRange', () => {
  it('spans exactly the 1-minute bars inside the bar', () => {
    expect(magnifierRange(600, FIVE_MIN, 600)).toEqual({ from: 600, to: 840 })
  })
  it('refuses a bar the cursor has not reached', () => {
    expect(magnifierRange(900, FIVE_MIN, 600)).toBeNull()
  })
  it('refuses with no cursor, and on a 1-minute session (nothing finer to show)', () => {
    expect(magnifierRange(600, FIVE_MIN, null)).toBeNull()
    expect(magnifierRange(600, 60, 600)).toBeNull()
  })
})

describe('magnifier can never reveal future bars', () => {
  it('for every cursor position and every bar, requests and returns nothing past the cursor bar', () => {
    for (const tf of [300, 900, 3600]) {
      for (let cursorTime = 0; cursorTime < 6 * 3600; cursorTime += tf) {
        const cursorBarEnd = cursorTime + tf
        for (let barTime = 0; barTime < 8 * 3600; barTime += tf) {
          const range = magnifierRange(barTime, tf, cursorTime)
          if (barTime > cursorTime) {
            expect(range).toBeNull()
            expect(clampMagnifierBars(DAY, barTime, tf, cursorTime)).toEqual([])
            continue
          }
          expect(range).not.toBeNull()
          expect(range!.to).toBeLessThan(cursorBarEnd)
          for (const b of clampMagnifierBars(DAY, barTime, tf, cursorTime)) {
            expect(b.time).toBeGreaterThanOrEqual(barTime)
            expect(b.time).toBeLessThan(cursorBarEnd)
          }
        }
      }
    }
  })

  it('drops future bars even if the data source hands them back (whole dataset in, only the bar out)', () => {
    const shown = clampMagnifierBars(DAY, 600, FIVE_MIN, 600)
    expect(shown.map((b) => b.time)).toEqual([600, 660, 720, 780, 840])
    // Nothing from the next 5-minute bar (900) or beyond.
    expect(shown.some((b) => b.time >= 900)).toBe(false)
  })

  it('shows an earlier revealed bar in full while the cursor is further on', () => {
    const shown = clampMagnifierBars(DAY, 300, FIVE_MIN, 1200)
    expect(shown.map((b) => b.time)).toEqual([300, 360, 420, 480, 540])
  })

  it('returns nothing for an unrevealed bar even when its 1-minute data is available', () => {
    expect(clampMagnifierBars(DAY, 1500, FIVE_MIN, 1200)).toEqual([])
  })
})
