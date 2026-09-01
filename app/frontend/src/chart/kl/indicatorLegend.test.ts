import { describe, expect, it } from 'vitest'
import { EYE_OFF_PATH, EYE_PATH, INDICATOR_KEY_BY_NAME, buildIndicatorFeatures } from './indicatorLegend'

const STYLE_OPTS = { color: '#888888', activeColor: '#ffffff', hoverBg: 'rgba(255,255,255,0.08)' }

describe('INDICATOR_KEY_BY_NAME', () => {
  it('maps every klinecharts indicator name this app creates to its IndicatorPrefs key', () => {
    expect(INDICATOR_KEY_BY_NAME).toEqual({
      VOL: 'volume',
      klVwap: 'vwap',
      klEma20: 'ema20',
      klEma50: 'ema50',
      klAtr14: 'atr14',
    })
  })
})

describe('buildIndicatorFeatures', () => {
  it('always includes an eye and a remove feature', () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'none', ...STYLE_OPTS })
    const ids = features.map((f) => f.id)
    expect(ids).toContain('ind-eye')
    expect(ids).toContain('ind-remove')
  })

  it('shows the open-eye path when not hidden, and the crossed-eye path when hidden', () => {
    const visible = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'none', ...STYLE_OPTS })
    const hidden = buildIndicatorFeatures({ hidden: true, showSettings: false, reorder: 'none', ...STYLE_OPTS })
    const eyeContent = (id: 'ind-eye') => (f: (typeof visible)[number]) => f.id === id
    expect(visible.find(eyeContent('ind-eye'))?.content).toEqual({ path: EYE_PATH, style: 'stroke', lineWidth: 1.3 })
    expect(hidden.find(eyeContent('ind-eye'))?.content).toEqual({ path: EYE_OFF_PATH, style: 'stroke', lineWidth: 1.3 })
  })

  it('omits the settings feature when showSettings is false (e.g. volume)', () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'none', ...STYLE_OPTS })
    expect(features.some((f) => f.id === 'ind-settings')).toBe(false)
  })

  it('includes the settings feature when showSettings is true', () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: true, reorder: 'none', ...STYLE_OPTS })
    expect(features.some((f) => f.id === 'ind-settings')).toBe(true)
  })

  it("omits reorder arrows when reorder is 'none'", () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'none', ...STYLE_OPTS })
    expect(features.some((f) => f.id === 'ind-up' || f.id === 'ind-down')).toBe(false)
  })

  it("includes only the up arrow when reorder is 'up'", () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'up', ...STYLE_OPTS })
    expect(features.some((f) => f.id === 'ind-up')).toBe(true)
    expect(features.some((f) => f.id === 'ind-down')).toBe(false)
  })

  it("includes only the down arrow when reorder is 'down'", () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'down', ...STYLE_OPTS })
    expect(features.some((f) => f.id === 'ind-down')).toBe(true)
    expect(features.some((f) => f.id === 'ind-up')).toBe(false)
  })

  it("includes both arrows when reorder is 'both'", () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: false, reorder: 'both', ...STYLE_OPTS })
    expect(features.some((f) => f.id === 'ind-up')).toBe(true)
    expect(features.some((f) => f.id === 'ind-down')).toBe(true)
  })

  it('every feature carries the given color/activeColor/hoverBg and renders on the right', () => {
    const features = buildIndicatorFeatures({ hidden: false, showSettings: true, reorder: 'both', ...STYLE_OPTS })
    for (const f of features) {
      expect(f.color).toBe(STYLE_OPTS.color)
      expect(f.activeColor).toBe(STYLE_OPTS.activeColor)
      expect(f.activeBackgroundColor).toBe(STYLE_OPTS.hoverBg)
      expect(f.position).toBe('right')
    }
  })

  it('produces unique feature ids within one call (no duplicate icons in a single row)', () => {
    const features = buildIndicatorFeatures({ hidden: true, showSettings: true, reorder: 'both', ...STYLE_OPTS })
    const ids = features.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
