import { describe, expect, it } from 'vitest'
import { MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, contrastRatio, ensureContrast, passesContrast } from './contrast'

describe('contrastRatio', () => {
  it('is 21 for pure black vs pure white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('is 1 for identical colors', () => {
    expect(contrastRatio('#58a6ff', '#58a6ff')).toBeCloseTo(1, 5)
  })

  it('is symmetric regardless of argument order', () => {
    expect(contrastRatio('#0d1117', '#f6f8fa')).toBeCloseTo(contrastRatio('#f6f8fa', '#0d1117'), 5)
  })

  it('accepts 3-digit hex shorthand', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1)
  })
})

describe('passesContrast', () => {
  it('passes a strongly contrasting pair at the text threshold', () => {
    expect(passesContrast('#000000', '#ffffff', MIN_TEXT_CONTRAST)).toBe(true)
  })

  it('fails a near-identical dark-on-dark pair', () => {
    expect(passesContrast('#0d1117', '#161b22', MIN_TEXT_CONTRAST)).toBe(false)
  })

  it('a pair passing the UI threshold need not pass the stricter text one', () => {
    // Pick a mid-gray-on-dark pair that clears 3:1 but not 4.5:1.
    const bg = '#0d1117'
    const fg = '#5c6370'
    const ratio = contrastRatio(fg, bg)
    expect(ratio).toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
    expect(ratio).toBeLessThan(MIN_TEXT_CONTRAST)
    expect(passesContrast(fg, bg, MIN_UI_CONTRAST)).toBe(true)
    expect(passesContrast(fg, bg, MIN_TEXT_CONTRAST)).toBe(false)
  })
})

describe('ensureContrast', () => {
  it('returns the color unchanged when it already passes', () => {
    expect(ensureContrast('#ffffff', '#000000', MIN_TEXT_CONTRAST)).toBe('#ffffff')
  })

  it('lightens a color that fails against a dark background until it passes', () => {
    const bg = '#0d1117'
    const bad = '#151a20' // barely lighter than bg -- fails badly
    const fixed = ensureContrast(bad, bg, MIN_TEXT_CONTRAST)
    expect(passesContrast(fixed, bg, MIN_TEXT_CONTRAST)).toBe(true)
  })

  it('darkens a color that fails against a light background until it passes', () => {
    const bg = '#f6f8fa'
    const bad = '#eef0f2' // barely darker than bg -- fails badly
    const fixed = ensureContrast(bad, bg, MIN_TEXT_CONTRAST)
    expect(passesContrast(fixed, bg, MIN_TEXT_CONTRAST)).toBe(true)
  })

  it('preserves hue while fixing lightness', () => {
    const bg = '#0d1117'
    const bad = '#1a2f1a' // dark, desaturated green -- fails
    const fixed = ensureContrast(bad, bg, MIN_TEXT_CONTRAST)
    expect(passesContrast(fixed, bg, MIN_TEXT_CONTRAST)).toBe(true)
    expect(fixed).not.toBe(bad)
  })
})
