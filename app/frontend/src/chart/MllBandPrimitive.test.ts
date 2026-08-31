import { describe, expect, it, vi } from 'vitest'
import type { IChartApiBase, ISeriesApi, PaneAttachedParameter, Time } from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import { MllBandPrimitive, type BandPoint } from './MllBandPrimitive'

// Fake chart/series pair: each maps a domain value to a screen coordinate
// via a plain lookup table, with `null` standing in for "off the visible
// range" -- exactly what lightweight-charts itself returns in that case.
function createFakeChart(timeToX: Record<number, number | null>) {
  return {
    timeScale: () => ({
      timeToCoordinate: (t: Time) => timeToX[t as unknown as number] ?? null,
    }),
  } as unknown as IChartApiBase<Time>
}

function createFakeSeries(priceToY: Record<number, number | null>) {
  return {
    priceToCoordinate: (p: number) => priceToY[p] ?? null,
  } as unknown as ISeriesApi<'Line'>
}

function attach(primitive: MllBandPrimitive, chart: IChartApiBase<Time>, requestUpdate = vi.fn()) {
  primitive.attached({ chart, requestUpdate } as unknown as PaneAttachedParameter<Time>)
  return requestUpdate
}

const POINTS: BandPoint[] = [
  { time: 1, equity: 100, floor: 90 },
  { time: 2, equity: 105, floor: 91 },
  { time: 3, equity: 103, floor: 92 },
]

describe('MllBandPrimitive.getScreenPoints', () => {
  it('returns [] before attached (no chart yet)', () => {
    const series = createFakeSeries({ 100: 10, 90: 20 })
    const primitive = new MllBandPrimitive(series, POINTS, '#f00')
    expect(primitive.getScreenPoints()).toEqual([])
  })

  it('maps every point through timeToCoordinate/priceToCoordinate when all are visible', () => {
    const chart = createFakeChart({ 1: 10, 2: 20, 3: 30 })
    const series = createFakeSeries({ 100: 200, 105: 195, 103: 197, 90: 300, 91: 299, 92: 298 })
    const primitive = new MllBandPrimitive(series, POINTS, '#f00')
    attach(primitive, chart)

    expect(primitive.getScreenPoints()).toEqual([
      { x: 10, yEquity: 200, yFloor: 300 },
      { x: 20, yEquity: 195, yFloor: 299 },
      { x: 30, yEquity: 197, yFloor: 298 },
    ])
  })

  it('drops a point if its x coordinate is off-screen (null)', () => {
    const chart = createFakeChart({ 1: 10, 2: null, 3: 30 })
    const series = createFakeSeries({ 100: 200, 105: 195, 103: 197, 90: 300, 91: 299, 92: 298 })
    const primitive = new MllBandPrimitive(series, POINTS, '#f00')
    attach(primitive, chart)

    const result = primitive.getScreenPoints()
    expect(result).toHaveLength(2)
    expect(result.map((p) => p.x)).toEqual([10, 30])
  })

  it('drops a point if its equity price resolves off-screen (null)', () => {
    const chart = createFakeChart({ 1: 10, 2: 20, 3: 30 })
    const series = createFakeSeries({ 100: 200, 105: null, 103: 197, 90: 300, 91: 299, 92: 298 })
    const primitive = new MllBandPrimitive(series, POINTS, '#f00')
    attach(primitive, chart)

    expect(primitive.getScreenPoints()).toHaveLength(2)
  })

  it('drops a point if its floor price resolves off-screen (null)', () => {
    const chart = createFakeChart({ 1: 10, 2: 20, 3: 30 })
    const series = createFakeSeries({ 100: 200, 105: 195, 103: 197, 90: 300, 91: null, 92: 298 })
    const primitive = new MllBandPrimitive(series, POINTS, '#f00')
    attach(primitive, chart)

    expect(primitive.getScreenPoints()).toHaveLength(2)
  })

  it('returns [] again after detached', () => {
    const chart = createFakeChart({ 1: 10, 2: 20, 3: 30 })
    const series = createFakeSeries({ 100: 200, 105: 195, 103: 197, 90: 300, 91: 299, 92: 298 })
    const primitive = new MllBandPrimitive(series, POINTS, '#f00')
    attach(primitive, chart)
    expect(primitive.getScreenPoints()).toHaveLength(3)

    primitive.detached()
    expect(primitive.getScreenPoints()).toEqual([])
  })
})

