import { describe, expect, it, vi } from 'vitest'
import {
  FAIR_VALUE_GROUP,
  SESSION_BAND_GROUP,
  buildFairValueOverlay,
  buildSessionBandOverlay,
  ensureSessionBandOverlayRegistered,
  sessionColor,
  type SessionBand,
} from './sessionOverlay'

const band: SessionBand = { start: 1000, end: 2000, session: 'asia', fairValue: 14750.25 }

describe('sessionColor', () => {
  it('gives each known session its own color and falls back for an unknown one', () => {
    expect(sessionColor('asia')).not.toBe(sessionColor('london'))
    expect(sessionColor('london')).not.toBe(sessionColor('ny'))
    expect(sessionColor('made-up')).toBeTruthy()
  })
})

describe('buildSessionBandOverlay', () => {
  it('converts start/end to ms and carries the session color as extendData', () => {
    const overlay = buildSessionBandOverlay(band)
    expect(overlay.groupId).toBe(SESSION_BAND_GROUP)
    expect(overlay.points).toEqual([
      { timestamp: 1_000_000, value: 0 },
      { timestamp: 2_000_000, value: 0 },
    ])
    expect(overlay.extendData).toBe(sessionColor('asia'))
  })
})

describe('buildFairValueOverlay', () => {
  it('builds a horizontalSegment with both points at the fair value price', () => {
    const overlay = buildFairValueOverlay(band)!
    expect(overlay.name).toBe('horizontalSegment')
    expect(overlay.groupId).toBe(FAIR_VALUE_GROUP)
    expect(overlay.points).toEqual([
      { timestamp: 1_000_000, value: 14750.25 },
      { timestamp: 2_000_000, value: 14750.25 },
    ])
  })

  it('returns null when the session has no fair value', () => {
    expect(buildFairValueOverlay({ ...band, fairValue: null })).toBeNull()
  })

  // klinecharts' built-in horizontalSegment uses the interactive `line`
  // figure, whose DEFAULT right-click behavior is to delete the overlay
  // outright unless onRightClick calls preventDefault -- without this, a
  // stray right-click on the fair-value line would silently delete it.
  it('suppresses klinecharts\' default right-click-deletes-the-overlay behavior', () => {
    const overlay = buildFairValueOverlay(band)!
    const preventDefault = vi.fn()
    overlay.onRightClick?.({ preventDefault } as never)
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})

describe('ensureSessionBandOverlayRegistered', () => {
  it('does not throw, including when called more than once (idempotent)', () => {
    expect(() => {
      ensureSessionBandOverlayRegistered()
      ensureSessionBandOverlayRegistered()
    }).not.toThrow()
  })
})
