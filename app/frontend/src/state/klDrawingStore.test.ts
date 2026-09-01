import { beforeEach, describe, expect, it } from 'vitest'
import { overlaysForInstrument, useKLDrawingStore } from './klDrawingStore'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'

describe('overlaysForInstrument', () => {
  const mnq: PersistedOverlay[] = [{ id: '1', name: 'segment', points: [] }]

  it('returns the overlays for a known instrument', () => {
    expect(overlaysForInstrument({ MNQ: mnq }, 'MNQ')).toBe(mnq)
  })

  it('returns an empty array for an unknown instrument or null', () => {
    expect(overlaysForInstrument({ MNQ: mnq }, 'ZN')).toEqual([])
    expect(overlaysForInstrument({ MNQ: mnq }, null)).toEqual([])
  })
})

describe('recordToolUsed / recentTools (REPLICA_ROADMAP.md Batch 4 favorites row)', () => {
  beforeEach(() => {
    useKLDrawingStore.setState({ recentTools: [] })
  })

  it('starts empty', () => {
    expect(useKLDrawingStore.getState().recentTools).toEqual([])
  })

  it('records a used tool at the front', () => {
    useKLDrawingStore.getState().recordToolUsed('segment')
    expect(useKLDrawingStore.getState().recentTools).toEqual(['segment'])
  })

  it('most-recently-used comes first', () => {
    useKLDrawingStore.getState().recordToolUsed('segment')
    useKLDrawingStore.getState().recordToolUsed('klZone')
    expect(useKLDrawingStore.getState().recentTools).toEqual(['klZone', 'segment'])
  })

  it('re-using an already-recent tool moves it to the front instead of duplicating it', () => {
    useKLDrawingStore.getState().recordToolUsed('segment')
    useKLDrawingStore.getState().recordToolUsed('klZone')
    useKLDrawingStore.getState().recordToolUsed('segment')
    expect(useKLDrawingStore.getState().recentTools).toEqual(['segment', 'klZone'])
  })

  it('caps at 5 entries, dropping the oldest', () => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      useKLDrawingStore.getState().recordToolUsed(name)
    }
    expect(useKLDrawingStore.getState().recentTools).toEqual(['f', 'e', 'd', 'c', 'b'])
  })
})
