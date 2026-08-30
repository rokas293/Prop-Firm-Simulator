import { describe, expect, it } from 'vitest'
import { fmtPoints, fmtPrice } from './format'

describe('fmtPrice', () => {
  it('formats MNQ prices at 2dp with a thousands separator (0.25pt ticks)', () => {
    expect(fmtPrice(14748, 'MNQ')).toBe('14,748.00')
  })

  it('formats ZN prices at the higher precision its 1/64pt ticks need', () => {
    // 1/64 = 0.015625 -> 6dp to render exactly (instruments.ts pricePrecisionFromTick).
    expect(fmtPrice(110.5, 'ZN')).toBe('110.500000')
  })

  it('falls back to 2dp for an unrecognized instrument rather than throwing', () => {
    expect(fmtPrice(100, 'XYZ')).toBe('100.00')
  })

  it('returns a dash for null/undefined', () => {
    expect(fmtPrice(null, 'MNQ')).toBe('-')
    expect(fmtPrice(undefined, 'MNQ')).toBe('-')
  })
})

describe('fmtPoints', () => {
  it('formats at fixed 2dp with a thousands separator', () => {
    expect(fmtPoints(1234.5)).toBe('1,234.50')
  })

  it('returns a dash for null/undefined', () => {
    expect(fmtPoints(null)).toBe('-')
    expect(fmtPoints(undefined)).toBe('-')
  })
})
