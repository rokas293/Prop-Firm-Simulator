import { describe, expect, it } from 'vitest'
import { diffBars } from './barDiff'
import type { Bar } from '../api/types'

function bar(time: number, close = time): Bar {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 }
}

describe('diffBars', () => {
  it('reports append when nextBars is prevBars plus new bars at the end', () => {
    const prev = [bar(10), bar(20), bar(30)]
    const next = [bar(10), bar(20), bar(30), bar(40), bar(50)]
    const result = diffBars(prev, next)
    expect(result.kind).toBe('append')
    if (result.kind === 'append') {
      expect(result.newBars.map((b) => b.time)).toEqual([40, 50])
    }
  })

  it('reports append with an empty newBars list when nothing changed', () => {
    const prev = [bar(10), bar(20)]
    const next = [bar(10), bar(20)]
    const result = diffBars(prev, next)
    expect(result.kind).toBe('append')
    if (result.kind === 'append') expect(result.newBars).toEqual([])
  })

  it('reports replace when bars were prepended (panned backward)', () => {
    const prev = [bar(20), bar(30)]
    const next = [bar(10), bar(20), bar(30)]
    expect(diffBars(prev, next).kind).toBe('replace')
  })

  it('reports replace when the window shrank (fewer bars than before)', () => {
    const prev = [bar(10), bar(20), bar(30)]
    const next = [bar(10), bar(20)]
    expect(diffBars(prev, next).kind).toBe('replace')
  })

  it('reports replace when an existing bar in the shared prefix changed value', () => {
    const prev = [bar(10), bar(20)]
    const next = [bar(10), bar(20, 999), bar(30)]
    expect(diffBars(prev, next).kind).toBe('replace')
  })

  it('reports replace when the window is a completely different range (e.g. a new trade/timeframe)', () => {
    const prev = [bar(10), bar(20)]
    const next = [bar(1000), bar(1010)]
    expect(diffBars(prev, next).kind).toBe('replace')
  })

  it('reports replace when starting from an empty series', () => {
    expect(diffBars([], [bar(10)]).kind).toBe('replace')
  })
})
