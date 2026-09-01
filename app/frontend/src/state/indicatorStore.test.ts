import { beforeEach, describe, expect, it } from 'vitest'
import { useIndicatorStore } from './indicatorStore'

const DEFAULTS = {
  sessionShading: true,
  fairValue: true,
  vwap: true,
  ema20: false,
  ema50: false,
  atr14: false,
  volume: true,
}

beforeEach(() => {
  useIndicatorStore.setState({ ...DEFAULTS, colors: {} })
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

  it('toggle works on the volume key too (REPLICA_ROADMAP.md Batch 3: no longer an unconditional mount-time indicator)', () => {
    useIndicatorStore.getState().toggle('volume')
    expect(useIndicatorStore.getState().volume).toBe(false)
  })
})

describe('setIndicatorColor', () => {
  it('starts with no overrides', () => {
    expect(useIndicatorStore.getState().colors).toEqual({})
  })

  it('sets a color override for exactly the given key', () => {
    useIndicatorStore.getState().setIndicatorColor('vwap', '#ff0000')
    expect(useIndicatorStore.getState().colors).toEqual({ vwap: '#ff0000' })
  })

  it('leaves other overrides untouched when setting a second key', () => {
    useIndicatorStore.getState().setIndicatorColor('vwap', '#ff0000')
    useIndicatorStore.getState().setIndicatorColor('ema20', '#00ff00')
    expect(useIndicatorStore.getState().colors).toEqual({ vwap: '#ff0000', ema20: '#00ff00' })
  })

  it('passing null clears an override back to the theme default, not just an empty string', () => {
    useIndicatorStore.getState().setIndicatorColor('atr14', '#123456')
    useIndicatorStore.getState().setIndicatorColor('atr14', null)
    expect(useIndicatorStore.getState().colors).toEqual({})
  })
})
