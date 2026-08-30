import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from './uiStore'

beforeEach(() => {
  useUiStore.setState({
    selectedRunId: null,
    timeframe: '15min',
    pendingDayJump: null,
    compareRunIds: null,
  })
})

describe('selectRun', () => {
  it('sets the selected run id', () => {
    useUiStore.getState().selectRun('run-1')
    expect(useUiStore.getState().selectedRunId).toBe('run-1')
  })

  it('clears any pending day jump -- it would otherwise target a day in the wrong run', () => {
    useUiStore.getState().jumpToTradingDay('2024-03-01')
    expect(useUiStore.getState().pendingDayJump).toBe('2024-03-01')
    useUiStore.getState().selectRun('run-2')
    expect(useUiStore.getState().pendingDayJump).toBeNull()
  })

  it('accepts null to deselect', () => {
    useUiStore.getState().selectRun('run-1')
    useUiStore.getState().selectRun(null)
    expect(useUiStore.getState().selectedRunId).toBeNull()
  })
})

describe('day jump lifecycle', () => {
  it('jumpToTradingDay sets pendingDayJump, consumeDayJump clears it', () => {
    useUiStore.getState().jumpToTradingDay('2024-05-10')
    expect(useUiStore.getState().pendingDayJump).toBe('2024-05-10')
    useUiStore.getState().consumeDayJump()
    expect(useUiStore.getState().pendingDayJump).toBeNull()
  })

  it('a second jumpToTradingDay overrides the first before it is consumed', () => {
    useUiStore.getState().jumpToTradingDay('2024-05-10')
    useUiStore.getState().jumpToTradingDay('2024-05-11')
    expect(useUiStore.getState().pendingDayJump).toBe('2024-05-11')
  })
})

describe('setTimeframe / setCompareRunIds', () => {
  it('setTimeframe updates the timeframe', () => {
    useUiStore.getState().setTimeframe('1h')
    expect(useUiStore.getState().timeframe).toBe('1h')
  })

  it('setCompareRunIds accepts a pair and null', () => {
    useUiStore.getState().setCompareRunIds(['run-a', 'run-b'])
    expect(useUiStore.getState().compareRunIds).toEqual(['run-a', 'run-b'])
    useUiStore.getState().setCompareRunIds(null)
    expect(useUiStore.getState().compareRunIds).toBeNull()
  })
})

describe('persistence partialize', () => {
  it('persists only selectedRunId and timeframe, not the ephemeral day-jump/compare fields', () => {
    // Reaches into the store's own persist config the same way the store is
    // actually constructed with (zustand exposes it on .persist), so this
    // fails if a future edit widens partialize to leak ephemeral state into
    // localStorage.
    const persistOptions = (useUiStore as unknown as { persist: { getOptions: () => { partialize: (s: unknown) => unknown } } }).persist
    const partialize = persistOptions.getOptions().partialize
    useUiStore.getState().selectRun('run-1')
    useUiStore.getState().setTimeframe('5min')
    useUiStore.getState().jumpToTradingDay('2024-01-01')
    useUiStore.getState().setCompareRunIds(['run-a', 'run-b'])
    expect(partialize(useUiStore.getState())).toEqual({ selectedRunId: 'run-1', timeframe: '5min' })
  })
})
