import { describe, expect, it } from 'vitest'
import { easeOutCubic, interpolateRange } from './animateRange'

describe('easeOutCubic', () => {
  it('starts at 0 and ends at 1', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
  })

  it('clamps outside [0, 1]', () => {
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
  })

  it('front-loads the motion (past the halfway point before t=0.5)', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })

  it('is monotonically increasing', () => {
    let prev = -1
    for (let t = 0; t <= 1; t += 0.1) {
      const v = easeOutCubic(t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('interpolateRange', () => {
  const from = { from: 0, to: 100 }
  const to = { from: 1000, to: 2000 }

  it('is exactly the start range at t=0', () => {
    expect(interpolateRange(from, to, 0)).toEqual(from)
  })

  it('is exactly the target range at t=1', () => {
    expect(interpolateRange(from, to, 1)).toEqual(to)
  })

  it('stays within [from, to] bounds partway through', () => {
    const mid = interpolateRange(from, to, 0.5)
    expect(mid.from).toBeGreaterThan(from.from)
    expect(mid.from).toBeLessThan(to.from)
    expect(mid.to).toBeGreaterThan(from.to)
    expect(mid.to).toBeLessThan(to.to)
  })
})
