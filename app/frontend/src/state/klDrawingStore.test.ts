import { describe, expect, it } from 'vitest'
import { overlaysForInstrument } from './klDrawingStore'
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
