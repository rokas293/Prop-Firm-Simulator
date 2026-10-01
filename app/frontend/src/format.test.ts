import { describe, expect, it } from 'vitest'
import { fmtPoints, fmtPrice, fmtUsd, fmtUsdWhole } from './format'

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

describe('fmtUsd sign placement', () => {
  it('puts the minus before the dollar sign, never after it', () => {
    expect(fmtUsd(-1898.75)).toBe('-$1,898.75')
    expect(fmtUsd(1898.75)).toBe('$1,898.75')
    expect(fmtUsd(0)).toBe('$0.00')
  })

  it('does not print a negative zero for a value that rounds to nothing', () => {
    expect(fmtUsd(-0.001)).toBe('$0.00')
  })

  it('fmtUsdWhole is the same convention at whole dollars', () => {
    expect(fmtUsdWhole(-47950)).toBe('-$47,950')
    expect(fmtUsdWhole(53000)).toBe('$53,000')
    expect(fmtUsdWhole(null)).toBe('-')
  })
})
