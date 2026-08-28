import { describe, expect, it } from 'vitest'
import { INSTRUMENTS, findInstrument, pricePrecisionFromTick, tfToPeriod } from './instruments'

describe('kl instruments', () => {
  it('finds a known instrument and returns undefined for an unknown one', () => {
    expect(findInstrument('MNQ')?.description).toBe('Micro E-mini Nasdaq-100')
    expect(findInstrument('ES')).toBeUndefined()
  })

  it('maps every supported timeframe to a klinecharts Period', () => {
    expect(tfToPeriod('1min')).toEqual({ type: 'minute', span: 1 })
    expect(tfToPeriod('5min')).toEqual({ type: 'minute', span: 5 })
    expect(tfToPeriod('15min')).toEqual({ type: 'minute', span: 15 })
    expect(tfToPeriod('1h')).toEqual({ type: 'hour', span: 1 })
  })

  it('returns null for an unsupported timeframe', () => {
    expect(tfToPeriod('4h')).toBeNull()
  })

  it('derives exact decimal precision from each instrument tick', () => {
    for (const spec of INSTRUMENTS) {
      const precision = pricePrecisionFromTick(spec.minmov, spec.pricescale)
      const scale = 10 ** precision
      expect(Math.round(spec.tickSize * scale) / scale).toBeCloseTo(spec.tickSize, 10)
    }
    // Concrete expected values from CLAUDE.md §2's tick sizes.
    expect(pricePrecisionFromTick(25, 100)).toBe(2) // MES/MNQ: 0.25
    expect(pricePrecisionFromTick(1, 64)).toBe(6) // ZN: 1/64 = 0.015625
  })
})
