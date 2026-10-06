import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../state/contrast'
import { THEME_PRESETS, resolveBase } from '../../state/themeStore'
import { GHOST_MIN_CONTRAST, ghostStroke, layoutLabel, stackOffsets } from './orderLabelOverlay'

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

describe('label width is stable while a level is dragged', () => {
  // Digits are wider than the rest in this fake font, so a width that depended on the digits would move.
  const measure = (t: string) => [...t].reduce((n, c) => n + (/\d/.test(c) ? 8 : 5), 0)
  const body = (text: string) => ({ key: 'body' as const, text, tone: 'neutral' as const })

  it('digits are measured alike, so the same shape gives the same width', () => {
    const a = layoutLabel([body('-$46.00 | 46 ticks | 0.06%')], 600, measure).widths[0]
    const b = layoutLabel([body('-$99.00 | 99 ticks | 0.99%')], 600, measure).widths[0]
    expect(a).toBe(b)
  })

  it('the readout never gets narrower as it loses digits (a floor for a typical $/ticks/% line)', () => {
    const wide = layoutLabel([body('-$1,234.50 | 1234 ticks | 1.23%')], 600, measure).widths[0]
    const small = layoutLabel([body('$0.00 | 0 ticks | 0.00%')], 600, measure).widths[0]
    const mid = layoutLabel([body('-$146.00 | 146 ticks | 0.19%')], 600, measure).widths[0]
    expect(mid).toBe(small)
    expect(wide).toBeGreaterThanOrEqual(mid)
  })

  it('the position P&L has its own floor and is stable across digit changes', () => {
    const a = layoutLabel([body('+$1.25')], 600, measure).widths[0]
    const b = layoutLabel([body('-$987.65')], 600, measure).widths[0]
    expect(a).toBe(b)
  })
})

describe('ghostStroke: the ghost border reads at 3:1 on the chart background, in every theme, and stays fainter than a placed level', () => {
  const roleColours = (p: (typeof THEME_PRESETS)[number], b: ReturnType<typeof resolveBase>) => [b.warning, p.colors.positive]

  for (const preset of THEME_PRESETS) {
    it(`${preset.name} (${preset.mode})`, () => {
      const base = resolveBase(preset.mode)
      for (const role of roleColours(preset, base)) {
        const ghost = ghostStroke(role, base.bg)
        expect(contrastRatio(ghost, base.bg)).toBeGreaterThanOrEqual(GHOST_MIN_CONTRAST)
        // clearly fainter than the placed level's full-strength colour
        expect(contrastRatio(ghost, base.bg)).toBeLessThan(contrastRatio(role, base.bg))
        expect(ghost).not.toBe(role)
      }
    })
  }

  it('picks the faintest step that still passes (not simply the strongest)', () => {
    const dark = resolveBase('dark')
    const g = ghostStroke(dark.warning, dark.bg)
    expect(contrastRatio(g, dark.bg)).toBeLessThan(GHOST_MIN_CONTRAST + 0.6)
  })
})