describe('MllBandPrimitive setters', () => {
  it('setPoints replaces the points used by getScreenPoints and triggers requestUpdate', () => {
    const chart = createFakeChart({ 1: 10, 5: 50 })
    const series = createFakeSeries({ 100: 200, 90: 300, 110: 210, 95: 305 })
    const primitive = new MllBandPrimitive(series, [{ time: 1, equity: 100, floor: 90 }], '#f00')
    const requestUpdate = attach(primitive, chart)
    requestUpdate.mockClear()

    primitive.setPoints([{ time: 5, equity: 110, floor: 95 }])

    expect(primitive.getScreenPoints()).toEqual([{ x: 50, yEquity: 210, yFloor: 305 }])
    expect(requestUpdate).toHaveBeenCalledTimes(1)
  })

  it('setColor updates getFillColor and triggers requestUpdate', () => {
    const series = createFakeSeries({})
    const primitive = new MllBandPrimitive(series, [], '#f00')
    const requestUpdate = attach(primitive, createFakeChart({}))
    requestUpdate.mockClear()

    primitive.setColor('#0f0')

    expect(primitive.getFillColor()).toBe('#0f0')
    expect(requestUpdate).toHaveBeenCalledTimes(1)
  })
})

// A fake canvas 2D context that just records the drawing calls made against
// it, so the renderer's path-construction logic can be asserted on directly.
function createFakeContext() {
  const calls: string[] = []
  const context = {
    beginPath: () => calls.push('beginPath'),
    moveTo: (x: number, y: number) => calls.push(`moveTo(${x},${y})`),
    lineTo: (x: number, y: number) => calls.push(`lineTo(${x},${y})`),
    closePath: () => calls.push('closePath'),
    fill: () => calls.push('fill'),
    fillStyle: '',
  }
  return { context, calls }
}

function createFakeTarget(context: ReturnType<typeof createFakeContext>['context']) {
  const useMediaCoordinateSpace = vi.fn((cb: (scope: { context: typeof context }) => void) => {
    cb({ context })
  })
  return { useMediaCoordinateSpace } as unknown as CanvasRenderingTarget2D
}

describe('MllBandRenderer.draw', () => {
  it('no-ops (never touches the canvas) when fewer than 2 screen points are visible', () => {
    const series = createFakeSeries({ 100: 200, 90: 300 })
    const primitive = new MllBandPrimitive(series, [{ time: 1, equity: 100, floor: 90 }], '#f00')
    attach(primitive, createFakeChart({ 1: 10 }))

    const renderer = primitive.paneViews()[0].renderer()!
    const { context, calls } = createFakeContext()
    const target = createFakeTarget(context)

    renderer.draw(target)

    expect(target.useMediaCoordinateSpace).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('builds a closed path: equity edge forward, then floor edge backward, then fills with the current color', () => {
    const chart = createFakeChart({ 1: 10, 2: 20, 3: 30 })
    const series = createFakeSeries({ 100: 200, 105: 195, 103: 197, 90: 300, 91: 299, 92: 298 })
    const primitive = new MllBandPrimitive(series, POINTS, '#123456')
    attach(primitive, chart)

    const renderer = primitive.paneViews()[0].renderer()!
    const { context, calls } = createFakeContext()
    const target = createFakeTarget(context)

    renderer.draw(target)

    expect(target.useMediaCoordinateSpace).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([
      'beginPath',
      'moveTo(10,200)', // first point's equity edge
      'lineTo(20,195)', // forward along equity edge
      'lineTo(30,197)',
      'lineTo(30,298)', // reversed back along the floor edge
      'lineTo(20,299)',
      'lineTo(10,300)',
      'closePath',
      'fill',
    ])
    expect(context.fillStyle).toBe('#123456')
  })

  it('reflects a live color change (setColor) in the next draw', () => {
    const chart = createFakeChart({ 1: 10, 2: 20 })
    const series = createFakeSeries({ 100: 200, 105: 195, 90: 300, 91: 299 })
    const primitive = new MllBandPrimitive(series, POINTS.slice(0, 2), '#f00')
    attach(primitive, chart)
    primitive.setColor('#00ff00')

    const renderer = primitive.paneViews()[0].renderer()!
    const { context } = createFakeContext()
    const target = createFakeTarget(context)
    renderer.draw(target)

    expect(context.fillStyle).toBe('#00ff00')
  })
})
