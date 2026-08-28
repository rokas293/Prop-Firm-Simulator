import { describe, expect, it } from 'vitest'
import {
  DRAWING_TOOLS,
  ensureDrawingOverlaysRegistered,
  hydrateOverlay,
  measureLabel,
  serializeOverlay,
  setMeasureBarsContext,
  toolByName,
} from './drawingOverlays'
import type { Bar } from '../../api/types'

describe('DRAWING_TOOLS catalog', () => {
  it('covers every group with no duplicate names', () => {
    const names = DRAWING_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const group of ['lines', 'fibonacci', 'shapes', 'annotations']) {
      expect(DRAWING_TOOLS.some((t) => t.group === group)).toBe(true)
    }
  })

  it('is a strict superset of the old 5-tool set (H-Line, Ray, Trend, Zone, Measure)', () => {
    const names = DRAWING_TOOLS.map((t) => t.name)
    expect(names).toContain('horizontalStraightLine') // H-Line
    expect(names).toContain('rayLine') // Ray
    expect(names).toContain('segment') // Trend
    expect(names).toContain('klZone') // Zone
    expect(names).toContain('klMeasure') // Measure
    expect(DRAWING_TOOLS.length).toBeGreaterThan(5)
  })

  it('finds a tool by name and returns undefined for an unknown one', () => {
    expect(toolByName('klZone')?.label).toBe('Zone')
    expect(toolByName('nope')).toBeUndefined()
  })
})

describe('ensureDrawingOverlaysRegistered', () => {
  it('does not throw, including when called more than once (idempotent)', () => {
    expect(() => {
      ensureDrawingOverlaysRegistered()
      ensureDrawingOverlaysRegistered()
    }).not.toThrow()
  })
})

describe('measureLabel', () => {
  const bars: Bar[] = [
    { time: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: 1060, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: 1120, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ]

  it('computes points/percent/bars/duration off the current bars context', () => {
    setMeasureBarsContext(bars)
    const label = measureLabel({ timestamp: 1000_000, value: 100 }, { timestamp: 1120_000, value: 110 })
    expect(label).toContain('+10.00')
    expect(label).toContain('+10.00%')
    expect(label).toContain('3 bars')
  })

  it('returns an empty string when either point has no value yet (mid-draw)', () => {
    expect(measureLabel({ timestamp: 1000_000 }, { timestamp: 1120_000, value: 110 })).toBe('')
  })
})

describe('serializeOverlay / hydrateOverlay round trip', () => {
  it('keeps id/name/points/styles and only a string extendData', () => {
    const overlay = {
      id: 'kl-drawing-1',
      name: 'segment',
      points: [{ timestamp: 1000, value: 1 }],
      styles: { line: { color: '#fff' } },
      extendData: 'my note',
    }
    const persisted = serializeOverlay(overlay)
    expect(persisted).toEqual({
      id: 'kl-drawing-1',
      name: 'segment',
      points: overlay.points,
      styles: overlay.styles,
      extendDataText: 'my note',
    })

    const hydrated = hydrateOverlay(persisted, {})
    expect(hydrated.id).toBe('kl-drawing-1')
    expect(hydrated.name).toBe('segment')
    expect(hydrated.extendData).toBe('my note')
  })

  it('drops a non-string extendData (e.g. a live-computed function) rather than trying to serialize it', () => {
    const persisted = serializeOverlay({
      id: 'kl-drawing-2',
      name: 'klMeasure',
      points: [],
      styles: undefined,
      extendData: () => 'computed live',
    })
    expect(persisted.extendDataText).toBeUndefined()
  })
})
