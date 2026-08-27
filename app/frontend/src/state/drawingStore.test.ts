import { beforeEach, describe, expect, it } from 'vitest'
import { drawingsForInstrument, useDrawingStore, type Drawing } from './drawingStore'

beforeEach(() => {
  localStorage.clear()
  useDrawingStore.setState({ drawings: [], activeTool: null, pendingPoint: null })
})

function makeDrawing(overrides: Partial<Drawing> = {}): Drawing {
  return {
    id: 'd1',
    type: 'hline',
    instrument: 'MNQ',
    points: [{ time: 100, price: 5000 }],
    ...overrides,
  }
}

describe('useDrawingStore', () => {
  it('starts empty with no active tool', () => {
    const s = useDrawingStore.getState()
    expect(s.drawings).toEqual([])
    expect(s.activeTool).toBeNull()
    expect(s.pendingPoint).toBeNull()
  })

  it('addDrawing appends without touching existing drawings', () => {
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'a' }))
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'b' }))
    expect(useDrawingStore.getState().drawings.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('removeDrawing deletes only the matching id', () => {
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'a' }))
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'b' }))
    useDrawingStore.getState().removeDrawing('a')
    expect(useDrawingStore.getState().drawings.map((d) => d.id)).toEqual(['b'])
  })

  it('clearForInstrument only removes drawings for that instrument', () => {
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'a', instrument: 'MNQ' }))
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'b', instrument: 'MES' }))
    useDrawingStore.getState().clearForInstrument('MNQ')
    expect(useDrawingStore.getState().drawings.map((d) => d.id)).toEqual(['b'])
  })

  it('setActiveTool clears any in-progress pending point (switching tools abandons a half-drawn line)', () => {
    useDrawingStore.getState().setActiveTool('trendline')
    useDrawingStore.getState().setPendingPoint({ time: 1, price: 2 })
    useDrawingStore.getState().setActiveTool('rect')
    expect(useDrawingStore.getState().pendingPoint).toBeNull()
    expect(useDrawingStore.getState().activeTool).toBe('rect')
  })

  it('cancelDrawing clears both tool and pending point', () => {
    useDrawingStore.getState().setActiveTool('ray')
    useDrawingStore.getState().setPendingPoint({ time: 1, price: 2 })
    useDrawingStore.getState().cancelDrawing()
    expect(useDrawingStore.getState().activeTool).toBeNull()
    expect(useDrawingStore.getState().pendingPoint).toBeNull()
  })

  it('persists drawings to localStorage but not the ephemeral tool-selection state', () => {
    useDrawingStore.getState().addDrawing(makeDrawing({ id: 'a' }))
    useDrawingStore.getState().setActiveTool('measure')

    const raw = localStorage.getItem('propbt-viz:drawings')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.drawings).toHaveLength(1)
    expect(parsed.state.activeTool).toBeUndefined()
  })
})

describe('drawingsForInstrument', () => {
  it('filters to just the given instrument', () => {
    const drawings = [makeDrawing({ id: 'a', instrument: 'MNQ' }), makeDrawing({ id: 'b', instrument: 'MES' })]
    expect(drawingsForInstrument(drawings, 'MNQ').map((d) => d.id)).toEqual(['a'])
  })

  it('returns an empty list when instrument is null', () => {
    expect(drawingsForInstrument([makeDrawing()], null)).toEqual([])
  })
})
