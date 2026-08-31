import { beforeEach, describe, expect, it } from 'vitest'
import { useIndicatorStore } from './indicatorStore'

const DEFAULTS = {
  sessionShading: true,
  fairValue: true,
  vwap: true,
  ema20: false,
  ema50: false,
  atr14: false,
}

beforeEach(() => {
  useIndicatorStore.setState(DEFAULTS)
})

describe('useIndicatorStore', () => {
  it('starts with the documented defaults', () => {
    const state = useIndicatorStore.getState()
    expect(state).toMatchObject(DEFAULTS)
  })

  it('toggle flips exactly the given key, leaving every other key untouched', () => {
    useIndicatorStore.getState().toggle('ema20')
    const state = useIndicatorStore.getState()
    expect(state).toMatchObject({ ...DEFAULTS, ema20: true })
  })

  it('toggle on a true-by-default key flips it to false', () => {
    useIndicatorStore.getState().toggle('vwap')
    expect(useIndicatorStore.getState().vwap).toBe(false)
  })

  it('toggling the same key twice returns it to its original value', () => {
    useIndicatorStore.getState().toggle('atr14')
    useIndicatorStore.getState().toggle('atr14')
    expect(useIndicatorStore.getState().atr14).toBe(false)
  })

  it('toggling one key does not affect a second, independently-toggled key', () => {
    useIndicatorStore.getState().toggle('ema20')
    useIndicatorStore.getState().toggle('ema50')
    const state = useIndicatorStore.getState()
    expect(state.ema20).toBe(true)
    expect(state.ema50).toBe(true)
    expect(state.atr14).toBe(false)
  })
})
