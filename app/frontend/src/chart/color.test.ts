import { describe, expect, it } from 'vitest'
import { hexToRgba } from './color'

describe('hexToRgba', () => {
  it('converts a 6-digit hex to rgba', () => {
    expect(hexToRgba('#58a6ff', 0.5)).toBe('rgba(88, 166, 255, 0.5)')
  })

  it('converts a 3-digit shorthand hex to rgba', () => {
    expect(hexToRgba('#0f0', 1)).toBe('rgba(0, 255, 0, 1)')
  })

  it('works without a leading #', () => {
    expect(hexToRgba('58a6ff', 0.5)).toBe('rgba(88, 166, 255, 0.5)')
  })

  it('handles black and white', () => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
    expect(hexToRgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)')
  })
})
