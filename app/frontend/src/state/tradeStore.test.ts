import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_FILTERS, filtersToParams, filtersToStatsParams, useTradeStore } from './tradeStore'

beforeEach(() => {
  useTradeStore.setState({ filters: EMPTY_FILTERS, selectedTradeId: null })
})

describe('useTradeStore', () => {
  it('starts with no filters and no selection', () => {
    const state = useTradeStore.getState()
    expect(state.filters).toEqual(EMPTY_FILTERS)
    expect(state.selectedTradeId).toBeNull()
  })

  it('setFilter updates a single field without touching the others', () => {
    useTradeStore.getState().setFilter('leg', 'mean_reversion')
    useTradeStore.getState().setFilter('session', 'london')
    expect(useTradeStore.getState().filters).toEqual({
      ...EMPTY_FILTERS,
      leg: 'mean_reversion',
      session: 'london',
    })
  })

  it('setFilter can clear a single field back to null', () => {
    useTradeStore.getState().setFilter('side', 'long')
    useTradeStore.getState().setFilter('side', null)
    expect(useTradeStore.getState().filters.side).toBeNull()
  })

  it('clearFilters resets every field regardless of what was set', () => {
    const { setFilter, clearFilters } = useTradeStore.getState()
    setFilter('leg', 'continuation')
    setFilter('result', 'win')
    setFilter('dateFrom', '2024-01-01')
    clearFilters()
    expect(useTradeStore.getState().filters).toEqual(EMPTY_FILTERS)
  })

  it('selectTrade sets and clears the selected trade id', () => {
    useTradeStore.getState().selectTrade(42)
    expect(useTradeStore.getState().selectedTradeId).toBe(42)
    useTradeStore.getState().selectTrade(null)
    expect(useTradeStore.getState().selectedTradeId).toBeNull()
  })
})

describe('filtersToParams', () => {
  it('omits every field when no filters are set', () => {
    expect(filtersToParams(EMPTY_FILTERS)).toEqual({})
  })

  it('maps exitType -> exit_type and passes through simple fields', () => {
    const params = filtersToParams({
      ...EMPTY_FILTERS,
      leg: 'mean_reversion',
      session: 'london',
      side: 'short',
      result: 'loss',
      exitType: 'sl',
    })
    expect(params).toEqual({
      leg: 'mean_reversion',
      session: 'london',
      side: 'short',
      result: 'loss',
      exit_type: 'sl',
    })
  })

  it('converts dateFrom/dateTo to inclusive ET day boundaries in unix seconds', () => {
    const params = filtersToParams({ ...EMPTY_FILTERS, dateFrom: '2024-01-15', dateTo: '2024-01-15' })
    // EST (UTC-5): 00:00 ET = 05:00Z, 23:59:59 ET = 04:59:59Z the next day.
    expect(params.from).toBe(Date.UTC(2024, 0, 15, 5, 0, 0) / 1000)
    expect(params.to).toBe(Date.UTC(2024, 0, 16, 4, 59, 59) / 1000)
  })

  it('uses DST-correct ET boundaries (EDT is UTC-4; the spring-forward day is 23h)', () => {
    const summer = filtersToParams({ ...EMPTY_FILTERS, dateFrom: '2024-07-15', dateTo: '2024-07-15' })
    expect(summer.from).toBe(Date.UTC(2024, 6, 15, 4, 0, 0) / 1000)
    expect(summer.to).toBe(Date.UTC(2024, 6, 16, 3, 59, 59) / 1000)
    const springForward = filtersToParams({ ...EMPTY_FILTERS, dateFrom: '2024-03-10', dateTo: '2024-03-10' })
    expect((springForward.to as number) - (springForward.from as number) + 1).toBe(23 * 3600)
  })

  it('keeps a 20:00 ET trade on its ET day, not the next UTC day', () => {
    // 2024-01-15 20:00 ET = 2024-01-16 01:00Z.
    const entry = Date.UTC(2024, 0, 16, 1, 0, 0) / 1000
    const day15 = filtersToParams({ ...EMPTY_FILTERS, dateFrom: '2024-01-15', dateTo: '2024-01-15' })
    const day16 = filtersToParams({ ...EMPTY_FILTERS, dateFrom: '2024-01-16', dateTo: '2024-01-16' })
    expect(entry >= (day15.from as number) && entry <= (day15.to as number)).toBe(true)
    expect(entry >= (day16.from as number) && entry <= (day16.to as number)).toBe(false)
  })
})

describe('manual-run (journal) filters', () => {
  it('sends tag/setup/grade/backtest-session and the NY entry hour to the server', () => {
    expect(
      filtersToParams({ ...EMPTY_FILTERS, tag: 'breakout', setup: 'Fade', grade: 'A', sessionId: 's1', entryHourNy: 10 }),
    ).toEqual({ tag: 'breakout', setup: 'Fade', grade: 'A', session_id: 's1', hour_ny: 10 })
  })

  it('keeps hour 0 (midnight NY) as a real filter value, not unset', () => {
    expect(filtersToParams({ ...EMPTY_FILTERS, entryHourNy: 0 }).hour_ny).toBe(0)
  })

  it('filtersToStatsParams carries only the journal slices the stats endpoint understands', () => {
    expect(
      filtersToStatsParams({ ...EMPTY_FILTERS, tag: 't', session: 'ny', side: 'long', result: 'win', dateFrom: '2024-01-01' }),
    ).toEqual({ tag: 't', session: 'ny' })
  })

  it('a filter set persisted before F6 (no journal keys) rehydrates with them null, not undefined', async () => {
    localStorage.setItem(
      'propbt-viz:trade-filters',
      JSON.stringify({ state: { filters: { leg: 'continuation', side: null } }, version: 0 }),
    )
    await useTradeStore.persist.rehydrate()
    const f = useTradeStore.getState().filters
    expect(f.leg).toBe('continuation')
    expect(f.tag).toBeNull()
    expect(f.sessionId).toBeNull()
    localStorage.clear()
  })
})
