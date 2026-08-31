import { beforeEach, describe, expect, it } from 'vitest'
import { useChartDefaultsStore } from './chartDefaultsStore'

beforeEach(() => {
  useChartDefaultsStore.setState({ bracketDensity: 'auto' })
})

describe('useChartDefaultsStore', () => {
  it('starts with bracketDensity "auto"', () => {
    expect(useChartDefaultsStore.getState().bracketDensity).toBe('auto')
  })

  it('setBracketDensity updates the value', () => {
    useChartDefaultsStore.getState().setBracketDensity('full')
    expect(useChartDefaultsStore.getState().bracketDensity).toBe('full')
  })

  it('setBracketDensity accepts every BracketDensity value', () => {
    for (const d of ['auto', 'full', 'markers'] as const) {
      useChartDefaultsStore.getState().setBracketDensity(d)
      expect(useChartDefaultsStore.getState().bracketDensity).toBe(d)
    }
  })
})
