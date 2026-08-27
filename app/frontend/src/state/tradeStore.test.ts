import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_FILTERS, filtersToParams, useTradeStore } from './tradeStore'

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

  it('converts dateFrom/dateTo to inclusive UTC day boundaries in unix seconds', () => {
    const params = filtersToParams({ ...EMPTY_FILTERS, dateFrom: '2024-01-01', dateTo: '2024-01-01' })
    expect(params.from).toBe(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000)
    expect(params.to).toBe(Date.UTC(2024, 0, 1, 23, 59, 59) / 1000)
    expect(params.to).toBeGreaterThan(params.from as number)
  })
})
