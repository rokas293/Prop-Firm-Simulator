import { describe, expect, it } from 'vitest'
import { getOverlayClass } from 'klinecharts'
import { registerRectOverlay } from './rectOverlay'

describe('registerRectOverlay', () => {
  it('registers a new overlay name without throwing', () => {
    expect(() => registerRectOverlay('testRectA', true)).not.toThrow()
    expect(getOverlayClass('testRectA')).not.toBeNull()
  })

  it('is idempotent -- registering the same name twice does not throw or re-register', () => {
    registerRectOverlay('testRectB', true)
    const first = getOverlayClass('testRectB')
    expect(() => registerRectOverlay('testRectB', true)).not.toThrow()
    expect(getOverlayClass('testRectB')).toBe(first)
  })

  it('computes rect geometry from two corners regardless of which corner is which', () => {
    registerRectOverlay('testRectC', true)
    const OverlayClass = getOverlayClass('testRectC')!
    const overlay = new OverlayClass()
    // Bottom-right-to-top-left drag (p1 has smaller x/y than p0) must still
    // produce a positive-width/height rect anchored at the min corner --
    // this is the one piece of real math in the module (Math.min/abs), the
    // actual bug-prone part if it were ever changed to naive x1/y1/x2/y2.
    const figures = overlay.createPointFigures!({
      overlay: overlay as never,
      coordinates: [
        { x: 100, y: 80 },
        { x: 20, y: 10 },
      ],
      bounding: { width: 0, height: 0, left: 0, top: 0 },
      barSpace: 0,
      precision: { price: 2, volume: 0 },
      thousandsSeparator: '',
      decimalFoldThreshold: 0,
      dateTimeFormat: new Intl.DateTimeFormat(),
      defaultStyles: {} as never,
      xAxis: null,
      yAxis: null,
    } as never)
    expect(figures).toEqual([
      expect.objectContaining({
        type: 'rect',
        attrs: { x: 20, y: 10, width: 80, height: 70 },
      }),
    ])
  })

  it('returns no figures while only one corner has been placed (mid-draw)', () => {
    registerRectOverlay('testRectD', true)
    const OverlayClass = getOverlayClass('testRectD')!
    const overlay = new OverlayClass()
    const figures = overlay.createPointFigures!({
      overlay: overlay as never,
      coordinates: [{ x: 10, y: 10 }],
      bounding: { width: 0, height: 0, left: 0, top: 0 },
      barSpace: 0,
      precision: { price: 2, volume: 0 },
      thousandsSeparator: '',
      decimalFoldThreshold: 0,
      dateTimeFormat: new Intl.DateTimeFormat(),
      defaultStyles: {} as never,
      xAxis: null,
      yAxis: null,
    } as never)
    expect(figures).toEqual([])
  })
})
