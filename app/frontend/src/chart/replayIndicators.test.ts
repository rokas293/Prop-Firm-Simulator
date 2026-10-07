import { describe, expect, it } from 'vitest'
import type { IndicatorPoint } from '../api/types'
import { foldTail, spliceTail, tailRequest } from './replayIndicators'

const pts = (...pairs: Array<[number, number]>): IndicatorPoint[] => pairs.map(([time, value]) => ({ time, value }))
const H = 3600

describe('tailRequest: what to ask the backend for after a step', () => {
  const historyEnd = 10 * H - 1 // history holds candles up to 09:00; the forming candle opens at 10:00

  it('the first request covers everything from the end of the history', () => {
    expect(tailRequest({ lastAcceptedCursor: null, cursor: 10 * H + 5 * 60, historyEnd, tfSeconds: H })).toEqual({ since: 10 * H, reset: true })
  })

  it('a forward step only re-asks for the candle that was forming (it may have completed) and anything newer', () => {
    expect(tailRequest({ lastAcceptedCursor: 10 * H + 5 * 60, cursor: 10 * H + 6 * 60, historyEnd, tfSeconds: H })).toEqual({ since: 10 * H, reset: false })
    expect(tailRequest({ lastAcceptedCursor: 12 * H + 59 * 60, cursor: 13 * H, historyEnd, tfSeconds: H })).toEqual({ since: 12 * H, reset: false })
  })

  it('asks for nothing when the cursor did not move', () => {
    expect(tailRequest({ lastAcceptedCursor: 100, cursor: 100, historyEnd, tfSeconds: H })).toBeNull()
  })

  it('a rewind rebuilds the tail from the candle the cursor is in, even before the end of the history', () => {
    // Back inside the history (08:30): the forming candle is 08:00, earlier than the history's end.
    expect(tailRequest({ lastAcceptedCursor: 12 * H, cursor: 8 * H + 30 * 60, historyEnd, tfSeconds: H })).toEqual({ since: 8 * H, reset: true })
    // Back, but still after the history: from the history's end.
    expect(tailRequest({ lastAcceptedCursor: 12 * H, cursor: 10 * H + 30 * 60, historyEnd, tfSeconds: H })).toEqual({ since: 10 * H, reset: true })
  })
})

describe('foldTail / spliceTail', () => {
  it('an incoming point replaces the held one at its time and drops later held points', () => {
    expect(foldTail(pts([1, 10], [2, 20], [3, 30]), pts([2, 21], [3, 31], [4, 41]))).toEqual(pts([1, 10], [2, 21], [3, 31], [4, 41]))
    expect(foldTail(pts([1, 10], [2, 20], [3, 30]), pts([2, 99]))).toEqual(pts([1, 10], [2, 99]))
    expect(foldTail(pts([1, 10]), [])).toEqual(pts([1, 10]))
  })

  it('draws history up to where the tail starts, then the tail', () => {
    const history = pts([1, 1], [2, 2], [3, 3], [4, 4])
    expect(spliceTail(history, pts([3, 33], [4, 44], [5, 55]))).toEqual(pts([1, 1], [2, 2], [3, 33], [4, 44], [5, 55]))
    expect(spliceTail(history, [])).toEqual(history)
  })

  it('after a rewind into history the history value for the forming candle is NOT used', () => {
    // History holds a whole-candle value at t=8h; the as-of-cursor tail replaces it and everything later.
    const history = pts([6 * H, 1], [7 * H, 2], [8 * H, 3], [9 * H, 4])
    const tail = pts([8 * H, 2.5]) // the partial 08:00 candle
    expect(spliceTail(history, tail)).toEqual(pts([6 * H, 1], [7 * H, 2], [8 * H, 2.5]))
  })
})
