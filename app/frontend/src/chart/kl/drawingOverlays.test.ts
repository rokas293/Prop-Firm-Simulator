import { describe, expect, it } from 'vitest'
import {
  DRAWING_TOOLS,
  LINE_HIT_TOLERANCE_PX,
  distanceToSegment,
  ensureDrawingOverlaysRegistered,
  hydrateOverlay,
  measureLabel,
  serializeOverlay,
  setMeasureBarsContext,
  toolByName,
  wideLineCheckEventOn,
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

  // REPLICA_ROADMAP.md Batch 1's "Lock" context-menu action: without this,
  // a locked drawing silently un-locked itself on the next reload, since
  // hydrateOverlay had no field to carry the prior lock state through.
  it('round-trips lock:true through serialize/hydrate', () => {
    const persisted = serializeOverlay({
      id: 'kl-drawing-3',
      name: 'segment',
      points: [{ timestamp: 1000, value: 1 }],
      styles: undefined,
      extendData: undefined,
      lock: true,
    })
    expect(persisted.lock).toBe(true)
    const hydrated = hydrateOverlay(persisted, {})
    expect(hydrated.lock).toBe(true)
  })

  it('hydrates an unlocked (or never-locked) drawing as lock:false, not undefined', () => {
    const persisted = serializeOverlay({
      id: 'kl-drawing-4',
      name: 'segment',
      points: [],
      styles: undefined,
      extendData: undefined,
    })
    expect(hydrateOverlay(persisted, {}).lock).toBe(false)
  })

  // REPLICA_ROADMAP.md Batch 2's drawing manager "hide" action: same
  // round-trip concern as lock above -- without persisting it, a hidden
  // drawing would silently reappear on the next reload/instrument switch.
  it('round-trips visible:false through serialize/hydrate', () => {
    const persisted = serializeOverlay({
      id: 'kl-drawing-6',
      name: 'segment',
      points: [{ timestamp: 1000, value: 1 }],
      styles: undefined,
      extendData: undefined,
      visible: false,
    })
    expect(persisted.visible).toBe(false)
    const hydrated = hydrateOverlay(persisted, {})
    expect(hydrated.visible).toBe(false)
  })

  it('hydrates a never-hidden drawing as visible:true, not undefined', () => {
    const persisted = serializeOverlay({
      id: 'kl-drawing-7',
      name: 'segment',
      points: [],
      styles: undefined,
      extendData: undefined,
    })
    expect(hydrateOverlay(persisted, {}).visible).toBe(true)
  })

  it('re-attaches every interaction callback the caller passes -- onRightClick/onMouseEnter/onMouseLeave, not just the persistence hooks', () => {
    const onRightClick = () => {}
    const onMouseEnter = () => {}
    const onMouseLeave = () => {}
    const hydrated = hydrateOverlay(serializeOverlay({ id: 'kl-drawing-5', name: 'segment', points: [], styles: undefined, extendData: undefined }), {
      onRightClick,
      onMouseEnter,
      onMouseLeave,
    })
    expect(hydrated.onRightClick).toBe(onRightClick)
    expect(hydrated.onMouseEnter).toBe(onMouseEnter)
    expect(hydrated.onMouseLeave).toBe(onMouseLeave)
  })
})

describe('distanceToSegment', () => {
  it('is 0 for a point exactly on the segment', () => {
    expect(distanceToSegment(50, 0, 0, 0, 100, 0)).toBe(0)
  })

  it('measures perpendicular distance to a point beside the segment', () => {
    expect(distanceToSegment(50, 5, 0, 0, 100, 0)).toBe(5)
  })

  it('measures distance to the nearest ENDPOINT once past the segment\'s ends, not the infinite line', () => {
    // 10px left of (0,0), off the start of a segment running rightward --
    // the infinite-line distance would be 0, but the true nearest point is
    // the (0,0) endpoint itself.
    expect(distanceToSegment(-10, 0, 0, 0, 100, 0)).toBe(10)
  })

  it('falls back to point-to-point distance for a zero-length segment', () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBe(5)
  })
})

describe('wideLineCheckEventOn (REPLICA_ROADMAP.md Batch 1: "verify a click a few px off the line still selects it")', () => {
  const horizontalLine = { coordinates: [{ x: 0, y: 100 }, { x: 200, y: 100 }] }

  it('hits exactly on the line', () => {
    expect(wideLineCheckEventOn({ x: 100, y: 100 }, horizontalLine)).toBe(true)
  })

  it(`hits a click ${LINE_HIT_TOLERANCE_PX}px off the line (the widened tolerance)`, () => {
    expect(wideLineCheckEventOn({ x: 100, y: 100 + LINE_HIT_TOLERANCE_PX }, horizontalLine)).toBe(true)
  })

  it('misses a click well beyond the widened tolerance', () => {
    expect(wideLineCheckEventOn({ x: 100, y: 100 + LINE_HIT_TOLERANCE_PX + 5 }, horizontalLine)).toBe(false)
  })

  it('hits a click 4px off -- outside klinecharts\' own hardcoded 2px tolerance, but within this widened one', () => {
    expect(wideLineCheckEventOn({ x: 100, y: 104 }, horizontalLine)).toBe(true)
  })

  it('accepts an array of line segments (klinecharts passes multi-segment attrs this way, e.g. parallel/price channels)', () => {
    const secondLine = { coordinates: [{ x: 0, y: 300 }, { x: 200, y: 300 }] }
    expect(wideLineCheckEventOn({ x: 100, y: 300 }, [horizontalLine, secondLine])).toBe(true)
    expect(wideLineCheckEventOn({ x: 100, y: 200 }, [horizontalLine, secondLine])).toBe(false)
  })
})
