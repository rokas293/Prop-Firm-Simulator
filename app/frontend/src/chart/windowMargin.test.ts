import { describe, expect, it } from 'vitest'
import { withMargin } from './windowMargin'

describe('withMargin', () => {
  it('expands the window by the given ratio on each side', () => {
    const result = withMargin({ from: 1000, to: 2000 }, 0.5)
    // span = 1000, margin = 500 each side
    expect(result).toEqual({ from: 500, to: 2500 })
  })

  it('defaults to a 0.5 margin ratio when none is given', () => {
    const result = withMargin({ from: 1000, to: 2000 })
    expect(result).toEqual({ from: 500, to: 2500 })
  })

  it('produces no margin for a zero ratio', () => {
    const result = withMargin({ from: 1000, to: 2000 }, 0)
    expect(result).toEqual({ from: 1000, to: 2000 })
  })

  it('never inflates a zero-span window into a negative span', () => {
    const result = withMargin({ from: 1000, to: 1000 }, 0.5)
    expect(result.to).toBeGreaterThanOrEqual(result.from)
  })
})
