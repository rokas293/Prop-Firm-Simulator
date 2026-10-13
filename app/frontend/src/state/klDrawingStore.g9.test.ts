// FXR_V2_SPEC.md section 7 (G9): drawings belong to the session they were made in; what was
// stored per instrument before becomes a shared layer that is never deleted; named layouts
// are saved per session; style templates are saved once.
import { beforeEach, describe, expect, it } from 'vitest'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { styleFromOverlayStyles, styleToOverlayStyles } from '../chart/kl/drawingStyleTemplates'
import { cloneDrawings, drawingLayers, useKLDrawingStore, type NamedLayout } from './klDrawingStore'

const line = (id: string): PersistedOverlay => ({ id, name: 'segment', points: [{ timestamp: 1, value: 100 }] })
const reset = () =>
  useKLDrawingStore.setState({
    overlaysByInstrument: {},
    overlaysBySession: {},
    sharedVisibleBySession: {},
    layoutsBySession: {},
    styleTemplates: [],
    newDrawingTemplateId: null,
  })

describe('per-session drawings', () => {
  beforeEach(reset)

  it('a drawing made in one session is not in another', () => {
    const s = useKLDrawingStore.getState()
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    s.setOverlaysForSession('B', 'MNQ', [line('b1'), line('b2')])
    const st = useKLDrawingStore.getState()
    expect(drawingLayers(st, 'A', 'MNQ').own.map((o) => o.id)).toEqual(['a1'])
    expect(drawingLayers(st, 'B', 'MNQ').own.map((o) => o.id)).toEqual(['b1', 'b2'])
    expect(drawingLayers(st, 'C', 'MNQ').own).toEqual([])
    // Per instrument inside a session, too.
    expect(drawingLayers(st, 'A', 'MES').own).toEqual([])
  })

  it('writing a session never touches the shared layer', () => {
    useKLDrawingStore.getState().setOverlaysForInstrument('MNQ', [line('old')])
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [line('a1')])
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [])
    expect(useKLDrawingStore.getState().overlaysByInstrument.MNQ.map((o) => o.id)).toEqual(['old'])
  })

  it('the shared layer is the old per-instrument set, shown only when that session switches it on', () => {
    const s = useKLDrawingStore.getState()
    s.setOverlaysForInstrument('MNQ', [line('old1'), line('old2')])
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    expect(drawingLayers(useKLDrawingStore.getState(), 'A', 'MNQ').shared).toEqual([])
    s.setSharedVisible('A', true)
    const st = useKLDrawingStore.getState()
    expect(drawingLayers(st, 'A', 'MNQ').shared.map((o) => o.id)).toEqual(['old1', 'old2'])
    // The toggle is per session, and the session's own drawings are separate from it.
    expect(drawingLayers(st, 'B', 'MNQ').shared).toEqual([])
    expect(drawingLayers(st, 'A', 'MNQ').own.map((o) => o.id)).toEqual(['a1'])
    // Switching it off hides, never deletes.
    s.setSharedVisible('A', false)
    expect(drawingLayers(useKLDrawingStore.getState(), 'A', 'MNQ').shared).toEqual([])
    expect(useKLDrawingStore.getState().overlaysByInstrument.MNQ).toHaveLength(2)
  })

  it('the blob an earlier version left in browser storage is not rehydrated into the store (G9b)', async () => {
    localStorage.setItem(
      'propbt-viz:kl-drawings',
      JSON.stringify({ state: { overlaysByInstrument: { MNQ: [line('legacy')] }, recentTools: ['segment'] }, version: 0 }),
    )
    await useKLDrawingStore.persist.rehydrate()
    const st = useKLDrawingStore.getState()
    // Only the one-off migration reads that key (legacyDrawings.ts); the store never does.
    expect(st.overlaysByInstrument).toEqual({})
    expect(st.overlaysBySession).toEqual({})
    expect(st.recentTools).toEqual([])
    localStorage.removeItem('propbt-viz:kl-drawings')
  })

  it('drawings, layouts and templates are never written to browser storage', () => {
    localStorage.clear()
    const s = useKLDrawingStore.getState()
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    s.setOverlaysForInstrument('MNQ', [line('old')])
    s.setSharedVisible('A', true)
    s.saveStyleTemplate({ id: 't1', name: 'Key', style: { color: '#fff000', width: 2 } })
    s.recordToolUsed('segment')
    const written = Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? ''] as const)
    // Only the favourites row (a view preference) is persisted, under its own key.
    expect(written.map(([k]) => k)).toEqual(['propbt-viz:kl-recent-tools'])
    expect(JSON.parse(written[0][1]).state).toEqual({ recentTools: ['segment'] })
    localStorage.clear()
  })
})

