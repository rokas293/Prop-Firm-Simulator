import { describe, expect, it } from 'vitest'
import { tradesCsvUrl } from './tradesCsv'

describe('tradesCsvUrl', () => {
  it('one session, or every session', () => {
    expect(tradesCsvUrl('2025-03-10-abc')).toBe('/api/bt-sessions/2025-03-10-abc/trades.csv')
    expect(tradesCsvUrl(null)).toBe('/api/bt-sessions/export.csv')
  })
})
