import { describe, expect, it } from 'vitest'
import { EMPTY_FILTERS } from '../state/tradeStore'
import { activeFilterChips } from './filterChips'

describe('activeFilterChips', () => {
  it('is empty when nothing is filtered', () => {
    expect(activeFilterChips(EMPTY_FILTERS)).toEqual([])
  })

  it('makes one removable chip per active dimension, keyed by the filter field it clears', () => {
    const chips = activeFilterChips({ ...EMPTY_FILTERS, tag: 'breakout', grade: 'A', entryHourNy: 9, side: 'long' })
    expect(chips).toEqual([
      { key: 'tag', label: 'Tag: breakout' },
      { key: 'grade', label: 'Grade: A' },
      { key: 'side', label: 'Side: long' },
      { key: 'entryHourNy', label: 'Hour: 09:00 ET' },
    ])
  })

  it('counts hour 0 (midnight NY) as active, and the date range as two chips', () => {
    expect(activeFilterChips({ ...EMPTY_FILTERS, entryHourNy: 0 })[0].label).toBe('Hour: 00:00 ET')
    const dates = activeFilterChips({ ...EMPTY_FILTERS, dateFrom: '2025-03-10', dateTo: '2025-03-14' })
    expect(dates.map((c) => c.label)).toEqual(['From 2025-03-10', 'To 2025-03-14'])
  })

  it('also surfaces the dashboard cross-filters that have no dropdown (weekday, hold time, streak)', () => {
    const labels = activeFilterChips({
      ...EMPTY_FILTERS,
      weekday: 'Fri',
      holdTimeBucket: '1-5 bars',
      streakSelector: { type: 'loss', length: 3 },
    }).map((c) => c.label)
    expect(labels).toEqual(['Weekday: Fri', 'Hold: 1-5 bars', 'loss streak of 3'])
  })
})