describe('named layouts', () => {
  beforeEach(reset)
  const layout = (id: string, name: string, patch: Partial<NamedLayout> = {}): NamedLayout => ({
    id,
    name,
    indicators: { sessionShading: true, fairValue: false, newsEvents: true, vwap: true, ema20: true, ema50: false, atr14: false, volume: false },
    candleType: 'heikin_ashi',
    timeframe: '15min',
    drawings: { MNQ: [line('d1')] },
    sharedVisible: true,
    ...patch,
  })

  it('saves per session and loads back what was saved', () => {
    const s = useKLDrawingStore.getState()
    s.saveLayout('A', layout('l1', 'Breakout'))
    const got = useKLDrawingStore.getState().layoutsBySession.A
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ name: 'Breakout', candleType: 'heikin_ashi', timeframe: '15min', sharedVisible: true })
    expect(got[0].indicators.ema20).toBe(true)
    expect(got[0].drawings.MNQ.map((o) => o.id)).toEqual(['d1'])
    // Another session has none.
    expect(useKLDrawingStore.getState().layoutsBySession.B).toBeUndefined()
  })

  it('saving under an existing name replaces it; delete removes only that layout', () => {
    const s = useKLDrawingStore.getState()
    s.saveLayout('A', layout('l1', 'Breakout'))
    s.saveLayout('A', layout('l2', 'breakout', { timeframe: '5min' }))
    s.saveLayout('A', layout('l3', 'Fade'))
    expect(useKLDrawingStore.getState().layoutsBySession.A.map((l) => [l.name, l.timeframe])).toEqual([
      ['breakout', '5min'],
      ['Fade', '15min'],
    ])
    s.deleteLayout('A', 'l3')
    expect(useKLDrawingStore.getState().layoutsBySession.A.map((l) => l.id)).toEqual(['l2'])
  })

  it('a layout owns a copy of its drawings: editing the live ones leaves it unchanged', () => {
    const live = { MNQ: [line('d1')] }
    const saved = cloneDrawings(live)
    live.MNQ[0].points = [{ timestamp: 9, value: 999 }]
    live.MNQ.push(line('d2'))
    expect(saved.MNQ).toHaveLength(1)
    expect(saved.MNQ[0].points).toEqual([{ timestamp: 1, value: 100 }])
  })

  it("loading a layout's drawings replaces the session's set", () => {
    const s = useKLDrawingStore.getState()
    s.setOverlaysForSession('A', 'MNQ', [line('now1'), line('now2')])
    s.saveLayout('A', layout('l1', 'Before', { drawings: { MNQ: [line('keep')] } }))
    const saved = useKLDrawingStore.getState().layoutsBySession.A[0]
    useKLDrawingStore.getState().setSessionDrawings('A', cloneDrawings(saved.drawings))
    expect(drawingLayers(useKLDrawingStore.getState(), 'A', 'MNQ').own.map((o) => o.id)).toEqual(['keep'])
  })
})

describe('drawing style templates', () => {
  beforeEach(reset)

  it('saves a style and applies it to a new drawing', () => {
    const style = { color: '#ff8800', width: 3 }
    useKLDrawingStore.getState().saveStyleTemplate({ id: 't1', name: 'Key level', style })
    useKLDrawingStore.getState().setNewDrawingTemplateId('t1')
    const st = useKLDrawingStore.getState()
    const chosen = st.styleTemplates.find((t) => t.id === st.newDrawingTemplateId)!
    const overlayStyles = styleToOverlayStyles(chosen.style)
    expect(overlayStyles.line).toEqual({ color: '#ff8800', size: 3 })
    expect(overlayStyles.rect).toEqual({ borderColor: '#ff8800', borderSize: 3 })
    expect(overlayStyles.text).toEqual({ color: '#ff8800' })
  })

  it("reads a drawing's style back, with a fallback for what it never set", () => {
    const fallback = { color: '#58a6ff', width: 1 }
    expect(styleFromOverlayStyles(undefined, fallback)).toEqual(fallback)
    expect(styleFromOverlayStyles({ line: { color: '#f00' } }, fallback)).toEqual({ color: '#f00', width: 1 })
    expect(styleFromOverlayStyles(styleToOverlayStyles({ color: '#0f0', width: 4 }), fallback)).toEqual({ color: '#0f0', width: 4 })
  })

  it('deleting the template new drawings use falls back to the default style', () => {
    const s = useKLDrawingStore.getState()
    s.saveStyleTemplate({ id: 't1', name: 'A', style: { color: '#111111', width: 1 } })
    s.setNewDrawingTemplateId('t1')
    s.deleteStyleTemplate('t1')
    expect(useKLDrawingStore.getState().newDrawingTemplateId).toBeNull()
  })
})
