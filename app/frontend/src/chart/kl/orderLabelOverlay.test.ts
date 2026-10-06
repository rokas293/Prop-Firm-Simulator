import { describe, expect, it } from 'vitest'
import { layoutLabel, stackOffsets } from './orderLabelOverlay'

describe('stackOffsets (labels that would cover each other sit side by side)', () => {
  const e = (id: string, role: string, y: number, width = 100) => ({ id, role, y, width })

  it('leaves well-separated labels alone', () => {
    const o = stackOffsets([e('pos', 'position', 100), e('sl', 'sl', 200)])
    expect(o.get('pos')).toBe(0)
    expect(o.get('sl')).toBe(0)
  })

  it('a break-even stop at the entry steps left of the position label, which keeps the edge', () => {
    const o = stackOffsets([e('sl', 'sl', 300, 240), e('pos', 'position', 300, 136)])
    expect(o.get('pos')).toBe(0)
    expect(o.get('sl')).toBe(136 + 4)
  })

  it('a chain stacks cumulatively, never overlapping an already-shifted label', () => {
    const o = stackOffsets([e('pos', 'position', 100, 100), e('sl', 'sl', 110, 100), e('tp', 'tp', 125, 100)])
    // tp overlaps sl (15px) but not pos (25px >= label height): it must clear sl's shifted extent.
    expect(o.get('sl')).toBe(104)
    expect(o.get('tp')).toBe(104 + 100 + 4)
  })

  it('is independent of input order', () => {
    const a = [e('a', 'sl', 50), e('b', 'position', 55), e('c', 'order', 52)]
    expect(stackOffsets(a).get('b')).toBe(0)
    expect(stackOffsets([...a].reverse()).get('a')).toBe(stackOffsets(a).get('a'))
  })
})

describe('layoutLabel', () => {
  it('hugs the right edge and lays segments left to right', () => {
    const { xs, widths, left, total } = layoutLabel(
      [
        { key: 'tag', text: 'ab', tone: 'neutral' },
        { key: 'close', text: '×', tone: 'muted' },
      ],
      500,
      () => 10,
    )
    expect(widths).toEqual([26, 20])
    expect(total).toBe(46)
    expect(left).toBe(500 - 8 - 46)
    expect(xs).toEqual([left, left + 26])
  })
})
